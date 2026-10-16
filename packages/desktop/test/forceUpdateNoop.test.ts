import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: {},
  ipcMain: {},
  Menu: {},
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      checkForUpdates: mocks.checkForUpdates,
      downloadUpdate: mocks.downloadUpdate,
      quitAndInstall: mocks.quitAndInstall,
    },
  },
  CancellationToken: class CancellationToken {},
}));

vi.mock("@zcode/shared", () => ({
  DEFAULT_LOCALE: "en-US",
  PlatformChannels: {},
  ZCODE_VERSION: "1.0.0",
  desktopMenuMessageIds: {},
  formatDesktopMenuMessage: vi.fn(),
  getDesktopMenuMessage: vi.fn(),
}));

vi.mock("../src/main/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { requestForceAutoUpdate } from "../src/main/autoUpdater.js";
import { maybeBlockStartupForForceUpdate } from "../src/main/forceUpdateGuard.js";

describe("停用官方强制升级入口", () => {
  it("启动守卫不读取配置、不拦截启动且不调用回调", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("强制升级守卫不应触发任何副作用");
    });

    await expect(
      maybeBlockStartupForForceUpdate({
        locale: "zh-CN",
        logger: { info: vi.fn(), warn: vi.fn() },
        fetchRemoteConfig: forbidden,
        requestAutoUpdate: forbidden,
        onBlocked: forbidden,
      }),
    ).resolves.toEqual({ blocked: false });

    expect(forbidden).not.toHaveBeenCalled();
  });

  it("强制更新兼容入口不发状态、不检查、不下载或安装", () => {
    const onStateChange = vi.fn();
    const dispose = requestForceAutoUpdate(onStateChange, "force-update", "3.15.0");

    expect(dispose).toEqual(expect.any(Function));
    dispose();

    expect(onStateChange).not.toHaveBeenCalled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });
});
