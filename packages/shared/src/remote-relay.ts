/**
 * VPS 中继（remote relay）的类型。
 *
 * 桌面把本机窗口 Host「借」给自建 VPS 中继，手机浏览器经中继访问。
 * 配置来源有两个，**环境变量优先于配置文件**：
 * - 环境变量：`ZCODE_REMOTE_RELAY_URL` / `ZCODE_REMOTE_RELAY_HOST_SECRET` /
 *   `ZCODE_REMOTE_RELAY_WORKSPACE` / `ZCODE_REMOTE_RELAY_WINDOW`
 * - 配置文件：`~/.zcodium/v2/remote-relay.json`（getAppConfigDir，跟随 ZCODE_DATA_BASE_DIR
 *   隔离；正常打开 App 即生效，无需终端 env）
 */

/** `~/.zcodium/v2/remote-relay.json` 的形状。全部字段可省略。 */
export interface RemoteRelayFileConfig {
  /** 中继主机端点，如 `wss://relay.example.com`（本机验证可用 `ws://127.0.0.1:3180`）。 */
  url?: string;
  /** 与中继 `HOST_SECRET` 一致的共享密钥。 */
  hostSecret?: string;
  /** 覆盖上报的工作区路径；不填则跟随窗口当前工作区。 */
  workspace?: string;
  /** 钉住借出 Host 的窗口 id；不填则跟随聚焦窗口。 */
  windowId?: number;
  /**
   * 并发客户端槽位数（1..8，缺省 1；spec vps-relay-bridge.md §17）。
   * 每个槽位 = 一条独立的中继连接 + 独立 Host attachment + 独立 E2EE 握手，
   * 允许 N 个客户端（手机/浏览器 tab）**同时**访问同一桌面。
   */
  slots?: number;
  /**
   * 槽位基址（0..91，缺省首次自动生成并持久化）：实际槽位号 = slotBase + k。
   * 多桌面共用一台 relay 时各桌面 slotBase 随机错开（碰撞 ≈1%，冲突时手工覆盖）。
   */
  slotBase?: number;
  /** App 启动时自动连接（缺省 true —— 写了配置文件即视为要用）。 */
  autoStart?: boolean;
  /** 浏览器侧访问的公开源（用于拼分享链接）；缺省由 url 推导（wss→https / ws→http）。 */
  publicUrl?: string;
  /** 中继的 `RELAY_TOKEN`（手机配对码，用于拼分享链接）。 */
  pairingToken?: string;
  /**
   * 端到端加密开关（spec vps-relay-bridge.md §16）。默认 false = 现行为逐字节不变。
   * 开启是显式动作：两端必须同时具备能力（先重新部署含 E2EE 的 web dist，再开此开关），
   * 不做探测降级——旧 bundle 的手机会握手失败并显示错误页（fail-closed，不白屏）。
   */
  e2ee?: boolean;
  /**
   * E2EE 的 channelKey（32B base64url）。**与 hostSecret 同等敏感**：它经分享链接的
   * `#k=` fragment 分发给手机（浏览器不把 fragment 发给服务器，中继拿不到它）。
   * 启用 e2ee 且缺失时由 Main 自动生成并落盘；清空保存即轮换（旧链接全部失效）。
   */
  channelKey?: string;
}

/** `zcode:remote-relay-get-status` 的响应。 */
export interface RemoteRelayStatus {
  /** 是否有可用配置（env 或配置文件）。 */
  configured: boolean;
  /** 客户端是否已创建并尝试连接。 */
  running: boolean;
  /** 当前是否已连上中继。 */
  connected: boolean;
  /** 配置来源。 */
  source: "env" | "file" | null;
  /** 是否已启用端到端加密（启用时分享链接带 `#k=`）。 */
  e2ee: boolean;
  /** 并发客户端槽位数（spec §17；缺省 1）。 */
  slots: number;
  /**
   * 内网接入链接（手机与中继**同一局域网/WiFi** 直连）。仅当「中继就在本机局域网
   * （loopback 或私有网段）」时非空，端口沿用中继地址；中继在 VPS 时为 null
   * （局域网里根本没有它）。主机取值分两种：
   * - 中继主机是 loopback → 换成**检测到的本机局域网 IP**（手机连不上 127.0.0.1），
   *   此时还要求检测到局域网地址，否则为 null；
   * - 中继主机**本身已是私有 IP** → **原样沿用该主机**（中继在局域网内的另一台机器，
   *   如 NAS `ws://192.168.1.50:3180`；换成桌面机 IP 会指向一台没有中继的机器）。
   */
  lanShareUrl: string | null;
  /**
   * 公网接入链接（手机经外网访问）：公开地址覆盖值优先，否则由公网中继地址推导。
   * 中继在本机局域网**且没有**公开地址覆盖时为 null —— 那种配置本来就没有外网入口，
   * 硬拼一条出来只会和「内网链接」重复。
   */
  publicShareUrl: string | null;
  /** 当前借出 Host 的窗口 id（尽力而为，连接建立后才有意义）。 */
  windowId: number | null;
  /**
   * 本机可用的局域网 IPv4（私有网段优先，已排除 loopback/链路本地）。
   * 设置页在「手机访问地址指向本机」时用它提示/一键填入：中继配成 127.0.0.1 时手机即使同 WiFi 也连不上。
   */
  lanAddresses: string[];
  /** 配置文件路径（便于 UI 提示「去这里改配置」）。 */
  configFilePath: string;
  /** 配置文件当前内容（env 未覆盖的字段以此回填 UI 表单；无文件时为 null）。 */
  fileConfig: RemoteRelayFileConfig | null;
}

