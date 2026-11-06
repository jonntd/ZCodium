/**
 * ChatPanel — 侧栏 WebviewViewProvider。
 *
 * 双模式（设置 `zcodium.sidebarUi`，默认 pane）：
 * - **full**（默认）：侧栏直接内嵌完整界面（fullui server 的 packages/web 页面，iframe 承载）
 *   ——用户口径「聊天窗口直接就用完整界面」。server 懒启动（首次面板可见时拉起），
 *   就绪后经 `full-ui-url` host 帧把地址推给 webview 设置 iframe.src。
 * - **pane**：v0.2.0 原 React 装配面（12 层 Provider 栈 + V4ChatPane），保留为回退档。
 *
 * 两种模式共用同一条 host 帧通道与 CSP 纪律：full 模式的 CSP 增加
 * `frame-src http://127.0.0.1:*`（仅本机回环 server），其余面仍为 none。
 */

import type { Webview, WebviewView, WebviewViewProvider } from "vscode";
import { Uri, env, window, workspace } from "vscode";
import type { HostRuntime } from "../host/hostRuntime";
import type { VisibilityHostFramePayload } from "../host/hostFrameKinds";

export const CHAT_VIEW_ID = "zcodium.chat";

export interface ChatPanelFullUiOptions {
  /** 侧栏是否承载完整界面（zcodium.sidebarUi === "full"）。 */
  enabled: () => boolean;
  /** 懒启动共享 server 并返回 base URL；失败抛可读错误。 */
  ensureUrl: () => Promise<string>;
}

export class ChatPanel implements WebviewViewProvider {
  public static readonly viewId = CHAT_VIEW_ID;
  private view: WebviewView | null = null;

  constructor(
    private readonly extensionUri: Uri,
    private readonly hostRuntime: HostRuntime,
    /** per-folder 最近会话解析（P1-1.5：bootstrap data-session-id 注入）。 */
    private readonly resolveInitialSessionId: (folder: string) => string | null = () => null,
    /** 完整界面承载（缺省退回 pane 模式）。 */
    private readonly fullUi?: ChatPanelFullUiOptions,
  ) {}

  resolveWebviewView(view: WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.extensionUri, "dist")],
    };
    const fullMode = this.fullUi?.enabled() === true;
    view.webview.html = fullMode ? this.buildFullUiHtml() : this.buildPaneHtml(view.webview);
    // 帧转发：webview → host。
    view.webview.onDidReceiveMessage((message: unknown) => {
      this.hostRuntime.handleWebviewMessage(CHAT_VIEW_ID, message);
    });
    this.hostRuntime.attachWebview(CHAT_VIEW_ID, view.webview);
    // full 模式：懒启动共享 server，就绪后把地址推给 webview 设置 iframe.src。
    if (fullMode && this.fullUi) {
      const fullUi = this.fullUi;
      void fullUi
        .ensureUrl()
        .then((url) => {
          this.hostRuntime.pushHostFrame("full-ui-url", { url });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.hostRuntime.pushHostFrame("full-ui-url", { url: "", error: message });
        });
    }
    // 可见性帧生产（T02⑦）：侧栏面板隐藏/显示 → webview 暂停/恢复渲染面。
    // @types/vscode 1.90 的 onDidChangeVisibility 事件无载荷，读 view.visible 快照。
    view.onDidChangeVisibility(() => {
      const payload: VisibilityHostFramePayload = { visible: view.visible };
      this.hostRuntime.pushHostFrame("visibility", payload);
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

  /** 设置（zcodium.sidebarUi）变化后重建面板：模式切换即重载 webview。 */
  reload(): void {
    if (!this.view) return;
    const view = this.view;
    const fullMode = this.fullUi?.enabled() === true;
    view.webview.html = fullMode ? this.buildFullUiHtml() : this.buildPaneHtml(view.webview);
    if (fullMode && this.fullUi) {
      const fullUi = this.fullUi;
      void fullUi
        .ensureUrl()
        .then((url) => {
          this.hostRuntime.pushHostFrame("full-ui-url", { url });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.hostRuntime.pushHostFrame("full-ui-url", { url: "", error: message });
        });
    }
  }

  private buildPaneHtml(webview: Webview): string {
    const nonce = Array.from({ length: 32 }, () => Math.random().toString(36).slice(2)).join("");
    const scriptUri = webview.asWebviewUri(
      Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      Uri.joinPath(this.extensionUri, "dist", "webview", "styles.css"),
    );
    const config = workspace.getConfiguration("zcodium");
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
  <title>ZCodium Agent</title>
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

  /** 完整界面承载页：加载占位 + full-ui-url 帧到达后注入 iframe。 */
  private buildFullUiHtml(): string {
    const nonce = Array.from({ length: 32 }, () => Math.random().toString(36).slice(2)).join("");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZCodium Agent</title>
  <style>
    html, body { margin: 0; height: 100%; background: var(--vscode-editor-background, #1f1f1f); }
    .zcode-boot { display: flex; height: 100vh; align-items: center; justify-content: center;
      flex-direction: column; gap: 12px; color: var(--vscode-foreground, #ccc);
      font-family: var(--vscode-font-family, sans-serif); font-size: 13px; }
    .zcode-boot .zcode-error { color: var(--vscode-errorForeground, #f66); white-space: pre-wrap;
      max-width: 80%; text-align: center; }
    iframe { border: 0; width: 100%; height: 100vh; display: block; }
  </style>
</head>
<body>
  <div class="zcode-boot" id="zcode-boot">
    <div id="zcode-boot-text">正在启动完整界面…（首次需拉起共享服务进程）</div>
  </div>
  <script nonce="${nonce}">
    (function () {
      var booted = false;
      window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.t !== "host" || data.kind !== "full-ui-url" || booted) return;
        booted = true;
        var payload = data.payload || {};
        var boot = document.getElementById("zcode-boot");
        if (payload.url) {
          boot.remove();
          var frame = document.createElement("iframe");
          frame.src = payload.url;
          frame.allow = "clipboard-read; clipboard-write";
          document.body.appendChild(frame);
        } else {
          var text = document.getElementById("zcode-boot-text");
          text.className = "zcode-error";
          text.textContent = "完整界面启动失败：" + (payload.error || "未知错误") +
            "\\n可在设置 zcodium.fullUiRepoRoot 指定 monorepo 根目录后重试。";
        }
      });
    }());
  </script>
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
