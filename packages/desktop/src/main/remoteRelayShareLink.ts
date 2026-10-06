import { createHmac, randomBytes } from "node:crypto";
import { deriveRemoteRelayPublicUrl } from "@zcode/shared";

/**
 * 分享链接构造（spec vps-relay-bridge.md §18）：
 * - 永久链接 = 现状 legacy `?token=`（RELAY_TOKEN 本体，PWA/书签兼容）；
 * - 时效链接 = 官方形状的签名凭据 `?s=&t=&e=&h=`，HMAC 密钥即两端共享的
 *   pairingToken（= 中继 RELAY_TOKEN），泄露暴露窗口 = 有效期而非永久。
 *
 * 验证在 relay 侧（deploy/vps-relay/relay.mjs，无状态常量时间比较）；
 * 本模块只负责生成，签名不进渲染层。
 */

/** 时效边界（秒）：UI 档位越界时 clamp，防止拼出 1 秒后过期的废链接或十年链接。 */
export const SHARE_LINK_MIN_TTL_SECONDS = 3600;
export const SHARE_LINK_MAX_TTL_SECONDS = 30 * 24 * 3600;

/** 时钟偏移容差：relay 校验 `t` 时允许的偏差（秒），与 §18.2 一致。 */
export const SHARE_LINK_CLOCK_SKEW_SECONDS = 300;

export interface RelayShareLinkInput {
  /** 中继地址（wss://…）；公开地址缺省由它推导。 */
  url: string;
  /** 手机侧公开地址（缺省由 url 推导）。 */
  publicUrl?: string | null;
  /** 配对码（= 中继 RELAY_TOKEN），时效链接的 HMAC 密钥。 */
  pairingToken: string;
  /** E2EE channelKey：非空时追加 `#k=` fragment（不进任何请求，spec §16.2）。 */
  channelKey?: string | null;
  /** 有效期秒数；null = 永久 legacy token 链接。 */
  ttlSeconds: number | null;
  /** 签发时刻（epoch 毫秒）；缺省当前时间（测试注入用）。 */
  issuedAtMs?: number;
}

export interface RelayShareLink {
  shareUrl: string;
  /** 时效链接的过期时刻（epoch 毫秒）；永久链接为 null。 */
  expiresAt: number | null;
}

/** 官方 `d_` + 16B 同形：房间 id 仅用于链接唯一性与未来撤销钩子，relay 不存它。 */
function createShareSid(): string {
  return randomBytes(16).toString("base64url");
}

/** §18.2 签名载荷：relay 侧按同一字符串重算，改动任何字段都会导致 401。 */
export function signRelayShareParams(
  pairingToken: string,
  sid: string,
  issuedAtSec: number,
  expiresAtSec: number,
): string {
  return createHmac("sha256", pairingToken)
    .update(`${sid}|${issuedAtSec}|${expiresAtSec}`)
    .digest("base64url");
}

export function buildRelayShareLink(input: RelayShareLinkInput): RelayShareLink | null {
  const base = (input.publicUrl?.trim() || deriveRemoteRelayPublicUrl(input.url)).replace(/\/+$/, "");
  if (!base || !input.pairingToken) return null;
  // 链接自带 autoReconnect=1：手机锁屏/切网断线后自动整页重载恢复（与永久链接一致）。
  let url = `${base}/?token=${encodeURIComponent(input.pairingToken)}&autoReconnect=1`;
  let expiresAt: number | null = null;
  if (input.ttlSeconds != null) {
    const ttl = Math.min(
      SHARE_LINK_MAX_TTL_SECONDS,
      Math.max(SHARE_LINK_MIN_TTL_SECONDS, Math.floor(input.ttlSeconds)),
    );
    const issuedAtMs = input.issuedAtMs ?? Date.now();
    const issuedAtSec = Math.floor(issuedAtMs / 1000);
    const expiresAtSec = issuedAtSec + ttl;
    const sid = createShareSid();
    const sig = signRelayShareParams(input.pairingToken, sid, issuedAtSec, expiresAtSec);
    // 时效链接**不携带 token**：凭据 = 签名四元组。302 保留这些参数（§18.4），
    // web bundle 会把它们附到 wsUrl/server-info（等价于 token 通道）。
    url = `${base}/?s=${encodeURIComponent(sid)}&t=${issuedAtSec}&e=${expiresAtSec}&h=${encodeURIComponent(
      sig,
    )}&autoReconnect=1`;
    expiresAt = expiresAtSec * 1000;
  }
  if (input.channelKey) {
    url += `#k=${encodeURIComponent(input.channelKey)}`;
  }
  return { shareUrl: url, expiresAt };
}
