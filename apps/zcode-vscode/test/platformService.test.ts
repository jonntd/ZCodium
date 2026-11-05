/**
 * T03 平台矩阵逐方法断言（架构 §2.4 装配矩阵全量；P1-9.3）。
 *
 * 原则逐条落到断言：
 * - 能力位：isDesktop===true（解锁 Claude 会话迁移，H7）；
 * - 不支持面：返回安全空值而非抛错（no-op / false / [] / {success:false} / 优雅 reject）；
 * - 可代理面：plat-req 方法名与实参逐字下发（host 白名单校验）；
 * - host 帧驱动：onSettingsChanged/onApplicationLocaleChanged/onThemeChanged 由
 *   HostFrameBus 帧驱动（§2.2 运行时跟随，非仅挂载一次）；
 * - T06/P1-1.5 上报面：notifySessionCreated/notifySessionDeleted/pickWorkspaceFolder 帧形。
 *
 * 勘察背景：原矩阵覆盖只有 test/p0Equivalence.test.ts:139-170 抽样 3 项；
 * 本文件补齐逐方法全矩阵。
 */

import { describe, expect, it } from "vitest";
import type { BridgeEnvelope } from "../src/bridge/wire";
import { HostFrameBus } from "../src/webview-react/bridge/hostFrames";
import { PlatformRpcClient } from "../src/webview-react/bridge/platformRpcClient";
import { VscodePlatformService } from "../src/webview-react/platform/vscodePlatformService";
import type { VscodeThemeKind } from "../src/webview-react/themeBridge";

/** 内存双端：plat-req → 录制 + 罐头应答；host 帧 → 直接喂 HostFrameBus。 */
function makePlatform(options?: {
  respond?: (method: string, args: unknown[]) => unknown;
}) {
  const sent: Array<{ method: string; args: unknown[] }> = [];
  const events: Array<{ event: string; payload: unknown }> = [];
  const rpc = new PlatformRpcClient({
    postMessage: (message: unknown) => {
      const frame = message as BridgeEnvelope;
      if (frame.t === "plat-req") {
        sent.push({ method: frame.method, args: frame.args });
        const value = options?.respond?.(frame.method, frame.args);
        // host 半：同步回 plat-res（PlatformRpcClient 同步 handleMessageData 可收）。
        rpcHandleMessage({ t: "plat-res", id: frame.id, ok: true, value: value ?? null });
      } else if (frame.t === "plat-evt") {
        events.push({ event: frame.event, payload: frame.payload });
      }
    },
  });
  function rpcHandleMessage(frame: BridgeEnvelope): void {
    rpc.handleMessageData(frame);
  }
  const hostFrames = new HostFrameBus();
  const platform = new VscodePlatformService({ rpc, hostFrames });
  return { platform, hostFrames, sent, events };
}

/** 无帧总线装配（矩阵「缺省空实现」路径：监听返回 no-op 解除函数）。 */
function makePlatformWithoutFrames() {
  const rpc = new PlatformRpcClient({ postMessage: () => {} });
  return new VscodePlatformService({ rpc });
}

describe("§2.4 能力位", () => {
  it("isDesktop=true（解锁 Claude 会话迁移）/ 文件能力位开启 / 非本地开发态", () => {
    const { platform } = makePlatform();
    expect(platform.isDesktop).toBe(true);
    expect(platform.canOpenLocalFiles).toBe(true);
    expect(platform.canSelectFilePath).toBe(true);
    expect(platform.isLocalDevelopmentRuntime).toBe(false);
  });
});

