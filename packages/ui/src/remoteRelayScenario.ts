/**
 * 远程访问的「使用场景 → 中继地址」换算。
 *
 * 配置里只有**一个** `url`（桌面拨出连接的中继端点），手机侧地址由它推导
 * （`deriveRemoteRelayPublicUrl`）。两种常见场景只是协议不同：
 *
 * - **内网**：手机与中继在同一 WiFi → `ws://`（桌面）+ `http://`（手机），无需 TLS
 * - **公网**：经 VPS 中继 → `wss://`（桌面）+ `https://`（手机），TLS 由 VPS 反代终止
 *
 * 因此设置页让用户选场景 + 只填主机，协议在这里补，避免用户在两个地址框之间
 * 自己推协议（历史上这里最容易填错，填错就直接连不上中继）。
 */
export type RelayScenario = "lan" | "public";

// 中继 URL 的语义解析（端口 / loopback 判定）唯一实现在 shared：主进程拼「内网链接」
// 也要用同一套判定，这里只做转出，避免两处实现漂移。
export { extractRelayPort, isLoopbackRelayHost } from "@zcode/shared";

/** 由已保存的 url 反推场景：`wss://` 视为公网，其余（含空值）视为内网。 */
export function resolveRelayScenario(url: string | undefined): RelayScenario {
  return /^wss:\/\//i.test(url ?? "") ? "public" : "lan";
}

/** 设置页地址输入框只显示主机（含可选端口），协议不在这里手填。 */
export function stripRelayScheme(url: string | undefined): string {
  return (url ?? "").replace(/^wss?:\/\//i, "");
}

/** 主机 + 场景 → 完整中继 url；主机为空时返回空串（表示未配置）。 */
export function buildRelayUrl(scenario: RelayScenario, host: string): string {
  const trimmed = host.trim();
  return trimmed ? `${scenario === "public" ? "wss" : "ws"}://${trimmed}` : "";
}

/** 「内网」场景的建议地址：本机检测到的局域网 IP + 当前端口；没有检测结果时为 null。 */
export function composeLanSuggestion(
  lanAddresses: readonly string[] | undefined,
  port: string,
): string | null {
  const address = lanAddresses?.[0];
  return address ? `${address}:${port}` : null;
}
