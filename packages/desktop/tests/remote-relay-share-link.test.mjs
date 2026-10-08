import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { isLocalRelayHost } from "@zcode/shared";

import {
  SHARE_LINK_MAX_TTL_SECONDS,
  SHARE_LINK_MIN_TTL_SECONDS,
  buildRelayLanShareLink,
  buildRelayShareLink,
  signRelayShareParams,
} from "../src/main/remoteRelayShareLink.js";

const TOKEN = "pairing-token";
const URL_BASE = "https://relay.example.com";

test("永久链接 = legacy token 形状，无签名四元组、expiresAt 为 null", () => {
  const link = buildRelayShareLink({
    url: "wss://relay.example.com",
    pairingToken: TOKEN,
    ttlSeconds: null,
  });
  assert.ok(link);
  assert.equal(link.expiresAt, null);
  const parsed = new URL(link.shareUrl);
  assert.equal(`${parsed.protocol}//${parsed.host}`, URL_BASE);
  assert.equal(parsed.searchParams.get("token"), TOKEN);
  assert.equal(parsed.searchParams.get("autoReconnect"), "1");
  assert.equal(parsed.searchParams.get("s"), null);
  assert.equal(parsed.searchParams.get("h"), null);
  assert.equal(parsed.hash, "");
});

test("时效链接：s/t/e/h 齐全、不含 token、签名可用同密钥重算验证", () => {
  const issuedAtMs = 1_700_000_000_000;
  const link = buildRelayShareLink({
    url: "wss://relay.example.com",
    pairingToken: TOKEN,
    ttlSeconds: 86_400,
    issuedAtMs,
  });
  assert.ok(link);
  assert.equal(link.expiresAt, issuedAtMs + 86_400 * 1000);
  const parsed = new URL(link.shareUrl);
  const sid = parsed.searchParams.get("s");
  const t = Number(parsed.searchParams.get("t"));
  const e = Number(parsed.searchParams.get("e"));
  const h = parsed.searchParams.get("h");
  assert.equal(parsed.searchParams.get("token"), null);
  assert.equal(parsed.searchParams.get("autoReconnect"), "1");
  assert.ok(sid && sid.length >= 20, "sid 应为 16 字节 base64url");
  assert.equal(t, Math.floor(issuedAtMs / 1000));
  assert.equal(e, t + 86_400);
  // 与 relay（deploy/vps-relay/relay.mjs）一致的验证算法：任何字段被篡改都对不上。
  assert.equal(h, signRelayShareParams(TOKEN, sid, t, e));
  assert.equal(
    h,
    createHmac("sha256", TOKEN).update(`${sid}|${t}|${e}`).digest("base64url"),
  );
});

test("时效链接篡改任意参数后签名不再匹配（fail-closed 的前提）", () => {
  const link = buildRelayShareLink({
    url: "wss://relay.example.com",
    pairingToken: TOKEN,
    ttlSeconds: 3600,
    issuedAtMs: 1_700_000_000_000,
  });
  const parsed = new URL(link?.shareUrl ?? "");
  const forged = signRelayShareParams(TOKEN, parsed.searchParams.get("s"), 1_234_567, 1_234_999);
  assert.notEqual(parsed.searchParams.get("h"), forged);
});

test("ttl 越界被 clamp 到 1h..30d", () => {
  const small = buildRelayShareLink({
    url: "wss://relay.example.com",
    pairingToken: TOKEN,
    ttlSeconds: 1,
    issuedAtMs: 1_700_000_000_000,
  });
  const large = buildRelayShareLink({
    url: "wss://relay.example.com",
    pairingToken: TOKEN,
    ttlSeconds: Number.MAX_SAFE_INTEGER,
    issuedAtMs: 1_700_000_000_000,
  });
  const spanOf = (link) => {
    const parsed = new URL(link.shareUrl);
    return Number(parsed.searchParams.get("e")) - Number(parsed.searchParams.get("t"));
  };
  assert.equal(spanOf(small), SHARE_LINK_MIN_TTL_SECONDS);
  assert.equal(spanOf(large), SHARE_LINK_MAX_TTL_SECONDS);
});

