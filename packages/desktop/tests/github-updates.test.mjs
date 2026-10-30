import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind } from "typescript";

const require = createRequire(import.meta.url);
const feed = "https://github.com/ZCodium-project/ZCodium/releases/latest/download/";
async function load(relative, imports = {}) {
  const source = await readFile(new URL(`../src/main/${relative}.ts`, import.meta.url), "utf8");
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "process", output)(
    (name) => {
      assert.ok(name in imports, `unexpected runtime import: ${name}`);
      return imports[name];
    },
    exports,
    imports.runtimeProcess ?? process,
  );
  return exports;
}
const logger = { info() {}, warn() {}, error() {}, debug() {} };

test("update modules have no official endpoint or custom manifest dependency", async () => {
  for (const name of ["autoUpdater", "forceUpdateGuard"]) {
    const source = await readFile(new URL(`../src/main/${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /DEFAULT_ZCODE_ENDPOINT_ORIGIN|resolveRuntimeZCodeEndpointOrigin|manifestUpdateProvider|zcode\.z\.ai|\/api\/v1\/client\/configs/,
    );
  }
});

test("force guard never fetches, blocks or invokes callbacks", async () => {
  const guard = await load("forceUpdateGuard");
  const unexpected = () => assert.fail("force update must have no side effects");
  assert.deepEqual(
    await guard.maybeBlockStartupForForceUpdate({
      locale: "en-US",
      logger,
      fetchRemoteConfig: unexpected,
      requestAutoUpdate: unexpected,
      onBlocked: unexpected,
    }),
    { blocked: false },
  );
});

test("generic feed, overrides, manual check and native download/install remain wired", async () => {
  const updater = new EventEmitter();
  const settings = {
    receivePreviewUpdates: true,
    skippedElectronUpdateVersions: { stable: "2.0.0" },
  };
  const settingService = {
    get: async () => settings,
    update: async (patch) => Object.assign(settings, patch),
  };
  let checks = 0,
    downloads = 0,
    installs = 0,
    preparation = 0,
    configured;
  updater.setFeedURL = (value) => {
    configured = value;
  };
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit("checking-for-update");
    updater.emit("update-not-available", { version: "1.0.0" });
  };
  updater.downloadUpdate = async () => {
    downloads++;
  };
  updater.quitAndInstall = () => {
    installs++;
  };
  const handlers = new Map();
  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { id: 1, send: (...args) => sent.push(args) },
  };
  const module = await load("autoUpdater", {
    runtimeProcess: { ...process, platform: "win32" },
    electron: {
      app: { isPackaged: true, getVersion: () => "1.0.0", on: () => {} },
      BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win },
      Menu: { getApplicationMenu: () => null },
      ipcMain: { handle: (key, fn) => handlers.set(key, fn), on() {} },
    },
    "@zcode/shared": {
      DEFAULT_LOCALE: "en-US",
      ZCODE_VERSION: "1.0.0",
      PlatformChannels: new Proxy({}, { get: (_, key) => key }),
      desktopMenuMessageIds: {},
      getDesktopMenuMessage: () => "",
      formatDesktopMenuMessage: () => "",
    },
    "electron-updater": {
      __esModule: true,
      default: { autoUpdater: updater },
      CancellationToken: class {
        dispose() {}
      },
    },
    semver: { __esModule: true, default: require("semver") },
    "./logger.js": { logger },
    // 加载真实版本比较模块，避免手写替身漏掉 legacy 版本线的规则。
    "./autoUpdateVersion.js": await load("autoUpdateVersion", {
      semver: { __esModule: true, default: require("semver") },
    }),
  });
  assert.deepEqual(
    module.resolveUpdateFeedSourceFromStartupConfig({
      argv: [],
      env: { ZCODE_UPDATE_FEED_URL: "https://example.invalid/feed/" },
    }),
    { url: "https://example.invalid/feed/" },
  );
  for (const argv of [
    ["--zcode-update-feed-url=https://example.invalid/cli/"],
    ["--zcode-update-feed-url", "https://example.invalid/cli/"],
  ]) {
    assert.deepEqual(
      module.resolveUpdateFeedSourceFromStartupConfig({
        argv,
        env: { ZCODE_UPDATE_FEED_URL: feed },
      }),
      { url: "https://example.invalid/cli/" },
    );
  }
  await module.initAutoUpdater({
    settingService,
    onBeforeQuitAndInstall: async () => {
      preparation++;
    },
  });
  await new Promise(setImmediate);
  assert.equal(configured.provider, "generic");
  assert.equal(configured.url, feed);
  assert.equal(configured.channel, "latest");
  assert.equal(configured.useMultipleRangeRequest, false);
  assert.equal(checks, 1);
  // #88：latest 只有 stable，preview 偏好不得发起重复检查或污染跳过版本的 key。
  module.refreshAutoUpdaterReleaseChannel(true);
  await new Promise(setImmediate);
  assert.equal(checks, 1);
  module.requestForceAutoUpdate(() => assert.fail("no callback"))();
  assert.equal(checks, 1);
  updater.emit("update-available", { version: "2.0.0" });
  await new Promise(setImmediate);
  assert.equal(module.getAutoUpdaterState().kind, "idle");
  module.checkForUpdateMenuClick(win);
  await new Promise(setImmediate);
  assert.equal(checks, 2);
  assert.equal(settings.skippedElectronUpdateVersions.stable, undefined);
  updater.emit("update-available", { version: "2.0.0" });
  await new Promise(setImmediate);
  assert.equal(module.getAutoUpdaterState().kind, "update-available");
  assert.equal(module.getAutoUpdaterState().channel, "stable");
  await module.skipAvailableUpdateVersion("2.0.0", settingService);
  assert.equal(settings.skippedElectronUpdateVersions.stable, "2.0.0");
  assert.equal(settings.skippedElectronUpdateVersions.preview, undefined);
  await settingService.update({ skippedElectronUpdateVersions: {} });
  updater.emit("update-available", { version: "2.0.0" });
  await new Promise(setImmediate);
  await handlers.get("DownloadUpdate")();
  assert.equal(downloads, 1);
  updater.emit("update-downloaded", { version: "2.0.0" });
  await new Promise(setImmediate);
  assert.equal(module.getAutoUpdaterState().kind, "update-downloaded");
  await handlers.get("QuitAndInstallUpdate")();
  assert.equal(preparation, 1);
  assert.equal(installs, 1);
  assert.ok(sent.length > 0);
  await module.initAutoUpdater({ updateFeedSource: { url: "https://example.invalid/custom/" } });
  assert.equal(configured.url, "https://example.invalid/custom/");
  await module.initAutoUpdater({ enabled: false });
});

test("built-in provider reads platform YAML and resolves release assets", async () => {
  const { GenericProvider } = require("electron-updater/out/providers/GenericProvider.js");
  for (const [platform, suffix] of [
    ["darwin", "-mac"],
    ["win32", ""],
    ["linux", `-linux${process.arch === "x64" ? "" : `-${process.arch}`}`],
  ]) {
    let requested;
    const provider = new GenericProvider(
      { provider: "generic", url: feed, channel: "latest" },
      { isAddNoCacheQuery: false },
      {
        platform,
        executor: {
          request: async (options) => {
            requested = `https://${options.hostname}${options.path}`;
            return "version: 2.0.0\nfiles:\n  - url: app.zip\n    sha512: test-checksum\n";
          },
        },
      },
    );
    const info = await provider.getLatestVersion();
    assert.equal(requested, `${feed}latest${suffix}.yml`);
    assert.equal(provider.resolveFiles(info)[0].url.href, `${feed}app.zip`);
  }
});

