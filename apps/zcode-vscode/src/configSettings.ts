/**
 * 配置类型与纯函数（无 vscode 依赖，供测试复用）。
 * settings 读取（readConfig）在 config.ts（vscode 层）。
 * 协议类型唯一所有者回归 @zcode/shared——本模块只保留插件侧 UI 偏好。
 */

export type ZCodeSessionMode = "build" | "plan" | "edit" | "guarded" | "yolo" | "auto";

export const ZCODE_SESSION_MODES: readonly ZCodeSessionMode[] = [
  "build",
  "plan",
  "edit",
  "guarded",
  "yolo",
  "auto",
];

export interface ZcodiumConfig {
  /** settings 里配置的 CLI 绝对路径，空串表示走 PATH 探测。 */
  cliPath: string;
  /** 会话创建参数 config.mode，默认 build。 */
  mode: ZCodeSessionMode;
  /** settings 的 model 字符串（"providerId/modelId"），未解析。空串 = CLI 默认模型。 */
  rawModel: string;
}

export const DEFAULT_ZCODIUM_CONFIG: ZcodiumConfig = {
  cliPath: "",
  mode: "build",
  rawModel: "",
};

/**
 * 把 settings 的 "providerId/modelId" 解析为协议 modelSelection；
 * 无法解析（缺 "/"）时返回 undefined，让 CLI 用默认模型。
 */
export function parseModelSelection(
  raw: string,
): { providerId: string; modelId: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/** 归一化 mode：非法值回落 build。 */
export function normalizeMode(raw: string | undefined): ZCodeSessionMode {
  return ZCODE_SESSION_MODES.includes(raw as ZCodeSessionMode)
    ? (raw as ZCodeSessionMode)
    : "build";
}

/**
 * MCP servers 的 settings 写回归一化（updateMcpServers，P1-8 写回面）：
 * 只保留数组内的对象条目（settings schema `zcodium.mcp.servers: object[]`），
 * 字段级校验归 @zcode/shared 的 zcodeProtocolMcpServerSchema（会话参数面时校验）。
 */
export function normalizeMcpServersForSettings(servers: readonly unknown[]): unknown[] {
  return servers.filter(
    (server) => typeof server === "object" && server !== null && !Array.isArray(server),
  );
}
