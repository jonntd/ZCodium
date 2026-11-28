/** fork no-telemetry 审计版垫片：上游遥测面按 AGENTS.md「已移除功能」约定移除后，
 *  为保留 v4.0.0 的调用点形状提供零上报实现——只走本地 logger，不产生任何网络请求。
 *  重新接通真实遥测时删除本垫片并恢复上游模块。 */

import { logger } from "@/logger.js";

export type UserActionTrigger =
  | "click"
  | "keyboard"
  | "command"
  | "api"
  | (string & {});

export type UserActionResult =
  | "success"
  | "failure"
  | (string & {});

export interface SettingsUserActionInput {
  featureId: string;
  action: string;
  trigger: UserActionTrigger;
}

/** 只执行业务操作，不产生遥测上报（fork no-telemetry 审计版）。 */
export function runUserAction<T>(options: {
  input: SettingsUserActionInput;
  operation: () => T;
  completed?: UserActionResult;
  failureStage?: string;
}): T {
  try {
    return options.operation();
  } catch (error) {
    logger.warn("[user-action] operation failed", {
      featureId: options.input.featureId,
      action: options.input.action,
      error,
    });
    throw error;
  }
}

export async function runUserActionAsync<T>(options: {
  input: SettingsUserActionInput;
  operation: () => Promise<T>;
  completed?: UserActionResult;
  failureStage?: string;
}): Promise<T> {
  try {
    return await options.operation();
  } catch (error) {
    logger.warn("[user-action] async operation failed", {
      featureId: options.input.featureId,
      action: options.input.action,
      error,
    });
    throw error;
  }
}
