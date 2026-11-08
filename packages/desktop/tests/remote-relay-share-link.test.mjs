import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { isLocalRelayHost, resolveRelayLanHost } from "@zcode/shared";

import {
  SHARE_LINK_MAX_TTL_SECONDS,
  SHARE_LINK_MIN_TTL_SECONDS,
  buildRelayLanShareLink,
  buildRelayShareLink,
  buildRelayShareUrls,
  signRelayShareParams,
} from "../src/main/remoteRelayShareLink.js";

const TOKEN = "pairing-token";
const URL_BASE = "https://relay.example.com";

test("永久链接 = legacy token 形状，无签名四元组、expiresAt 为 null", () => {
  const link = buildRelayShareLink({
    url: "wss://relay.example.com",
    roomKey: TOKEN,
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

test("时效链接（v6 自验）：s/t/e/h + token 齐全、签名可用同密钥重算验证", () => {
  const issuedAtMs = 1_700_000_000_000;
  const link = buildRelayShareLink({
    url: "wss://relay.example.com",
    roomKey: TOKEN,
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
  // v6 key-room 自验链接（spec §19.2）：自带 token（中继用它自验签名并建房），
  // 302 摘 token 后地址栏只剩 s/t/e/h。
  assert.equal(parsed.searchParams.get("token"), TOKEN);
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
    roomKey: TOKEN,
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
    roomKey: TOKEN,
    ttlSeconds: 1,
    issuedAtMs: 1_700_000_000_000,
  });
  const large = buildRelayShareLink({
    url: "wss://relay.example.com",
    roomKey: TOKEN,
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

test("E2EE channelKey 进 #k= fragment（两种链接一致）；缺 roomKey 返回 null", () => {
  const withKey = buildRelayShareLink({
    url: "wss://relay.example.com",
    roomKey: TOKEN,
    channelKey: "k".repeat(43),
    ttlSeconds: 3600,
  });
  assert.equal(new URL(withKey?.shareUrl ?? "").hash, "#k=" + "k".repeat(43));
  const withoutKey = buildRelayShareLink({
    url: "wss://relay.example.com",
    roomKey: TOKEN,
    ttlSeconds: null,
  });
  assert.equal(new URL(withoutKey?.shareUrl ?? "").hash, "");
  assert.equal(
    buildRelayShareLink({ url: "wss://relay.example.com", roomKey: "", ttlSeconds: null }),
    null,
  );
});

test("publicUrl 覆盖 url 推导；结尾斜杠被去掉", () => {
  const link = buildRelayShareLink({
    url: "wss://relay.example.com",
    publicUrl: "https://phone.example.com/",
    roomKey: TOKEN,
    ttlSeconds: null,
  });
  assert.ok((link?.shareUrl ?? "").startsWith("https://phone.example.com/?token="));
});

// ── 内网链接（spec §18.6）────────────────────────────────────────────────────

test("中继在本机局域网：内网链接把主机换成检测到的局域网 IP，端口沿用", () => {
  const link = buildRelayLanShareLink({
    relayUrl: "ws://127.0.0.1:3180",
    lanAddresses: ["192.168.1.10", "10.0.0.5"],
    roomKey: TOKEN,
  });
  assert.ok(link);
  assert.ok(link.startsWith("http://192.168.1.10:3180/?token="), link);
  const parsed = new URL(link);
  assert.equal(parsed.searchParams.get("token"), TOKEN);
  assert.equal(parsed.searchParams.get("autoReconnect"), "1");
});

test("中继在本机（loopback）：内网链接换成检测到的局域网 IP，端口沿用中继地址", () => {
  const link = buildRelayLanShareLink({
    relayUrl: "ws://127.0.0.1:8443",
    lanAddresses: ["192.168.8.105"],
    roomKey: TOKEN,
  });
  assert.ok((link ?? "").startsWith("http://192.168.8.105:8443/?token="), link);
});

test("中继在局域网内另一台机器：内网链接原样用它的主机（不能换成桌面机 IP）", () => {
  const link = buildRelayLanShareLink({
    relayUrl: "ws://10.0.0.5:8443",
    lanAddresses: ["192.168.8.105"],
    roomKey: TOKEN,
  });
  assert.ok((link ?? "").startsWith("http://10.0.0.5:8443/?token="), link);
});

test("E2EE 时内网链接同样带 #k= fragment", () => {
  const link = buildRelayLanShareLink({
    relayUrl: "ws://192.168.1.10:3180",
    lanAddresses: ["192.168.1.10"],
    roomKey: TOKEN,
    channelKey: "k".repeat(43),
  });
  assert.equal(new URL(link ?? "").hash, `#k=${"k".repeat(43)}`);
});

test("中继不在本机局域网 / 未检测到局域网地址：不给内网链接", () => {
  assert.equal(
    buildRelayLanShareLink({
      relayUrl: "wss://relay.example.com",
      lanAddresses: ["192.168.1.10"],
      roomKey: TOKEN,
    }),
    null,
    "中继在 VPS：局域网里没有它，硬拼只会指向用户自己的机器",
  );
  assert.equal(
    buildRelayLanShareLink({
      relayUrl: "ws://127.0.0.1:3180",
      lanAddresses: [],
      roomKey: TOKEN,
    }),
    null,
    "没有检测到局域网地址",
  );
});

test("isLocalRelayHost：loopback 与 RFC1918 私有网段算本机局域网", () => {
  for (const url of [
    "ws://127.0.0.1:3180",
    "ws://localhost:3180",
    "ws://[::1]:3180",
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

test("resolveRelayLanHost：loopback → null（须换成局域网 IP）；私有 IP → 原样；公网/域名 → null", () => {
  for (const url of ["ws://127.0.0.1:3180", "ws://localhost:3180", "ws://[::1]:3180"]) {
    assert.equal(resolveRelayLanHost(url), null, url);
  }
  assert.equal(resolveRelayLanHost("ws://192.168.1.50:3180"), "192.168.1.50");
  assert.equal(resolveRelayLanHost("ws://10.0.0.9:8443"), "10.0.0.9");
  assert.equal(resolveRelayLanHost("ws://172.16.0.9:3180"), "172.16.0.9");
  for (const url of [
    "wss://relay.example.com",
    "ws://104.223.21.20:3180",
    "ws://8.8.8.8",
    "ws://172.32.0.1",
    "",
  ]) {
    assert.equal(resolveRelayLanHost(url), null, url);
  }
});

// ── buildRelayShareUrls（spec §21）：buildStatus 与草稿预览共用的唯一推导入口 ──

test("buildRelayShareUrls：中继在 VPS → 外网链接由 url 推导，内网链接为 null", () => {
  const urls = buildRelayShareUrls({
    relayUrl: "ws://104.223.21.20:3180",
    publicUrlOverride: null,
    lanAddresses: ["192.168.8.106"],
    roomKey: TOKEN,
  });
  const parsed = new URL(urls.publicShareUrl ?? "");
  assert.equal(`${parsed.protocol}//${parsed.host}`, "http://104.223.21.20:3180");
  assert.equal(parsed.searchParams.get("token"), TOKEN);
  assert.equal(parsed.searchParams.get("autoReconnect"), "1");
  assert.equal(urls.lanShareUrl, null);
});

test("buildRelayShareUrls：中继在本机（loopback）→ 内网链接用检测到的局域网地址；无覆盖时外网为 null", () => {
  const urls = buildRelayShareUrls({
    relayUrl: "ws://127.0.0.1:3180",
    publicUrlOverride: null,
    lanAddresses: ["192.168.8.106"],
    roomKey: TOKEN,
  });
  const parsed = new URL(urls.lanShareUrl ?? "");
  assert.equal(`${parsed.protocol}//${parsed.host}`, "http://192.168.8.106:3180");
  assert.equal(parsed.searchParams.get("token"), TOKEN);
  assert.equal(urls.publicShareUrl, null);
});

test("buildRelayShareUrls：publicUrl 覆盖值优先于推导（§18.5 语义，端口映射/DDNS 路径）", () => {
  const urls = buildRelayShareUrls({
    relayUrl: "wss://relay.example.com",
    publicUrlOverride: "https://ddns.example.org",
    lanAddresses: [],
    roomKey: TOKEN,
  });
  const parsed = new URL(urls.publicShareUrl ?? "");
  assert.equal(`${parsed.protocol}//${parsed.host}`, "https://ddns.example.org");
});

test("buildRelayShareUrls：E2EE 时两条链接都带 #k=；缺 roomKey 返回双 null", () => {
  const withKey = buildRelayShareUrls({
    relayUrl: "ws://104.223.21.20:3180",
    publicUrlOverride: null,
    lanAddresses: [],
    roomKey: TOKEN,
    channelKey: "channel-key",
  });
  assert.equal(withKey.publicShareUrl?.endsWith("#k=channel-key"), true);
  for (const urls of [
    buildRelayShareUrls({
      relayUrl: "ws://104.223.21.20:3180",
      publicUrlOverride: null,
      lanAddresses: [],
      roomKey: "",
    }),
    buildRelayShareUrls({
      relayUrl: "",
      publicUrlOverride: null,
      lanAddresses: [],
      roomKey: TOKEN,
    }),
  ]) {
    assert.deepEqual(urls, { lanShareUrl: null, publicShareUrl: null });
  }
});
