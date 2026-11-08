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

export const CHAT_VIEW_ID = "gode.chat";

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
    /**
     * 侧栏可见跳板（Claude Code 点击体验）：webview view 无法拖进编辑器标签行，
     * 用户点活动栏图标 → 侧栏可见 → 宿主回调（container）弹出可拖动的编辑器标签。
     */
    private readonly onVisible?: () => void,
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
    // 跳板：resolve 即首次可见；onDidChangeVisibility 覆盖后续每次展开。
    // 注意：visibility 不再经 pushHostFrame 广播——编辑器标签形态并存后，A 页的
    // 可见性帧会广播到 B 页把对方渲染面错误暂停/恢复（跨页状态污染的根源）；
    // 各 webview 的 document.visibilitychange 自证源已足够感知自身可见性。
    if (view.visible) this.onVisible?.();
    this.resolveSubscriptions.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.onVisible?.();
      }),
      view.onDidDispose(() => {
        for (const disposable of this.resolveSubscriptions) disposable.dispose();
        this.resolveSubscriptions = [];
        this.hostRuntime.detachWebview(CHAT_VIEW_ID);
        this.view = null;
      }),
    );
  }

  /** 显示面板（引导/错误时调用）。 */
  reveal(): void {
    void this.view?.show?.(true);
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
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <!-- CSP 硬约束（docs/conversation-share-v1.md 同源教训）：script-src 必须带
       'wasm-unsafe-eval'，否则 shiki 的 oniguruma wasm 无法实例化，@pierre/diffs
       拿不到高亮 token → 聊天面板代码块只剩 header、代码体空白。它只放开 wasm
       编译，eval / new Function 仍被挡。worker-src 放行 blob:（diff worker 池兜底）。 -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
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
    data-session-id="${escapeAttr(sessionId ?? "")}"></script>
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
