import { networkInterfaces } from "node:os";
import { ipcMain } from "electron";
import {
  isLocalRelayHost,
  PlatformChannels,
  type RemoteRelayFileConfig,
  type RemoteRelayShareLink,
  type RemoteRelayStatus,
} from "@zcode/shared";
import { pickRemoteRelayLanAddresses } from "./remoteRelayLanAddresses.js";
import {
  parseRemoteRelaySetConfigRequest,
  parseRemoteRelayShareLinkRequest,
} from "./remoteRelayConfigPayload.js";
import {
  ensureRelaySecrets,
  getConfigFilePath,
  readConfigFile,
  resolveEffectiveConfig,
  shouldAutoStartRelay,
  writeConfigFile,
  type EffectiveRelayConfig,
} from "./remoteRelayConfig.js";
import { buildRelayLanShareLink, buildRelayShareLink } from "./remoteRelayShareLink.js";
import {
  createRemoteRelayClient,
  type RelayMessagePort,
  type RelayTargetWindow,
  type RemoteRelayClient,
} from "./remoteRelayClient.js";

/**
 * VPS 中继的控制面（spec §15）：
 * 把 `remoteRelayClient` 的启停/状态暴露成 IPC，供设置页 UI 使用；
 * 配置读 `~/.zcodium/v2/remote-relay.json`（env 优先），因此**正常打开 App 即可启用**，无需终端 env。
 *
 * 与官方 `[web-remote-control]` 的差异（有意简化）：
 * - 不做 authorizeStart 一次性令牌（那是防渲染进程被攻破后静默开启的加固，后续可补）；
 * - 配对沿用 relay 的 `?token=` cookie 通道，另提供官方形状的时效签名链接
 *   （spec §18，签名在 remoteRelayShareLink.ts）；不做官方的多设备房间路由。
 *
 * ⚠ **公开地址（`publicUrl`）只认用户显式填的值，绝不自动写入**（2026-10-09 修）。
 * 此前会探测本机局域网 IP 自动填进去，那在「只有一条链接」的年代是必要的；§18.6 拆成
 * 内网/外网两条链接后，内网那条由 `lanShareUrl` 负责，自动填就变成副作用：
 * 中继在本机时「外网」那一行会显示一条和内网一模一样的局域网地址（甚至 loopback），
 * 看着像配好了其实连不上，也挡住了「填端口映射 / DDNS 地址」这条正确路径。
 * 现在中继在本机且未填覆盖值时，「外网」那一行如实显示「未配置公开地址」的提示。
 */

/** 由 index.ts 注入的窗口/工作区解析（依赖模块级 Map，必须留在 index.ts）。 */
export interface RemoteRelayControlDeps {
  logger?: {
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
  };
  hostLabel?: string;
  appVersion?: string;
  /** 与 `remoteRelayClient` 同名选项：由 Main 注入 Electron 的 `MessageChannelMain`。 */
  createChannel: () => { port1: RelayMessagePort; port2: RelayMessagePort };
  /** 选出要借出 Host 的窗口；`pinnedWindowId` 非 null 时必须钉住该窗口。 */
  resolveTargetWindow: (pinnedWindowId: number | null) => RelayTargetWindow | null;
  /** 读窗口工作区；`pinnedPath` 非 null 时优先于窗口当前工作区。 */
  resolveWorkspace: (
    windowId: number,
    pinnedPath: string | null,
  ) => { workspacePath: string; workspaceIdentity?: string } | null;
}

