// ZCodium 私有 CUA broker socket（docs/spec/cua-runtime-builtin.md §D 跨安装共存）。
//
// 背景：stable socket 按 user 单例，官方 ZCode.app 的托管 helper 常驻其上，fork 的
// getStatus 探测/launch 全落空（2026-09-30 真机实测：每次查询 ~20s 后 unavailable）。
// 这里防守私有 socket 下发的三个语义：路径按平台隔离、用户显式注入优先、非 pipe
// 路径预创建父目录（vendor bind 不做 mkdir）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyForkCuaBrokerSocketEnv,
  BROKER_SOCKET_ENV,
  ensureForkCuaBrokerSocketDir,
  resolveForkCuaBrokerSocketPath,
} from "../src/main/desktopCuaBrokerSocket.js";

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

test("applyForkCuaBrokerSocketEnv injects by default and respects explicit user values", () => {
  const injected = applyForkCuaBrokerSocketEnv({});
  assert.equal(typeof injected[BROKER_SOCKET_ENV], "string");
  assert.ok(injected[BROKER_SOCKET_ENV]?.includes("zcodium"));

  // 空白值视同未设置：替换为 fork 私有路径。
  const whitespace = applyForkCuaBrokerSocketEnv({ [BROKER_SOCKET_ENV]: "   " });
  assert.notEqual(whitespace[BROKER_SOCKET_ENV]?.trim(), "");

  // 用户显式注入原样保留（与 ZCODE_CUA_BUNDLED_HELPER_APP_PATH 同策略）。
  const explicit = applyForkCuaBrokerSocketEnv({
    [BROKER_SOCKET_ENV]: "/custom/broker.sock",
  });
  assert.equal(explicit[BROKER_SOCKET_ENV], "/custom/broker.sock");

  // 纯函数：不修改入参。
  const source = {};
  applyForkCuaBrokerSocketEnv(source);
  assert.equal(source[BROKER_SOCKET_ENV], undefined);
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

test("vendor resolveBrokerSocketPath honors the hardcoded env key (lazy-binding drift guard)", async () => {
  // vendor 把 BROKER_SOCKET_ENV 放在 __esm 懒初始化块里，跨 chunk import 裸绑定可能
  // 是 undefined（2026-09-30 实测注入键退化为 "undefined"）。这里不比对其导出值，
  // 而是行为级验证：把本模块的字面量喂给 vendor 的真实现，它必须原样采信——
  // 字面量与 vendor 漂移时此探针失败。
  const { resolveBrokerSocketPath } = await import(
    "../../../runtimes/zcode-cua/broker-socket-path.js"
  );
  const probe = "/probe/fork-cua-broker.sock";
  assert.equal(resolveBrokerSocketPath({ env: { [BROKER_SOCKET_ENV]: probe } }), probe);
});
