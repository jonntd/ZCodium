/**
 * ChatPanel — 侧栏 WebviewViewProvider。
 *
 * 插件原生形态（唯一形态）：侧栏 webview 挂载与桌面/full 形态同源的 `Root`
 * 工作台（packages/ui），服务经 hostRuntime IPC 桥接进程内 ServiceCollection。
 * 编辑器命令经 host 帧直达 composer 预填；会话绑定 IDE 工程；Agent 由插件
 * 进程管理（Claude Code/Augment 同构）。
 * （server/iframe 形态已退役：跨源上下文断裂，见 2026-11-06 缺陷分析。）
 */

import { randomBytes } from "node:crypto";
import type {
  Disposable,
  Webview,
  WebviewView,
  WebviewViewProvider,
} from "vscode";
import { Uri, env, window, workspace } from "vscode";
import type { HostRuntime } from "../host/hostRuntime";
import { log } from "../features/logger";

export const CHAT_VIEW_ID = "gode.chat";

/**
 * 侧栏显隐偏好的宿主持久化读取面（扩展装配时注入 `context.globalState` 读取器）。
 *
 * 为什么要在 host 侧：VS Code 的每个 webview 有独立 origin，`localStorage` **不能**
 * 跨页签/跨重建共享；webview 侧唯一的跨实例通道就是 bootstrap 注入。
 */
let sidebarVisibleSeedProvider: () => boolean | null = () => null;

export function setSidebarVisibleSeedProvider(provider: () => boolean | null): void {
  sidebarVisibleSeedProvider = provider;
}

export class ChatPanel implements WebviewViewProvider {
  public static readonly viewId = CHAT_VIEW_ID;
  private view: WebviewView | null = null;
  /**
   * 本轮 resolve 注册的监听（增量审查 X3）：resolveWebviewView 可能被多次调用
   * （webview 重建/宿主重解析），重复 resolve 先清旧监听——否则 onDidReceiveMessage
   * 叠加，一条 webview 消息会被重复处理（RPC 重复执行、host 帧重复）。
   */
  private resolveSubscriptions: Disposable[] = [];

  constructor(
    private readonly extensionUri: Uri,
    private readonly hostRuntime: HostRuntime,
    /** per-folder 最近会话解析（P1-1.5：bootstrap data-session-id 注入）。 */
    private readonly resolveInitialSessionId: (folder: string) => string | null = () => null,
  ) {}

  resolveWebviewView(view: WebviewView): void {
    // 增量审查 X3：重复 resolve 先清上一轮监听（见 resolveSubscriptions 注释）。
    for (const disposable of this.resolveSubscriptions) disposable.dispose();
    this.resolveSubscriptions = [];
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = buildChatWebviewHtml(
      view.webview,
      this.extensionUri,
      this.resolveInitialSessionId,
    );
    // 帧转发：webview → host。
    this.resolveSubscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        this.hostRuntime.handleWebviewMessage(CHAT_VIEW_ID, message);
      }),
    );
    this.hostRuntime.attachWebview(CHAT_VIEW_ID, view.webview);
    // 可见性**不参与任何决策**（缺陷修复 2026-11-08）：
    // 原「侧栏可见跳板」在视图可见时去 reveal 编辑器标签，而 reveal() 内部会多点
    // 延迟收起侧栏——于是**用户自己点活动栏图标打开的对话面板**被我们自己的收栏
    // 逻辑关掉/连带关掉主侧栏（资源管理器），表现为「弹出个窗口然后秒关」与
    // 「点 gode 按钮后资源管理器/编辑器布局被清掉」。活动栏图标语义就是「打开这个
    // 视图」：视图留下即可，不需要我们做任何事。
    // 收栏兜底早已整体删除（chatEditorPanel.ts 文件头），可见性因此没有任何消费者——
    // 连"状态自证"都不再保留，否则后人会以为可见性还在驱动布局决策。
    this.resolveSubscriptions.push(
      view.onDidDispose(() => {
        for (const disposable of this.resolveSubscriptions) disposable.dispose();
        this.resolveSubscriptions = [];
        this.hostRuntime.detachWebview(CHAT_VIEW_ID);
        this.view = null;
      }),
    );
  }

  /**
   * 显示面板（引导/错误时调用）。
   * 返回是否真的发起了 show：视图从未 resolve（活动栏没打开过 / 已被销毁）时
   * `this.view` 为 null，旧实现静默 no-op，调用方无法感知失败。
   */
  reveal(): boolean {
    if (!this.view) {
      log.warn("chat-panel", "侧栏视图尚未 resolve，reveal() 无效（IDE 不会显示对话视图）");
      return false;
    }
    void this.view.show?.(true);
    return true;
  }
}