export function createRemoteRelayControl(deps: RemoteRelayControlDeps): {
  register: () => void;
  autoStart: () => Promise<void>;
  stop: () => Promise<RemoteRelayStatus>;
} {
  const logger = deps.logger;
  /** 每个槽位一个独立客户端实例（独立连接/attachment/E2EE 握手/重连循环，spec §17）。 */
  let clients: RemoteRelayClient[] = [];
  let currentConfig: EffectiveRelayConfig | null = null;
  let lastFileConfig: RemoteRelayFileConfig | null = null;

  function buildStatus(running: boolean): RemoteRelayStatus {
    const lanAddresses = pickRemoteRelayLanAddresses(networkInterfaces());
    const token = currentConfig?.pairingToken ?? "";
    const channelKey = currentConfig?.e2ee ? (currentConfig.channelKey ?? null) : null;
    // 只认用户**显式填写**的覆盖值。中继在本机时「由 url 推导」会得到 http://127.0.0.1:3180，
    // 手机永远访问不到，若拿它当覆盖值就会让「外网」那一行显示一个 loopback 地址。
    const publicUrlOverride = currentConfig?.publicUrlOverride ?? null;
    return {
      configured: currentConfig !== null,
      running,
      connected: clients.some((client) => client.isConnected()),
      source: currentConfig?.source ?? null,
      e2ee: currentConfig?.e2ee ?? false,
      slots: currentConfig?.slots ?? 1,
      // 内网链接：中继就在本机局域网时，把主机换成检测到的局域网地址——中继配成
      // 127.0.0.1 时手机同 WiFi 也连不上，这是唯一能让手机连上的地址（spec §18.6）。
      lanShareUrl:
        currentConfig && token
          ? buildRelayLanShareLink({
              relayUrl: currentConfig.url,
              lanAddresses,
              pairingToken: token,
              channelKey,
            })
          : null,
      // 公网链接：中继本来就在公网时由 url 推导即可（buildRelayShareLink 内部做）；
      // 中继在本机时必须由用户**显式填**外网地址，否则给 null —— 那种配置本来就没有外网
      // 入口，硬拼一条只会和内网链接重复（或拼出一条连不上的 loopback 地址）。
      publicShareUrl:
        currentConfig &&
        token &&
        (!isLocalRelayHost(currentConfig.url) || publicUrlOverride !== null)
          ? (buildRelayShareLink({
              url: currentConfig.url,
              publicUrl: publicUrlOverride,
              pairingToken: token,
              channelKey,
              ttlSeconds: null,
            })?.shareUrl ?? null)
          : null,
      windowId: null,
      lanAddresses,
      configFilePath: getConfigFilePath(),
      fileConfig: lastFileConfig,
    };
  }

  async function start(): Promise<RemoteRelayStatus> {
    if (clients.length) return buildStatus(true);
    const file = await readConfigFile(logger);
    // 先补齐再解析（spec §15.4）：全新设备还没有中继地址时，这里也会生成配对码
    // 并落盘——「保存即生成」，随后才判断有没有可拨的地址。
    lastFileConfig = await ensureRelaySecrets(file, logger);
    const config = resolveEffectiveConfig(lastFileConfig);
    if (!config) {
      currentConfig = null;
      return buildStatus(false);
    }
    currentConfig = config;
    // 每个槽位一个独立客户端实例：独立连接、独立 attachmentId、独立 E2EE 握手与重连
    // 循环（spec §17）。同一窗口 Host 可并存多个 attachment（官方预留设计，已验证）。
    for (let slot = 0; slot < config.slots; slot += 1) {
      const client = createRemoteRelayClient({
        url: config.url,
        hostSecret: config.hostSecret,
        hostLabel: deps.hostLabel,
        appVersion: deps.appVersion,
        logger,
        createChannel: deps.createChannel,
        e2eeChannelKey: config.e2ee && config.channelKey ? config.channelKey : undefined,
        slot: (config.slotBase ?? 0) + slot,
        resolveTargetWindow: () => deps.resolveTargetWindow(config.pinnedWindowId),
        resolveWorkspace: (windowId) => deps.resolveWorkspace(windowId, config.pinnedWorkspacePath),
      });
      clients.push(client);
      client.start();
    }
    logger?.info(
      `[remote-relay] 已启用，目标 ${config.url}（来源 ${config.source}，槽位 ${config.slots}）`,
    );
    return buildStatus(true);
  }

  async function stop(): Promise<RemoteRelayStatus> {
    for (const client of clients) client.stop();
    clients = [];
    return buildStatus(false);
  }

  function register(): void {
    ipcMain.handle(PlatformChannels.RemoteRelayGetStatus, async (): Promise<RemoteRelayStatus> => {
      const file = await readConfigFile(logger);
      lastFileConfig = file;
      if (clients.length) {
        if (currentConfig) lastFileConfig = file;
        return buildStatus(true);
      }
      // 未运行时也先补齐密钥（spec §15.4）：全新设备**首次打开设置页**就生成配对码
      // 并落盘（此前无 url 时 probe 为 null 直接早退，什么都不生成）。
      lastFileConfig = await ensureRelaySecrets(file, logger);
      const previous = currentConfig;
      const probe = resolveEffectiveConfig(lastFileConfig);
      if (!probe) {
        currentConfig = null;
        const status = buildStatus(false);
        currentConfig = previous;
        return status;
      }
      currentConfig = probe;
      return buildStatus(false);
    });

    ipcMain.handle(PlatformChannels.RemoteRelayStart, () => start());

    ipcMain.handle(PlatformChannels.RemoteRelayStop, () => stop());

    ipcMain.handle(
      PlatformChannels.RemoteRelaySetConfig,
      async (_event, payload: unknown): Promise<RemoteRelayStatus> => {
        const request = parseRemoteRelaySetConfigRequest(payload);
        await writeConfigFile(request.config);
        logger?.info(`[remote-relay] 配置已写入 ${getConfigFilePath()}`);
        if (!request.apply) {
          const file = await readConfigFile(logger);
          lastFileConfig = file;
          const previous = currentConfig;
          currentConfig = resolveEffectiveConfig(file) ?? previous;
          return buildStatus(clients.length > 0);
        }
        await stop();
        return start();
      },
    );

    // 时效签名链接（spec §18）：按次生成，签名只发生在 Main。与「读状态」同样
    // 惯例——配对码缺失时自动补齐，首次打开设置页就能直接生成链接。
    ipcMain.handle(
      PlatformChannels.RemoteRelayGetShareLink,
      async (_event, payload: unknown): Promise<RemoteRelayShareLink> => {
        const request = parseRemoteRelayShareLinkRequest(payload);
        const file = await readConfigFile(logger);
        // 与「读状态」同一套补齐链：配对码 / E2EE channelKey 缺失时自动生成并落盘，
        // 否则 E2EE 开着但链接缺 #k=，手机端会卡在 confirm 校验失败。
        lastFileConfig = await ensureRelaySecrets(file, logger);
        const config = resolveEffectiveConfig(lastFileConfig);
        if (!config) return { shareUrl: null, expiresAt: null };
        const link = buildRelayShareLink({
          url: config.url,
          publicUrl: config.publicUrlOverride,
          pairingToken: config.pairingToken ?? "",
          channelKey: config.e2ee ? config.channelKey : null,
          ttlSeconds: request.ttlSeconds ?? null,
        });
        return link ?? { shareUrl: null, expiresAt: null };
      },
    );
  }

  /**
   * App 启动后调用：**先补齐密钥**（全新设备还没有中继地址也生成配对码并落盘，
   * spec §15.4），有配置（env 或文件）就自动连接。
   */
  async function autoStart(): Promise<void> {
    const envUrl = process.env.ZCODE_REMOTE_RELAY_URL?.trim();
    const file = await readConfigFile(logger);
    // 无条件补齐：全新设备一开机就有配对码，打开设置页即可看到/复制（spec §15.4）。
    // start() 会再读一次文件，补齐幂等无副作用。
    lastFileConfig = await ensureRelaySecrets(file, logger);
    if (!shouldAutoStartRelay(lastFileConfig, envUrl)) return;
    await start().catch((error: unknown) => {
      logger?.warn("[remote-relay] 自动启动失败", error);
    });
  }

  return { register, autoStart, stop };
}
