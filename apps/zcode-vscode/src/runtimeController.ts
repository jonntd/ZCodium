/**
 * RuntimeController — 薄编排层（架构 §5.1：保留改造）。
 *
 * 原 session/ 状态机已删除：会话状态唯一所有者回归 @zcode/services 的 Agent 进程管理
 * （services 内建 onAgentRuntimeRestarted/onAgentRuntimeLifecycle 事件链），UI 投影归
 * @zcode/ui store。本层只负责：
 * - folder → 会话参数编排：create/resume 统一走 HostSettingsBridge（P1-3/P1-6.3 沿用约束）；
 * - per-folder 最近会话恢复（P1-1.5/P1-2 host 半）：activate 后按 workspaceSessions 键控
 *   （src/webview-react/session/workspaceSessions.ts，只读复用同一 store 键空间）resume；
 * - Agent 服务生命周期：订阅 onAgentRuntimeRestarted → 自动 resume + 失败降级
 *   （diagnostics.log + 状态栏 crashed 语义，不静默，P1-6）。
 *
 * 本层不 import vscode：workspaceSessions/listFolders/事件出口全部注入，vitest 直测。
 */

import type { IZCodeAgentService } from "@zcode/services";
import type { ZCodeSessionMode } from "@zcode/shared";
import type { HostSettingsBridge } from "./host/hostSettingsBridge";
import { folderKey, type WorkspaceSessions } from "./webview-react/session/workspaceSessions";

/** 编排层对 host 状态面的投影（状态栏 P0-2 / 横幅帧 P1-6 消费）。 */
export type RuntimeUiState = "starting" | "ready" | "crashed" | "restarting";

export interface RuntimeResumeFailure {
  folder: string;
  sessionId: string;
  error: string;
}

export interface RuntimeRestoreResult {
  /** 自动恢复成功的会话。 */
  restored: string[];
  failures: RuntimeResumeFailure[];
}

/** 进程换代编排结果（restart 横幅帧载荷，见 src/host/hostFrameKinds.ts）。 */
export interface RuntimeRestartOutcome extends RuntimeRestoreResult {
  workspaceKey: string;
}

export interface RuntimeControllerEvents {
  /** 状态栏投影（P0-2：状态机随 Agent 生命周期）。 */
  onStateChange?(state: RuntimeUiState): void;
  /** 进程换代编排结果（横幅帧生产 + 失败降级提示，P1-6）。 */
  onRuntimeRestart?(outcome: RuntimeRestartOutcome): void;
}

export interface RuntimeControllerOptions {
  agentService: IZCodeAgentService;
  settingsBridge: HostSettingsBridge;
  /** per-folder 最近会话键控（P1-1.5/P1-2 host 半；与 webview 侧同一 store 键空间）。 */
  workspaceSessions?: WorkspaceSessions;
  /** 当前 workspace folders（vscode 注入；纯层不感知 vscode）。 */
  listFolders?: () => string[];
  /** 诊断出口（失败降级不静默）。 */
  log?: (message: string) => void;
  events?: RuntimeControllerEvents;
}

