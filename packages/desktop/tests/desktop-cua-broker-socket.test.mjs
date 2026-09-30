// ZCodium 私有 CUA broker socket（docs/spec/cua-runtime-builtin.md §E 跨安装共存）。
//
// 背景：stable socket 按 user 单例，官方 ZCode.app 的托管 helper 常驻其上，fork 的
// getStatus 探测/launch 全落空（2026-09-30 真机实测：每次查询 ~20s 后 unavailable）。
// 下发链分两段——main 把私有路径写进 fork 键 ZCODIUM_CUA_BROKER_SOCKET（host 启动的
// confused-deputy sanitize 会剥标准键，fork 键能活着穿过），host 侧
// restoreZCodiumCuaBrokerSocketEnv（shared）在 sanitize 后把 fork 键恢复成 vendor 读取的
// 标准键并删除 fork 键。这里防守：路径按平台隔离、用户显式注入优先、恢复语义、
// 两处 fork 键字面量一致、vendor 真实现确实采信标准键。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyForkCuaBrokerSocketEnv,
  BROKER_SOCKET_ENV,
  ensureForkCuaBrokerSocketDir,
  FORK_CUA_BROKER_SOCKET_ENV,
  resolveForkCuaBrokerSocketPath,
} from "../src/main/desktopCuaBrokerSocket.js";
import { restoreZCodiumCuaBrokerSocketEnv } from "../../../packages/shared/src/runtimeEnv.ts";

test("fork broker socket path is namespaced per platform (no clash with official app)", () => {
  const darwin = resolveForkCuaBrokerSocketPath({ platform: "darwin", uid: "501" });
  assert.equal(darwin, "/tmp/zcode-cua-zcodium-501/broker.sock");

  const win32 = resolveForkCuaBrokerSocketPath({ platform: "win32" });
  assert.equal(win32, "\\\\.\\pipe\\zcode-cua-helper-zcodium");

  const linux = resolveForkCuaBrokerSocketPath({
    platform: "linux",
    home: "/home/tester",
  });
  assert.equal(linux, "/home/tester/.zcode/cua-broker-zcodium/broker.sock");
});

test("applyForkCuaBrokerSocketEnv injects the fork key by default and respects explicit values", () => {
  const injected = applyForkCuaBrokerSocketEnv({});
  assert.equal(typeof injected[FORK_CUA_BROKER_SOCKET_ENV], "string");
  assert.ok(injected[FORK_CUA_BROKER_SOCKET_ENV]?.includes("zcodium"));
  // 绝不直接写标准键：host 启动的 confused-deputy sanitize 会把它剥掉。
  assert.equal(injected[BROKER_SOCKET_ENV], undefined);

  // 空白值视同未设置：替换为 fork 私有路径。
  const whitespace = applyForkCuaBrokerSocketEnv({ [FORK_CUA_BROKER_SOCKET_ENV]: "   " });
  assert.notEqual(whitespace[FORK_CUA_BROKER_SOCKET_ENV]?.trim(), "");

  // 用户显式注入原样保留（与 ZCODE_CUA_BUNDLED_HELPER_APP_PATH 同策略）。
  const explicit = applyForkCuaBrokerSocketEnv({
    [FORK_CUA_BROKER_SOCKET_ENV]: "/custom/broker.sock",
  });
  assert.equal(explicit[FORK_CUA_BROKER_SOCKET_ENV], "/custom/broker.sock");

  // 纯函数：不修改入参。
  const source = {};
  applyForkCuaBrokerSocketEnv(source);
  assert.equal(source[FORK_CUA_BROKER_SOCKET_ENV], undefined);
});

test("restoreZCodiumCuaBrokerSocketEnv moves the fork key onto the vendor key and removes it", () => {
  // 常规路径：恢复标准键 + 删除 fork 键（不泄入 Bash/tool 子进程）。
  const env = {
    [FORK_CUA_BROKER_SOCKET_ENV]: "/tmp/zcode-cua-zcodium-501/broker.sock",
  };
  restoreZCodiumCuaBrokerSocketEnv(env);
  assert.equal(env[BROKER_SOCKET_ENV], "/tmp/zcode-cua-zcodium-501/broker.sock");
  assert.equal(env[FORK_CUA_BROKER_SOCKET_ENV], undefined);

  // 标准键已有值时尊重现状（上游未来改变注入方式时不覆盖）。
  const occupied = {
    [FORK_CUA_BROKER_SOCKET_ENV]: "/fork/broker.sock",
    [BROKER_SOCKET_ENV]: "/existing/broker.sock",
  };
  restoreZCodiumCuaBrokerSocketEnv(occupied);
  assert.equal(occupied[BROKER_SOCKET_ENV], "/existing/broker.sock");
  assert.equal(occupied[FORK_CUA_BROKER_SOCKET_ENV], undefined);

  // fork 键缺失（CLI 直跑等未注入场景）no-op；空白值同样不恢复。
  const absent = {};
  restoreZCodiumCuaBrokerSocketEnv(absent);
  assert.equal(absent[BROKER_SOCKET_ENV], undefined);
  const blank = { [FORK_CUA_BROKER_SOCKET_ENV]: "  " };
  restoreZCodiumCuaBrokerSocketEnv(blank);
  assert.equal(blank[BROKER_SOCKET_ENV], undefined);
  assert.equal(blank[FORK_CUA_BROKER_SOCKET_ENV], undefined);
});

test("fork key literal matches the shared constant (two modules share one contract)", () => {
  // desktopCuaBrokerSocket 刻意不 import shared（保持 node --test 零 workspace 依赖），
  // 两处字面量靠这里防守漂移。
  assert.equal(FORK_CUA_BROKER_SOCKET_ENV, "ZCODIUM_CUA_BROKER_SOCKET");
});

test("ensureForkCuaBrokerSocketDir creates the parent dir for fs sockets and no-ops for pipes", () => {
  const dir = join(tmpdir(), `zcode-cua-socket-test-${process.pid}`);
  const socketPath = join(dir, "broker.sock");
  ensureForkCuaBrokerSocketDir(socketPath);
  assert.ok(existsSync(dir), "expected the socket parent dir to be created");

  // named pipe 没有父目录概念：不得抛错、不得创建字面路径。
  ensureForkCuaBrokerSocketDir("\\\\.\\pipe\\zcode-cua-helper-zcodium");
  assert.ok(!existsSync("\\\\.\\pipe\\zcode-cua-helper-zcodium"));
});

test("vendor resolveBrokerSocketPath honors the hardcoded vendor key (lazy-binding drift guard)", async () => {
  // vendor 把 BROKER_SOCKET_ENV 放在 __esm 懒初始化块里，跨 chunk import 裸绑定可能
  // 是 undefined（2026-09-30 实测注入键退化为 "undefined"）。这里不比对其导出值，
  // 而是行为级验证：把标准键字面量喂给 vendor 的真实现，它必须原样采信——
  // 字面量与 vendor 漂移时此探针失败。
  const { resolveBrokerSocketPath } = await import(
    "../../../runtimes/zcode-cua/broker-socket-path.js"
  );
  const probe = "/probe/fork-cua-broker.sock";
  assert.equal(resolveBrokerSocketPath({ env: { [BROKER_SOCKET_ENV]: probe } }), probe);
});