/** `zcode:remote-relay-set-config` 的请求：校验后整体覆写配置文件。 */
export interface RemoteRelaySetConfigRequest {
  config: RemoteRelayFileConfig;
  /** 写入后是否立即用新配置重启客户端（缺省 true）。 */
  apply?: boolean;
}

/** `zcode:remote-relay-get-share-link` 的请求（spec §18）：按需生成分享链接。 */
export interface RemoteRelayShareLinkRequest {
  /**
   * 有效期秒数（越界 clamp 到 1h..30d）：非空 = 时效签名链接（§18.2）；
   * null/缺省 = 永久 legacy token 链接（现状，PWA/书签兼容）。
   */
  ttlSeconds?: number | null;
}

/** `zcode:remote-relay-get-share-link` 的响应。 */
export interface RemoteRelayShareLink {
  /** 分享链接（手机浏览器打开即配对）；缺 publicUrl/pairingToken 时为 null。 */
  shareUrl: string | null;
  /** 时效链接的过期时刻（epoch 毫秒）；永久链接为 null。 */
  expiresAt: number | null;
}

/**
 * 由中继地址推导手机浏览器可访问的公开地址：`wss://` → `https://`、`ws://` → `http://`，
 * 并去掉结尾斜杠。
 *
 * 两个地址**通常就是同一主机的不同协议**（桌面用 WS 拨出去，手机用 HTTP 打开），
 * 所以 `publicUrl` 缺省由 `url` 推导；只有当中继地址与手机访问地址确实不同
 * （反向代理、端口映射、桌面走内网/隧道拨入等）时才需要显式覆盖。
 * 主进程与设置页 UI 共用本函数，避免两处推导规则漂移。
 */
export function deriveRemoteRelayPublicUrl(url: string): string {
  return String(url ?? "")
    .trim()
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/+$/, "");
}

/**
 * 从 url 里取端口；取不到用 defaultPort（中继默认 3180）。
 *
 * 主进程拼「内网链接」（检测到的局域网 IP + 本端口）与设置页的地址建议都要用，
 * 因此放在 shared 里做**唯一实现**，避免两处正则漂移。
 */
export function extractRelayPort(url: string | undefined, defaultPort = "3180"): string {
  return /:(\d+)(?:\/|$)/.exec(url ?? "")?.[1] ?? defaultPort;
}

/** 从 url / 主机串里取主机名（去协议、去端口、去 IPv6 中括号）。 */
function relayHostname(url: string | undefined): string {
  const normalized = String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // IPv6 字面量写作 [::1]:3180，先取中括号里的主机名。
  const bracketed = /^\[([^\]]+)\]/.exec(normalized);
  if (bracketed?.[1]) return bracketed[1];
  // 裸 IPv6（无中括号，如已剥离协议的 "::1"）：按第一个冒号切会把 "::1" 切成空串，
  // 于是 loopback 判定失效 ⇒ 内网链接不生成。含 2 个以上冒号即按 IPv6 字面量原样返回。
  // （IPv6 + 端口本就必须写中括号，所以这里不存在歧义。）
  if ((normalized.match(/:/g)?.length ?? 0) >= 2) return normalized;
  return normalized.split(":")[0] ?? "";
}

/** 中继地址是否指向本机 loopback：这种配置**只有本机能访问**，手机在同一 WiFi 也连不上。 */
export function isLoopbackRelayHost(host: string): boolean {
  const hostname = relayHostname(host);
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

/** RFC1918 私有 IPv4（10/8、172.16–31、192.168/16）；非 IPv4 字面量一律 false。 */
export function isPrivateIpv4Host(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/**
 * 中继是否就在**本机/本局域网**（loopback 或 RFC1918 私有 IPv4）。
 *
 * 只有这种情况「内网链接」才成立：中继在 VPS 时局域网里根本没有它，拼一条
 * `http://192.168.x.x:3180` 只会指向用户自己的机器（那里没有中继在监听）。
 */
export function isLocalRelayHost(url: string | undefined): boolean {
  const hostname = relayHostname(url);
  if (!hostname) return false;
  return isLoopbackRelayHost(hostname) || isPrivateIpv4Host(hostname);
}

/**
 * 中继在局域网内时，手机该直连的**主机名**（去协议、去端口）：
 *
 * - **loopback**（`127.*` / `localhost` / `::1`）→ `null`：中继就在本机，手机连不上
 *   loopback，调用方必须换成**检测到的本机局域网 IP**（`pickRemoteRelayLanAddresses`）。
 * - **RFC1918 私有 IPv4** → **该主机本身**：中继在局域网内的**另一台机器**（如 NAS
 *   `ws://192.168.1.50:3180`），手机直连它即可；**不能**换成桌面机自己的 IP——
 *   那是另一台机器，上面没有中继在监听（2026-10-09 修：此前一律替换成桌面机 IP，
 *   中继不在本机时生成的内网链接指向错的机器）。
 * - 公网 IP / 域名 → `null`：局域网里没有它。
 */
export function resolveRelayLanHost(url: string | undefined): string | null {
  const hostname = relayHostname(url);
  if (!hostname || isLoopbackRelayHost(hostname)) return null;
  return isPrivateIpv4Host(hostname) ? hostname : null;
}
