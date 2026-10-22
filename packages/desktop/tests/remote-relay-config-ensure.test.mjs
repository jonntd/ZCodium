// 「App 启动即补齐密钥」的回归测试（spec vps-relay-bridge.md §15.4）。
//
// 背景（用户实测「新设备并没有自动生成」）：此前全新设备（还没有中继地址）打开
// 设置页什么都不会生成——resolveEffectiveConfig 无 url 即返回 null，autoStart /
// GetStatus / start 都在 ensure 之前早退。现在补齐链（ensureRelaySecrets）在
// resolve 之前无条件执行：一开机就生成配对码 + 统一默认主机密钥并落盘。
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
delete process.env.ZCODE_REMOTE_RELAY_HOST_SECRET;
delete process.env.ZCODE_REMOTE_RELAY_E2EE;
delete process.env.ZCODE_REMOTE_RELAY_SLOT_BASE;

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

/** 32B 随机 channelKey 的 base64url 形态（32 字节 → 43 字符，无 padding）。 */
const CHANNEL_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * v5（2026-10-22）：channelKey 恢复随机生成，**不再等于**仓库常量
 * `DEFAULT_RELAY_CHANNEL_KEY`（v4 曾回填它，使 E2EE 保密性退化为全局公开常量）。
 */
function assertRandomChannelKey(value, label) {
  assert.equal(typeof value, "string", `${label}：应生成 channelKey`);
  assert.match(value, CHANNEL_KEY_RE, `${label}：应为 32B base64url`);
  assert.notEqual(value, DEFAULT_RELAY_CHANNEL_KEY, `${label}：不应回填仓库默认常量（v5）`);
}

test("全新设备（无配置文件）：配对码/主机密钥回填默认值，channelKey/槽位基址随机生成并落盘", async () => {
  rmSync(configPath, { force: true });
  const ensured = await ensureRelaySecrets(null, logger);
  // 配对码仍固定回填统一默认值（= 当前部署 relay 的 RELAY_TOKEN），新设备开箱即配对。
  assert.equal(ensured.pairingToken, DEFAULT_RELAY_PAIRING_TOKEN);
  assert.equal(ensured.hostSecret, DEFAULT_RELAY_HOST_SECRET);
  assert.equal(typeof ensured.slotBase, "number");
  assert.ok(ensured.slotBase >= 0 && ensured.slotBase <= 91);
  // v4 默认开启：无 e2ee 字段 ⇒ 默认加密，channelKey 一并生成（spec §16.5）。
  // v5 起是**随机生成**，不是回填默认常量。
  assertRandomChannelKey(ensured.channelKey, "全新设备");
  // 落盘内容与返回值一致
  const file = readConfig();
  assert.equal(file.pairingToken, ensured.pairingToken);
  assert.equal(file.hostSecret, DEFAULT_RELAY_HOST_SECRET);
  assert.equal(file.slotBase, ensured.slotBase);
  assert.equal(file.channelKey, ensured.channelKey);
});

test("regression：无中继地址也补齐（此前 resolve 为 null 直接早退什么都不生成）", async () => {
  // 文件存在但只有空密钥、没有任何 url。
  writeConfig({ pairingToken: "", hostSecret: "" });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.pairingToken, DEFAULT_RELAY_PAIRING_TOKEN);
  assert.equal(ensured.hostSecret, DEFAULT_RELAY_HOST_SECRET);
  // 补齐与「是否配置了中继」是两个独立步骤：仍无 url ⇒ 未配置。
  assert.equal(resolveEffectiveConfig(ensured), null);
  assert.equal(shouldAutoStartRelay(ensured, undefined), false);
});

test("幂等：重复补齐不更换已生成的配对码与主机密钥", async () => {
  const first = await ensureRelaySecrets(null, logger);
  const second = await ensureRelaySecrets(first, logger);
  assert.equal(second.pairingToken, first.pairingToken);
  assert.equal(second.hostSecret, first.hostSecret);
  assert.equal(second.slotBase, first.slotBase);
});

