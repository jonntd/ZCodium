// remoteRelaySetConfig 请求解析的测试。
//
// 这里是一条**数据损坏回归守卫**：preload 曾把请求签名写成 (config, apply) 并再次包一层，
// 于是一次保存就把 `{ config, apply }` 信封写进了配置文件 → App 重启读不到 url、直接掉线。
// 校验必须让这种 payload 在写入之前就失败，并且历史坏文件能被自动还原。
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRemoteRelaySetConfigRequest,
  unwrapLegacyRemoteRelayConfigFile,
} from "../src/main/remoteRelayConfigPayload.ts";

const VALID_CONFIG = {
  url: "ws://127.0.0.1:3180",
  hostSecret: "devsecret",
  publicUrl: "http://127.0.0.1:3180",
  pairingToken: "token-123",
  workspace: "/Volumes/date/ZCodium",
  autoStart: true,
};

test("合法请求：返回扁平 config，apply 缺省为 true", () => {
  const parsed = parseRemoteRelaySetConfigRequest({ config: VALID_CONFIG });
  assert.deepEqual(parsed.config, VALID_CONFIG);
  assert.equal(parsed.apply, true);
  assert.equal(parseRemoteRelaySetConfigRequest({ config: VALID_CONFIG, apply: false }).apply, false);
});

test("回归守卫：被二次包装的信封 payload 必须被拒绝（不能再写坏配置）", () => {
  assert.throws(
    () => parseRemoteRelaySetConfigRequest({ config: { config: VALID_CONFIG, apply: true } }),
    /未知字段：config/,
  );
});

test("回归守卫：任意未知字段一律拒绝", () => {
  assert.throws(
    () => parseRemoteRelaySetConfigRequest({ config: { ...VALID_CONFIG, typo: 1 } }),
    /未知字段：typo/,
  );
});

test("可选字段清空（空串）必须能保存：公开地址/工作区/主机密钥/url", () => {
  // 清空公开地址 = 按中继地址推导；清空工作区 = 跟随窗口。历史上这些保存会被拒。
  const parsed = parseRemoteRelaySetConfigRequest({
    config: { url: "", hostSecret: "", publicUrl: "", workspace: "", pairingToken: "" },
  });
  assert.deepEqual(parsed.config, {
    url: "",
    hostSecret: "",
    publicUrl: "",
    workspace: "",
    pairingToken: "",
  });
});

test("字段级校验仍然生效（仅针对非空值）", () => {
  assert.throws(() => parseRemoteRelaySetConfigRequest({ config: { url: "http://x" } }), /ws:\/\//);
  assert.throws(() => parseRemoteRelaySetConfigRequest({ config: { publicUrl: "ws://x" } }), /http/);
  assert.throws(() => parseRemoteRelaySetConfigRequest({ config: { windowId: 0 } }), /正整数/);
  assert.throws(() => parseRemoteRelaySetConfigRequest({ config: { autoStart: "yes" } }), /布尔/);
  assert.throws(() => parseRemoteRelaySetConfigRequest({ config: "nope" }), /config 必须是对象/);
  assert.throws(() => parseRemoteRelaySetConfigRequest(null), /请求体必须是对象/);
});

test("E2EE 字段（e2ee/channelKey）可保存：布尔 + 32B base64url", () => {
  // 32 字节的 base64url（spec vps-relay-bridge.md §16）
  const channelKey = "uMyuWKCd7JfUgpqtTJyHwiRdP1Zt5RMo0Ec1j8Wj-mY";
  const parsed = parseRemoteRelaySetConfigRequest({
    config: { ...VALID_CONFIG, e2ee: true, channelKey },
  });
  assert.equal(parsed.config.e2ee, true);
  assert.equal(parsed.config.channelKey, channelKey);
});

test("E2EE 校验：channelKey 非法（长度/base64url）必须在写入前被拒", () => {
  assert.throws(
    () => parseRemoteRelaySetConfigRequest({ config: { e2ee: true, channelKey: "not-base64!!" } }),
    /channelKey 不合法/,
  );
  assert.throws(
    () =>
      parseRemoteRelaySetConfigRequest({
        config: { e2ee: true, channelKey: Buffer.from("short").toString("base64url") },
      }),
    /channelKey 不合法/,
  );
  assert.throws(
    () => parseRemoteRelaySetConfigRequest({ config: { e2ee: "yes" } }),
    /e2ee 必须是布尔值/,
  );
  // 空串 = 轮换（清空后由 Main 重新生成），必须放行
  assert.doesNotThrow(() =>
    parseRemoteRelaySetConfigRequest({ config: { e2ee: true, channelKey: "" } }),
  );
});

test("历史坏文件（信封形状）能被还原成扁平配置", () => {
  const recovered = unwrapLegacyRemoteRelayConfigFile({ config: VALID_CONFIG, apply: true });
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.config, VALID_CONFIG);
});

test("正常文件原样返回，不误判", () => {
  const flat = unwrapLegacyRemoteRelayConfigFile(VALID_CONFIG);
  assert.equal(flat.recovered, false);
  assert.deepEqual(flat.config, VALID_CONFIG);
});
