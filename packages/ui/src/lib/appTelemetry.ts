/** fork no-telemetry 审计版垫片：上游遥测面按 AGENTS.md「已移除功能」约定移除后，
 *  为保留 v4.0.0 的调用点形状提供零上报实现——只走本地 logger，不产生任何网络请求。
 *  重新接通真实遥测时删除本垫片并恢复上游模块。 */

import { logger } from "@/logger.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import type { TelemetryUiMode } from "@zcode/shared";

export type AppTelemetryEventPayload = Record<string, unknown> & {
  elementName?: string;
};

/** fork no-telemetry 审计版：渲染层遥测事件只落本地 debug 日志。 */
export function reportAppTelemetryEvent(
  _platform: unknown,
  event: AppTelemetryEventPayload,
  _source?: string,
): void {
  logger.debug("[app-telemetry/noop] event", { elementName: event?.elementName });
}

export function resolveProviderTelemetryLabel(_providerId: string): string {
  return "";
}

export function toTelemetryUiMode(mode: InterfaceMode): TelemetryUiMode {
  // 审计版无遥测消费；返回 unknown 兼容旧签名。
  return "unknown";
}

export function useSetInterfaceModeWithTelemetry() {
  return (mode: InterfaceMode) => mode;
}
