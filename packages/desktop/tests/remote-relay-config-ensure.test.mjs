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
import { DEFAULT_RELAY_HOST_SECRET } from "@zcode/shared";

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
/** 24 字节 base64url = 32 字符（generatePairingToken）。 */
const PAIRING_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

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

test("全新设备（无配置文件）：补齐生成配对码 + 统一默认主机密钥 + 槽位基址并落盘", async () => {
  rmSync(configPath, { force: true });
  const ensured = await ensureRelaySecrets(null, logger);
  assert.match(ensured.pairingToken ?? "", PAIRING_TOKEN_RE);
  assert.equal(ensured.hostSecret, DEFAULT_RELAY_HOST_SECRET);
  assert.equal(typeof ensured.slotBase, "number");
  assert.ok(ensured.slotBase >= 0 && ensured.slotBase <= 91);
  // 落盘内容与返回值一致
  const file = readConfig();
  assert.equal(file.pairingToken, ensured.pairingToken);
  assert.equal(file.hostSecret, DEFAULT_RELAY_HOST_SECRET);
  assert.equal(file.slotBase, ensured.slotBase);
});

test("regression：无中继地址也补齐（此前 resolve 为 null 直接早退什么都不生成）", async () => {
  // 文件存在但只有空密钥、没有任何 url。
  writeConfig({ pairingToken: "", hostSecret: "" });
  const ensured = await ensureRelaySecrets(await readConfigFile(), logger);
  assert.match(ensured.pairingToken ?? "", PAIRING_TOKEN_RE);
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

test("轮换：清空配对码后下一次补齐重新生成", async () => {
  const current = readConfig();
  delete current.pairingToken;
  writeConfig(current);
  const before = (await ensureRelaySecrets(await readConfigFile(), logger)).pairingToken;
  assert.match(before ?? "", PAIRING_TOKEN_RE);
  // 再清一次 ⇒ 新值与上次不同。
  const cleared = readConfig();
  delete cleared.pairingToken;
  writeConfig(cleared);
  const after = (await ensureRelaySecrets(await readConfigFile(), logger)).pairingToken;
  assert.match(after ?? "", PAIRING_TOKEN_RE);
  assert.notEqual(after, before);
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
