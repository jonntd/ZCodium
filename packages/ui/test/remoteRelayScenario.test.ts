// 远程访问「场景 → 中继地址」换算的测试。
//
// 这里钉住的是一条填错就**直接连不上中继**的规则：地址框只填主机，协议由场景补
// （内网 ws:// / 公网 wss://），且回填时不能把协议重复拼进去。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRelayUrl,
  composeLanSuggestion,
  extractRelayPort,
  isLoopbackRelayHost,
  resolveRelayScenario,
  stripRelayScheme,
} from "../src/settings/remoteRelayScenario.js";

test("场景由上保存的协议反推，空配置默认内网", () => {
  assert.equal(resolveRelayScenario("ws://192.168.1.10:3180"), "lan");
  assert.equal(resolveRelayScenario("wss://relay.example.com"), "public");
  assert.equal(resolveRelayScenario("WSS://relay.example.com"), "public");
  assert.equal(resolveRelayScenario(""), "lan");
  assert.equal(resolveRelayScenario(undefined), "lan");
});

test("地址框只显示主机（协议不重复、端口保留）", () => {
  assert.equal(stripRelayScheme("ws://192.168.1.10:3180"), "192.168.1.10:3180");
  assert.equal(stripRelayScheme("wss://relay.example.com"), "relay.example.com");
  assert.equal(stripRelayScheme(""), "");
});

test("场景 + 主机拼回完整 url（内网 ws / 公网 wss）", () => {
  assert.equal(buildRelayUrl("lan", "192.168.1.10:3180"), "ws://192.168.1.10:3180");
  assert.equal(buildRelayUrl("public", "relay.example.com"), "wss://relay.example.com");
  // 用户多打了空格：trim 后拼接，不产生 "ws:// relay…"
  assert.equal(buildRelayUrl("public", "  relay.example.com  "), "wss://relay.example.com");
});

test("主机为空表示未配置（不产生 ws:// 空壳）", () => {
  assert.equal(buildRelayUrl("lan", ""), "");
  assert.equal(buildRelayUrl("public", "   "), "");
});

test("回填往返：strip + build 对同一场景是幂等的", () => {
  for (const url of ["ws://192.168.1.10:3180", "wss://relay.example.com"]) {
    const scenario = resolveRelayScenario(url);
    assert.equal(buildRelayUrl(scenario, stripRelayScheme(url)), url);
  }
});

test("loopback 识别：127.x / localhost / ::1 都算本机", () => {
  for (const host of ["127.0.0.1", "127.0.1.1:3180", "localhost", "localhost:3180", "[::1]:3180"]) {
    assert.equal(isLoopbackRelayHost(host), true, host);
  }
  for (const host of ["192.168.1.10:3180", "relay.example.com", "10.0.0.5"]) {
    assert.equal(isLoopbackRelayHost(host), false, host);
  }
});

test("端口从 url 取，缺省 3180", () => {
  assert.equal(extractRelayPort("ws://127.0.0.1:3180"), "3180");
  assert.equal(extractRelayPort("wss://relay.example.com:8443"), "8443");
  assert.equal(extractRelayPort("wss://relay.example.com"), "3180");
  assert.equal(extractRelayPort(""), "3180");
});

test("内网建议地址 = 首个检测到的局域网 IP + 当前端口", () => {
  assert.equal(composeLanSuggestion(["192.168.1.10", "10.0.0.5"], "3180"), "192.168.1.10:3180");
  assert.equal(composeLanSuggestion([], "3180"), null);
  assert.equal(composeLanSuggestion(undefined, "3180"), null);
});

test("也接受完整 URL（手机访问地址就是这种形状）", () => {
  assert.equal(isLoopbackRelayHost("http://127.0.0.1:3180"), true);
  assert.equal(isLoopbackRelayHost("ws://localhost:3180"), true);
  assert.equal(isLoopbackRelayHost("http://192.168.8.105:3180"), false);
  assert.equal(isLoopbackRelayHost("https://relay.example.com"), false);
});
