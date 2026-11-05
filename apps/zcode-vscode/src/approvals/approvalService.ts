/**
 * ApprovalService — 审批状态唯一所有者（P0-7/P0-8）。
 *
 * 实测语义（见 zcodeProtocol/README.md 核对项 3）：
 * - 审批的权威链路是 agent 发起的**反向 request** `interaction/requestPermission`
 *   （params 含业务 requestId），宿主以 response 应答，result =
 *   zcodePermissionResponseSchema { decision, reason?, ... }。
 * - 幂等：同 requestId 重复 resolved 忽略并告警（不重复应答帧）。
 * - 会话级 allowlist："本次会话允许"按 工具名+命令/路径 归一化键缓存，
 *   会话重建即清空；critical 风险永不自动放行。
 * - turn 结束未应答 → 标记 awaitingRestore（pending 保留），restore 后经
 *   snapshot.projection.pendingPermissions 重放呈现。
 * - 不做自动超时拒绝（PRD §7.3）。
 */

import {
  zcodePermissionOptionSchema,
  zcodePermissionRequestedEventPayloadSchema,
  type ZCodePermissionResponse,
} from "@zcode/shared";
import type { z } from "zod";
import { ExtensionProtocolError, EXTENSION_ERROR_CODES } from "../errors";

/** 审批选项类型（schema 推导；shared 未单独导出该 type 别名）。 */
type ZCodePermissionOption = z.infer<typeof zcodePermissionOptionSchema>;

export type ApprovalChoice = "allow" | "allowSession" | "deny";

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  input: unknown;
  options: ZCodePermissionOption[];
  requestedAt: number;
  /** pending | resolved | pendingRestore（快照恢复重放、无活跃应答帧）。 */
  state: "pending" | "resolved" | "pendingRestore";
  /** 反向请求的帧 id；snapshot 恢复的请求没有。 */
  frameId?: string | number;
  /** turn 已结束但未应答（恢复会话后重放）。 */
  awaitingRestore: boolean;
}

export interface ApprovalUpdate {
  kind: "requested" | "autoAllowed" | "resolved" | "restored" | "mirroredResolved";
  request: ApprovalRequest;
}

export type ApprovalReplyFn = (frameId: string | number, result: ZCodePermissionResponse) => void;
export type ApprovalWarnFn = (message: string) => void;

/** 危险命令保守静态规则（架构 §8.4）。 */
export function isDangerousCommand(command: string): boolean {
  const cmd = command.trim();
  if (/^sudo(\s|$)/.test(cmd)) return true;
  if (/rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/.test(cmd)) return true;
  if (/git\s+push\s+.*--force/.test(cmd)) return true;
  // 写系统路径（保守词表）
  if (/(^|\s)(\/etc|\/usr|\/bin|\/sbin|\/var|\/boot|\/System|\/Windows)(\/|\s|$)/.test(cmd)) {
    return true;
  }
  return false;
}

/** 从工具 input 中提取人读目标（命令全文或文件路径）。 */
export function extractApprovalTarget(toolName: string, input: unknown): { command?: string; path?: string } {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  const command = record["command"];
  const path = record["path"] ?? record["filePath"] ?? record["file_path"] ?? record["file"];
  return {
    command: typeof command === "string" ? command : undefined,
    path: typeof path === "string" ? path : undefined,
  };
}

/** 会话级 allowlist 键：工具名 + 命令/路径归一化（架构 §7.5）。 */
export function allowlistKey(toolName: string, input: unknown): string {
  const { command, path } = extractApprovalTarget(toolName, input);
  if (command !== undefined) return `${toolName}#${command.trim()}`;
  if (path !== undefined) return `${toolName}#${path.trim()}`;
  return `${toolName}#`;
}

/**
 * 「本次会话允许」的 settings 写回规则（P0-8 写回面，v0.2.0 起取代 host 内存缓存）：
 * 产出 `Tool` / `Tool(args)` 形式（与 CLI --disallowed-tools 同一规则语言，
 * 见 hostSettingsBridge.ts 头部语义），由 appendSessionAllowlist 落
 * zcodium.permissions.allowlist workspace scope。
 */
export function sessionAllowlistRule(toolName: string, input: unknown): string {
  const name = toolName.trim();
  const { command, path } = extractApprovalTarget(name, input);
  if (command !== undefined) return `${name}(${command.trim()})`;
  if (path !== undefined) return `${name}(${path.trim()})`;
  return name;
}

export class ApprovalService {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly sessionAllowlist = new Set<string>();
  private replyFn: ApprovalReplyFn | null = null;
  private warnFn: ApprovalWarnFn | null = null;
  private updateHandler: ((update: ApprovalUpdate) => void) | null = null;

  /** 注入应答通道（ProtocolConnection.reply 的包装）与告警通道。 */
  attach(replyFn: ApprovalReplyFn, warnFn?: ApprovalWarnFn): void {
    this.replyFn = replyFn;
    this.warnFn = warnFn ?? null;
  }

  onUpdate(handler: (update: ApprovalUpdate) => void): void {
    this.updateHandler = handler;
  }

