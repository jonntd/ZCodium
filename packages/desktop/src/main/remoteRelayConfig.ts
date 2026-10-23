/**
 * 中继配置的纯逻辑（spec vps-relay-bridge.md §15.4 / §16 / §17）：
 * 配置文件读取、env 覆盖解析（env > 文件 > 统一默认值）与「首次自动生成」补齐链。
 *
 * 与 `remoteRelayControlIpc.ts`（IPC 胶水 + 中继客户端生命周期）分开的原因同
 * `remoteRelayConfigPayload.ts`：本模块**不导入 electron**，可在纯 Node 测试里加载
 * （控制模块 import 了 `ipcMain`，原生 ESM 的具名导出检查会在链接期直接拒绝，
 * 表现为 `The requested module 'electron' does not provide an export named 'ipcMain'`）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import {
  generateRelayChannelKey,
  resolveRelayRoomKey,
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
  /** 房间密钥（v6 key-room，spec §19）：拨入 Bearer 凭据 + 手机配对凭据 + 房间路由键。 */
  roomKey: string;
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
  /** 端到端加密开关（spec vps-relay-bridge.md §16）。 */
  e2ee: boolean;
  /** 并发客户端槽位数（spec §17）。 */
  slots: number;
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

/** E2EE 生效开关（spec vps-relay-bridge.md §16）。
 *  优先级：env `ZCODE_REMOTE_RELAY_E2EE`（`1`/`true` 开，`0`/`false` 显式关）>
 *  文件 `e2ee`（显式 true/false）> **默认开启**（v4，2026-10-21：未显式设置过的设备
 *  默认加密——手机端只用自带 web bundle，具备 E2EE 能力，见 §16.6 灰度结论）。
 *  resolveEffectiveConfig 与补齐链共用同一判定，避免两处漂移。 */
export function isE2eeEnabled(file: RemoteRelayFileConfig | null): boolean {
  const env = process.env.ZCODE_REMOTE_RELAY_E2EE?.trim();
  if (env) return /^(1|true)$/i.test(env);
  if (file?.e2ee !== undefined) return file.e2ee === true;
  return true;
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

  const envWindow = Number(process.env.ZCODE_REMOTE_RELAY_WINDOW ?? "");
  const envWorkspace = process.env.ZCODE_REMOTE_RELAY_WORKSPACE?.trim();
  // E2EE 判定收口到 isE2eeEnabled（与补齐链同源）。
  // 并发客户端槽位数（spec §17）：每槽位一条独立连接 + 独立 Host attachment。
  // 槽位号是房间内 0..slots-1（v6 key-room：房间即隔离，原 slotBase 删除）。
  const envSlots = Number.parseInt(process.env.ZCODE_REMOTE_RELAY_SLOTS?.trim() ?? "", 10);
  const rawSlots = Number.isInteger(envSlots) ? envSlots : file?.slots;
  const slots = Math.min(8, Math.max(1, Number.isInteger(rawSlots) ? (rawSlots as number) : 1));

  // 公开地址只认用户显式填的值；缺省推导（ws→http / wss→https）交给 buildRelayShareLink
  // 在生成链接时做——见 `publicUrlOverride` 的注释。
  const publicUrlOverride = file?.publicUrl?.trim() || null;

  return {
    url,
    // roomKey 由补齐链（ensureRoomKey）先行保证存在；resolve 只读不生成，
    // 生成时机收口在补齐链，避免「读状态」与「拨出」两次生成漂移。
    roomKey: file?.roomKey?.trim() || "",
    pinnedWindowId:
      Number.isInteger(envWindow) && envWindow > 0
        ? envWindow
        : typeof file?.windowId === "number" && file.windowId > 0
          ? file.windowId
          : null,
    pinnedWorkspacePath: envWorkspace || file?.workspace?.trim() || null,
    publicUrlOverride,
    e2ee: isE2eeEnabled(file),
    slots,
    channelKey: file?.channelKey?.trim() || null,
    source: envUrl ? "env" : "file",
  };
}

/** v5 旧配置的遗留字段（已从 `RemoteRelayFileConfig` 删除，磁盘上仍可能存在；只读迁移用）。 */
interface LegacyRelayConfigFields {
  hostSecret?: string;
  pairingToken?: string;
  slotBase?: number;
}

/**
 * 房间密钥补齐 + v5→v6 迁移（spec §19.5）。
 *
 * 决策在 shared 的 `resolveRelayRoomKey`（纯函数，可单测）：
 * 已有 roomKey 沿用；旧 pairingToken/hostSecret 为自定义值时沿用（旧手机链接继续可用）；
 * 缺失或等于已公开的默认常量时随机生成。落盘时**同时移除旧字段**，写回扁平新形状——
 * 否则下次读取又会看到旧值（虽然 resolve 不再读它们，但残留只会制造误解）。
 *
 * 迁移落盘失败的降级与其它补齐一致：内存里保留结果，仅 warn。
 */
