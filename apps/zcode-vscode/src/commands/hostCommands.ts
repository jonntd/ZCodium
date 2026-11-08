/**
 * Host 命令注册（T09 host 半；架构 §命令面）。
 *
 * contributes.commands 全量 31 条中的 14 条宿主命令 id（本文件子集；全量按注册来源的
 * 分布见 src/CONTRACT.md 命令面条目）在 container.registerCommands 集中注册，
 * 实现体归本文件：
 * - 组1 登记的面板/设置命令 → open-panel host 帧（组3/4 消费）或设置 UI；
 * - code.sendDiagnostics → 当前文件 languages.getDiagnostics 两档（仅错误/错误+警告）→
 *   pushHostFrame("diagnostics")（载荷形状见 src/host/hostFrameKinds.ts）；
 * - code.switchWorkspace → 多根 QuickPick（T06 host 半，经 SessionsIndexBridge）；
 * - code.onboarding → welcomePage 3 步上手卡（P1-10.2 随时可看入口）。
 *
 * 本文件在 vscode 层（import vscode），vitest 不直测；可测的纯逻辑
 * （诊断两档过滤/载荷形状）在 src/host/hostFrameKinds.ts。
 */

import { commands, languages, window, type Disposable, type Uri } from "vscode";
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
import { toggleChatFullscreenLayout } from "../features/chatFullscreen";
import { resolveNewSessionTarget } from "../features/newSessionTarget";
import { CHAT_VIEW_ID } from "../ui/chatPanel";
import { log } from "../features/logger";

/** 侧栏对话视图标题（仅用于命令返回值；真实标题由 package.json 的 views 声明）。 */
const SIDEBAR_CHAT_TITLE = "Gode 对话";

/** 命令实现依赖（container 注入；结构化最小面）。 */
export interface HostCommandDeps {
  /** 编辑器标签页形态（可拖动/拆分/移动）；「打开对话」默认形态。 */
  chatEditorPanel: {
    reveal(): {
      created: boolean;
      viewType: string;
      title: string;
      viewColumn?: number;
    };
    /**
     * 总是新建一个对话页签（状态栏「新建页签」按钮 / 无存活页签时的「新建会话」）；
     * 多页签并存、内容同显。`reason` 只进诊断日志（区分是哪个入口建的页）。
     */
    openNew(reason?: string): {
      created: boolean;
      viewType: string;
      title: string;
      viewColumn?: number;
    };
    /**
     * 「新建会话」的定向投递目标：reveal() 会选中的同一块面板的连接 id
     * （两者共用同一判定函数，不会漂移）。无存活页签时 null。
     */
    activeConnectionId(): string | null;
  };
  hostRuntime: {
    pushHostFrame(kind: HostFrameKind, payload: unknown): void;
    /** UI 定向帧（open-panel/diagnostics）：只投给最近活动的对话页，不广播。 */
    pushToActiveHostFrame(kind: HostFrameKind, payload: unknown): void;
    /**
     * 定向帧（指定连接）：只投给这一页；目标不存在则丢弃，未就绪则排到该连接队列。
     * 返回 false 表示目标连接不存在（帧被丢弃），调用方可据此提示而不是假装成功。
     */
    pushHostFrameTo(
      connectionId: string | null,
      kind: HostFrameKind,
      payload: unknown,
    ): boolean;
    /** 该连接是否在线（判断"某一面在不在"，不发帧）。 */
    hasConnection(connectionId: string): boolean;
  };
  diagnostics: { show(): void; log(message: string): void };
  sessionsIndex: Pick<SessionsIndexBridge, "pickWorkspaceFolder">;
  agentService: Pick<IZCodeAgentService, "disposeAll">;
  /** 3 步上手卡（P1-10.2；container 注入 welcomePage.presentOnboarding，CLI 实况由容器闭包读取）。 */
  presentOnboarding: () => Promise<void>;
  /**
   * 首次打开对话的一次性钩子（容器注入：globalState 标记 + 自动呈现上手卡）。
   * openChat/openChatInEditor/newChatTab/newSession 四个入口统一调用；缺省不呈现。
   */
  firstOpen?: () => void;
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

/** 组4 消费的 open-panel 帧（面板打开指令）：定向到最近活动页，不广播。 */
function pushOpenPanel(deps: HostCommandDeps, panel: string): void {
  const payload: OpenPanelHostFramePayload = { panel };
  deps.hostRuntime.pushToActiveHostFrame("open-panel", payload);
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
    { placeHolder: "Gode：发送诊断信息（当前文件，两档）" },
  );
  if (!tier) return; // 用户取消：不发帧、不提示
  const payload: DiagnosticsHostFramePayload = buildDiagnosticsFramePayload(
    tier.tier,
    toDiagnosticsEntries(window.activeTextEditor?.document.uri),
  );
  deps.diagnostics.log(
    `[diagnostics] 下发 ${payload.tier} 档诊断：${payload.items.length} 条（errors=${payload.errorCount}）`,
  );
  // 诊断面是 UI 定向内容：只投给最近活动的对话页，避免另一页同步弹出诊断。
  deps.hostRuntime.pushToActiveHostFrame("diagnostics", payload);
  deps.chatEditorPanel.reveal();
}

