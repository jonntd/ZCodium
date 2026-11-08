/**
 * ChatEditorPanel — 可自由拖动的编辑器标签页形态（Claude Code / Augment 同款）。
 *
 * 与侧栏 `ChatPanel`（WebviewViewProvider）并存，挂载同一份 `Root` 工作台和同一套
 * 进程内服务：WebviewPanel 是 VS Code 编辑器标签，天然支持拖动到任意编辑器组、
 * 拆分、移动到新窗口，正好补齐侧栏视图「位置固定」的限制。
 *
 * 消息桥复用 HostRuntime 的多连接面：每个 webview 一个独立 bridge id，
 * pushHostFrame 广播、plat-rsp 按 id 回投，两种形态互不干扰。
 */

import type { WebviewPanel } from "vscode";
import { commands, Uri, ViewColumn, window } from "vscode";
import type { HostRuntime } from "../host/hostRuntime";
import {
  composeEditorTabTitle,
  parseEditorTabUiPayload,
} from "../host/hostFrameKinds";
import { buildChatWebviewHtml } from "./chatPanel";

/** createWebviewPanel 的 viewType（与侧栏 CHAT_VIEW_ID 区分，避免视图注册冲突）。 */
export const CHAT_EDITOR_VIEW_TYPE = "gode.chatEditor";
/** 该 webview 在 HostRuntime 里的独立连接 id。 */
export const CHAT_EDITOR_BRIDGE_ID = "gode.chat.editor";
/** 编辑器标签标题（真机测试按此断言标签是否创建）。 */
export const CHAT_EDITOR_TITLE = "Gode 对话";
/** 对话页签上限：每个页签是完整 webview 实例（bundle + 高亮引擎），无上限会拖垮宿主。 */
export const MAX_CHAT_EDITOR_TABS = 4;

/**
 * 收起主侧栏与辅助侧栏（延迟多点重试）。
 *
 * IDE（Antigravity）在 agent 类 webview 获得焦点/重新聚焦时会**异步自动展开**
 * 承载 Gode 视图的侧栏（布局联动），且展开时点不固定（布局动画/视图恢复后
 * 都可能再展开一次）；立即收会输给第一次自动展开，单次延迟也可能输给更晚的
 * 那次——多点重试幂等收栏（侧栏已关时 setPartHidden 是 no-op，无误伤）。
 * 窗口收窄到 1.5s：IDE 自动展开集中在 webview 激活后的瞬间；再往后的重试只会
 * 误伤用户在打开对话后手动展开的侧栏（无法与自动展开区分，只能限长）。
 */
/**
 * 在途收栏调度（增量审查 X1）：模块级单飞——一轮窗口（1.5s）内重复调用不叠加
 * timer（连续点按钮 N 次原实现会堆 3N 个回调）；保留 id 以便 dispose 取消，
 * 防扩展宿主收尾后回调仍 fire 误伤用户侧栏。
 */
let sidePanelsCollapseTimers: ReturnType<typeof setTimeout>[] = [];

function scheduleSidePanelsCollapse(): void {
  if (sidePanelsCollapseTimers.length > 0) return;
  const delays = [350, 800, 1_500];
  sidePanelsCollapseTimers = delays.map((delay, index) =>
    globalThis.setTimeout(
      () => {
        if (index === delays.length - 1) sidePanelsCollapseTimers = []; // 窗口收口
        closeSidePanels();
      },
      delay,
    ),
  );
}

/** 取消在途收栏调度（ChatEditorPanel.dispose 调用）。 */
export function cancelSidePanelsCollapse(): void {
  for (const timer of sidePanelsCollapseTimers) {
    globalThis.clearTimeout(timer);
  }
  sidePanelsCollapseTimers = [];
}

function closeSidePanels(): void {
  for (const closeCommand of [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.closeSidebar",
  ]) {
    void commands.executeCommand(closeCommand).then(
      undefined,
      () => {}, // 旧版 IDE 无此命令时静默忽略（该栏保留，不影响功能）
    );
  }
}

/** 打开结果（命令返回值；真机自动化据此断言面板确实创建在编辑器里）。 */
export interface ChatEditorOpenResult {
  created: boolean;
  viewType: string;
  title: string;
  viewColumn?: number;
}

export class ChatEditorPanel {
  /** 存活页签表：bridgeId → panel（多页签；桥层按 id 独立连接、广播共享会话内容）。 */
  private readonly panels = new Map<string, WebviewPanel>();
  /** bridge id 序列（首个沿用常量 id，兼容既有契约断言）。 */
  private seq = 0;
  /** 最近创建/聚焦的页签（reveal 的聚焦目标）。 */
  private lastId: string | null = null;

  constructor(
    private readonly extensionUri: Uri,
    private readonly hostRuntime: HostRuntime,
    /** per-folder 最近会话解析（与侧栏同一注入源）。 */
    private readonly resolveInitialSessionId: (folder: string) => string | null = () => null,
  ) {}

