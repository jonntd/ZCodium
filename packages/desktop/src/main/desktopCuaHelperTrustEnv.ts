// ZCodium fork 的 CUA helper 信任门 env 决策（docs/spec/cua-runtime-builtin.md §B 信任模型偏离）。
// 纯函数、零依赖：信任语义必须在 node --test 里可直接验证，不能耦合 electron/services 导入面。
export const ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV = "ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL";

export function applyBundledCuaHelperTrustEnv<T extends Record<string, string | undefined>>(
  env: T,
  bundledAppPath: string | undefined,
): T {
  if (!bundledAppPath) {
    // 未打包（dev）保持上游语义：信任门由文档化的 dev 流程显式 opt-in，主进程不代持。
    return env;
  }
  // 随包 helper 一律是 prepare:cua-helper 打过 local-dev 补丁的 adhoc 变体，fork 无 Apple 证书，
  // 上游严格验证（非 adhoc + TeamID pin）对本产品永远不满足——必须与 host 链同语义走
  // local_dev_unsigned（buildId/arch 校验保留）。上游在同点位 delete 该变量以保证"已签名 app
  // 的确定性"；fork 反转为"由主进程确定性提供"：恒置 "1"，用户 shell/launchctl 注入无法改变行为。
  return { ...env, [ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV]: "1" };
}
