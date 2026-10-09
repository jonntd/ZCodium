import { randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { getAppConfigDir } from "@zcode/services/node";
import {
  generateRelayChannelKey,
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
  unwrapLegacyRemoteRelayConfigFile,
} from "./remoteRelayConfigPayload.js";
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

interface EffectiveRelayConfig {
  url: string;
  hostSecret: string;
  pinnedWindowId: number | null;
  pinnedWorkspacePath: string | null;
  /**
   * 用户**显式填写**的公开地址（配置文件里的 `publicUrl`）；未填为 null。
   *
   * ⚠ 只认文件里的原始值，**不能**用「由 url 推导」的结果顶替：中继在本机时推导值是
   * `http://127.0.0.1:3180`，手机永远访问不到，却会被当成「用户填了覆盖值」，
   * 于是「外网」那一行显示一个 loopback 地址（2026-10-09 修）。
   * 缺省推导交给 `buildRelayShareLink` 在生成链接时做——那里对「中继在公网」等价，
   * 对「中继在本机」则正确地不生效。
   */
  publicUrlOverride: string | null;
  pairingToken: string | null;
  /** 端到端加密开关（spec vps-relay-bridge.md §16）。 */
  e2ee: boolean;
  /** 并发客户端槽位数（spec §17）。 */
  slots: number;
  /** 槽位基址（spec §17）：实际槽位号 = slotBase + k。null = 尚未生成。 */
  slotBase: number | null;
  channelKey: string | null;
  source: "env" | "file";
}

export function getConfigFilePath(): string {
  // 收口到 services 数据根（~/.zcodium/v2，跟随 ZCODE_DATA_BASE_DIR 隔离），与 #19
  // 数据根迁移后其他 main 侧配置文件同源；迁移「只复制」会把旧配置带入新根。
  return join(getAppConfigDir(), "remote-relay.json");
}

/** 解析配置文件；不存在或损坏时返回 null（损坏会记 warn，但不算致命）。 */
async function readConfigFile(logger?: RemoteRelayControlDeps["logger"]): Promise<RemoteRelayFileConfig | null> {
  try {
    const raw = await readFile(getConfigFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger?.warn("中继配置文件不是 JSON 对象，已忽略", getConfigFilePath());
      return null;
    }
    const { config, recovered } = unwrapLegacyRemoteRelayConfigFile(parsed);
    if (recovered) {
      // 历史 bug：保存时把 { config, apply } 信封当成 config 写了进来（preload 签名不匹配）。
      // 读到时自动还原并立刻修回扁平文件，避免 App 反复读不到 url 而掉线。
      logger?.warn("中继配置是历史信封形状，已自动还原", getConfigFilePath());
      await writeConfigFile(config).catch(() => {});
    }
    return config;
  } catch {
    return null;
  }
}

/** 配对码：24 字节随机（base64url），与官方 `createPassword` 同量级，禁止出现 `devtoken` 这类共享弱口令。 */
function generatePairingToken(): string {
  return randomBytes(24).toString("base64url");
}

async function writeConfigFile(config: RemoteRelayFileConfig): Promise<void> {
  const path = getConfigFilePath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * 配对码缺失时自动生成并落盘。
 *
 * 为什么放在这里而不是让用户手填：配对码是中继与手机之间的共享密钥，
 * 手填很容易退化成 `devtoken` 这种全局弱口令（且会被拼进分享链接）。
 * 只需要用户在**中继侧**设同一个 `RELAY_TOKEN`——UI 里能看到/复制它。
 * 想要轮换时清空该字段并保存即可（下一次读取会重新生成）。
 */
async function ensurePairingToken(
  file: RemoteRelayFileConfig | null,
  config: EffectiveRelayConfig,
  logger?: RemoteRelayControlDeps["logger"],
): Promise<{ file: RemoteRelayFileConfig | null; config: EffectiveRelayConfig }> {
  if (config.pairingToken) return { file, config };
  const pairingToken = generatePairingToken();
  const nextFile: RemoteRelayFileConfig = { ...file, pairingToken };
  try {
    await writeConfigFile(nextFile);
    logger?.info(`[remote-relay] 已自动生成配对码并写入 ${getConfigFilePath()}`);
    return { file: nextFile, config: { ...config, pairingToken } };
  } catch (error) {
    // 落盘失败（只读目录等）时仍让本次会话可用：内存里保留新配对码。
    logger?.warn("[remote-relay] 配对码写入失败，仅在本次会话内有效", error);
    return { file, config: { ...config, pairingToken } };
  }
}

/** env 逐字段优先于文件；没有 url 即视为未配置。 */
function resolveEffectiveConfig(file: RemoteRelayFileConfig | null): EffectiveRelayConfig | null {
  const envUrl = process.env.ZCODE_REMOTE_RELAY_URL?.trim();
  const fileUrl = file?.url?.trim();
  const url = envUrl || fileUrl;
  if (!url) return null;
  if (!/^wss?:\/\//i.test(url)) return null;

  const envSecret = process.env.ZCODE_REMOTE_RELAY_HOST_SECRET?.trim();
  const envWindow = Number(process.env.ZCODE_REMOTE_RELAY_WINDOW ?? "");
  const envWorkspace = process.env.ZCODE_REMOTE_RELAY_WORKSPACE?.trim();
  // E2EE 是显式开关（默认关）：两端必须同时具备能力（spec §16.6 灰度顺序）。
  const envE2ee = /^(1|true)$/i.test(process.env.ZCODE_REMOTE_RELAY_E2EE?.trim() ?? "");
  const e2ee = envE2ee || file?.e2ee === true;
  // 并发客户端槽位数（spec §17）：每槽位一条独立连接 + 独立 Host attachment。
  const envSlots = Number.parseInt(process.env.ZCODE_REMOTE_RELAY_SLOTS?.trim() ?? "", 10);
  const rawSlots = Number.isInteger(envSlots) ? envSlots : file?.slots;
  const slots = Math.min(8, Math.max(1, Number.isInteger(rawSlots) ? (rawSlots as number) : 1));
  const envSlotBase = Number.parseInt(process.env.ZCODE_REMOTE_RELAY_SLOT_BASE?.trim() ?? "", 10);
  const cfgSlotBase = Number.isInteger(file?.slotBase) ? (file?.slotBase as number) : null;
  const slotBase =
    envSlotBase !== null && Number.isInteger(envSlotBase) && envSlotBase >= 0 && envSlotBase <= 91
      ? envSlotBase
      : cfgSlotBase !== null && cfgSlotBase >= 0 && cfgSlotBase <= 91
        ? cfgSlotBase
        : null;

  // 公开地址只认用户显式填的值；缺省推导（ws→http / wss→https）交给 buildRelayShareLink
  // 在生成链接时做——见 `publicUrlOverride` 的注释。
  const publicUrlOverride = file?.publicUrl?.trim() || null;
  const pairingToken = file?.pairingToken?.trim() || null;

  return {
    url,
    hostSecret: envSecret ?? file?.hostSecret?.trim() ?? "",
    pinnedWindowId:
      Number.isInteger(envWindow) && envWindow > 0
        ? envWindow
        : typeof file?.windowId === "number" && file.windowId > 0
          ? file.windowId
          : null,
    pinnedWorkspacePath: envWorkspace || file?.workspace?.trim() || null,
    publicUrlOverride,
    pairingToken,
    e2ee,
    slots,
    slotBase,
    channelKey: file?.channelKey?.trim() || null,
    source: envUrl ? "env" : "file",
  };
}

/**
 * 槽位基址缺失时自动生成并落盘（spec §17）：
 * 多桌面共用一台 relay 时各桌面的 slotBase 随机错开（0..91，碰撞 ≈1%），
 * 单桌面无感。与 pairingToken/channelKey 同一套「首次自动生成」惯例。
 */
async function ensureSlotBase(
  file: RemoteRelayFileConfig | null,
  config: EffectiveRelayConfig,
  logger?: RemoteRelayControlDeps["logger"],
): Promise<{ file: RemoteRelayFileConfig | null; config: EffectiveRelayConfig }> {
  if (config.slotBase !== null) return { file, config };
  const slotBase = randomInt(0, 92);
  const nextFile: RemoteRelayFileConfig = { ...file, slotBase };
  try {
    await writeConfigFile(nextFile);
    logger?.info(`[remote-relay] 已生成槽位基址 ${slotBase} 并写入 ${getConfigFilePath()}`);
  } catch (error) {
    logger?.warn("[remote-relay] 槽位基址写入失败，仅在本次会话内有效", error);
  }
  return { file: nextFile, config: { ...config, slotBase } };
}

/**
 * 启用 E2EE 且 channelKey 缺失时自动生成并落盘。
 *
 * 与 pairingToken 同理：手填 32 字节密钥不现实，且用户很可能复用弱值。
 * 生成只发生一次；清空该字段保存即可轮换（旧链接全部失效）。
 */
async function ensureE2eeChannelKey(
  file: RemoteRelayFileConfig | null,
  config: EffectiveRelayConfig,
  logger?: RemoteRelayControlDeps["logger"],
): Promise<{ file: RemoteRelayFileConfig | null; config: EffectiveRelayConfig }> {
  if (!config.e2ee || config.channelKey) return { file, config };
  const channelKey = generateRelayChannelKey();
  const nextFile: RemoteRelayFileConfig = { ...file, channelKey };
  try {
    await writeConfigFile(nextFile);
    logger?.info(`[remote-relay] 已生成 E2EE channelKey 并写入 ${getConfigFilePath()}`);
  } catch (error) {
    // 落盘失败时仅本次会话内有效：重启后会重新生成（旧链接将失效），warn 提示。
    logger?.warn("[remote-relay] E2EE channelKey 写入失败，仅在本次会话内有效", error);
  }
  return { file: nextFile, config: { ...config, channelKey } };
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
    lastFileConfig = file;
    let config = resolveEffectiveConfig(file);
    if (!config) {
      currentConfig = null;
      return buildStatus(false);
    }
    const withToken = await ensurePairingToken(file, config, logger);
    const withChannelKey = await ensureE2eeChannelKey(withToken.file, withToken.config, logger);
    const withSlotBase = await ensureSlotBase(withChannelKey.file, withChannelKey.config, logger);
    lastFileConfig = withSlotBase.file;
    config = withSlotBase.config;
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
      // 未运行时也如实回答「有没有配置」：probe 结果只影响 configured/shareUrl 展示。
      const previous = currentConfig;
      const probe = resolveEffectiveConfig(file);
      if (!probe) {
        currentConfig = null;
        const status = buildStatus(false);
        currentConfig = previous;
        return status;
      }
      // 未启动也要能显示链接，所以这里同样补配对码 / E2EE channelKey：
      // 首次打开设置页就会自动生成并落盘。
      const withToken = await ensurePairingToken(file, probe, logger);
      const withChannelKey = await ensureE2eeChannelKey(withToken.file, withToken.config, logger);
      lastFileConfig = withChannelKey.file;
      currentConfig = withChannelKey.config;
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
        lastFileConfig = file;
        const config = resolveEffectiveConfig(file);
        if (!config) return { shareUrl: null, expiresAt: null };
        // 与「读状态」同一套补齐链：配对码 / E2EE channelKey 缺失时自动生成并落盘，
        // 否则 E2EE 开着但链接缺 #k=，手机端会卡在 confirm 校验失败。
        const withToken = await ensurePairingToken(file, config, logger);
        const withChannelKey = await ensureE2eeChannelKey(withToken.file, withToken.config, logger);
        lastFileConfig = withChannelKey.file;
        const link = buildRelayShareLink({
          url: withChannelKey.config.url,
          publicUrl: withChannelKey.config.publicUrlOverride,
          pairingToken: withChannelKey.config.pairingToken ?? "",
          channelKey: withChannelKey.config.e2ee ? withChannelKey.config.channelKey : null,
          ttlSeconds: request.ttlSeconds ?? null,
        });
        return link ?? { shareUrl: null, expiresAt: null };
      },
    );
  }

  /** App 启动后调用：有配置（env 或文件）就自动连接。 */
  async function autoStart(): Promise<void> {
    const envUrl = process.env.ZCODE_REMOTE_RELAY_URL?.trim();
    const file = await readConfigFile(logger);
    const shouldStart = Boolean(envUrl) || (Boolean(file?.url) && file?.autoStart !== false);
    if (!shouldStart) return;
    await start().catch((error: unknown) => {
      logger?.warn("[remote-relay] 自动启动失败", error);
    });
  }

  return { register, autoStart, stop };
}
