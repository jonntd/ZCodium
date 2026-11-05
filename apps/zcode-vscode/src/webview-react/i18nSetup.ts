/**
 * i18nSetup — VS Code locale → ZCodeIntlProvider 初始语言（架构 §2.4 i18n 跟随，T04）。
 *
 * env.language（如 zh-cn / en）→ ui 包 Locale 联合（zh-CN / fa-IR / en-US）。
 * 宿主配置变更时经 host 帧（locale）推送刷新。
 */

import type { Locale } from "@zcode/shared";

/** 纯映射函数（vitest 直测）。 */
export function mapVscodeLanguage(language: string | undefined): Locale {
  const normalized = (language ?? "").toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("fa")) return "fa-IR";
  return "en-US";
}
