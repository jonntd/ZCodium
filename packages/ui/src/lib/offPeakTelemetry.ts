/** fork no-telemetry 审计版垫片：上游遥测面按 AGENTS.md「已移除功能」约定移除后，
 *  为保留 v4.0.0 的调用点形状提供零上报实现——只走本地 logger，不产生任何网络请求。
 *  重新接通真实遥测时删除本垫片并恢复上游模块。 */

import { logger } from "@/logger.js";

/** 只执行真正的创建闭包，不产生遥测快照/上报（fork no-telemetry 审计版）。 */
export async function createAndReportOffPeakTask<T>(
  _platform: unknown,
  _snapshot: unknown,
  create: () => Promise<T>,
): Promise<T> {
  return create();
}

export function freezeOffPeakCreateTelemetrySnapshot(_platform: unknown): unknown {
  return null;
}

export function reportOffPeakCreateResult(_result: unknown): void {
  logger.debug("[offPeak-telemetry/noop] create result");
}