/**
 * 命令注册（container.registerCommands 委托）：本文件注册 14 条宿主命令（id 与
 * package.json contributes 的宿主子集一致）。全量 31 条按注册来源分布（hostCommands
 * 14 + editorCommands 16 + container 直注 openFullUi 1）见 src/CONTRACT.md 命令面条目；
 * 勿再宣称「与 contributes 一字不差」——那曾造成 14↔31 的契约漂移（2026-11-06 修正）。
 * 返回全部注册 Disposable（增量审查 X7：调用方入 context.subscriptions，
 * 对齐 VS Code 扩展官方订阅生命周期口径）。
 */
export function registerHostCommands(deps: HostCommandDeps): Disposable[] {
  const disposables: Disposable[] = [];
  // 「打开对话」默认即编辑器标签页形态（与 Claude Code tab 同款：IDE 管理标签，
  // 可随意拖动 / 拆分 / 移动到新窗口）；侧栏视图保留为可选形态（gode.chat 仍注册）。
  // 返回面板状态（真机冒烟按此断言标签创建）。一次性上手卡钩子在 reveal **之后**：
  // presentOnboarding 内部同步 revealChat，若先行会把首开 created 置 false。
  const openChat = () => {
    const result = deps.chatEditorPanel.reveal();
    deps.firstOpen?.();
    return result;
  };
  disposables.push(commands.registerCommand("gode.openChat", openChat));
  // 别名入口（view/title navigation@3）：与 openChat 同一目标。
  disposables.push(commands.registerCommand("gode.openChatInEditor", openChat));
  // 状态栏「新建页签」：总是创建一个新的对话编辑器标签（多页签并存，内容同显）。
  disposables.push(
    commands.registerCommand("gode.newChatTab", () => {
      const result = deps.chatEditorPanel.openNew();
      deps.firstOpen?.();
      return result;
    }),
  );
  // 全屏切换（editor/title navigation@3 ⤢）：让对话所在编辑器组吃满编辑器区域宽度，
  // 再点一次恢复均分。**不隐藏资源管理器、不关闭/隐藏任何已打开的标签**——语义与
  // 具体取舍见 features/chatFullscreen.ts 文件头（原生「最大化编辑器组」单组时是
  // no-op、多组时会把其它组整体隐藏，两条都不符合用户诉求）。
  // **when 仍带 `!editorPartMaximizedEditorGroup`**：IDE 内核
  // workbench.action.toggleMaximizeEditorGroup 自带 editor/title 按钮（order -1e4、
  // icon screen-full、when editorPartMaximizedEditorGroup、带 toggled 高亮）；用户若
  // 从命令面板/快捷键进了原生最大化态，我们的按钮让位，避免两个同款 $(screen-full) 并排。
  // （锁定编辑器组同理不放自定义按钮：IDE 原生锁定 UI 更完整——tab 右键「锁定组」
  // + 锁定后标签行右侧原生锁指示器点击即解锁；自定义按钮会与原生指示器重复显示。）
  disposables.push(
    commands.registerCommand("gode.toggleChatFullscreen", async () => {
      const result = await toggleChatFullscreenLayout({
        editorGroupCount: () => window.tabGroups.all.length,
        executeCommand: (command) => commands.executeCommand(command),
        notifyAlreadyFull: () => {
          window.setStatusBarMessage(
            "对话已占满编辑器区域（当前只有 1 个编辑器组）：不会隐藏资源管理器，也不会关闭已打开的标签",
            4_000,
          );
        },
        notifyUnsupported: () => {
          window.setStatusBarMessage(
            "当前 IDE 不支持编辑器组宽度切换（workbench.action.toggleEditorWidths）",
            4_000,
          );
        },
      });
      log.info(
        "layout",
        `对话全屏切换：编辑器组=${result.groups}，重排=${result.acted ? "展开↔均分" : "跳过（单组）"}`,
      );
      return result;
    }),
  );
  disposables.push(commands.registerCommand("gode.onboarding", () => deps.presentOnboarding()));
  disposables.push(commands.registerCommand("gode.showLogs", () => deps.diagnostics.show()));
  disposables.push(
    commands.registerCommand("gode.restartAgent", () => {
      // Agent 进程生命周期归 @zcode/services 进程管理；命令面释放全部 workspace 运行时，
      // 下次对话自动重新拉起（崩溃重建编排的对手面）。
      deps.agentService.disposeAll();
    }),
  );
  // 「新建会话（+）」：让**眼前这一面**回到草稿态（V4WorkspaceChatArea draft；会话数据
  // 保留在会话库），**绝不新开编辑器页签**——那条路走 openNew（状态栏「新建页签」）。
  //
  // 历史缺陷（2026-11-08 用户反馈「我点加号为什么会创建出一个 TAB 窗口」）：侧栏
  // 标题栏的 +（view/title）与标签行的 +（editor/title）绑定同一条命令，而这条命令
  // 只认编辑器页签 → 在侧栏点 + 时要么把编辑器页签清成草稿（点错面），要么（没有
  // 编辑器页签）直接 reveal 出一个新 TAB。目标面判定见 features/newSessionTarget.ts。
  disposables.push(
    commands.registerCommand("gode.newSession", () => {
      const target = resolveNewSessionTarget({
        editorConnectionId: deps.chatEditorPanel.activeConnectionId(),
        sidebarOnline: deps.hostRuntime.hasConnection(CHAT_VIEW_ID),
        sidebarConnectionId: CHAT_VIEW_ID,
      });
      const payload: WorkspaceHostFramePayload = { kind: "new-session" };
      if (target.surface === "editor") {
        // reveal 只是聚焦（有存活页签时不会 create），投递目标 = 同一块面板。
        const result = deps.chatEditorPanel.reveal();
        deps.hostRuntime.pushHostFrameTo(target.connectionId, "workspace", payload);
        deps.firstOpen?.();
        return result;
      }
      if (target.surface === "sidebar") {
        // 只剩侧栏一面：在侧栏里新开对话。定向投递（不广播）——编辑器页签此时不存在，
        // 但广播会把"回草稿"同时推给任何别的连接。
        deps.hostRuntime.pushHostFrameTo(target.connectionId, "workspace", payload);
        deps.firstOpen?.();
        return {
          created: false,
          viewType: CHAT_VIEW_ID,
          title: SIDEBAR_CHAT_TITLE,
        };
      }
      // 一个对话面都没有（首次使用 / 页签被关光）：才建草稿页签。**不要**先 reveal()
      // ——reveal 走 resume 模式，会按 per-folder 最近会话建页再被清空，用户会看到
      // "点 + 先闪出上次的对话再变空"。
      const created = deps.chatEditorPanel.openNew("newSession:无任何对话面，建草稿页");
      deps.firstOpen?.();
      return created;
    }),
  );
  // 侧栏标题栏的 +（view/title）：**只**作用于侧栏这一页。
  // 与 gode.newSession 分开是有意的——菜单命令拿不到"从哪儿点的"，两者若共用一条实现，
  // 必然有一面被错误对待（有编辑器页签时侧栏点 + 会去清编辑器，反之则新开 TAB）。
  disposables.push(
    commands.registerCommand("gode.newSidebarSession", () => {
      const delivered = deps.hostRuntime.pushHostFrameTo(CHAT_VIEW_ID, "workspace", {
        kind: "new-session",
      } satisfies WorkspaceHostFramePayload);
      if (!delivered) {
        // 侧栏 webview 尚未挂桥（视图刚展开 / 正在重建）：明确告知，不假装成功。
        window.setStatusBarMessage("侧栏对话尚未就绪，请稍后再试", 3_000);
      }
    }),
  );
  disposables.push(
    commands.registerCommand("gode.checkBundleSize", () => {
      void window.showInformationMessage("体积门禁在构建脚本中执行：pnpm --filter zcode-vscode size");
    }),
  );
  // ── 组1 登记命令的 host 半（T06/T09） ──
  disposables.push(
    commands.registerCommand("gode.switchWorkspace", async () => {
      const picked = await deps.sessionsIndex.pickWorkspaceFolder();
      if (picked === null) return; // 取消/无 folder：不发帧
      deps.diagnostics.log(`[workspace] 聚焦 folder：${picked}`);
      const payload: WorkspaceHostFramePayload = { kind: "workspace-focused", folder: picked };
      deps.hostRuntime.pushHostFrame("workspace", payload);
      deps.chatEditorPanel.reveal();
    }),
  );
  disposables.push(
    commands.registerCommand("gode.sendDiagnostics", () => {
      void sendDiagnosticsCommand(deps);
    }),
  );
  disposables.push(
    commands.registerCommand("gode.openMcpSettings", () => {
      // MCP 写回仅落 settings（PRD 降级口径：改动后需重建会话生效），入口直达设置面。
      void commands.executeCommand("workbench.action.openSettings", "gode.mcp.servers");
    }),
  );
  disposables.push(commands.registerCommand("gode.openInstructions", () => pushOpenPanel(deps, "instructions")));
  disposables.push(commands.registerCommand("gode.openSessionParams", () => pushOpenPanel(deps, "session-params")));
  disposables.push(
    commands.registerCommand("gode.importClaudeSessions", () =>
      pushOpenPanel(deps, "import-claude-sessions"),
    ),
  );
  disposables.push(commands.registerCommand("gode.showSubagents", () => pushOpenPanel(deps, "subagents")));
  disposables.push(commands.registerCommand("gode.openUsage", () => pushOpenPanel(deps, "usage")));
  return disposables;
}
