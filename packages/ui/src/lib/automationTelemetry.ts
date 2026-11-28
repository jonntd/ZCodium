/** fork no-telemetry 审计版垫片：上游遥测面按 AGENTS.md「已移除功能」约定移除后，
 *  为保留 v4.0.0 的调用点形状提供零上报实现——只走本地 logger，不产生任何网络请求。
 *  重新接通真实遥测时删除本垫片并恢复上游模块。 */

import { logger } from "@/logger.js";

export function reportAutomationActionClick(
  _action: string,
  _context?: Record<string, unknown>,
): void {
  logger.debug("[automation-telemetry/noop] action click", { action: _action });
}

export function reportAutomationCreateResult(_result: unknown): void {
  logger.debug("[automation-telemetry/noop] create result");
}

/** 审计版无遥测消费：返回空字段集。 */
export function resolveAutomationSelectionTelemetry(
  _modelSelection: unknown,
  _providerSettingsView?: unknown,
): Record<string, never> {
  return {};
}
