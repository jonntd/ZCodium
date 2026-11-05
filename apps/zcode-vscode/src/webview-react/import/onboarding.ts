/**
 * import/onboarding.ts — Claude 会话导入的检测引导与导入映射（T11，P1-12/P1-10.2）。
 *
 * - 前提门：isDesktop === true（vscodePlatformService.ts H7 桌面能力位）才开放——
 *   ~/.claude/projects 扫描发生在扩展宿主进程（services zcode-task 频道：
 *   IZCodeTaskService.scanImportableClaudeSessions / importClaudeSessions，
 *   §9 核实项 4 的证据面）；
 * - 检测引导：扫描结果（含错误）→ 引导态投影（未检测到 = 提示安装/路径说明）；
 * - 导入映射：候选选择 → importClaudeSessions 入参；结果 → 可读汇总 + 打开新会话。
 * 纯函数模块：vitest 直测（test/claudeImport.test.ts）。
 */

import type { ZCodeImportableSessionCandidate, ZCodeImportSessionsResult } from "@zcode/shared";

/** 候选行的展示投影（P1-12.1：标题 + 时间 + workspace 归属）。 */
export interface ClaudeCandidateRow {
  sessionId: string;
  title: string;
  workspacePath: string;
  sourcePath: string;
  updatedAtLabel: string;
}

/** 引导态（P1-10.2：检测到 ~/.claude 时提示可导入；P1-12 门开启态）。 */
export interface ClaudeImportSupport {
  supported: boolean;
  /** 不支持原因（desktopOnly）。 */
  reason: "desktopOnly" | null;
  /** 扫描已成功执行且 ~/.claude 存在可导入历史。 */
  detected: boolean;
  /** 已扫描但无候选（未安装 Claude Code 或无历史）。 */
  scanned: boolean;
  scanError: string | null;
  /** 引导文案（面板顶部一行；空串 = 不展示）。 */
  guidance: string;
}

export const CLAUDE_NOT_DETECTED_GUIDANCE =
  "未在本机检测到 Claude Code 会话（~/.claude/projects）。安装并使用 Claude Code 后，这里可一键导入历史。";
export const CLAUDE_DETECTED_GUIDANCE = "检测到 Claude Code 本地历史，可选择导入：";
export const CLAUDE_DESKTOP_ONLY_GUIDANCE =
  "Claude 会话导入仅在桌面环境可用（需读取本机 ~/.claude/projects）。";

/** isDesktop 门（H7）+ 扫描结果 → 引导态。 */
export function projectClaudeImportSupport(params: {
  isDesktop: boolean | undefined;
  candidates?: readonly ZCodeImportableSessionCandidate[] | null;
  scanError?: string | null;
}): ClaudeImportSupport {
  if (!params.isDesktop) {
    return {
      supported: false,
      reason: "desktopOnly",
      detected: false,
      scanned: false,
      scanError: null,
      guidance: CLAUDE_DESKTOP_ONLY_GUIDANCE,
    };
  }
  if (params.scanError) {
    return {
      supported: true,
      reason: null,
      detected: false,
      scanned: true,
      scanError: params.scanError,
      guidance: `扫描 ~/.claude/projects 失败：${params.scanError}`,
    };
  }
  const candidates = params.candidates ?? null;
  const detected = candidates !== null && candidates.length > 0;
  return {
    supported: true,
    reason: null,
    detected,
    scanned: candidates !== null,
    scanError: null,
    guidance: detected
      ? CLAUDE_DETECTED_GUIDANCE
      : candidates !== null
        ? CLAUDE_NOT_DETECTED_GUIDANCE
        : "",
  };
}

/** 候选 → 展示行（updatedAt 1-based 可读；标题缺省回退 sessionId）。 */
export function formatCandidateRows(
  candidates: readonly ZCodeImportableSessionCandidate[],
): ClaudeCandidateRow[] {
  return [...candidates]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((candidate) => ({
      sessionId: candidate.sessionId,
      title: candidate.previewTitle?.trim() || candidate.sessionId,
      workspacePath: candidate.workspacePath,
      sourcePath: candidate.sourcePath,
      updatedAtLabel: new Date(candidate.updatedAt).toLocaleString(),
    }));
}

/** 导入请求（选中项 → importClaudeSessions 入参；workspaceIdentity 缺省不传）。 */
export function buildImportRequest(params: {
  sessionIds: readonly string[];
  workspacePath?: string | null;
}): { sessionIds: string[]; workspacePath?: string } {
  const request: { sessionIds: string[]; workspacePath?: string } = {
    sessionIds: [...params.sessionIds],
  };
  if (params.workspacePath) request.workspacePath = params.workspacePath;
  return request;
}

export interface ClaudeImportOutcome {
  /** 导入成功的新会话（P1-12.2：完成后打开新会话——首个即打开目标）。 */
  importedSessionIds: string[];
  /** 打开目标（导入成功的第一条；null = 无）。 */
  openSessionId: string | null;
  /** 可读汇总（P1-12.3：失败/跳过原因直接呈现）。 */
  summary: string;
  /** 可读错误行（failed + skipped）。 */
  issues: string[];
}

/** 导入结果 → 汇总与打开目标（原文件不删除由 services 承诺，本层不触碰磁盘）。 */
export function mapImportResult(result: ZCodeImportSessionsResult | null): ClaudeImportOutcome {
  if (!result) {
    return { importedSessionIds: [], openSessionId: null, summary: "", issues: [] };
  }
  const importedSessionIds = result.imported.map((item) => item.sessionId);
  const issues: string[] = [];
  for (const failed of result.failed) {
    issues.push(`导入失败 ${failed.sessionId}：${failed.reason}`);
  }
  for (const skipped of result.skipped) {
    issues.push(`已跳过 ${skipped.sessionId}：${skipped.reason}`);
  }
  const summaryParts: string[] = [];
  if (result.imported.length > 0) summaryParts.push(`成功导入 ${result.imported.length} 个会话`);
  if (result.skipped.length > 0) summaryParts.push(`跳过 ${result.skipped.length} 个`);
  if (result.failed.length > 0) summaryParts.push(`失败 ${result.failed.length} 个`);
  return {
    importedSessionIds,
    openSessionId: importedSessionIds[0] ?? null,
    summary: summaryParts.join("；"),
    issues,
  };
}
