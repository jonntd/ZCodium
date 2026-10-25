// fork 改名（2026-10-25，docs/spec/cua-runtime-builtin.md §B）：Helper 身份与官方 ZCode 彻底分离。
// TCC 授权行按 bundle id 存键——官方 ZCode 的 Helper 与本 fork 的 Helper 过去共享
// dev.zcode.cua-helper，同名同图标同 id，系统设置里互相踩授权（拖拽撞已有行、
// tccutil reset 互相清除）。改为 dev.zcodium.computer（与 dev.zcode.cua-helper 等长 20 字节，
// Helper SEA 二进制可等长字节 patch；变长 patch 会错位 Mach-O 段偏移，不可行——真机实测）。
// 显示名/目录名走 plist 与本常量（纯 JS，长度自由）。
// DEV_* 保持官方命名不变：dev 流的 staged 件与 product patch 管线相互独立。
export const HELPER_APP_NAME = "ZCodium Computer Use.app";
export const DEV_HELPER_APP_NAME = "ZCode Computer Use Dev.app";
export const HELPER_DISPLAY_NAME = "ZCodium Computer Use";
export const HELPER_BUNDLE_ID = "dev.zcodium.computer";
export const DEV_CUA_HELPER_BUNDLE_ID = "dev.zcode.cua-helper.dev";
