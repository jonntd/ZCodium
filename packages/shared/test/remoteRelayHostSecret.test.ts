// resolveRelayRoomKey 与 roomKey 生成的单元测试（spec vps-relay-bridge.md §19.5）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RELAY_HOST_SECRET,
  DEFAULT_RELAY_PAIRING_TOKEN,
  RELAY_ROOM_KEY_MAX_LENGTH,
  generateRelayRoomKey,
  resolveRelayRoomKey,
} from "../src/remote-relay.ts";

test("已有 roomKey 原样沿用（幂等）", () => {
  assert.deepEqual(resolveRelayRoomKey({ roomKey: "my-room-key-1234" }), {
    roomKey: "my-room-key-1234",
    source: "kept",
  });
  // 纯空白也视为缺省，走迁移决策
  assert.notEqual(resolveRelayRoomKey({ roomKey: "   " }).roomKey.trim(), "");
});

test("v5 自定义旧值沿用为 roomKey（旧手机链接继续可用）", () => {
  assert.deepEqual(
    resolveRelayRoomKey({ pairingToken: "custom-pairing-token-1234" }),
    { roomKey: "custom-pairing-token-1234", source: "kept" },
  );
  // pairingToken 与 hostSecret 同时存在时优先 pairingToken（它就是链接里的凭据）
  assert.deepEqual(
    resolveRelayRoomKey({ pairingToken: "token-12345678", hostSecret: "secret-12345678" }),
    { roomKey: "token-12345678", source: "kept" },
  );
  // 只有 hostSecret 时也沿用
  assert.deepEqual(resolveRelayRoomKey({ hostSecret: "secret-12345678" }), {
    roomKey: "secret-12345678",
    source: "kept",
  });
});

test("公开常量视为已泄露：等于默认常量的旧值必须轮换", () => {
  for (const leaked of [DEFAULT_RELAY_HOST_SECRET, DEFAULT_RELAY_PAIRING_TOKEN]) {
    const result = resolveRelayRoomKey({ pairingToken: leaked });
    assert.equal(result.source, "generated");
    assert.notEqual(result.roomKey, leaked);
  }
});

test("缺省时随机生成（不回填任何默认常量，spec §19.5）", () => {
  const result = resolveRelayRoomKey({});
  assert.equal(result.source, "generated");
  assert.ok(result.roomKey.length > 0);
  assert.ok(!result.roomKey.includes(DEFAULT_RELAY_HOST_SECRET));
});

test("超长旧值不沿用（防把任意垃圾当房间密钥）", () => {
  const tooLong = "k".repeat(RELAY_ROOM_KEY_MAX_LENGTH + 1);
  assert.equal(resolveRelayRoomKey({ pairingToken: tooLong }).source, "generated");
});

test("generateRelayRoomKey：43 字符 base64url，两次生成不同", () => {
  const a = generateRelayRoomKey();
  const b = generateRelayRoomKey();
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
});
