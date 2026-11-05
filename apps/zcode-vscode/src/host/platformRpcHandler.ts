/**
 * PlatformRpcHandler — 平台能力 RPC host 端（架构 §2.2/§2.4）。
 *
 * webview 侧 VscodePlatformService 的 `plat-req` 帧在这里落地为 VS Code API 调用。
 * host 端**方法白名单**校验：白名单外方法一律拒绝应答（ok:false），杜绝 webview
 * 侧任意调用 VS Code API。
 */

import type { BridgeEnvelope, PlatformResponseFrame } from "../bridge/wire";

export type PlatformMethodHandler = (args: unknown[]) => unknown | Promise<unknown>;

/**
 * 平台方法白名单（§2.4 矩阵的可代理面）。
 * 不可代理的方法不登记，webview 侧调用会得到 "method not allowed"（UI 入口自然隐藏）。
 */
export const PLATFORM_METHOD_WHITELIST: readonly string[] = [
  // 文件/目录选择
  "selectFile",
  "selectDirectory",
  "selectDirectories",
  "selectFiles",
  "saveFile",
  "getPathForFile",
  "createTempTextAttachment",
  // 打开/跳转
  "openExternal",
  "openInFileManager",
  "openExternalFile",
  "openFeedback",
  "openCommunity",
  "canOpenCommunity",
  // 编辑器集成（插件特有：diff/文档路由 P1-9.3）
  "showDiff",
  "showTextDocument",
  "revealWorkspace",
  // 诊断/通知
  "exportLogs",
  "showTaskNotification",
  "getDeviceId",
  "activateOrSetWorkspace",
  "openDataRootImport",
  "getSystemLocale",
  "getInstalledEditors",
  // MCP 本机目录（桌面能力位，P1-8）
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
  // 同步面
  "notifyRendererReady",
  "syncWindowTabs",
  "syncWindowUnreadCount",
  "syncActiveTaskSession",
  "registerOAuthState",
  // 会话/编排接线（v0.2.0 T02/T06，host 侧先行定义，组3/4 消费）
  "notifySessionCreated",
  "notifySessionDeleted",
  /** per-folder 最近会话键表（P1-1.1 频道失败降级列表的数据源，T06 host 半）。 */
  "getLatestSessionIdByFolder",
  "reportPendingApprovals",
  "appendSessionAllowlist",
  "updatePermissionRules",
  "updateMcpServers",
  "updateAdditionalDirectories",
  "getActiveEditorSelection",
  "importWorkspaceInstructions",
  "pickWorkspaceFolder",
  // 设置读面（T08/T12 面板：MCP CRUD/权限规则/附加目录展示需要读当前 zcodium.* 值；
  // 只读投影，不含 cliPath/model 等无关面）。
  "getWorkspaceSettings",
];

export interface PlatformRpcHandlerOptions {
  /** 白名单方法实现表（缺失的方法即使白名单内也返回 not implemented）。 */
  methods: ReadonlyMap<string, PlatformMethodHandler>;
  /** 白名单覆盖（缺省 PLATFORM_METHOD_WHITELIST）。 */
  whitelist?: readonly string[];
  /** 帧发送出口（HostRuntime 提供，指向当前 webview）。 */
  post: (frame: BridgeEnvelope) => void;
  /** 告警出口（诊断 OutputChannel）。 */
  warn?: (message: string) => void;
}

export class PlatformRpcHandler {
  private readonly whitelist: ReadonlySet<string>;
  private seq = 0;

  constructor(private readonly options: PlatformRpcHandlerOptions) {
    this.whitelist = new Set(options.whitelist ?? PLATFORM_METHOD_WHITELIST);
  }

  /** 处理一条 plat-req；总是回 plat-res（成功或失败），不抛出到调用栈外。 */
  async handleRequest(id: number, method: string, args: unknown[]): Promise<void> {
    const response = await this.invoke(id, method, args);
    this.options.post(response);
  }

  /** host → webview 平台事件（如通知点击、主题外平台事件预留）。 */
  postEvent(event: string, payload: unknown): void {
    this.options.post({ t: "plat-evt", event, payload });
  }

  /** 生成递增请求 id（host 主动调用 webview 面预留，当前为对称性保留）。 */
  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  private async invoke(
    id: number,
    method: string,
    args: unknown[],
  ): Promise<PlatformResponseFrame> {
    if (!this.whitelist.has(method)) {
      this.options.warn?.(`[platform-rpc] 白名单外方法被拒绝：${method}`);
      return { t: "plat-res", id, ok: false, error: `method not allowed: ${method}` };
    }
    const handler = this.options.methods.get(method);
    if (!handler) {
      return { t: "plat-res", id, ok: false, error: `method not implemented: ${method}` };
    }
    try {
      const value = await handler(args);
      return { t: "plat-res", id, ok: true, value };
    } catch (error) {
      return {
        t: "plat-res",
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
