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
  /** 分享链接（手机浏览器打开即配对）；缺 publicUrl/pairingToken 时为 null。 */
  shareUrl: string | null;
  /** 当前借出 Host 的窗口 id（尽力而为，连接建立后才有意义）。 */
  windowId: number | null;
  /**
   * 本机可用的局域网 IPv4（私有网段优先，已排除 loopback/链路本地）。
   * 设置页在「内网」场景下用它提示/一键填入：中继配成 127.0.0.1 时手机即使同 WiFi 也连不上。
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
