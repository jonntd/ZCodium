/**
 * 本机局域网地址探测（设置页「内网」场景的建议地址）。
 *
 * 为什么需要：中继配成 `127.0.0.1` 时**只有本机能访问**，手机即使在同一 WiFi 也连不上；
 * 而用户几乎不可能记得自己的局域网 IP。这里给出候选地址（私有网段优先），
 * 由设置页一键填入。检测本身不联网、不改配置，只读网卡信息。
 *
 * 与 electron 无关，因此独立成模块以便单测（IPC 模块有 `ipcMain` 值导入）。
 */
import type { networkInterfaces } from "node:os";
import { extractRelayPort } from "@zcode/shared";

type NetworkInterfaceMap = ReturnType<typeof networkInterfaces>;

function isPrivateIpv4(address: string): boolean {
  return (
    address.startsWith("192.168.") ||
    address.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

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
  return addresses.sort((a, b) => Number(isPrivateIpv4(b)) - Number(isPrivateIpv4(a)));
}

/**
 * 手机侧公开地址建议：`http://<首个局域网 IP>:<中继端口>`。
 *
 * 中继端口沿用 `relayUrl` 里的端口（缺省 3180），这样桌面 → 中继仍可走 loopback（稳定，
 * 不受 DHCP 影响），而手机拿到的分享链接指向局域网地址（手机唯一能访问到的那个）。
 */
export function composeLanPublicUrl(
  lanAddresses: readonly string[] | undefined,
  relayUrl: string,
): string | null {
  const address = lanAddresses?.[0];
  if (!address) return null;
  return `http://${address}:${extractRelayPort(relayUrl)}`;
}
