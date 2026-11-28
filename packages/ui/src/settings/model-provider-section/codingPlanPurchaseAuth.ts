/** fork no-telemetry 审计版垫片：Coding Plan 购买令牌状态读取。
 *  上游实现依赖遥测身份链，本仓按已移除功能约定只返回未登录态；
 *  重新接通购买链路时恢复上游模块。 */

export interface CodingPlanPurchaseTokenState {
  authenticated: boolean;
  providerId: string | null;
}

export function readCodingPlanPurchaseTokenState(
  accountAvailability: { loginProvider?: string | null } | null | undefined,
): Record<string, boolean> {
  if (!accountAvailability?.loginProvider) return {};
  return { [accountAvailability.loginProvider]: false };
}
