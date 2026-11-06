/**
 * Host 命令注册（T09 host 半；架构 §命令面）。
 *
 * contributes.commands 全量 31 条中的 14 条宿主命令 id（本文件子集；全量按注册来源的
 * 分布见 src/CONTRACT.md 命令面条目）在 container.registerCommands 集中注册，
 * 实现体归本文件：
 * - 组1 登记的面板/设置命令 → open-panel host 帧（组3/4 消费）或设置 UI；
 * - zcodium.sendDiagnostics → 当前文件 languages.getDiagnostics 两档（仅错误/错误+警告）→
 *   pushHostFrame("diagnostics")（载荷形状见 src/host/hostFrameKinds.ts）；
 * - zcodium.switchWorkspace → 多根 QuickPick（T06 host 半，经 SessionsIndexBridge）；
 * - zcodium.onboarding → welcomePage 3 步上手卡（P1-10.2 随时可看入口）。
 *
 * 本文件在 vscode 层（import vscode），vitest 不直测；可测的纯逻辑
 * （诊断两档过滤/载荷形状）在 src/host/hostFrameKinds.ts。
 */

import { commands, languages, window, type Uri } from "vscode";
import type { IZCodeAgentService } from "@zcode/services";
import type { HostFrameKind } from "../bridge/wire";
import {
  buildDiagnosticsFramePayload,
  type DiagnosticsSourceEntry,
  type DiagnosticsHostFramePayload,
  type OpenPanelHostFramePayload,
  type WorkspaceHostFramePayload,
} from "../host/hostFrameKinds";
import type { SessionsIndexBridge } from "../host/sessionsIndexBridge";

/** 命令实现依赖（container 注入；结构化最小面）。 */
export interface HostCommandDeps {
  chatPanel: { reveal(): void };
  hostRuntime: { pushHostFrame(kind: HostFrameKind, payload: unknown): void };
  diagnostics: { show(): void; log(message: string): void };
  sessionsIndex: Pick<SessionsIndexBridge, "pickWorkspaceFolder">;
  agentService: Pick<IZCodeAgentService, "disposeAll">;
  /** 3 步上手卡（P1-10.2；container 注入 welcomePage.presentOnboarding，CLI 实况由容器闭包读取）。 */
  presentOnboarding: () => Promise<void>;
}

/** languages.getDiagnostics() → 帧载荷原始条目；限定当前编辑器文件（P1-5.1）。 */
function toDiagnosticsEntries(activeFile: Uri | undefined): DiagnosticsSourceEntry[] {
  const entries: DiagnosticsSourceEntry[] = [];
  for (const [uri, diagnostics] of languages.getDiagnostics()) {
    // P1-5.1：只收集 Problems 面板当前文件的条目（无活动编辑器时为空集）。
    if (activeFile && uri.fsPath !== activeFile.fsPath) continue;
    for (const diagnostic of diagnostics) {
      entries.push({
        path: uri.fsPath,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
        startLine: diagnostic.range.start.line,
        startCharacter: diagnostic.range.start.character,
      });
    }
  }
  return entries;
}

/** 组4 消费的 open-panel 帧（面板打开指令）。 */
function pushOpenPanel(deps: HostCommandDeps, panel: string): void {
  const payload: OpenPanelHostFramePayload = { panel };
  deps.hostRuntime.pushHostFrame("open-panel", payload);
}

/** T09 host 半：两档 QuickPick → getDiagnostics（当前文件）→ diagnostics 帧（取消不发帧）。 */
export async function sendDiagnosticsCommand(deps: HostCommandDeps): Promise<void> {
  const tier = await window.showQuickPick(
    [
      { tier: "errors" as const, label: "仅错误", detail: "只下发当前文件 Error 级诊断" },
      {
        tier: "all" as const,
        label: "错误+警告",
        detail: "下发当前文件 Error/Warning 级诊断",
      },
    ],
    { placeHolder: "ZCodium：发送诊断信息（当前文件，两档）" },
  );
  if (!tier) return; // 用户取消：不发帧、不提示
  const payload: DiagnosticsHostFramePayload = buildDiagnosticsFramePayload(
    tier.tier,
    toDiagnosticsEntries(window.activeTextEditor?.document.uri),
  );
  deps.diagnostics.log(
    `[diagnostics] 下发 ${payload.tier} 档诊断：${payload.items.length} 条（errors=${payload.errorCount}）`,
  );
  deps.hostRuntime.pushHostFrame("diagnostics", payload);
  deps.chatPanel.reveal();
}

/**
 * 命令注册（container.registerCommands 委托）：本文件注册 14 条宿主命令（id 与
 * package.json contributes 的宿主子集一致）。全量 31 条按注册来源分布（hostCommands
 * 14 + editorCommands 16 + container 直注 openFullUi 1）见 src/CONTRACT.md 命令面条目；
 * 勿再宣称「与 contributes 一字不差」——那曾造成 14↔31 的契约漂移（2026-11-06 修正）。
 */
export function registerHostCommands(deps: HostCommandDeps): void {
  void commands.registerCommand("zcodium.openChat", () => deps.chatPanel.reveal());
  void commands.registerCommand("zcodium.onboarding", () => deps.presentOnboarding());
  void commands.registerCommand("zcodium.showLogs", () => deps.diagnostics.show());
  void commands.registerCommand("zcodium.restartAgent", () => {
    // Agent 进程生命周期归 @zcode/services 进程管理；命令面释放全部 workspace 运行时，
    // 下次对话自动重新拉起（崩溃重建编排的对手面）。
    deps.agentService.disposeAll();
  });
  void commands.registerCommand("zcodium.newSession", () => {
    // 新会话 = webview 侧回到草稿态（V4WorkspaceChatArea draft）；会话数据保留在会话库。
    const payload: WorkspaceHostFramePayload = { kind: "new-session" };
    deps.hostRuntime.pushHostFrame("workspace", payload);
    deps.chatPanel.reveal();
  });
  void commands.registerCommand("zcodium.checkBundleSize", () => {
    void window.showInformationMessage("体积门禁在构建脚本中执行：pnpm --filter zcode-vscode size");
  });
  // ── 组1 登记命令的 host 半（T06/T09） ──
  void commands.registerCommand("zcodium.switchWorkspace", async () => {
    const picked = await deps.sessionsIndex.pickWorkspaceFolder();
    if (picked === null) return; // 取消/无 folder：不发帧
    deps.diagnostics.log(`[workspace] 聚焦 folder：${picked}`);
    const payload: WorkspaceHostFramePayload = { kind: "workspace-focused", folder: picked };
    deps.hostRuntime.pushHostFrame("workspace", payload);
    deps.chatPanel.reveal();
  });
  void commands.registerCommand("zcodium.sendDiagnostics", () => {
    void sendDiagnosticsCommand(deps);
  });
  void commands.registerCommand("zcodium.openMcpSettings", () => {
    // MCP 写回仅落 settings（PRD 降级口径：改动后需重建会话生效），入口直达设置面。
    void commands.executeCommand("workbench.action.openSettings", "zcodium.mcp.servers");
  });
  void commands.registerCommand("zcodium.openInstructions", () => pushOpenPanel(deps, "instructions"));
  void commands.registerCommand("zcodium.openSessionParams", () => pushOpenPanel(deps, "session-params"));
  void commands.registerCommand("zcodium.importClaudeSessions", () =>
    pushOpenPanel(deps, "import-claude-sessions"),
  );
  void commands.registerCommand("zcodium.showSubagents", () => pushOpenPanel(deps, "subagents"));
  void commands.registerCommand("zcodium.openUsage", () => pushOpenPanel(deps, "usage"));
}