test("packaged macOS offers manual installation without native downloads, ready replay or quit", async () => {
  const updater = new EventEmitter();
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getVersion: () => "1.0.0",
  });
  let downloads = 0;
  let installs = 0;
  const opened = [];
  let finishOpen;
  let failOpen = false;
  const handlers = new Map();
  const settings = {
    autoDownloadAndInstallUpdates: true,
    receivePreviewUpdates: true,
    pendingPostUpdateReleaseNotes: {
      version: "2.0.0",
      title: "Old cached download",
      markdown: "Not a staged signed update",
    },
  };
  const settingService = {
    get: async () => settings,
    update: async (patch) => Object.assign(settings, patch),
  };
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "2.0.0" });
  };
  updater.downloadUpdate = async () => {
    downloads++;
  };
  updater.quitAndInstall = () => {
    installs++;
  };
  const module = await load("autoUpdater", {
    runtimeProcess: { ...process, platform: "darwin" },
    electron: {
      app,
      shell: {
        openExternal: (url) => {
          opened.push(url);
          return failOpen
            ? Promise.reject(new Error("Cannot open browser"))
            : new Promise((resolve) => {
                finishOpen = resolve;
              });
        },
      },
      BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
      Menu: { getApplicationMenu: () => null },
      ipcMain: { handle: (key, fn) => handlers.set(key, fn), on() {} },
    },
    "@zcode/shared": {
      DEFAULT_LOCALE: "en-US",
      ZCODE_VERSION: "1.0.0",
      PlatformChannels: new Proxy({}, { get: (_, key) => key }),
      desktopMenuMessageIds: {},
      getDesktopMenuMessage: () => "",
      formatDesktopMenuMessage: () => "",
    },
    "electron-updater": {
      __esModule: true,
      default: { autoUpdater: updater },
      CancellationToken: class {
        dispose() {}
      },
    },
    semver: { __esModule: true, default: require("semver") },
    "./logger.js": { logger },
    "./autoUpdateVersion.js": await load("autoUpdateVersion", {
      semver: { __esModule: true, default: require("semver") },
    }),
  });

  await module.hydratePendingPostUpdateReleaseNotes(settingService);
  assert.equal(module.getAutoUpdaterState().kind, "idle");
  await module.initAutoUpdater({ settingService });
  await new Promise(setImmediate);
  assert.deepEqual(module.getAutoUpdaterState(), {
    kind: "update-available",
    version: "2.0.0",
    enabled: true,
    channel: "stable",
    manualInstall: true,
  });
  assert.equal(downloads, 0);
  assert.deepEqual(opened, []);
  module.downloadAvailableUpdate("auto-download");
  assert.deepEqual(opened, []);

  const firstOpen = handlers.get("DownloadUpdate")();
  const repeatedOpen = handlers.get("DownloadUpdate")();
  assert.equal(firstOpen, repeatedOpen);
  assert.deepEqual(opened, ["https://github.com/ZCodium-project/ZCodium/releases/latest"]);
  finishOpen();
  await firstOpen;
  failOpen = true;
  await assert.rejects(handlers.get("DownloadUpdate")(), /Cannot open browser/);
  assert.equal(module.getAutoUpdaterState().manualInstall, true);
  updater.emit("download-progress", { percent: 50 });
  updater.emit("update-downloaded", { version: "2.0.0" });
  assert.equal(module.getAutoUpdaterState().kind, "update-available");
  module.syncReadyUpdateToWindow({
    isDestroyed: () => false,
    webContents: { send: () => assert.fail("manual mode must not replay UpdateReady") },
  });
  await assert.rejects(handlers.get("QuitAndInstallUpdate")(), /manual installation/);
  app.emit("before-quit", { preventDefault: () => assert.fail("must not intercept quit") });
  assert.equal(downloads, 0);
  assert.equal(installs, 0);
  await module.initAutoUpdater({ enabled: false });
});
