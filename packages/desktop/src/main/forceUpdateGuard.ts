import type { ForceUpdateRequirement, Locale } from "@zcode/shared";
import type { ForceAutoUpdateState } from "./autoUpdater.js";

export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

export interface ForceUpdateGuardOptions {
  /** fork：灰度公开读取走 ZCode JWT（帮助配置链复用）。 */
  resolveZcodeJwtToken?: () => Promise<string | null | undefined>;
  locale: Locale;
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  requestAutoUpdate?: (
    onStateChange?: (state: ForceAutoUpdateState) => void,
  ) => (() => void) | void;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

export async function maybeBlockStartupForForceUpdate(
  _options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  // ZCodium 使用独立版本线，不能用官方 ZCode 的最低版本配置阻断启动；按更新规范保留零 IO 放行。
  return { blocked: false };
}
