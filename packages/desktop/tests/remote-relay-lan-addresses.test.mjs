// 局域网地址探测 + 手机侧内网地址拼装的测试：
// 探测必须只挑可用的 IPv4；内网地址的主机必须按「中继在哪台机器上」决定。
import assert from "node:assert/strict";
import test from "node:test";
import {
  composeLanPublicUrl,
  pickRemoteRelayLanAddresses,
} from "../src/main/remoteRelayLanAddresses.ts";

function entry(address, family, internal = false) {
  return { address, netmask: "255.255.255.0", family, mac: "00:00:00:00:00:00", internal, cidr: null };
}

test("只挑非 loopback / 非链路本地的 IPv4，并去重", () => {
  const picked = pickRemoteRelayLanAddresses({
    lo0: [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
    en0: [entry("192.168.1.10", "IPv4"), entry("fe80::1", "IPv6")],
    en1: [entry("169.254.3.4", "IPv4"), entry("192.168.1.10", "IPv4")],
  });
  assert.deepEqual(picked, ["192.168.1.10"]);
});

test("私有网段优先于其它地址", () => {
  const picked = pickRemoteRelayLanAddresses({
    utun3: [entry("100.64.0.7", "IPv4")],           // CGNAT/隧道
    en0: [entry("10.0.0.5", "IPv4")],               // 私有
    en1: [entry("172.20.3.9", "IPv4")],             // 私有
  });
  assert.deepEqual(picked, ["10.0.0.5", "172.20.3.9", "100.64.0.7"]);
});

test("family 以数字给出（旧 Node）也能识别，空输入不炸", () => {
  assert.deepEqual(pickRemoteRelayLanAddresses({ en0: [entry("192.168.0.2", 4)] }), ["192.168.0.2"]);
  assert.deepEqual(pickRemoteRelayLanAddresses(undefined), []);
  assert.deepEqual(pickRemoteRelayLanAddresses({}), []);
});

test("中继在本机（loopback）：换成检测到的局域网 IP + 中继端口", () => {
  assert.equal(composeLanPublicUrl(["192.168.8.105"], "ws://127.0.0.1:3180"), "http://192.168.8.105:3180");
  assert.equal(composeLanPublicUrl(["10.0.0.5"], "ws://localhost:8443"), "http://10.0.0.5:8443");
  assert.equal(composeLanPublicUrl([], "ws://127.0.0.1:3180"), null);
  assert.equal(composeLanPublicUrl(undefined, "ws://127.0.0.1:3180"), null);
});

test("中继在局域网内另一台机器：原样沿用它的主机，不换成桌面机 IP", () => {
  // NAS 上的中继：手机直连 192.168.1.50，而不是桌面机自己的 192.168.8.105。
  assert.equal(
    composeLanPublicUrl(["192.168.8.105"], "ws://192.168.1.50:3180"),
    "http://192.168.1.50:3180",
  );
  assert.equal(composeLanPublicUrl(["10.0.0.5"], "ws://10.0.0.9:8443"), "http://10.0.0.9:8443");
  // 中继在另一台机器时，不需要检测到桌面机自己的局域网地址。
  assert.equal(composeLanPublicUrl([], "ws://192.168.1.50:3180"), "http://192.168.1.50:3180");
});

test("中继在公网（VPS / 域名 / 公网 IP）：局域网里没有它，不给内网地址", () => {
  assert.equal(composeLanPublicUrl(["10.0.0.5"], "wss://relay.example.com:8443"), null);
  assert.equal(composeLanPublicUrl(["10.0.0.5"], "wss://relay.example.com"), null);
  assert.equal(composeLanPublicUrl(["10.0.0.5"], "ws://104.223.21.20:3180"), null);
});
