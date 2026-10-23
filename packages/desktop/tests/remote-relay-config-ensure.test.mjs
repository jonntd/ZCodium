// 「App 启动即补齐密钥」的回归测试（spec vps-relay-bridge.md §15.4 / §19）。
//
// 背景（用户实测「新设备并没有自动生成」）：此前全新设备（还没有中继地址）打开
// 设置页什么都不会生成——resolveEffectiveConfig 无 url 即返回 null，autoStart /
// GetStatus / start 都在 ensure 之前早退。现在补齐链（ensureRelaySecrets）在
// resolve 之前无条件执行：一开机就生成 roomKey + channelKey 并落盘。
//
// v6 key-room（§19）：原「配对码 + 主机密钥 + 槽位基址」三条补齐链收敛为
// ensureRoomKey（含 v5 迁移）+ ensureE2eeChannelKey；无任何默认常量回填。
//
// 测的是拆分出的纯逻辑模块 remoteRelayConfig.ts：控制模块 import 了 electron
// （ipcMain），原生 ESM 具名导出检查会在链接期拒绝加载，纯 Node 测试只能测这一层。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_RELAY_CHANNEL_KEY,
  DEFAULT_RELAY_HOST_SECRET,
  DEFAULT_RELAY_PAIRING_TOKEN,
} from "@zcode/shared";

// ZCODE_DATA_BASE_DIR 在 paths.ts 模块加载时捕获 ⇒ 先设 env 再动态 import。
// node --test 每个测试文件跑在独立子进程，env 不会污染同批其他测试文件。
const dataDir = mkdtempSync(join(tmpdir(), "relay-ensure-"));
process.env.ZCODE_DATA_BASE_DIR = dataDir;
delete process.env.ZCODE_REMOTE_RELAY_URL;
delete process.env.ZCODE_REMOTE_RELAY_E2EE;

const { ensureRelaySecrets, readConfigFile, resolveEffectiveConfig, shouldAutoStartRelay } =
  await import("../src/main/remoteRelayConfig.ts");

const configPath = join(dataDir, ".zcodium", "v2", "remote-relay.json");

function readConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function writeConfig(config) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

const logs = [];
const logger = {
  info: (message) => logs.push(["info", message]),
  warn: (message) => logs.push(["warn", message]),
};

/** 32B 随机密钥的 base64url 形态（32 字节 → 43 字符，无 padding）。 */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

function assertRandomKey(value, label) {
  assert.equal(typeof value, "string", `${label}：应生成密钥`);
  assert.match(value, KEY_RE, `${label}：应为 32B base64url`);
}

// ── v6 key-room：roomKey 补齐与 v5 迁移（spec §19.5）────────────────────────

test("v6 全新设备（无配置文件）：roomKey 与 channelKey 随机生成并落盘，无默认常量回填", async () => {
  rmSync(configPath, { force: true });
  const ensured = await ensureRelaySecrets(null, logger);
  assertRandomKey(ensured.roomKey, "全新设备 roomKey");
  assert.notEqual(ensured.roomKey, DEFAULT_RELAY_PAIRING_TOKEN);
  assert.notEqual(ensured.roomKey, DEFAULT_RELAY_HOST_SECRET);
  // v4 默认开启：无 e2ee 字段 ⇒ 默认加密，channelKey 一并生成（spec §16.5）。
  // v5 起是**随机生成**，不是回填默认常量。
  assertRandomKey(ensured.channelKey, "全新设备 channelKey");
  assert.notEqual(ensured.channelKey, DEFAULT_RELAY_CHANNEL_KEY, "channelKey 不应回填仓库默认常量（v5）");
  // 落盘内容与返回值一致
  const file = readConfig();
  assert.equal(file.roomKey, ensured.roomKey);
  assert.equal(file.channelKey, ensured.channelKey);
});

test("regression：无中继地址也补齐（此前 resolve 为 null 直接早退什么都不生成）", async () => {
  rmSync(configPath, { force: true });
  writeConfig({ roomKey: "" });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assertRandomKey(ensured.roomKey, "无地址补齐");
  // 补齐与「是否配置了中继」是两个独立步骤：仍无 url ⇒ 未配置。
  assert.equal(resolveEffectiveConfig(ensured), null);
  assert.equal(shouldAutoStartRelay(ensured, undefined), false);
});

test("幂等：重复补齐不更换已生成的 roomKey 与 channelKey", async () => {
  const first = await ensureRelaySecrets(null, logger);
  const second = await ensureRelaySecrets(first, logger);
  assert.equal(second.roomKey, first.roomKey);
  assert.equal(second.channelKey, first.channelKey);
});

test("v6 迁移：v5 自定义 pairingToken 沿用为 roomKey（旧手机链接继续可用），旧字段落盘时移除", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    pairingToken: "my-custom-pairing-token",
    hostSecret: "my-custom-secret",
  });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.roomKey, "my-custom-pairing-token", "pairingToken 优先沿用");
  const file = readConfig();
  assert.equal(file.roomKey, "my-custom-pairing-token");
  assert.equal("pairingToken" in file, false, "迁移后旧字段应从文件移除");
  assert.equal("hostSecret" in file, false, "迁移后旧字段应从文件移除");
});

