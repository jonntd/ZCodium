/**
 * 路线 B（官方远控协议）的配置文件读写（spec vps-relay-bridge.md §14.8）。
 *
 * 与路线 A 的 remoteRelayControlIpc 配置互不相干（两套独立技术栈）。
 * `deviceSid` 持久化也在这里：首次注册成功后落盘，后续连接跳过注册直接
 * auth_init（官方语义）——否则手机每次桌面重连都要重扫码。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAppConfigDir } from "@zcode/services/node";

export interface RemoteOfficialRelayFileConfig {
  enabled?: boolean;
  url?: string;
  deviceMid?: string;
  devicePassword?: string;
  /** 首次注册成功后持久化的房间 id；后续连接直接 auth_init（§14.8）。 */
  deviceSid?: string;
}

export interface OfficialRelayStartConfig {
  url: string;
  deviceMid: string;
  devicePassword: string;
  /** 上次会话持久化的 deviceSid；null = 走全新注册。 */
  deviceSid: string | null;
}

export function getOfficialRelayConfigFilePath(): string {
  return join(getAppConfigDir(), "remote-official-relay.json");
}

/**
 * 解析路线 B 启动配置；不满足启用条件（文件缺失 / enabled 非 true / 无 url）时
 * 返回 null，调用方完全不实例化客户端。env `ZCODE_OFFICIAL_RELAY_WS_URL` 优先于
 * 文件 url，但**不回写**文件里的 url。`deviceMid` / `devicePassword` 首次自动生成
 * 并持久化（与路线 A 的 pairingToken/channelKey/slotBase 同模式）：这两个值没有
 * 用户可读语义，手填只会退化成弱口令；轮换 = 清空字段重启。
 */
export async function loadOfficialRelayStartConfig(
  logger?: {
    warn(message: string, detail?: unknown): void;
  },
): Promise<OfficialRelayStartConfig | null> {
  const envUrl = process.env.ZCODE_OFFICIAL_RELAY_WS_URL?.trim() || null;
  let file: RemoteOfficialRelayFileConfig | null = null;
  try {
    const raw = await readFile(getOfficialRelayConfigFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      file = parsed as RemoteOfficialRelayFileConfig;
    } else {
      logger?.warn("官方中继配置文件不是 JSON 对象，已忽略", getOfficialRelayConfigFilePath());
    }
  } catch {
    file = null;
  }

  const fileUrl = typeof file?.url === "string" ? file.url.trim() : "";
  const url = envUrl ?? (fileUrl || null);
  if (file?.enabled !== true || !url) return null;

  const deviceMid = file.deviceMid || randomBytes(16).toString("base64url");
  const devicePassword = file.devicePassword || randomBytes(24).toString("base64url");
  if (!file.deviceMid || !file.devicePassword) {
    // 只在生成凭据时落盘，且保留文件里的 url/enabled 原值（env 只影响本次运行）。
    const nextFile: RemoteOfficialRelayFileConfig = { ...file, deviceMid, devicePassword };
    try {
      const path = getOfficialRelayConfigFilePath();
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(nextFile, null, 2)}\n`, "utf8");
    } catch (error) {
      logger?.warn("官方中继配置写入失败，凭据仅在本次会话内有效", error);
    }
  }
  return {
    url,
    deviceMid,
    devicePassword,
    deviceSid: typeof file.deviceSid === "string" && file.deviceSid ? file.deviceSid : null,
  };
}

/**
 * 持久化 / 清除 deviceSid（spec §14.8）。注册拿到新 sid 后写入；sid 失效
 * （relay 重启丢房 / passHash 轮换）时传 null 清除，客户端回退注册自愈。
 * 配置文件不存在时静默跳过——没有配置就没有会话，无从持久化。
 */
export async function persistOfficialRelayDeviceSid(deviceSid: string | null): Promise<void> {
  const path = getOfficialRelayConfigFilePath();
  let file: RemoteOfficialRelayFileConfig;
  try {
    file = JSON.parse(await readFile(path, "utf8")) as RemoteOfficialRelayFileConfig;
  } catch {
    return;
  }
  const nextFile: RemoteOfficialRelayFileConfig = { ...file };
  if (deviceSid) nextFile.deviceSid = deviceSid;
  else delete nextFile.deviceSid;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(nextFile, null, 2)}\n`, "utf8");
}
