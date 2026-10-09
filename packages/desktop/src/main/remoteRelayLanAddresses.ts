/**
 * 本机局域网地址探测 + 手机侧内网地址拼装。
 *
 * 为什么需要：中继配成 `127.0.0.1` 时**只有本机能访问**，手机即使在同一 WiFi 也连不上；
 * 而用户几乎不可能记得自己的局域网 IP。这里给出候选地址（私有网段优先），
 * 由设置页一键填入。检测本身不联网、不改配置，只读网卡信息。
 *
 * 与 electron 无关，因此独立成模块以便单测（IPC 模块有 `ipcMain` 值导入）。
 */
import type { networkInterfaces } from "node:os";
import {
  extractRelayPort,
  isLoopbackRelayHost,
  isPrivateIpv4Host,
  resolveRelayLanHost,
} from "@zcode/shared";

type NetworkInterfaceMap = ReturnType<typeof networkInterfaces>;

/**
 * 从网卡信息里挑出可用的局域网 IPv4：
 * 跳过 loopback、跳过链路本地（169.254.*），私有网段排前面（其余如公司网/公网直连排后面）。
 */
export function pickRemoteRelayLanAddresses(interfaces: NetworkInterfaceMap | undefined): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === "string" ? entry.family : `IPv${entry.family}`;
      if (family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (!addresses.includes(entry.address)) addresses.push(entry.address);
    }
  }
  // 私有网段排前面：它最可能是手机能直连的那个（判定唯一实现在 shared，避免漂移）。
  return addresses.sort((a, b) => Number(isPrivateIpv4Host(b)) - Number(isPrivateIpv4Host(a)));
}

/**
 * 手机侧内网地址：`http://<直连主机>:<中继端口>`。
 *
 * 主机取值**取决于中继在哪台机器上**（2026-10-09 修，此前一律换成桌面机自己的 IP）：
 *
 * - 中继主机是 **loopback**（中继就跑在本机）→ 换成**检测到的本机局域网 IP**。
 *   桌面 → 中继仍可走 loopback（稳定、不受 DHCP 影响），但手机连不上 `127.0.0.1`，
 *   必须走本机的局域网地址。
 * - 中继主机**本身已是私有 IP**（中继在局域网内的另一台机器，如 NAS
 *   `ws://192.168.1.50:3180`）→ **原样沿用该主机**。换成桌面机 IP 会指向一台
 *   没有中继在监听的机器，比不给链接还糟。
 * - 其它（公网 IP / 域名）→ `null`：局域网里根本没有它。
 *
 * 端口两种情况都沿用 `relayUrl` 里的端口（缺省 3180）。
 */
export function composeLanPublicUrl(
  lanAddresses: readonly string[] | undefined,
  relayUrl: string,
): string | null {
  const port = extractRelayPort(relayUrl);
  const lanHost = resolveRelayLanHost(relayUrl);
  if (lanHost) return `http://${lanHost}:${port}`;
  if (!isLoopbackRelayHost(relayUrl)) return null;
  const address = lanAddresses?.[0];
  return address ? `http://${address}:${port}` : null;
}