export class RuntimeController {
  /** folder → 最近活跃会话（内存投影；持久化归 ExtensionStore）。 */
  private readonly activeSessions = new Map<string, string>();
  private readonly restartDisposables: Array<{ dispose(): void }> = [];
  private orchestrationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RuntimeControllerOptions) {
    // 订阅进程换代（P1-6 编排入口）：自动 resume 最近会话，失败降级不静默。
    const disposable = this.options.agentService.onAgentRuntimeRestarted((event) => {
      void this.enqueue(() => this.handleRuntimeRestarted(event.workspaceKey));
    });
    this.restartDisposables.push(disposable);
  }

  /** 换代编排串行链：换代风暴期间逐次排队，不并发重复 resume。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.orchestrationChain.then(task, task);
    // 链上吞掉错误（一次失败不卡死后续编排）；result 本身仍把错误抛给调用者。
    this.orchestrationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 创建会话（settings 参数面统一从 HostSettingsBridge 取；P1-16.1 完整参数面）。 */
  async createSession(folder: string): Promise<{ sessionId: string }> {
    const params = this.options.settingsBridge.resolveCreateParams(folder);
    const snapshot = await this.options.agentService.createSession({
      workspacePath: params.workspacePath,
      mode: params.config.mode as ZCodeSessionMode,
      ...(params.config.modelSelection ? { model: params.config.modelSelection } : {}),
      toolAllowlist: params.toolAllowlist,
      toolDenylist: params.toolDenylist,
      mcpServers: params.mcpServers as never[],
      additionalDirectories: params.additionalDirectories,
    } as Parameters<IZCodeAgentService["createSession"]>[0]);
    this.trackSession(folder, snapshot.session.sessionId);
    return { sessionId: snapshot.session.sessionId };
  }

  /** 恢复会话：resume 必须携带 allowlist/denylist/mcpServers/附加目录（P1-3.2/P1-6.3）；思考档沿用原会话。 */
  async resumeSession(sessionId: string, folder: string): Promise<void> {
    const params = this.options.settingsBridge.resolveResumeParams(sessionId, folder);
    const thoughtLevel = await this.readSessionThoughtLevel(params.workspacePath, sessionId);
    await this.options.agentService.resumeSession({
      sessionId: params.sessionId,
      workspacePath: params.workspacePath,
      toolAllowlist: params.toolAllowlist,
      toolDenylist: params.toolDenylist,
      mcpServers: params.mcpServers as never[],
      additionalDirectories: params.additionalDirectories,
      // P1-6.3：协议 resume 参数支持 thoughtLevel；无独立 per-session 记忆面时以
      // 会话实体内的 settings.thoughtLevel.current 为准（未记录时缺省，不伪造）。
      ...(thoughtLevel ? { thoughtLevel } : {}),
    } as Parameters<IZCodeAgentService["resumeSession"]>[0]);
    this.trackSession(folder, sessionId);
  }

  /**
   * 原会话思考档（P1-6.3）：读会话状态快照的 settings.thoughtLevel.current。
   * 读取失败不阻塞 resume（降级为协议缺省，与「不绕过约束面」的工具面不同——
   * 思考档只影响深度，不涉及安全边界）。
   */
  private async readSessionThoughtLevel(
    workspacePath: string,
    sessionId: string,
  ): Promise<string | undefined> {
    try {
      const snapshot = await this.options.agentService.readSession({ workspacePath, sessionId });
      return snapshot.settings.thoughtLevel.current;
    } catch {
      return undefined;
    }
  }

  /** 记录 folder 的活跃会话（UI 侧切换会话时同步；写穿透 workspaceSessions 键空间）。 */
  setActiveSession(folder: string, sessionId: string | undefined): void {
    if (sessionId === undefined) this.activeSessions.delete(folder);
    else this.trackSession(folder, sessionId);
  }

  activeSession(folder: string): string | undefined {
    return this.activeSessions.get(folder);
  }

  /**
   * activate 后：按 workspaceSessions 键控恢复每个 folder 的最近会话（P1-1.5 host 半）。
   * resume 恒带 allowlist/denylist/mcpServers/附加目录（HostSettingsBridge 保证，不绕过）；
   * 失败降级与换代路径同语义：diagnostics.log + 状态栏 crashed（不静默）。
   */
  restoreWorkspaceSessions(): Promise<RuntimeRestoreResult> {
    return this.enqueue(async () => {
      this.options.events?.onStateChange?.("starting");
      const folders = this.currentFolders();
      this.options.log?.(
        `[runtime] 恢复 per-folder 最近会话：${folders.join(", ") || "(无 folder)"}`,
      );
      const { restored, failures } = await this.resumeFolders(folders);
      for (const failure of failures) {
        this.options.log?.(
          `[runtime] 会话恢复失败（降级）：folder=${failure.folder} sessionId=${failure.sessionId} error=${failure.error}`,
        );
      }
      this.options.events?.onStateChange?.(failures.length > 0 ? "crashed" : "ready");
      this.options.log?.(`[runtime] 会话恢复完成：${restored.join(", ") || "(无会话)"}`);
      return { restored, failures };
    });
  }

  /** Agent 进程换代事件订阅（测试/命令编排直连面）。 */
  onRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): { dispose(): void } {
    return this.options.agentService.onAgentRuntimeRestarted(listener);
  }

  dispose(): void {
    for (const disposable of this.restartDisposables) disposable.dispose();
    this.restartDisposables.length = 0;
  }

  // ── 内部编排 ─────────────────────────────────────────────

  private currentFolders(): string[] {
    return (this.options.listFolders?.() ?? []).map(folderKey);
  }

  private latestSession(folder: string): string | undefined {
    return this.activeSessions.get(folder) ?? this.options.workspaceSessions?.get(folder);
  }

  private trackSession(folder: string, sessionId: string): void {
    const key = folderKey(folder);
    this.activeSessions.set(key, sessionId);
    // 写穿透：与 webview 侧同一 store 键空间（P1-1.5），下次 activate 可恢复。
    this.options.workspaceSessions?.set(key, sessionId);
  }

  private async handleRuntimeRestarted(workspaceKey: string): Promise<RuntimeRestartOutcome> {
    this.options.events?.onStateChange?.("restarting");
    this.options.log?.(`[runtime] Agent 进程换代：${workspaceKey} → 自动恢复最近会话`);
    // workspaceKey = workspaceIdentity || workspacePath；插件侧不传 identity，
    // 因此键即 folder fsPath。兜底：键未命中且恰有一个有会话的 folder 时对齐它。
    const folders = this.currentFolders();
    let targets = folders.filter((f) => f === folderKey(workspaceKey));
    if (targets.length === 0) {
      const withSession = folders.filter((f) => this.latestSession(f) !== undefined);
      if (withSession.length === 1) targets = withSession;
    }
    const { restored, failures } = await this.resumeFolders(targets);
    const outcome: RuntimeRestartOutcome = { workspaceKey, restored, failures };
    this.options.events?.onRuntimeRestart?.(outcome);
    this.options.events?.onStateChange?.(failures.length > 0 ? "crashed" : "ready");
    if (failures.length > 0) {
      // 失败降级（P1-6）：诊断日志 + crashed 语义（onStateChange），绝不静默。
      for (const failure of failures) {
        this.options.log?.(
          `[runtime] 自动恢复失败（降级）：folder=${failure.folder} sessionId=${failure.sessionId} error=${failure.error}`,
        );
      }
    } else {
      this.options.log?.(`[runtime] 自动恢复完成：${restored.join(", ") || "(无会话)"}`);
    }
    return outcome;
  }

  private async resumeFolders(folders: string[]): Promise<RuntimeRestoreResult> {
    const restored: string[] = [];
    const failures: RuntimeResumeFailure[] = [];
    for (const folder of folders) {
      const sessionId = this.latestSession(folder);
      if (!sessionId) continue;
      try {
        await this.resumeSession(sessionId, folder);
        restored.push(sessionId);
      } catch (error) {
        failures.push({
          folder,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { restored, failures };
  }
}