async function ensureRoomKey(
  file: RemoteRelayFileConfig | null,
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig> {
  const legacy = (file ?? {}) as RemoteRelayFileConfig & LegacyRelayConfigFields;
  const { roomKey, source } = resolveRelayRoomKey({
    roomKey: file?.roomKey,
    pairingToken: legacy.pairingToken,
    hostSecret: legacy.hostSecret,
  });
  const hasLegacyFields =
    legacy.hostSecret !== undefined ||
    legacy.pairingToken !== undefined ||
    legacy.slotBase !== undefined;
  if (source === "kept" && !hasLegacyFields) return { ...file, roomKey };
  // 需要写盘：生成/沿用迁移值，或剥掉旧字段。旧字段从对象上显式删除（spread 不会去 undefined 键）。
  const nextFile: RemoteRelayFileConfig = { ...(file ?? {}), roomKey };
  delete (nextFile as RemoteRelayFileConfig & LegacyRelayConfigFields).hostSecret;
  delete (nextFile as RemoteRelayFileConfig & LegacyRelayConfigFields).pairingToken;
  delete (nextFile as RemoteRelayFileConfig & LegacyRelayConfigFields).slotBase;
  try {
    await writeConfigFile(nextFile);
    logger?.info(
      source === "generated"
        ? `[remote-relay] 已生成房间密钥并写入 ${getConfigFilePath()}`
        : `[remote-relay] 已迁移为 key-room 配置（沿用原密钥）并写入 ${getConfigFilePath()}`,
    );
  } catch (error) {
    logger?.warn("[remote-relay] 房间密钥写入失败，仅在本次会话内有效", error);
  }
  return nextFile;
}

/**
 * 密钥补齐链（spec §19.4/§19.5）：房间密钥（含 v5 迁移）与 E2EE channelKey 缺失时
 * 生成并落盘。v6 起不再有 hostSecret/pairingToken/slotBase 三条链。
 *
 * ⚠ 调用方在 `resolveEffectiveConfig` **之前无条件执行**：全新设备还没有中继地址时，
 * App 启动（`autoStart`）与读状态（`GetStatus`）也会把 roomKey 生成出来并落盘——
 * 「运行 App 即自动生成」，UI 里直接可见/复制。
 *
 * 幂等：已存在的值原样返回；写盘失败（只读目录等）只 warn，本次会话内存里仍用新值。
 */
export async function ensureRelaySecrets(
  file: RemoteRelayFileConfig | null,
  logger?: RelayConfigLogger,
): Promise<RemoteRelayFileConfig> {
  const withRoomKey = await ensureRoomKey(file, logger);
  return ensureE2eeChannelKey(withRoomKey, logger);
}

/**
 * 启用 E2EE 且 channelKey 缺失时**随机生成**并落盘（spec §16.5 v5，2026-10-22）。
 *
 * v5 从 v4 的「回填统一默认值」回退到随机生成：channelKey 不与任何服务端共享
 * （中继永远看不到分享链接的 `#k=`，它只约束桌面↔手机两端），固定成仓库常量的唯一
 * 收益是「换设备后旧链接仍能解密」，代价却是 E2EE 的保密前提从「每部署独立随机」
 * 退化为「全局公开常量」——读过仓库或拉过公开中继镜像的人即可解密全部流量。
 * 跨设备迁移改用「导入旧分享链接」（链接自带 `#k=`），不需要共享常量。
 *
 * ⚠ 已有值（含 v4 期间落盘的 `DEFAULT_RELAY_CHANNEL_KEY`）**不回改**：改了会让既有
 * 链接立刻全部失效。只有缺失 / 用户清空保存时才随机生成——这正是「清空保存 = 轮换」
 * 语义（UI 文案 `settings.remoteRelay.channelKeyDescription` 依赖它）。
 * 判定用 `isE2eeEnabled`（env 显式值 > 文件显式值 > 默认开启，与 resolveEffectiveConfig
 * 同源）。
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
    // 落盘失败时仅本次会话内有效：重启后会重新生成（换新值 ⇒ 旧链接失效），warn 提示。
    logger?.warn("[remote-relay] E2EE channelKey 写入失败，仅在本次会话内有效", error);
  }
  return nextFile;
}

/**
 * App 启动时是否自动连接（`autoStart` 用）：env URL 存在即连；文件配置要求有 url
 * 且 `autoStart` 未显式关。**与补齐无关**——补齐在调用方先执行（spec §15.4），
 * 即「有没有地址」只决定连不连，不影响「生不生成房间密钥」。
 */
export function shouldAutoStartRelay(
  file: RemoteRelayFileConfig,
  envUrl: string | undefined,
): boolean {
  return Boolean(envUrl?.trim()) || (Boolean(file.url?.trim()) && file.autoStart !== false);
}