  /**
   * 已有页签则聚焦「用户正看着的那个」（visible 优先），都没有才聚焦最近创建的；
   * 全部关闭则新建。随后多点延迟收起被 IDE 自动展开的侧栏。
   */
  reveal(): ChatEditorOpenResult {
    scheduleSidePanelsCollapse();
    // 已可见的面板优先：避免多页签下把焦点从用户正在看的页签抢到 lastId 页签。
    const visible = [...this.panels.values()].find((panel) => panel.visible);
    if (visible) {
      return {
        created: false,
        viewType: CHAT_EDITOR_VIEW_TYPE,
        title: CHAT_EDITOR_TITLE,
        ...(visible.viewColumn === undefined ? {} : { viewColumn: visible.viewColumn }),
      };
    }
    const last = this.lastId ? this.panels.get(this.lastId) : undefined;
    if (last) {
      // 无可见面板（最小化到后台/被覆盖）时才重新聚焦触发一次 focus。
      last.reveal(undefined, true);
      return {
        created: false,
        viewType: CHAT_EDITOR_VIEW_TYPE,
        title: CHAT_EDITOR_TITLE,
        ...(last.viewColumn === undefined ? {} : { viewColumn: last.viewColumn }),
      };
    }
    return this.create();
  }

  /**
   * 总是新建一个对话页签（状态栏「新建页签」按钮）：多页签并存，**新页签从草稿态
   * 开始**（Claude 同款：新标签 = 新对话；已有会话经共享标签栏切换）。
   * 达到上限时退化为聚焦已有页签——每个页签是完整 webview 实例，无限创建会拖垮宿主。
   */
  openNew(): ChatEditorOpenResult {
    scheduleSidePanelsCollapse();
    if (this.panels.size >= MAX_CHAT_EDITOR_TABS) {
      return this.reveal();
    }
    return this.create("draft");
  }

  private create(mode: "resume" | "draft" = "resume"): ChatEditorOpenResult {
    this.seq += 1;
    const bridgeId =
      this.seq === 1 ? CHAT_EDITOR_BRIDGE_ID : `${CHAT_EDITOR_BRIDGE_ID}.${this.seq}`;
    const panel = window.createWebviewPanel(
      CHAT_EDITOR_VIEW_TYPE,
      CHAT_EDITOR_TITLE,
      { viewColumn: ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [Uri.joinPath(this.extensionUri, "dist")],
      },
    );
    this.panels.set(bridgeId, panel);
    this.lastId = bridgeId;
    panel.iconPath = Uri.joinPath(this.extensionUri, "media", "gode.svg");
    // draft 模式 bootstrap 回草稿态（不继承最近会话）；resume 模式与侧栏同源。
    const resolveSessionId =
      mode === "draft" ? () => null : this.resolveInitialSessionId;
    panel.webview.html = buildChatWebviewHtml(
      panel.webview,
      this.extensionUri,
      resolveSessionId,
    );
    panel.webview.onDidReceiveMessage((message: unknown) => {
      this.hostRuntime.handleWebviewMessage(bridgeId, message);
    });
    this.hostRuntime.attachWebview(bridgeId, panel.webview);
    panel.onDidDispose(() => {
      this.hostRuntime.detachWebview(bridgeId);
      this.panels.delete(bridgeId);
      if (this.lastId === bridgeId) {
        const remaining = [...this.panels.keys()];
        this.lastId = remaining.length > 0 ? remaining[remaining.length - 1]! : null;
      }
    });
    return {
      created: true,
      viewType: CHAT_EDITOR_VIEW_TYPE,
      title: CHAT_EDITOR_TITLE,
      ...(panel.viewColumn === undefined ? {} : { viewColumn: panel.viewColumn }),
    };
  }

  /**
   * webview 上行的标签 UI 状态（plat-evt notifyEditorTabUi）→ 回写该连接对应的
   * WebviewPanel 标题：会话标题（首条消息自动截取）+ 忙态前缀（Agent 运行中）。
   * 仅消费编辑器形态连接（bridgeId 前缀匹配）；侧栏连接静默忽略。
   * 宿主在 webview 重载后仍持有 Map 项；连接不存在时静默丢弃（竞态不崩）。
   */
  handleEditorTabUi(connectionId: string, payload: unknown): void {
    if (!connectionId.startsWith(CHAT_EDITOR_BRIDGE_ID)) return;
    const parsed = parseEditorTabUiPayload(payload);
    if (parsed === null) return;
    const panel = this.panels.get(connectionId);
    if (!panel) return;
    panel.title = composeEditorTabTitle(CHAT_EDITOR_TITLE, parsed);
  }

  dispose(): void {
    cancelSidePanelsCollapse();
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.lastId = null;
  }
}