describe("§2.4 可代理面：plat-req 方法名与实参逐字下发", () => {
  it("文件/目录选择族", async () => {
    const { platform, sent } = makePlatform({ respond: (m) => (m === "selectFiles" ? [] : "/p") });
    await expect(platform.selectDirectory()).resolves.toBe("/p");
    await expect(platform.selectDirectories()).resolves.toBe("/p");
    await expect(platform.selectFile()).resolves.toBe("/p");
    await expect(platform.selectFiles()).resolves.toEqual([]);
    expect(sent.map((s) => s.method)).toEqual([
      "selectDirectory",
      "selectDirectories",
      "selectFile",
      "selectFiles",
    ]);
  });

  it("saveFile：data 编码为 dataB64 透传（host 弹保存对话框后写盘），sourceUrl 直传", async () => {
    const { platform, sent } = makePlatform({ respond: () => ({ success: true, path: "/x" }) });
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    await expect(
      platform.saveFile({ suggestedName: "a.txt", data }),
    ).resolves.toEqual({ success: true, path: "/x" });
    expect(sent[0]?.method).toBe("saveFile");
    // new Uint8Array([1,2,3,4]) 的 base64 形态（btoa 二进制字符串桥）。
    expect(sent[0]?.args).toEqual([{ dataB64: "AQIDBA==", sourceUrl: undefined, suggestedName: "a.txt" }]);
    // 无 data：dataB64 缺省，sourceUrl 直传。
    await expect(platform.saveFile({ suggestedName: "b.txt", sourceUrl: "https://x/f" })).resolves.toEqual({
      success: true,
      path: "/x",
    });
    expect(sent[1]?.args).toEqual([{ dataB64: undefined, sourceUrl: "https://x/f", suggestedName: "b.txt" }]);
  });

  it("getPathForFile 恒 null（Webview 沙箱内 File → 本机路径不可映射）", () => {
    const { platform } = makePlatform();
    expect(platform.getPathForFile({ name: "x" })).toBeNull();
  });

  it("打开/跳转族与编辑器集成路由", async () => {
    const { platform, sent } = makePlatform({ respond: () => true });
    platform.openExternal("https://example.com");
    await expect(platform.openInFileManager("/p")).resolves.toBe(true);
    await expect(platform.openExternalFile("/p")).resolves.toBe(true);
    await expect(platform.showDiff("/p", "proposed")).resolves.toBe(true);
    await expect(platform.showTextDocument("/p")).resolves.toBe(true);
    await expect(platform.createTempTextAttachment({ text: "hi" })).resolves.toBe(true);
    await expect(platform.openFeedback()).resolves.toBeUndefined();
    await expect(platform.openCommunity()).resolves.toBeUndefined();
    await expect(platform.canOpenCommunity("zh-CN")).resolves.toBe(true);
    expect(sent.map((s) => s.method)).toEqual([
      "openExternal",
      "openInFileManager",
      "openExternalFile",
      "showDiff",
      "showTextDocument",
      "createTempTextAttachment",
      "openFeedback",
      "openCommunity",
      "canOpenCommunity",
    ]);
    expect(sent[3]?.args).toEqual(["/p", "proposed"]);
  });

  it("诊断/通知/工作区与 MCP 本机目录（桌面能力位）", async () => {
    const { platform, sent } = makePlatform({ respond: () => ({ success: true }) });
    platform.showTaskNotification({ taskId: "t1", title: "t" } as Parameters<
      VscodePlatformService["showTaskNotification"]
    >[0]);
    await expect(platform.exportLogs()).resolves.toEqual({ success: true });
    await expect(platform.activateOrSetWorkspace("/p")).resolves.toEqual({ success: true });
    await expect(platform.loadMcpFromUserDirectory()).resolves.toEqual({ success: true });
    await expect(platform.saveMcpToUserDirectory({})).resolves.toEqual({ success: true });
    await expect(platform.migrateLegacyCommonMcp()).resolves.toEqual({ success: true });
    // openInEditor 是不支持面（§2.4「不支持」档）：不走 rpc，安全返回 {success:false}。
    await expect(platform.openInEditor("vscode", "/p")).resolves.toMatchObject({ success: false });
    expect(sent.map((s) => s.method)).toEqual([
      "showTaskNotification",
      "exportLogs",
      "activateOrSetWorkspace",
      "loadMcpFromUserDirectory",
      "saveMcpToUserDirectory",
      "migrateLegacyCommonMcp",
    ]);
  });

  it("getSystemLocale 经 plat-req 下发（§2.4 必选面）", async () => {
    const { platform, sent } = makePlatform({ respond: () => "en-US" });
    await expect(platform.getSystemLocale()).resolves.toBe("en-US");
    expect(sent.map((s) => s.method)).toEqual(["getSystemLocale"]);
  });

  it("同步面：notifyRendererReady 走 plat-evt；unread 上报 plat-req", () => {
    const { platform, sent, events } = makePlatform();
    platform.notifyRendererReady();
    platform.syncWindowTabs(["/p"]);
    platform.syncWindowUnreadCount(2);
    platform.syncActiveTaskSession("s-1");
    platform.openDataRootImport();
    expect(events.map((e) => e.event)).toEqual(["notifyRendererReady"]);
    // syncWindowTabs / syncActiveTaskSession 是桌面壳概念的 no-op（§2.4），不产生 plat-req。
    expect(sent.map((s) => s.method)).toEqual(["syncWindowUnreadCount", "openDataRootImport"]);
  });
});

