// 远程访问「连接协议 → 中继地址」换算的测试。
//
// 这里钉住的是一条填错就**直接连不上中继**的规则：地址框只填主机，协议前缀由协议选项补
// （明文 ws:// / TLS wss://），且回填时不能把协议重复拼进去。
// 该维度只决定前缀，与地址是内网还是公网无关（纯 IP 部署即「公网地址 + 明文 ws」）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRelayUrl,
  composeLanSuggestion,
  DEFAULT_LOCAL_RELAY_HOST,
  DEFAULT_PUBLIC_URL,
  extractRelayPort,
  isLoopbackRelayHost,
  resolveRelayScenario,
  stripRelayScheme,
} from "../src/remoteRelayScenario.js";

test("协议选项由已保存的 url 反推，空配置默认明文 ws://", () => {
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

test("协议选项 + 主机拼回完整 url（明文 ws / TLS wss）", () => {
  assert.equal(buildRelayUrl("lan", "192.168.1.10:3180"), "ws://192.168.1.10:3180");
  assert.equal(buildRelayUrl("public", "relay.example.com"), "wss://relay.example.com");
  // 用户多打了空格：trim 后拼接，不产生 "ws:// relay…"
  assert.equal(buildRelayUrl("public", "  relay.example.com  "), "wss://relay.example.com");
});

test("主机为空表示未配置（不产生 ws:// 空壳）", () => {
  assert.equal(buildRelayUrl("lan", ""), "");
  assert.equal(buildRelayUrl("public", "   "), "");
});

test("回填往返：strip + build 对同一协议选项是幂等的", () => {
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

test("v4 表单默认值：DEFAULT_LOCAL_RELAY_HOST 是本机 loopback + 缺省端口，明文 ws 可直接用", () => {
  // 预填的是「relay 跑在本机」的零配置路径：桌面拨 loopback 最稳（不受 DHCP 影响），
  // 内网链接由 Main 自动换成局域网 IP（spec §15.4 v4）。
  assert.equal(DEFAULT_LOCAL_RELAY_HOST, "127.0.0.1:3180");
  assert.equal(isLoopbackRelayHost(DEFAULT_LOCAL_RELAY_HOST), true);
  // 组合出的完整 url 形状正确，且 strip 后能无损还原（表单 round-trip 不漂移）。
  const url = buildRelayUrl("lan", DEFAULT_LOCAL_RELAY_HOST);
  assert.equal(url, "ws://127.0.0.1:3180");
  assert.equal(stripRelayScheme(url), DEFAULT_LOCAL_RELAY_HOST);
  assert.equal(resolveRelayScenario(url), "lan");
});

test("v4 公开地址默认值：DEFAULT_PUBLIC_URL 是当前部署的 VPS 隧道入口（非 loopback）", () => {
  // 本机 relay 的外网入口无法由中继地址推导（loopback 推导 = 127.0.0.1），按当前部署预填。
  assert.equal(DEFAULT_PUBLIC_URL, "http://104.223.21.20:3181");
  assert.equal(isLoopbackRelayHost(stripRelayScheme(DEFAULT_PUBLIC_URL)), false);
});
