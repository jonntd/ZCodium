// 契约值谓词（stub 侧副本）。
//
// 为什么存在：services 对 `./cuaPermissionService.js` 的值谓词 re-export 在 renderer
// 运行时（vite，无 build-time alias）落到本包；host/main 侧经 tsup alias 落到 vendor
// （runtimes/zcode-cua）。两侧谓词语义必须逐字一致，否则同一个 host 结果会在
// renderer 被判成 unavailable——2026-09-30 实证：stub 用 `available === true`、vendor
// 用 `available !== false`，而成功结果**不带** available 字段，设置页权限状态因此
// 永远无法收敛到「已授权」。修改任一侧时必须同步另一侧（对照测试
// packages/ui/test/cuaPermissionStatusStore.test.ts 与 vendor 谓词共享用例覆盖）。

export function isCuaPermissionStatusAvailable(result) {
  return Boolean(result) && typeof result === "object" && result.available !== false;
}

export function shouldRunCuaScreenCaptureProbe(state, options) {
  if (options?.includeFunctionalProbes !== true) return false;
  return state !== "denied";
}
