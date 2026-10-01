// 局域网地址探测的测试：设置页「内网」场景的建议地址必须只挑可用的 IPv4。
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

test("手机侧公开地址建议：首个局域网 IP + 中继端口", () => {
  assert.equal(composeLanPublicUrl(["192.168.8.105"], "ws://127.0.0.1:3180"), "http://192.168.8.105:3180");
  assert.equal(composeLanPublicUrl(["10.0.0.5"], "wss://relay.example.com:8443"), "http://10.0.0.5:8443");
  assert.equal(composeLanPublicUrl(["10.0.0.5"], "wss://relay.example.com"), "http://10.0.0.5:3180");
  assert.equal(composeLanPublicUrl([], "ws://127.0.0.1:3180"), null);
  assert.equal(composeLanPublicUrl(undefined, "ws://127.0.0.1:3180"), null);
});