describe("§2.4 不支持面：安全空值而非抛错（逐方法矩阵）", () => {
  it("远程/容器族：false / [] / {success:false} / idle", async () => {
    const { platform } = makePlatform();
    await expect(platform.isDockerAvailable()).resolves.toBe(false);
    await expect(platform.listWSLDistros()).resolves.toEqual([]);
    await expect(platform.listDockerContainers()).resolves.toEqual([]);
    await expect(platform.listSSHConfigAliases()).resolves.toEqual([]);
    await expect(
      platform.connectRemote({ kind: "ssh", host: "h" } as Parameters<
        VscodePlatformService["connectRemote"]
      >[0]),
    ).resolves.toMatchObject({ success: false });
    await expect(platform.cancelPendingRemoteConnection()).resolves.toBeUndefined();
    await expect(platform.stopWebRemoteControl()).resolves.toBeUndefined();
    await expect(platform.getWebRemoteControlStatus()).resolves.toEqual({ status: "idle" });
    await expect(platform.disposeRemoteSession("s-1")).resolves.toBeUndefined();
  });

  it("远程控制启动族：明确 reject（Promise<never> 面，UI 入口隐藏 + 文案可读）", async () => {
    const { platform } = makePlatform();
    await expect(platform.startWebRemoteControl({})).rejects.toThrow(/桌面端/);
    await expect(platform.refreshWebRemoteControlPairing({})).rejects.toThrow(/桌面端/);
  });

  it("更新族全部 no-op（插件更新走 VS Code 扩展更新）", async () => {
    const { platform } = makePlatform();
    await expect(platform.downloadUpdate()).resolves.toBeUndefined();
    await expect(platform.cancelUpdateDownload()).resolves.toBeUndefined();
    await expect(platform.skipUpdateVersion("1.0.0")).resolves.toBeUndefined();
    await expect(platform.acknowledgePostUpdateReleaseNotes("1.0.0")).resolves.toBeUndefined();
    await expect(platform.quitAndInstallUpdate()).resolves.toBeUndefined();
    await expect(platform.executeDesktopCommand("any")).resolves.toBeUndefined();
    await expect(platform.setApplicationLocale("zh-CN")).resolves.toBeUndefined();
    await expect(platform.setTitleBarTheme("dark")).resolves.toBeUndefined();
  });

  it("监听族：返回可解除的 no-op 订阅（重复解除不抛错）", () => {
    const { platform } = makePlatform();
    const disposers = [
      platform.onRemoteConnectionLog(() => {}),
      platform.onRemoteSessionClosed(() => {}),
      platform.onBotRemoteWorkspaceReconnected(() => {}),
      platform.onFocusTab(() => {}),
      platform.onNewTab(() => {}),
      platform.onNewTask(() => {}),
      platform.onOpenWorkspace(() => {}),
      platform.onWindowFullscreenChanged(() => {}),
      platform.onTaskNotificationClick(() => {}),
      platform.onUpdateReady(() => {}),
      platform.onUpdateCheckResult(() => {}),
      platform.onPostUpdateReleaseNotes(() => {}),
      platform.onOAuthCallback(() => {}),
      platform.onPaymentCallback(() => {}),
    ];
    for (const dispose of disposers) {
      expect(typeof dispose).toBe("function");
      dispose();
      dispose();
    }
  });

  it("getDeviceId：host 帧未达返回空串；setDeviceId 回填后同步读取", () => {
    const { platform } = makePlatform();
    expect(platform.getDeviceId()).toBe("");
    platform.setDeviceId("device-1");
    expect(platform.getDeviceId()).toBe("device-1");
  });

  it("getInstalledEditors 返回当前 VS Code；openInEditor 不支持面安全", async () => {
    const platform = makePlatformWithoutFrames();
    await expect(platform.getInstalledEditors()).resolves.toEqual([
      { id: "vscode", name: "Visual Studio Code", iconDataUrl: "" },
    ]);
    await expect(platform.openInEditor("code", "/p")).resolves.toMatchObject({ success: false });
  });

  it("原型面无 vscode 依赖方法缺失（类完整实现 IPlatformService 由 tsc 锁定；此处锁可调用面）", () => {
    const { platform } = makePlatform();
    const proto = Object.getPrototypeOf(platform) as Record<string, unknown>;
    const matrix = [
      "selectDirectory",
      "selectDirectories",
      "selectFile",
      "selectFiles",
      "saveFile",
      "getPathForFile",
      "createTempTextAttachment",
      "openExternal",
      "openInFileManager",
      "openExternalFile",
      "openFeedback",
      "openCommunity",
      "canOpenCommunity",
      "showDiff",
      "showTextDocument",
      "exportLogs",
      "showTaskNotification",
      "getDeviceId",
      "setDeviceId",
      "activateOrSetWorkspace",
      "openDataRootImport",
      "getSystemLocale",
      "getInstalledEditors",
      "openInEditor",
      "loadMcpFromUserDirectory",
      "saveMcpToUserDirectory",
      "migrateLegacyCommonMcp",
      "notifyRendererReady",
      "syncWindowTabs",
      "syncWindowUnreadCount",
      "syncActiveTaskSession",
      "registerOAuthState",
      "onOAuthCallback",
      "onPaymentCallback",
      "notifySessionCreated",
      "notifySessionDeleted",
      "pickWorkspaceFolder",
      "onRemoteConnectionLog",
      "onRemoteSessionClosed",
      "onBotRemoteWorkspaceReconnected",
      "onFocusTab",
      "onNewTab",
      "onNewTask",
      "onOpenWorkspace",
      "onWindowFullscreenChanged",
      "onTaskNotificationClick",
      "onUpdateReady",
      "onUpdateCheckResult",
      "onPostUpdateReleaseNotes",
      "connectRemote",
      "cancelPendingRemoteConnection",
      "startWebRemoteControl",
      "refreshWebRemoteControlPairing",
      "stopWebRemoteControl",
      "getWebRemoteControlStatus",
      "disposeRemoteSession",
      "isDockerAvailable",
      "listWSLDistros",
      "listDockerContainers",
      "listSSHConfigAliases",
      "downloadUpdate",
      "cancelUpdateDownload",
      "skipUpdateVersion",
      "acknowledgePostUpdateReleaseNotes",
      "quitAndInstallUpdate",
      "executeDesktopCommand",
      "setApplicationLocale",
      "setTitleBarTheme",
      "onSettingsChanged",
      "onApplicationLocaleChanged",
      "onThemeChanged",
    ];
    for (const method of matrix) {
      expect(proto[method], `缺少矩阵方法 ${method}`).toBeTypeOf("function");
    }
  });
});