  get pendingCount(): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.state === "pending") count += 1;
    }
    return count;
  }

  get pendingRequests(): ApprovalRequest[] {
    return [...this.requests.values()].filter(
      (r) => r.state === "pending" || r.state === "pendingRestore",
    );
  }

  isSessionAllowed(toolName: string, input: unknown): boolean {
    return this.sessionAllowlist.has(allowlistKey(toolName, input));
  }

  /** 会话重建时清空 allowlist（架构 §7.5）。 */
  clearSessionAllowlist(): void {
    this.sessionAllowlist.clear();
  }

  /**
   * 处理反向请求 interaction/requestPermission。
   * 命中会话 allowlist（且非 critical）→ 自动应答 allow；
   * 否则登记 pending 并推送 UI 卡片。
   * params 非法 → 以 invalid params 错误应答（审批安全边界宁可拒绝）。
   */
  handleReversePermissionRequest(params: unknown, frameId: string | number): void {
    const parsed = zcodePermissionRequestedEventPayloadSchema.safeParse(params);
    if (!parsed.success) {
      throw new ExtensionProtocolError(
        EXTENSION_ERROR_CODES.E_PERMISSION_UNKNOWN_REQUEST,
        "interaction/requestPermission 参数校验失败",
      );
    }
    const p = parsed.data;
    const requestId = p.requestId ?? p.toolCallId;
    const existing = this.requests.get(requestId);
    if (existing && existing.state !== "resolved") {
      // 同 requestId 重复 requested：忽略重复帧（幂等）。
      return;
    }
    if (this.isSessionAllowed(p.toolName, p.input) && p.riskLevel !== "critical") {
      const request: ApprovalRequest = {
        ...p,
        requestId,
        sessionId: "",
        requestedAt: Date.now(),
        state: "resolved",
        frameId,
        awaitingRestore: false,
      };
      this.requests.set(requestId, request);
      this.replyFn?.(frameId, {
        decision: "allow",
        reason: "本次会话允许（会话级 allowlist 命中）",
      });
      this.updateHandler?.({ kind: "autoAllowed", request });
      return;
    }
    const request: ApprovalRequest = {
      ...p,
      requestId,
      sessionId: "",
      requestedAt: Date.now(),
      state: "pending",
      frameId,
      awaitingRestore: false,
    };
    this.requests.set(requestId, request);
    this.updateHandler?.({ kind: "requested", request });
  }

  /** snapshot 恢复的 pendingPermissions 重放（P1-8 断线恢复内核）。 */
  handleSnapshotPermissions(
    pending: Array<{
      requestId: string;
      toolCallId: string;
      toolName: string;
      reason: string;
      riskLevel: "low" | "medium" | "high" | "critical";
      input?: unknown;
      options: ZCodePermissionOption[];
    }>,
    sessionId: string,
  ): void {
    for (const p of pending) {
      const existing = this.requests.get(p.requestId);
      if (existing && existing.state === "resolved") continue;
      if (existing && existing.state === "pending") {
        // 崩溃前的 pending：原应答帧已随旧连接失效，转为待恢复重放。
        existing.state = "pendingRestore";
        existing.frameId = undefined;
        existing.awaitingRestore = true;
        this.updateHandler?.({ kind: "restored", request: existing });
        continue;
      }
      const request: ApprovalRequest = {
        requestId: p.requestId,
        sessionId,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        reason: p.reason,
        riskLevel: p.riskLevel,
        input: p.input,
        options: p.options,
        requestedAt: Date.now(),
        state: "pendingRestore",
        awaitingRestore: true,
      };
      this.requests.set(p.requestId, request);
      this.updateHandler?.({ kind: "restored", request });
    }
  }

  /**
   * 用户决策。幂等：未知 requestId 或已 resolved → 告警并忽略（不重复应答帧）。
   * allowSession 同时写会话 allowlist。pendingRestore 的请求没有活跃帧，只更新状态。
   */
  resolve(requestId: string, choice: ApprovalChoice): void {
    const request = this.requests.get(requestId);
    if (!request || request.state === "resolved") {
      this.warnFn?.(
        `审批应答被忽略：requestId=${requestId} ${request ? "已 resolved" : "不存在"}（幂等保护）`,
      );
      return;
    }
    if (choice === "allowSession") {
      this.sessionAllowlist.add(allowlistKey(request.toolName, request.input));
    }
    const decision = choice === "deny" ? "deny" : "allow";
    request.state = "resolved";
    if (request.frameId !== undefined) {
      this.replyFn?.(request.frameId, { decision, reason: `用户选择：${choice}` });
    }
    this.updateHandler?.({ kind: "resolved", request });
  }

  /** turn 结束：仍未应答的请求标记 awaitingRestore（恢复会话后重放，不超时拒绝）。 */
  markTurnEnded(): void {
    for (const request of this.requests.values()) {
      if (request.state === "pending") {
        request.awaitingRestore = true;
      }
    }
  }

  /** 事件流 permission.resolved 镜像：agent 侧已终态（escalate/超时等），本地收敛。 */
  handleMirrorResolved(requestId: string | undefined): void {
    if (requestId === undefined) return;
    const request = this.requests.get(requestId);
    if (!request || request.state === "resolved") return;
    request.state = "resolved";
    this.updateHandler?.({ kind: "mirroredResolved", request });
  }

  /** 会话重建：清空全部审批状态与 allowlist。 */
  resetForNewSession(): void {
    this.requests.clear();
    this.sessionAllowlist.clear();
  }
}