test("轮换语义（v4）：清空配对码补齐回填的是同一个统一默认值，轮换须手动填新值", async () => {
  const current = readConfig();
  delete current.pairingToken;
  writeConfig(current);
  const before = (await ensureRelaySecrets(await readConfigFile(), logger)).pairingToken;
  assert.equal(before, DEFAULT_RELAY_PAIRING_TOKEN);
  // 再清一次 ⇒ 仍回填同一默认值（不再逐设备随机）。真正轮换 = UI 手动填新值并同步 relay。
  const cleared = readConfig();
  delete cleared.pairingToken;
  writeConfig(cleared);
  const after = (await ensureRelaySecrets(await readConfigFile(), logger)).pairingToken;
  assert.equal(after, DEFAULT_RELAY_PAIRING_TOKEN);
});

test("自定义配对码不被默认值覆盖", async () => {
  writeConfig({ ...readConfig(), pairingToken: "my-custom-pairing-token" });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.pairingToken, "my-custom-pairing-token");
});

test("已有自定义主机密钥时不被默认值覆盖", async () => {
  writeConfig({ ...readConfig(), hostSecret: "my-custom-secret" });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.hostSecret, "my-custom-secret");
});

test("resolveEffectiveConfig：hostSecret 缺省回退统一默认值", () => {
  const config = resolveEffectiveConfig({ url: "ws://127.0.0.1:3180" });
  assert.equal(config?.hostSecret, DEFAULT_RELAY_HOST_SECRET);
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

// ── v4（2026-10-21）：E2EE 默认开启（spec §16.5）─────────────────────────────

test("v4 默认开启：文件无 e2ee 字段 ⇒ resolve 判定加密且补齐生成 channelKey", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", pairingToken: "x".repeat(32), hostSecret: "s" });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assertRandomChannelKey(ensured.channelKey, "默认开启");
  const config = resolveEffectiveConfig(ensured);
  assert.equal(config?.e2ee, true);
});

test("v4：显式 e2ee: false（用户主动关闭）不被默认值覆盖", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    pairingToken: "x".repeat(32),
    hostSecret: "s",
    e2ee: false,
  });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.channelKey, undefined);
  const config = resolveEffectiveConfig(ensured);
  assert.equal(config?.e2ee, false);
});

test("v4：env 显式优先——ZCODE_REMOTE_RELAY_E2EE=0 压过默认开启，=1 压过显式 false", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    pairingToken: "x".repeat(32),
    hostSecret: "s",
    e2ee: false,
  });
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
  writeConfig({ url: "ws://127.0.0.1:3180", pairingToken: "x".repeat(32), hostSecret: "s" });
  const first = await ensureRelaySecrets(await readConfigFile(), logger);
  const second = await ensureRelaySecrets(first, logger);
  assertRandomChannelKey(first.channelKey, "首次生成");
  assert.equal(second.channelKey, first.channelKey);
});

test("v5：两次全新设备补齐得到不同 channelKey（随机而非共享常量）", async () => {
  rmSync(configPath, { force: true });
  const first = await ensureRelaySecrets(null, logger);
  rmSync(configPath, { force: true });
  const second = await ensureRelaySecrets(null, logger);
  assertRandomChannelKey(first.channelKey, "设备 A");
  assertRandomChannelKey(second.channelKey, "设备 B");
  assert.notEqual(first.channelKey, second.channelKey);
});

test("v5：v4 期间落盘的默认 channelKey 原值保留（不回改，否则既有链接全部失效）", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    pairingToken: "x".repeat(32),
    hostSecret: "s",
    channelKey: DEFAULT_RELAY_CHANNEL_KEY,
  });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.channelKey, DEFAULT_RELAY_CHANNEL_KEY);
});

test("v5：清空 channelKey 保存 = 轮换（重新随机生成，旧链接失效）", async () => {
  writeConfig({ url: "ws://127.0.0.1:3180", pairingToken: "x".repeat(32), hostSecret: "s" });
  const before = await ensureRelaySecrets(await readConfigFile(), logger);
  const cleared = readConfig();
  delete cleared.channelKey;
  writeConfig(cleared);
  const after = await ensureRelaySecrets(await readConfigFile(), logger);
  assertRandomChannelKey(after.channelKey, "轮换后");
  assert.notEqual(after.channelKey, before.channelKey);
});

test("自定义 channelKey 不被默认值覆盖", async () => {
  writeConfig({
    url: "ws://127.0.0.1:3180",
    pairingToken: "x".repeat(32),
    hostSecret: "s",
    channelKey: "my-custom-channel-key",
  });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.equal(ensured.channelKey, "my-custom-channel-key");
});