test("v6 迁移：只有自定义 hostSecret 时沿用", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", hostSecret: "only-host-secret" });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.roomKey, "only-host-secret");
});

test("v6 迁移：公开常量值视为已泄露，轮换为随机 roomKey", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    pairingToken: DEFAULT_RELAY_PAIRING_TOKEN,
    hostSecret: DEFAULT_RELAY_HOST_SECRET,
  });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assertRandomKey(ensured.roomKey, "公开常量轮换");
  assert.notEqual(ensured.roomKey, DEFAULT_RELAY_PAIRING_TOKEN);
  assert.notEqual(ensured.roomKey, DEFAULT_RELAY_HOST_SECRET);
});

test("v6 轮换语义：清空 roomKey 保存 → 重新随机生成（旧手机链接全部失效）", async () => {
  const before = await ensureRelaySecrets(await readConfigFile(), logger);
  const cleared = readConfig();
  delete cleared.roomKey;
  writeConfig(cleared);
  const after = await ensureRelaySecrets(await readConfigFile(), logger);
  assertRandomKey(after.roomKey, "轮换后");
  assert.notEqual(after.roomKey, before.roomKey);
});

test("resolveEffectiveConfig：roomKey 透传（生成时机收口在补齐链）", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", roomKey: "transparent-room-key" });
  const config = resolveEffectiveConfig(await readConfigFile());
  assert.equal(config?.roomKey, "transparent-room-key");
});

test("shouldAutoStartRelay：补齐与启动是两个独立步骤", () => {
  assert.equal(shouldAutoStartRelay({}, undefined), false);
  assert.equal(shouldAutoStartRelay({ url: "ws://relay.example.com" }, undefined), true);
  assert.equal(
    shouldAutoStartRelay({ url: "ws://relay.example.com", autoStart: false }, undefined),
    false,
  );
  assert.equal(shouldAutoStartRelay({}, "ws://relay.example.com"), true);
});

// ── E2EE（spec §16.5，v4/v5 语义不变，v6 只换配置形状）───────────────────────

test("v4 默认开启：文件无 e2ee 字段 ⇒ resolve 判定加密且补齐生成 channelKey", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", roomKey: "x".repeat(32) });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assertRandomKey(ensured.channelKey, "默认开启");
  const config = resolveEffectiveConfig(ensured);
  assert.equal(config?.e2ee, true);
});

test("v4：显式 e2ee: false（用户主动关闭）不被默认值覆盖", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", roomKey: "x".repeat(32), e2ee: false });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.channelKey, undefined);
  const config = resolveEffectiveConfig(ensured);
  assert.equal(config?.e2ee, false);
});

test("v4：env 显式优先——ZCODE_REMOTE_RELAY_E2EE=0 压过默认开启，=1 压过显式 false", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", roomKey: "x".repeat(32), e2ee: false });
  try {
    process.env.ZCODE_REMOTE_RELAY_E2EE = "0";
    assert.equal(resolveEffectiveConfig(await readConfigFile())?.e2ee, false);
    process.env.ZCODE_REMOTE_RELAY_E2EE = "1";
    assert.equal(resolveEffectiveConfig(await readConfigFile())?.e2ee, true);
  } finally {
    delete process.env.ZCODE_REMOTE_RELAY_E2EE;
  }
});

test("v4：幂等补齐不更换已生成的 channelKey", async () => {
  // 自置前置（默认开启形态），不吃上一个用例留下的 e2ee: false。
  writeConfig({ url: "ws://127.0.0.1:3180", roomKey: "x".repeat(32) });
  const first = await ensureRelaySecrets(await readConfigFile(), logger);
  const second = await ensureRelaySecrets(first, logger);
  assertRandomKey(first.channelKey, "首次生成");
  assert.equal(second.channelKey, first.channelKey);
});

test("v5：两次全新设备补齐得到不同 channelKey（随机而非共享常量）", async () => {
  rmSync(configPath, { force: true });
  const first = await ensureRelaySecrets(null, logger);
  rmSync(configPath, { force: true });
  const second = await ensureRelaySecrets(null, logger);
  assertRandomKey(first.channelKey, "设备 A");
  assertRandomKey(second.channelKey, "设备 B");
  assert.notEqual(first.channelKey, second.channelKey);
});

test("v5：v4 期间落盘的默认 channelKey 原值保留（不回改，否则既有链接全部失效）", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    roomKey: "x".repeat(32),
    channelKey: DEFAULT_RELAY_CHANNEL_KEY,
  });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.channelKey, DEFAULT_RELAY_CHANNEL_KEY);
});

test("v5：清空 channelKey 保存 = 轮换（重新随机生成，旧链接失效）", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", roomKey: "x".repeat(32) });
  const before = await ensureRelaySecrets(await readConfigFile(), logger);
  const cleared = readConfig();
  delete cleared.channelKey;
  writeConfig(cleared);
  const after = await ensureRelaySecrets(await readConfigFile(), logger);
  assertRandomKey(after.channelKey, "轮换后");
  assert.notEqual(after.channelKey, before.channelKey);
});

test("自定义 channelKey 不被默认值覆盖", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    roomKey: "x".repeat(32),
    channelKey: "my-custom-channel-key",
  });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.channelKey, "my-custom-channel-key");
});
