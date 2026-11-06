/**
 * ChatPanel — 侧栏 WebviewViewProvider。
 *
 * 插件原生形态（唯一形态）：侧栏 webview 挂载与桌面/full 形态同源的 `Root`
 * 工作台（packages/ui），服务经 hostRuntime IPC 桥接进程内 ServiceCollection。
 * 编辑器命令经 host 帧直达 composer 预填；会话绑定 IDE 工程；Agent 由插件
 * 进程管理（Claude Code/Augment 同构）。
 * （server/iframe 形态已退役：跨源上下文断裂，见 2026-11-06 缺陷分析。）
 */

import type { Webview, WebviewView, WebviewViewProvider } from "vscode";
import { Uri, env, window, workspace } from "vscode";
import type { HostRuntime } from "../host/hostRuntime";

export const CHAT_VIEW_ID = "code.chat";

export class ChatPanel implements WebviewViewProvider {
  public static readonly viewId = CHAT_VIEW_ID;
  private view: WebviewView | null = null;

  constructor(
    private readonly extensionUri: Uri,
    private readonly hostRuntime: HostRuntime,
    /** per-folder 最近会话解析（P1-1.5：bootstrap data-session-id 注入）。 */
    private readonly resolveInitialSessionId: (folder: string) => string | null = () => null,
  ) {}

  resolveWebviewView(view: WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.buildPaneHtml(view.webview);
    // 帧转发：webview → host。
    view.webview.onDidReceiveMessage((message: unknown) => {
      this.hostRuntime.handleWebviewMessage(CHAT_VIEW_ID, message);
    });
    this.hostRuntime.attachWebview(CHAT_VIEW_ID, view.webview);
    // 可见性帧生产（T02⑦）：侧栏面板隐藏/显示 → webview 暂停/恢复渲染面。
    // @types/vscode 1.90 的 onDidChangeVisibility 事件无载荷，读 view.visible 快照。
    view.onDidChangeVisibility(() => {
      this.hostRuntime.pushHostFrame("visibility", { visible: view.visible });
    });
    view.onDidDispose(() => {
      this.hostRuntime.detachWebview(CHAT_VIEW_ID);
      this.view = null;
    });
  }

  /** 显示面板（引导/错误时调用）。 */
  reveal(): void {
    void this.view?.show?.(true);
  }

  private buildPaneHtml(webview: Webview): string {
    const nonce = Array.from({ length: 32 }, () => Math.random().toString(36).slice(2)).join("");
    const scriptUri = webview.asWebviewUri(
      Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      Uri.joinPath(this.extensionUri, "dist", "webview", "styles.css"),
    );
    const folders = (workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const workspacePath = folders[0] ?? "";
    // per-folder 最近会话（P1-1.5 host 半；webview index.tsx 读取 data-session-id）。
    const sessionId = workspacePath
      ? this.resolveInitialSessionId(workspacePath)
      : null;
    // ColorThemeKind: 1 Light / 2 Dark / 3 HighContrast / 4 HighContrastLight。
    const themeKind = window.activeColorTheme.kind;
    const locale = env.language;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
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
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
