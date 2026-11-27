import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  initializeDataRootInteractive,
  initializeFreshDataRoot,
  isDataBaseDirEnvOverrideActive,
  releasePendingDiagnosticMode,
  setDataBaseDir,
  type DataRootStatus,
} from "@zcode/services/node";
import { ZCODE_VERSION } from "@zcode/shared";

type DataRootPendingStatus = Extract<DataRootStatus, { kind: "absent" | "unowned" | "corrupt" }>;

/**
 * 桌面启动的数据根判定结果：
 * - ready：数据根合法，正常启动；
 * - initialized：已完成全新初始化（无决策需求）；
 * - pending：需要决策窗口（冲突目录 / 存在旧根），主窗口与 Host 必须延后。
 */
export type DesktopDataRootStartupResult =
  | { state: "ready"; baseDir: string }
  | { state: "initialized"; baseDir: string; forfeitedRoot?: string }
  | { state: "pending"; baseDir: string; status: DataRootPendingStatus };

export function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcodium", "v2", "setting.json");
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  // Bug 原因（评审 CR-01）：ZCODE_CREDENTIALS_FILE 是 Source Server Core 的进程装配，凭据路径解析
  // 会优先采用它。Desktop 从设置了该变量的 shell / launchctl 环境启动时，Main cipher、Host 凭据服务
  // 与 Agent 会整体改用外部指定的凭据库（例如 Server 自有库）。Desktop 不是该变量的合法来源，
  // 在任何凭据读写方创建、Host fork 之前删除一次，Main、Host 与 Agent 都只用 Desktop 数据根。
  delete process.env[ZCODE_CREDENTIALS_FILE_ENV];
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (!dataBaseDir) {
    return homeResult.state === "ready"
      ? { state: "ready", baseDir: homeResult.baseDir }
      : { state: "initialized", baseDir: homeResult.baseDir };
  }

  // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录。
  setDataBaseDir(dataBaseDir);
  const customResult = initializeDataRootInteractive({
    createdBy: "desktop",
    appVersion: ZCODE_VERSION,
  });
  if (customResult.state === "pending") {
    return isAutomatedTestRun()
      ? settlePendingForAutomatedTest(customResult.baseDir)
      : {
          state: "pending",
          baseDir: customResult.baseDir,
          status: customResult.status,
        };
  }
  return customResult.state === "ready"
    ? { state: "ready", baseDir: customResult.baseDir }
    : { state: "initialized", baseDir: customResult.baseDir };
}
