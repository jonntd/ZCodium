/**
 * 远程访问的「连接协议 → 中继地址」换算。
 *
 * 配置里只有**一个** `url`（桌面拨出连接的中继端点），手机侧地址由它推导
 * （`deriveRemoteRelayPublicUrl`）。
 *
 * ⚠ 这个维度**只决定协议前缀**，与地址是内网还是公网**无关**（两者是独立维度）：
 *
 * - **明文 `ws://`**：局域网直连（手机 `http://`），以及**没有 TLS 的纯 IP 部署**
 *   —— 后者是「公网地址 + 明文协议」，历史上被 UI 标成「内网」，纯属文案误导
 * - **TLS `wss://`**：有域名和证书的 VPS 中继（手机 `https://`），TLS 由 VPS 反代终止
 *
 * 裸 IP 只能选 `ws://`：拿不到受信任证书，而桌面 WS 客户端未关闭证书校验
 * （仓库内无 `rejectUnauthorized`），`wss://<裸IP>` 会被拒连
 * （deploy/vps-relay/README.md §2.5.1）。
 *
 * 因此设置页让用户选协议 + 只填主机，前缀在这里补，避免用户在两个地址框之间
 * 自己推协议（历史上这里最容易填错，填错就直接连不上中继）。
 *
 * 注：类型值仍沿用 `"lan" | "public"`（仅内部标识，不对外显示）。
 */
export type RelayScenario = "lan" | "public";

// 中继 URL 的语义解析（端口 / loopback 判定）唯一实现在 shared：主进程拼「内网链接」
// 也要用同一套判定，这里只做转出，避免两处实现漂移。
export { extractRelayPort, isLoopbackRelayHost } from "@zcode/shared";

/** 由已保存的 url 反推协议选项：有 `wss://` 前缀即 TLS，其余（含空值）按明文 ws:// 处理。 */
export function resolveRelayScenario(url: string | undefined): RelayScenario {
  return /^wss:\/\//i.test(url ?? "") ? "public" : "lan";
}

/** 设置页地址输入框只显示主机（含可选端口），协议不在这里手填。 */
export function stripRelayScheme(url: string | undefined): string {
  return (url ?? "").replace(/^wss?:\/\//i, "");
}

/** 主机 + 协议选项 → 完整中继 url；主机为空时返回空串（表示未配置）。 */
export function buildRelayUrl(scenario: RelayScenario, host: string): string {
  const trimmed = host.trim();
  return trimmed ? `${scenario === "public" ? "wss" : "ws"}://${trimmed}` : "";
}

/** 局域网地址建议：本机检测到的局域网 IP + 当前端口；没有检测结果时为 null。 */
export function composeLanSuggestion(
  lanAddresses: readonly string[] | undefined,
  port: string,
): string | null {
  const address = lanAddresses?.[0];
  return address ? `${address}:${port}` : null;
}
