/**
 * 设置读取（gode.cliPath / mode / model / permissions.* / mcp / context.*）。
 * 只做读取与归一化，不持有 vscode 之外的状态。
 * 纯类型与解析函数在 configSettings.ts / hostSettingsBridge.ts（无 vscode 依赖）。
 */

import { workspace, ConfigurationTarget, type WorkspaceConfiguration } from "vscode";
import {
  DEFAULT_GODE_CONFIG,
  normalizeMode,
  parseModelSelection,
  type GodeConfig,
} from "./configSettings";
import type { HostSettingsSnapshot } from "./host/hostSettingsBridge";

export { parseModelSelection, DEFAULT_GODE_CONFIG } from "./configSettings";
export type { GodeConfig, ZCodeSessionMode } from "./configSettings";

export function readConfig(): GodeConfig {
  const section = workspace.getConfiguration("gode");
  return {
    cliPath: section.get<string>("cliPath", "").trim(),
    mode: normalizeMode(section.get<string>("mode")),
    rawModel: section.get<string>("model", "").trim(),
  };
}

/** HostSettingsBridge 的 settings 快照读取（P1-3/P1-8/P1-16 参数面）。 */
export function readHostSettingsSnapshot(): HostSettingsSnapshot {
  const section: WorkspaceConfiguration = workspace.getConfiguration("gode");
  return {
    toolAllowlist: section.get<string[]>("permissions.allowlist", []),
    toolDenylist: section.get<string[]>("permissions.denylist", []),
    mcpServers: section.get<unknown[]>("mcp.servers", []),
    additionalDirectories: section.get<string[]>("context.additionalDirectories", []),
    mode: section.get<string>("mode", "build"),
    rawModel: section.get<string>("model", ""),
  };
}

/**
 * settings 写回（plat 方法 updatePermissionRules/updateMcpServers/updateAdditionalDirectories
 * 与 appendSessionAllowlist 的落地面）：一律写 workspace scope（P1-2 per-folder 语义），
 * 无 folder 时退回 global scope；改动后需重建会话/下次 spawn 生效（PRD 降级口径）。
 */
export function readGodeSetting(key: string): unknown {
  return workspace.getConfiguration("gode").get(key);
}

export async function writeGodeSetting(
  key:
    | "permissions.allowlist"
    | "permissions.denylist"
    | "mcp.servers"
    | "context.additionalDirectories"
    // FR-A03（M2-1）：pane 内 switchModelConfig 帧的回写面（值 = providerId/modelId）。
    | "model",
  value: unknown,
): Promise<void> {
  const hasFolders = (workspace.workspaceFolders ?? []).length > 0;
  await workspace
    .getConfiguration("gode")
    .update(key, value, hasFolders ? ConfigurationTarget.Workspace : ConfigurationTarget.Global);
}
