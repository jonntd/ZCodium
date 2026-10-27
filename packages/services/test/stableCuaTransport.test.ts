import { afterEach, describe, expect, it } from "vitest";
import {
  __resetStableCuaTransportForTest,
  __STABLE_CUA_TRANSPORT_TEST_HOOKS,
  getStableCuaPipeName,
} from "#src/cua-permission-broker/stableCuaTransport.js";

// 管道名收敛契约（lazy-startup spec §9.2-D1）：win32 稳定 pipe 名优先读恢复后的标准键
// ZCODE_CUA_PERMISSION_BROKER_SOCKET（main 经 fork 键下发的共存层稳定名
// \\.\pipe\zcode-cua-helper-zcodium 由 host bootstrap 的 restoreZCodiumCuaBrokerSocketEnv
// 恢复至此），env 缺失才回退铸随机名。2026-10-27 实机确认旧实现无条件铸随机名，使
// 探测/spawn env/Host fork 与共存层各说各话、手工拉起的 helper 无法被 MCP 连上。
const { BROKER_SOCKET_ENV } = __STABLE_CUA_TRANSPORT_TEST_HOOKS;

afterEach(() => {
  delete process.env[BROKER_SOCKET_ENV];
  __resetStableCuaTransportForTest();
});

describe("getStableCuaPipeName", () => {
  it("优先采用 env 注入的稳定 pipe 名（共存层收敛）", () => {
    process.env[BROKER_SOCKET_ENV] = "\\\\.\\pipe\\zcode-cua-helper-zcodium";
    expect(getStableCuaPipeName()).toBe("\\\\.\\pipe\\zcode-cua-helper-zcodium");
  });

  it("env 缺失时回退铸随机名", () => {
    delete process.env[BROKER_SOCKET_ENV];
    const minted = getStableCuaPipeName();
    // mintBrokerSocketPath 按平台落到 tmpdir（win32 named pipe / darwin tmp sock）；
    // 这里只锁「回退路径非空且不等于任何注入值」，平台形态由 vendor 契约测试防守。
    expect(minted.length).toBeGreaterThan(0);
    expect(minted).not.toContain("zcode-cua-helper-");
  });

  it("同一进程内两次取值恒定（进程内稳定语义）", () => {
    delete process.env[BROKER_SOCKET_ENV];
    const first = getStableCuaPipeName();
    // env 后置变化不得翻转已铸名：spawn env 与探测必须看到同一条 pipe。
    process.env[BROKER_SOCKET_ENV] = "\\\\.\\pipe\\zcode-cua-helper-late";
    expect(getStableCuaPipeName()).toBe(first);
  });

  it("reset 后再次取值跟随新的 env 注入", () => {
    process.env[BROKER_SOCKET_ENV] = "\\\\.\\pipe\\zcode-cua-helper-a";
    expect(getStableCuaPipeName()).toBe("\\\\.\\pipe\\zcode-cua-helper-a");
    __resetStableCuaTransportForTest();
    process.env[BROKER_SOCKET_ENV] = "\\\\.\\pipe\\zcode-cua-helper-b";
    expect(getStableCuaPipeName()).toBe("\\\\.\\pipe\\zcode-cua-helper-b");
  });
});
