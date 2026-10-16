// resolveRelayHostSecret 与统一默认值的单元测试（spec vps-relay-bridge.md §15.4）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_RELAY_HOST_SECRET, resolveRelayHostSecret } from "../src/remote-relay.ts";

test("env 值优先于配置文件", () => {
  assert.equal(resolveRelayHostSecret("env-secret", "file-secret"), "env-secret");
});

test("配置文件值优先于统一默认值", () => {
  assert.equal(resolveRelayHostSecret(undefined, "file-secret"), "file-secret");
  assert.equal(resolveRelayHostSecret("", "file-secret"), "file-secret");
});

test("两者都缺省（空串 / 纯空白也算缺省）时回退统一默认值", () => {
  assert.equal(resolveRelayHostSecret(undefined, undefined), DEFAULT_RELAY_HOST_SECRET);
  assert.equal(resolveRelayHostSecret("", ""), DEFAULT_RELAY_HOST_SECRET);
  assert.equal(resolveRelayHostSecret("   ", "  "), DEFAULT_RELAY_HOST_SECRET);
});

test("跨文件同步守卫：relay.mjs 的 DEFAULT_HOST_SECRET 与 shared 常量一致", async () => {
  // relay.mjs 是独立部署的单文件脚本，不能 import shared；两端默认值必须手工同步，
  // 这条断言把「改了 shared 忘了改 relay」变成测试失败而不是线上 401。
  const relaySource = await readFile(
    new URL("../../../deploy/vps-relay/relay.mjs", import.meta.url),
    "utf8",
  );
  assert.match(relaySource, new RegExp(`DEFAULT_HOST_SECRET = "${DEFAULT_RELAY_HOST_SECRET}"`));
});