/**
 * webview HTML 骨架（侧栏 view 与编辑器标签页共用）：bootstrap 数据 + ESM 入口。
 * 两种形态挂载的是同一份 `Root` 工作台，资源 URI 由各自 webview 的 cspSource 生成。
 */
export function buildChatWebviewHtml(
  webview: Webview,
  extensionUri: Uri,
  resolveInitialSessionId: (folder: string) => string | null,
): string {
  // CSP nonce 用密码学随机（安全审查 S3）：Math.random 可预测，nonce 是 CSP
  // 唯一脚本信凭，不该依赖其不可猜测性。
  const nonce = randomBytes(16).toString("hex");
  const scriptUri = webview.asWebviewUri(
    Uri.joinPath(extensionUri, "dist", "webview", "main.js"),
  );
  // 文件图标素材基址：webview 文档 URL 不是扩展目录，源码侧的 BASE_URL 相对路径
  // 全部落空（每个图标 2 次失败请求后退到内置占位）。素材目录由 esbuild 构建期
  // 拷进 dist/webview/material-icons，这里以 asWebviewUri 注入，CSP img-src
  // cspSource 放行；webview 入口读取后调 setMaterialIconBasePath。
  const materialIconBaseUri = webview.asWebviewUri(
    Uri.joinPath(extensionUri, "dist", "webview", "material-icons"),
  ).toString();
  const styleUri = webview.asWebviewUri(
    Uri.joinPath(extensionUri, "dist", "webview", "styles.css"),
  );
  const folders = (workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const workspacePath = folders[0] ?? "";
  // per-folder 最近会话（P1-1.5 host 半；webview index.tsx 读取 data-session-id）。
  const sessionId = workspacePath ? resolveInitialSessionId(workspacePath) : null;
  // ColorThemeKind: 1 Light / 2 Dark / 3 HighContrast / 4 HighContrastLight。
  const themeKind = window.activeColorTheme.kind;
  const locale = env.language;
  // 侧栏显隐偏好（宿主 globalState 投影）：webview origin 隔离，localStorage 带不过去，
  // 只能由 HTML 骨架注入。空串 = 从未设置过（webview 侧落到"默认收起"）。
  const sidebarVisible = sidebarVisibleSeedProvider();
  const sidebarVisibleAttr =
    sidebarVisible === null ? "" : sidebarVisible ? "1" : "0";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <!-- CSP 硬约束（docs/conversation-share-v1.md 同源教训）：script-src 必须带
       'wasm-unsafe-eval'，否则 shiki 的 oniguruma wasm 无法实例化，@pierre/diffs
       拿不到高亮 token → 聊天面板代码块只剩 header、代码体空白。它只放开 wasm
       编译，eval / new Function 仍被挡。worker-src 放行 blob:（diff worker 池兜底）。
       style-src 必须带 'unsafe-inline'：@pierre/diffs 在 Shadow DOM 里用 innerHTML
       字符串渲染 token，语法高亮颜色、行距、字号全是 style="..." 属性（非 React
       CSSOM），没有 'unsafe-inline' 时浏览器整批拒绝应用 —— 实测 token computed
       color 全部退成继承色（代码块纯白无高亮）且行内布局错乱。这与 VS Code 官方
       webview CSP 模板一致（style-src 本就需要 unsafe-inline），只放开样式，不放开
       script/eval。 -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Gode Agent</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" id="zcode-bootstrap"
    data-workspace-path="${escapeAttr(workspacePath)}"
    data-folders="${escapeAttr(folders.join("\n"))}"
    data-theme-kind="${themeKind}"
    data-locale="${escapeAttr(locale)}"
    data-session-id="${escapeAttr(sessionId ?? "")}"
    data-icon-base="${escapeAttr(materialIconBaseUri)}"
    data-sidebar-visible="${sidebarVisibleAttr}"></script>
  <!-- ESM 入口（esbuild splitting，§7.2 ④懒加载）：chunk 经 cspSource 白名单加载。 -->
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