test("E2EE channelKey 进 #k= fragment（两种链接一致）；缺 pairingToken 返回 null", () => {
  const withKey = buildRelayShareLink({
    url: "wss://relay.example.com",
    pairingToken: TOKEN,
    channelKey: "k".repeat(43),
    ttlSeconds: 3600,
  });
  assert.equal(new URL(withKey?.shareUrl ?? "").hash, "#k=" + "k".repeat(43));
  const withoutKey = buildRelayShareLink({
    url: "wss://relay.example.com",
    pairingToken: TOKEN,
    ttlSeconds: null,
  });
  assert.equal(new URL(withoutKey?.shareUrl ?? "").hash, "");
  assert.equal(
    buildRelayShareLink({ url: "wss://relay.example.com", pairingToken: "", ttlSeconds: null }),
    null,
  );
});

test("publicUrl 覆盖 url 推导；结尾斜杠被去掉", () => {
  const link = buildRelayShareLink({
    url: "wss://relay.example.com",
    publicUrl: "https://phone.example.com/",
    pairingToken: TOKEN,
    ttlSeconds: null,
  });
  assert.ok((link?.shareUrl ?? "").startsWith("https://phone.example.com/?token="));
});

// ── 内网链接（spec §18.6）────────────────────────────────────────────────────

test("中继在本机局域网：内网链接把主机换成检测到的局域网 IP，端口沿用", () => {
  const link = buildRelayLanShareLink({
    relayUrl: "ws://127.0.0.1:3180",
    lanAddresses: ["192.168.1.10", "10.0.0.5"],
    pairingToken: TOKEN,
  });
  assert.ok(link);
  assert.ok(link.startsWith("http://192.168.1.10:3180/?token="), link);
  const parsed = new URL(link);
  assert.equal(parsed.searchParams.get("token"), TOKEN);
  assert.equal(parsed.searchParams.get("autoReconnect"), "1");
});

test("内网链接沿用中继地址的非默认端口（不能被 3180 顶掉）", () => {
  const link = buildRelayLanShareLink({
    relayUrl: "ws://10.0.0.5:8443",
    lanAddresses: ["192.168.8.105"],
    pairingToken: TOKEN,
  });
  assert.ok((link ?? "").startsWith("http://192.168.8.105:8443/?token="), link);
});

test("E2EE 时内网链接同样带 #k= fragment", () => {
  const link = buildRelayLanShareLink({
    relayUrl: "ws://192.168.1.10:3180",
    lanAddresses: ["192.168.1.10"],
    pairingToken: TOKEN,
    channelKey: "k".repeat(43),
  });
  assert.equal(new URL(link ?? "").hash, `#k=${"k".repeat(43)}`);
});

test("中继不在本机局域网 / 未检测到局域网地址：不给内网链接", () => {
  assert.equal(
    buildRelayLanShareLink({
      relayUrl: "wss://relay.example.com",
      lanAddresses: ["192.168.1.10"],
      pairingToken: TOKEN,
    }),
    null,
    "中继在 VPS：局域网里没有它，硬拼只会指向用户自己的机器",
  );
  assert.equal(
    buildRelayLanShareLink({
      relayUrl: "ws://127.0.0.1:3180",
      lanAddresses: [],
      pairingToken: TOKEN,
    }),
    null,
    "没有检测到局域网地址",
  );
});

test("isLocalRelayHost：loopback 与 RFC1918 私有网段算本机局域网", () => {
  for (const url of [
    "ws://127.0.0.1:3180",
    "ws://localhost:3180",
    "ws://192.168.1.10:3180",
    "ws://10.0.0.5",
    "ws://172.16.0.9:3180",
    "ws://172.31.255.254",
  ]) {
    assert.equal(isLocalRelayHost(url), true, url);
  }
  for (const url of ["wss://relay.example.com", "wss://8.8.8.8", "ws://172.32.0.1", ""]) {
    assert.equal(isLocalRelayHost(url), false, url);
  }
});
