// ZCodium 私有 CUA broker socket（docs/spec/cua-runtime-builtin.md §D 跨安装共存）。
//
// 为什么必须私有：stable socket 按 user 单例（darwin /tmp/zcode-cua-<uid>/broker.sock），
// 官方 ZCode.app 的托管 helper 常驻其上——fork 的 getStatus 探测拿不到 ok、launch 必
// EEXIST，两个 app 无法共存（2026-09-30 真机实测：fork 每次权限查询 ~20s 后如实
// unavailable）。vendor 的 resolveBrokerSocketPath 首选 ZCODE_CUA_PERMISSION_BROKER_SOCKET，
// 这里给 fork 确定性下发独立 runtime 目录：helper 经 --socket argv 拿同一路径，
// agent/node-repl 继承 host env（或经 transport tuple 显式下发），全链路同源。
// 用户显式注入的值优先（与 ZCODE_CUA_BUNDLED_HELPER_APP_PATH 同策略）。
//
// 纯函数模块（零 electron / 零 services 依赖）：node --test 可直载，
// 与 desktopCuaHelperTrustEnv.ts 同一拆分理由。
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// vendor socketPath.ts 的协议常量。不能 import：vendor 把它放在 __esm 懒初始化块里，
// tsup 代码分块后 chunk 间是真实 ESM live binding——本模块读裸绑定时若懒 init 尚未
// 被任何 vendor 函数触发，拿到的是 undefined（2026-09-30 真机实测：env 键变成字符串
// "undefined"，host 收不到，launch 仍打默认 socket）。这里字面量直写，由
// desktop-cua-broker-socket.test.mjs 用 vendor resolveBrokerSocketPath 行为探针防守漂移。
export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";

export function resolveForkCuaBrokerSocketPath({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? String(process.getuid()) : "nouuid",
  home = homedir(),
}: {
  platform?: NodeJS.Platform | string;
  uid?: string;
  home?: string;
} = {}): string {
  if (platform === "win32") {
    // 与 vendor WINDOWS_NAMED_PIPE_PREFIX 同前缀、zcodium 后缀隔离默认 pipe。
    return "\\\\.\\pipe\\zcode-cua-helper-zcodium";
  }
  if (platform === "darwin") {
    return `/tmp/zcode-cua-zcodium-${uid}/broker.sock`;
  }
  return join(home, ".zcode", "cua-broker-zcodium", "broker.sock");
}

/**
 * 把 fork 私有 socket 下发进 host env；用户显式注入（含非空白值）时原样保留。
 * 返回新对象，不修改入参。
 */
export function applyForkCuaBrokerSocketEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (env[BROKER_SOCKET_ENV]?.trim()) {
    return env;
  }
  return { ...env, [BROKER_SOCKET_ENV]: resolveForkCuaBrokerSocketPath() };
}

/**
 * 非 named pipe 的 socket 路径需要父目录先存在（vendor broker bind 不做 mkdir，
 * 默认目录历史上由安装器创建，私有目录没有安装器）。创建失败不兜底——让 helper
 * bind 的 ENOENT 直接暴露诊断信息。
 */
export function ensureForkCuaBrokerSocketDir(
  socketPath = resolveForkCuaBrokerSocketPath(),
  mkdir: typeof mkdirSync = mkdirSync,
): void {
  if (socketPath.startsWith("\\\\.\\pipe\\")) {
    return;
  }
  try {
    mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  } catch {
    // 静默：bind 阶段的 ENOENT 会带完整路径，比这里吞掉的异常更好诊断。
  }
}
