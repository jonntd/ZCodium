// win32 懒启动 recipe 消费端（lazy-startup spec §9.2-D2）。
//
// services 侧在 win32 spawn env 注入 ZCODE_CUA_WIN_HELPER_RECIPE，此前全仓零消费者：
// vendor 默认的 ensureStandaloneHelperLaunched 首行 `if (process.platform !== "darwin") return`
// 让 SDK 首调永远不会拉起 Helper，Windows 电脑控制只能靠设置页触发链或手工脚本兜底。
// 这里锁定消费端契约：
// 1. recipe 存在时 capture 必须挂上 ensureBrokerAvailable（源码 wiring，防回归）；
// 2. ensure 的 fork 形态与产品托管 host（windowsCuaDevHelperHost.startGeneration）同构：
//    argv 四参、cwd=root、execPath=command、env 带 addon + ELECTRON_RUN_AS_NODE；
// 3. recipe 缺失/畸形时静默回退 vendor 默认，不抛错不 fork。
import { describe, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

import { captureComputerUseRuntimeFromEnvironment, __launchWindowsHelperFromRecipeForTest } from "../src/server.js";

const RECIPE = {
  command: "C:\\app\\ZCodium.exe",
  entryPath: "C:\\app\\resources\\tools\\cua-helper\\dist\\windows-helper.js",
  root: "C:\\app\\resources\\tools\\cua-helper",
  addonPath: "C:\\app\\resources\\tools\\cua-helper\\build\\Release\\ax_native.node",
  commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
  hostPid: 4242,
};

const SOCKET = "\\\\.\\pipe\\zcode-cua-helper-zcodium";

const fakeChild = () => ({
  pid: 100,
  unref() {},
  on() {},
  send() {
    return true;
  },
  kill() {
    return true;
  },
});

describe("win32 lazy startup recipe consumption", () => {
  it("recipe env 注入时 capture 出 runtime 且 ensure wiring 挂接（源码级防回归）", async () => {
    const runtime = captureComputerUseRuntimeFromEnvironment({
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: SOCKET,
      ZCODE_CUA_WIN_HELPER_RECIPE: JSON.stringify(RECIPE),
    });
    expect(runtime).toBeDefined();
    // capture 期不 fork：ensure 只在 broker_unavailable 重试环上被 BrokerClient 调用。
    expect(forkMock).not.toHaveBeenCalled();

    // wiring 防回归：ensure 选项必须显式覆盖 vendor 默认（否则 win32 静默 return）。
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(import.meta.dirname, "../src/server.ts"), "utf8");
    expect(source).toContain(
      "ensureBrokerAvailable: () => launchWindowsHelperFromRecipe(recipe, socketPath)",
    );
  });

  it("fork 契约：argv 四参、cwd/execPath/env 与托管 host 同构", async () => {
    forkMock.mockClear();
    forkMock.mockImplementation(() => fakeChild());
    await __launchWindowsHelperFromRecipeForTest?.(RECIPE, SOCKET);
    expect(forkMock).toHaveBeenCalledTimes(1);
    const [entryPath, argv, options] = forkMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; execPath: string; env: Record<string, string | undefined>; stdio: string[] },
    ];
    expect(entryPath).toBe(RECIPE.entryPath);
    expect(argv).toEqual(["--socket", SOCKET, "--parent-pid", String(RECIPE.hostPid)]);
    expect(options.cwd).toBe(RECIPE.root);
    expect(options.execPath).toBe(RECIPE.command);
    expect(options.env[HELPER_ADDON_ENV_VALUE]).toBe(RECIPE.addonPath);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // IPC 通道承载 transport_ready/ready 控制消息；helper 侧 sendControl 缺 channel 时退化为 stdout。
    expect(options.stdio).toContain("ipc");
  });

  it("recipe 缺失或畸形时静默回退：不抛错、不 fork", () => {
    forkMock.mockClear();
    expect(
      captureComputerUseRuntimeFromEnvironment({
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: SOCKET,
      }),
    ).toBeDefined();
    expect(
      captureComputerUseRuntimeFromEnvironment({
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: SOCKET,
        ZCODE_CUA_WIN_HELPER_RECIPE: "not-json",
      }),
    ).toBeDefined();
    expect(
      captureComputerUseRuntimeFromEnvironment({
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: SOCKET,
        ZCODE_CUA_WIN_HELPER_RECIPE: JSON.stringify({ command: 1 }),
      }),
    ).toBeDefined();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it("socket env 缺失时整体不 capture（与既有语义一致）", () => {
    forkMock.mockClear();
    expect(
      captureComputerUseRuntimeFromEnvironment({
        ZCODE_CUA_WIN_HELPER_RECIPE: JSON.stringify(RECIPE),
      }),
    ).toBeUndefined();
    expect(forkMock).not.toHaveBeenCalled();
  });
});

// 与 services 侧 windowsCuaHelperHostSupport 同源（@zcode/zcode-cua/broker/server）。
import { HELPER_ADDON_ENV as HELPER_ADDON_ENV_VALUE } from "@zcode/zcode-cua/broker/server";
