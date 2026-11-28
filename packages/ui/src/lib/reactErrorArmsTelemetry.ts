/** fork no-telemetry 审计版垫片：上游遥测面按 AGENTS.md「已移除功能」约定移除后，
 *  为保留 v4.0.0 的调用点形状提供零上报实现——只走本地 logger，不产生任何网络请求。
 *  重新接通真实遥测时删除本垫片并恢复上游模块。 */

import { logger } from "@/logger.js";

/** fork no-telemetry 审计版：React 错误只落本地日志，不上报 ARMS。 */
export function reportReactErrorToArms(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  logger.error("[react-error]", error, context ?? {});
}

export function setReactErrorArmsReporter(_reporter: unknown): void {}
