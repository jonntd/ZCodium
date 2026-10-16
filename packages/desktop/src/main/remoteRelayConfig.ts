/**
 * 中继配置的纯逻辑（spec vps-relay-bridge.md §15.4 / §16 / §17）：
 * 配置文件读取、env 覆盖解析（env > 文件 > 统一默认值）与「首次自动生成」补齐链。
 *
 * 与 `remoteRelayControlIpc.ts`（IPC 胶水 + 中继客户端生命周期）分开的原因同
 * `remoteRelayConfigPayload.ts`：本模块**不导入 electron**，可在纯 Node 测试里加载
 * （控制模块 import 了 `ipcMain`，原生 ESM 的具名导出检查会在链接期直接拒绝，
 * 表现为 `The requested module 'electron' does not provide an export named 'ipcMain'`）。
 */
import { randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import {
  DEFAULT_RELAY_HOST_SECRET,
  generateRelayChannelKey,
  resolveRelayHostSecret,
  type RemoteRelayFileConfig,
} from "@zcode/shared";
import { unwrapLegacyRemoteRelayConfigFile } from "./remoteRelayConfigPayload.js";

/** 补齐链用的最小日志面（与 `RemoteRelayControlDeps.logger` 结构兼容）。 */
export interface RelayConfigLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

/** env 逐字段优先于文件后的生效配置；没有 url 即视为未配置（resolve 返回 null）。 */
export interface EffectiveRelayConfig {
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
export async function readConfigFile(
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig | null> {
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

export async function writeConfigFile(config: RemoteRelayFileConfig): Promise<void> {
  const path = getConfigFilePath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** E2EE 生效开关（spec §16）：env `ZCODE_REMOTE_RELAY_E2EE`（`1`/`true`）或文件 `e2ee`。
 *  resolveEffectiveConfig 与补齐链共用同一判定，避免两处漂移。 */
export function isE2eeEnabled(file: RemoteRelayFileConfig | null): boolean {
  return (
    /^(1|true)$/i.test(process.env.ZCODE_REMOTE_RELAY_E2EE?.trim() ?? "") || file?.e2ee === true
  );
}

/** env 逐字段优先于文件；没有 url 即视为未配置。 */
export function resolveEffectiveConfig(
  file: RemoteRelayFileConfig | null,
): EffectiveRelayConfig | null {
  const envUrl = process.env.ZCODE_REMOTE_RELAY_URL?.trim();
  const fileUrl = file?.url?.trim();
  const url = envUrl || fileUrl;
  if (!url) return null;
  if (!/^wss?:\/\//i.test(url)) return null;

  const envSecret = process.env.ZCODE_REMOTE_RELAY_HOST_SECRET?.trim();
  const envWindow = Number(process.env.ZCODE_REMOTE_RELAY_WINDOW ?? "");
  const envWorkspace = process.env.ZCODE_REMOTE_RELAY_WORKSPACE?.trim();
  // E2EE 判定收口到 isE2eeEnabled（与补齐链同源）。
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
    hostSecret: resolveRelayHostSecret(envSecret, file?.hostSecret),
    pinnedWindowId:
      Number.isInteger(envWindow) && envWindow > 0
        ? envWindow
        : typeof file?.windowId === "number" && file.windowId > 0
          ? file.windowId
          : null,
    pinnedWorkspacePath: envWorkspace || file?.workspace?.trim() || null,
    publicUrlOverride,
    pairingToken,
    e2ee: isE2eeEnabled(file),
    slots,
    slotBase,
    channelKey: file?.channelKey?.trim() || null,
    source: envUrl ? "env" : "file",
  };
}

/** 配对码：24 字节随机（base64url），与官方 `createPassword` 同量级，禁止出现 `devtoken` 这类共享弱口令。 */
function generatePairingToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 密钥补齐链（spec §15.4 / §16 / §17）：配对码 / 主机密钥 / E2EE channelKey /
 * 槽位基址缺失时生成并落盘。
 *
 * ⚠ 调用方在 `resolveEffectiveConfig` **之前无条件执行**：全新设备还没有中继地址时，
 * App 启动（`autoStart`）与读状态（`GetStatus`）也会把配对码生成出来并落盘——
 * 「运行 App 即自动生成」，UI 里直接可见/复制，省掉「先填一次地址再保存」才有码的
 * 步骤（此前无 url 时 resolve 返回 null，ensure 根本到不了）。
 *
 * 幂等：已存在的值原样返回；写盘失败（只读目录等）只 warn，本次会话内存里仍用新值。
 */
export async function ensureRelaySecrets(
  file: RemoteRelayFileConfig | null,
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig> {
  const withToken = await ensurePairingToken(file, logger);
  const withHostSecret = await ensureHostSecret(withToken, logger);
  const withChannelKey = await ensureE2eeChannelKey(withHostSecret, logger);
  return ensureSlotBase(withChannelKey, logger);
}

/**
 * 配对码缺失时自动生成并落盘（spec §15.4）。
 *
 * 为什么放在这里而不是让用户手填：配对码是中继与手机之间的共享密钥，
 * 手填很容易退化成 `devtoken` 这种全局弱口令（且会被拼进分享链接）。
 * 只需把生成值同步到**中继侧**的 `RELAY_TOKEN`——UI 里能看到/复制它。
 * 想要轮换时清空该字段并保存即可（下一次补齐会重新生成）。
 */
async function ensurePairingToken(
  file: RemoteRelayFileConfig | null,
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig> {
  if (file?.pairingToken?.trim()) return file;
  const pairingToken = generatePairingToken();
  const nextFile: RemoteRelayFileConfig = { ...file, pairingToken };
  try {
    await writeConfigFile(nextFile);
    logger?.info(`[remote-relay] 已自动生成配对码并写入 ${getConfigFilePath()}`);
  } catch (error) {
    // 落盘失败（只读目录等）时仍让本次会话可用：内存里保留新配对码。
    logger?.warn("[remote-relay] 配对码写入失败，仅在本次会话内有效", error);
  }
  return nextFile;
}

/**
 * 主机密钥缺失时回填**统一默认值**并落盘（spec §15.4）。
 *
 * 默认值是 `DEFAULT_RELAY_HOST_SECRET`（取当前部署真实 `HOST_SECRET`，新设备开箱即用）。
 * ⚠ 仓库若公开即等于公开该密钥：任何能访问 relay `/host` 的人都等于拿到桌面 Host 的
 * 服务面；公开前应先轮换（relay `.env` 与桌面两边同步改新值）。env
 * `ZCODE_REMOTE_RELAY_HOST_SECRET` 覆盖时不写文件（env 逐字段优先于文件）。
 */
async function ensureHostSecret(
  file: RemoteRelayFileConfig,
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig> {
  if (process.env.ZCODE_REMOTE_RELAY_HOST_SECRET?.trim()) return file;
  if (file.hostSecret?.trim()) return file;
  const nextFile: RemoteRelayFileConfig = { ...file, hostSecret: DEFAULT_RELAY_HOST_SECRET };
  try {
    await writeConfigFile(nextFile);
    logger?.info(`[remote-relay] 已回填统一默认主机密钥并写入 ${getConfigFilePath()}`);
  } catch (error) {
    logger?.warn("[remote-relay] 默认主机密钥写入失败，仅在本次会话内有效", error);
  }
  return nextFile;
}

/**
 * 启用 E2EE 且 channelKey 缺失时自动生成并落盘（spec §16.5）。
 *
 * 与配对码同一套补齐惯例；生成只发生一次，清空该字段保存即可轮换（旧链接全部失效）。
 * 判定用 `isE2eeEnabled`（文件 e2ee 或 env `ZCODE_REMOTE_RELAY_E2EE`，与
 * resolveEffectiveConfig 同源）。
 */
async function ensureE2eeChannelKey(
  file: RemoteRelayFileConfig,
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig> {
  if (!isE2eeEnabled(file) || file.channelKey?.trim()) return file;
  const channelKey = generateRelayChannelKey();
  const nextFile: RemoteRelayFileConfig = { ...file, channelKey };
  try {
    await writeConfigFile(nextFile);
    logger?.info(`[remote-relay] 已生成 E2EE channelKey 并写入 ${getConfigFilePath()}`);
  } catch (error) {
    // 落盘失败时仅本次会话内有效：重启后会重新生成（旧链接将失效），warn 提示。
    logger?.warn("[remote-relay] E2EE channelKey 写入失败，仅在本次会话内有效", error);
  }
  return nextFile;
}

/**
 * 槽位基址缺失时自动生成并落盘（spec §17）：
 * 多桌面共用一台 relay 时各桌面的 slotBase 随机错开（0..91，碰撞 ≈1%），
 * 单桌面无感。与配对码同一套「首次自动生成」惯例；env
 * `ZCODE_REMOTE_RELAY_SLOT_BASE` 仍逐字段优先于文件。
 */
async function ensureSlotBase(
  file: RemoteRelayFileConfig,
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig> {
  if (file.slotBase !== undefined) return file;
  const slotBase = randomInt(0, 92);
  const nextFile: RemoteRelayFileConfig = { ...file, slotBase };
  try {
    await writeConfigFile(nextFile);
    logger?.info(`[remote-relay] 已生成槽位基址 ${slotBase} 并写入 ${getConfigFilePath()}`);
  } catch (error) {
    logger?.warn("[remote-relay] 槽位基址写入失败，仅在本次会话内有效", error);
  }
  return nextFile;
}

/**
 * App 启动时是否自动连接（`autoStart` 用）：env URL 存在即连；文件配置要求有 url
 * 且 `autoStart` 未显式关。**与补齐无关**——补齐在调用方先执行（spec §15.4），
 * 即「有没有地址」只决定连不连，不影响「生不生成配对码」。
 */
export function shouldAutoStartRelay(
  file: RemoteRelayFileConfig,
  envUrl: string | undefined,
): boolean {
  return Boolean(envUrl?.trim()) || (Boolean(file.url?.trim()) && file.autoStart !== false);
}
