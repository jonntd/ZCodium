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
import { Uri, ViewColumn, window } from "vscode";
import type { HostRuntime } from "../host/hostRuntime";
import {
  composeEditorTabTitle,
  parseEditorTabUiPayload,
} from "../host/hostFrameKinds";
import { buildChatWebviewHtml } from "./chatPanel";
import { log } from "../features/logger";

/** createWebviewPanel 的 viewType（与侧栏 CHAT_VIEW_ID 区分，避免视图注册冲突）。 */
export const CHAT_EDITOR_VIEW_TYPE = "gode.chatEditor";
/** 该 webview 在 HostRuntime 里的独立连接 id。 */
export const CHAT_EDITOR_BRIDGE_ID = "gode.chat.editor";
/** 编辑器标签标题（真机测试按此断言标签是否创建）。 */
export const CHAT_EDITOR_TITLE = "Gode 对话";
/** 对话页签上限：每个页签是完整 webview 实例（bundle + 高亮引擎），无上限会拖垮宿主。 */
export const MAX_CHAT_EDITOR_TABS = 4;

/**
 * **本模块不再执行任何布局命令**（收栏兜底已删除，2026-11-08）。
 *
 * 历史：为对抗 Antigravity「agent webview 获焦时自动展开辅助侧栏」，这里挂过一轮
 * 延迟多点 `closeAuxiliaryBar`（曾经还捎带 `closeSidebar`，误关了用户的资源管理器）。
 * 但它有致命副作用——**我们的对话 WebviewPanel 就承载在辅助栏里**：关辅助栏 = 销毁
 * 自己的面板 → `onDidDispose` 把 panel 从存活表摘掉 → 下一次点「新建会话（+）」找不到
 * 已有页签，只好 `create()` 一个新的 → 用户看到「点一下就多出一个 Gode 对话标签」。
 *
 * 日志实证（~/.antigravity-ide 的 Gode 输出通道）：
 *   13:10:37.391 webview 断开：gode.chat.editor   ← 收栏把面板关掉
 *   13:10:41.984 webview 已连接：gode.chat.editor.2  ← 再点一次只能重建
 *   13:10:47.899 webview 已连接：gode.chat.editor.3
 * 而收栏被跳过（侧栏对话可见）的会话里，一次都没有新建出第二个页签。
 *
 * 现在「IDE 自动展开 agent 侧栏」由内核补丁兜住（scripts/disable-ide-agent-sidebar.mjs，
 * 运行期 openPanel + 启动布局双根断，deploy.sh 幂等重打），本模块无需也不该碰布局。
 */

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
  /**
   * 最近**真正获得焦点**的页签（`onDidChangeViewState.active`）。
   *
   * 为什么需要它：`panel.visible` 只说明"该页签在其编辑器组里可见"，而并排布局下
   * **多个组同时可见**——只按 `visible` 取第一个（Map 插入序 = 最早创建）会把
   * 「当前页」判成"最旧的那页"。多页签投递就此错位：点 + 把别的页拉回草稿，
   * 眼前页毫无反应（与"投错页"是同一类缺陷）。
   */
  private focusedId: string | null = null;

  constructor(
    private readonly extensionUri: Uri,
    private readonly hostRuntime: HostRuntime,
    /** per-folder 最近会话解析（与侧栏同一注入源）。 */
    private readonly resolveInitialSessionId: (folder: string) => string | null = () => null,
  ) {}

  /**
   * 唯一的「当前页」判定（reveal 聚焦目标 与 activeConnectionId 投递目标共用）。
   *
   * 历史缺陷：这套规则曾在 reveal() 与 activeConnectionId() 里各抄一份，任何一侧
   * 改动都会让"投递目标"和"实际聚焦"错位——点「新建会话」时帧投给 A 页、
   * 焦点却落在 B 页，表现为"点了没反应/另一页被清空"。
   *
   * 优先级：最近获得焦点且可见 → 任一可见（插入序）→ 最近创建。
   */
  private resolveTargetPanel(): { id: string; panel: WebviewPanel } | null {
    const focused = this.focusedId ? this.panels.get(this.focusedId) : undefined;
    if (focused?.visible && this.focusedId) return { id: this.focusedId, panel: focused };
    const visible = [...this.panels.entries()].find(([, panel]) => panel.visible);
    if (visible) return { id: visible[0], panel: visible[1] };
    const last = this.lastId ? this.panels.get(this.lastId) : undefined;
    return last && this.lastId ? { id: this.lastId, panel: last } : null;
  }

  /**
   * 已有页签则聚焦「用户正看着的那个」（最近获得焦点 → visible → 最近创建）；
   * 全部关闭才新建。
   */
  reveal(): ChatEditorOpenResult {
    const target = this.resolveTargetPanel();
    if (!target) return this.create("resume", "reveal:无存活页签");
    // 已可见的面板不做冗余 focus（editor/title 的 + 按钮 when 门控保证点击时面板已
    // 激活），冗余 focus 会触发 IDE agent 侧栏联动「点新建会话侧栏被打开」。
    if (!target.panel.visible) target.panel.reveal(undefined, true);
    return {
      created: false,
      viewType: CHAT_EDITOR_VIEW_TYPE,
      title: CHAT_EDITOR_TITLE,
      ...(target.panel.viewColumn === undefined ? {} : { viewColumn: target.panel.viewColumn }),
    };
  }

  /**
   * 定向投递目标：与 `reveal()` **同一块面板**（同一个判定函数，不可能漂移）。
   * 命令侧拿到连接 id 后把 UI 帧只投给「这一页」，避免多页签下把另一页拉回草稿。
   * **不创建页签**：无存活页签时返回 null（调用方自行决定是否打开）。
   */
  activeConnectionId(): string | null {
    return this.resolveTargetPanel()?.id ?? null;
  }

  /**
   * 总是新建一个对话页签（状态栏「新建页签」按钮）：多页签并存，**新页签从草稿态
   * 开始**（Claude 同款：新标签 = 新对话；已有会话经共享标签栏切换）。
   * 达到上限时退化为聚焦已有页签——每个页签是完整 webview 实例，无限创建会拖垮宿主。
   * 退化时给一次状态栏提示：否则"点了没反应"会被当成按钮坏了（静默失败）。
   */
  openNew(): ChatEditorOpenResult {
    if (this.panels.size >= MAX_CHAT_EDITOR_TABS) {
      log.info("layout", `新建页签已达上限 ${MAX_CHAT_EDITOR_TABS}：退化为聚焦现有页签`);
      window.setStatusBarMessage?.(
        `对话页签已达上限（${MAX_CHAT_EDITOR_TABS} 个）：已切换到现有页签`,
        3_000,
      );
      return this.reveal();
    }
    return this.create("draft", "openNew:状态栏新建页签");
  }

  /**
   * 编辑器形态的连接 id 判定：基础 id，或基础 id + 「.」+ 纯数字序号。
   * 不用裸 `startsWith`——那会把将来任何 `gode.chat.editor-xxx` 之类的连接也当页签
   * （改标题静默失败，且极难排查）。
   */
  private isEditorBridgeId(connectionId: string): boolean {
    if (connectionId === CHAT_EDITOR_BRIDGE_ID) return true;
    const prefix = `${CHAT_EDITOR_BRIDGE_ID}.`;
    if (!connectionId.startsWith(prefix)) return false;
    return /^\d+$/.test(connectionId.slice(prefix.length));
  }

  private create(
    mode: "resume" | "draft" = "resume",
    reason = "unknown",
  ): ChatEditorOpenResult {
    this.seq += 1;
    const bridgeId =
      this.seq === 1 ? CHAT_EDITOR_BRIDGE_ID : `${CHAT_EDITOR_BRIDGE_ID}.${this.seq}`;
    // 诊断锚点：新建页签是「用户可见的副作用」，必须能复盘是谁、为什么建的
    // （历史 bug：收栏把自己面板关掉 → 下一次点击被迫重建，见文件头注释）。
    log.info(
      "layout",
      `新建对话页签：${bridgeId}（reason=${reason}，存活=${this.panels.size}）`,
    );
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
    // 新页签一定是用户当前的操作面（createWebviewPanel 会激活它）；focusedId 同步置位，
    // 免得"点 + 之后立刻再点 +"因为 viewState 事件尚未到达而选中旧页。
    this.focusedId = bridgeId;
    panel.iconPath = Uri.joinPath(this.extensionUri, "media", "gode.svg");
    // draft 模式 bootstrap 回草稿态（不继承最近会话）；resume 模式与侧栏同源。
    const resolveSessionId =
      mode === "draft" ? () => null : this.resolveInitialSessionId;
    panel.webview.html = buildChatWebviewHtml(
      panel.webview,
      this.extensionUri,
      resolveSessionId,
    );
    // 这里**不做任何布局动作**（收栏兜底已删除，见文件头）：把消息交给桥层即可。
    panel.webview.onDidReceiveMessage((message: unknown) => {
      this.hostRuntime.handleWebviewMessage(bridgeId, message);
    });
    // 焦点跟随（只记录状态，不发任何命令）：并排布局下多个页签同时 visible，
    // 必须靠"谁真正 active"来回答「用户眼前是哪一页」。
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (!webviewPanel.active) return;
      this.focusedId = bridgeId;
      this.lastId = bridgeId;
    });
    this.hostRuntime.attachWebview(bridgeId, panel.webview);
    panel.onDidDispose(() => {
      this.hostRuntime.detachWebview(bridgeId);
      this.panels.delete(bridgeId);
      if (this.lastId === bridgeId) {
        const remaining = [...this.panels.keys()];
        this.lastId = remaining.length > 0 ? remaining[remaining.length - 1]! : null;
      }
      if (this.focusedId === bridgeId) {
        this.focusedId = this.panels.has(this.lastId ?? "") ? this.lastId : null;
      }
      // 先删再打印：用 size - 1 推算，在重复 dispose / 已被清空的竞态下会打出 -1，
      // 诊断锚点反而误导排查。
      log.info("layout", `对话页签已销毁：${bridgeId}（存活=${this.panels.size}）`);
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
   * 仅消费编辑器形态连接；侧栏连接（`gode.chat`）静默忽略。
   * 宿主在 webview 重载后仍持有 Map 项；连接不存在时静默丢弃（竞态不崩）。
   */
  handleEditorTabUi(connectionId: string, payload: unknown): void {
    if (!this.isEditorBridgeId(connectionId)) return;
    const parsed = parseEditorTabUiPayload(payload);
    if (parsed === null) return;
    const panel = this.panels.get(connectionId);
    if (!panel) return;
    panel.title = composeEditorTabTitle(CHAT_EDITOR_TITLE, parsed);
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.lastId = null;
    this.focusedId = null;
  }
}