describe("§2.4 host 帧驱动监听（运行时跟随，非仅挂载一次）", () => {
  it("onSettingsChanged：workspace 帧 {kind:'settings-changed'} 驱动；其他载荷不触发", () => {
    const { platform, hostFrames } = makePlatform();
    const changes: number[] = [];
    const off = platform.onSettingsChanged(() => changes.push(changes.length));
    hostFrames.handleMessageData({ t: "host", kind: "workspace", payload: { kind: "workspace-changed" } });
    expect(changes).toHaveLength(0);
    hostFrames.handleMessageData({ t: "host", kind: "workspace", payload: { kind: "settings-changed" } });
    hostFrames.handleMessageData({ t: "host", kind: "workspace", payload: { kind: "settings-changed" } });
    expect(changes).toEqual([0, 1]);
    off();
    hostFrames.handleMessageData({ t: "host", kind: "workspace", payload: { kind: "settings-changed" } });
    expect(changes).toEqual([0, 1]);
  });

  it("onApplicationLocaleChanged：locale 帧驱动 + 晚订阅立即以最近一帧同步", () => {
    const { platform, hostFrames } = makePlatform();
    hostFrames.handleMessageData({ t: "host", kind: "locale", payload: "zh-CN" });
    const locales: string[] = [];
    const off = platform.onApplicationLocaleChanged((locale) => locales.push(locale));
    // 晚订阅：最近一帧立即同步一次（HostFrameBus 保留最近帧语义）。
    expect(locales).toEqual(["zh-CN"]);
    hostFrames.handleMessageData({ t: "host", kind: "locale", payload: "en-US" });
    expect(locales).toEqual(["zh-CN", "en-US"]);
    off();
  });

  it("onThemeChanged：theme 帧（ColorThemeKind）驱动 + 解除后不触发", () => {
    const { platform, hostFrames } = makePlatform();
    const themes: VscodeThemeKind[] = [];
    const off = platform.onThemeChanged((kind) => themes.push(kind));
    hostFrames.handleMessageData({ t: "host", kind: "theme", payload: 3 });
    expect(themes).toEqual([3]);
    off();
    hostFrames.handleMessageData({ t: "host", kind: "theme", payload: 1 });
    expect(themes).toEqual([3]);
  });

  it("无 hostFrames 装配：监听面返回 no-op 解除函数（缺省空实现路径）", () => {
    const platform = makePlatformWithoutFrames();
    expect(platform.onSettingsChanged(() => {})()).toBeUndefined();
    expect(platform.onApplicationLocaleChanged(() => {})()).toBeUndefined();
    expect(platform.onThemeChanged(() => {})()).toBeUndefined();
  });
});

describe("§2.4 T06/P1-1.5 上报面：plat 帧形", () => {
  it("notifySessionCreated / notifySessionDeleted / pickWorkspaceFolder 帧名与实参", async () => {
    const { platform, sent } = makePlatform({
      respond: (m) => (m === "notifySessionCreated" ? { folder: "/repo", sessionId: "s-9" } : null),
    });
    await expect(platform.notifySessionCreated("s-9", "/repo")).resolves.toEqual({
      folder: "/repo",
      sessionId: "s-9",
    });
    await expect(platform.notifySessionDeleted("s-9")).resolves.toBeNull();
    await expect(platform.pickWorkspaceFolder()).resolves.toBeNull();
    expect(sent.map((s) => ({ method: s.method, args: s.args }))).toEqual([
      { method: "notifySessionCreated", args: ["s-9", "/repo"] },
      { method: "notifySessionDeleted", args: ["s-9"] },
      { method: "pickWorkspaceFolder", args: [] },
    ]);
  });
});
