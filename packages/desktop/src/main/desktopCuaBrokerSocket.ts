// ZCodium 私有 CUA broker socket（docs/spec/cua-runtime-builtin.md §E 跨安装共存）。
//
// 为什么必须私有：stable socket 按 user 单例（darwin /tmp/zcode-cua-<uid>/broker.sock），
// 官方 ZCode.app 的托管 helper 常驻其上——fork 的 getStatus 探测拿不到 ok、launch 必
// EEXIST，两个 app 无法共存（2026-09-30 真机实测：fork 每次权限查询 ~20s 后如实
// unavailable）。vendor 的 resolveBrokerSocketPath 读标准键 ZCODE_CUA_PERMISSION_BROKER_SOCKET，
// 但该键在 host 启动时被 initializeRuntimeProcessEnv 的 confused-deputy sanitize 从
// process.env 剥掉，main 经标准键注入到不了消费者。因此分两段：
//   main：applyForkCuaBrokerSocketEnv 把私有路径写进 ZCODIUM_CUA_BROKER_SOCKET（fork 键
//         不在剥离清单，能活着穿过 host 启动）；
//   host：@zcode/shared 的 restoreZCodiumCuaBrokerSocketEnv（node.ts 在
//         initializeRuntimeProcessEnv 之后调用）把 fork 键的值恢复成标准键并删掉 fork 键
//         ——vendor 读标准键，Bash/tool 子进程仍拿不到任何 socket 路径，
//         confused-deputy 语义不变。
// 用户显式注入（ZCODIUM_CUA_BROKER_SOCKET，含非空白值）时原样保留。
//
// 标准键值不直接 import vendor：vendor 把它放在 __esm 懒初始化块里，tsup 代码分块后
// chunk 间是真实 ESM live binding——读裸绑定时若懒 init 尚未被任何 vendor 函数触发，
// 拿到的是 undefined（2026-09-30 真机实测：env 键变成字符串 "undefined"）。这里字面量
// 直写，由 desktop-cua-broker-socket.test.mjs 用 vendor resolveBrokerSocketPath 行为探针
// 防守漂移。
//
// 纯函数模块（零 electron / 零 services 依赖）：node --test 可直载，
// 与 desktopCuaHelperTrustEnv.ts 同一拆分理由。
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// vendor socketPath.ts 的协议常量（ZCODE_CUA_PERMISSION_BROKER_SOCKET）。
export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";

// fork 私有下发键（@zcode/shared 的 ZCODIUM_CUA_BROKER_SOCKET_ENV_KEY 同值；此处不 import
// shared 以保持本模块零 workspace 依赖、node --test 可直载，alignment 由行为探针测试防守）。
export const FORK_CUA_BROKER_SOCKET_ENV = "ZCODIUM_CUA_BROKER_SOCKET";

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
  // linux 跟随 #19 数据根新家族（~/.zcodium）：fork 私有目录无迁移数据，
  // 直接切新根；~/.zcode 属官方 ZCode.app（dev.zcode.app）所有，不再落 fork 文件。
  return join(home, ".zcodium", "cua-broker-zcodium", "broker.sock");
}

/**
 * main 侧：把 fork 私有 socket 下发进 host env（fork 键）。用户显式注入时原样保留。
 * 返回新对象，不修改入参。标准键即使被用户设了也到不了 host（sanitize 剥离），
 * 所以这里只写 fork 键，绝不写标准键。
 */
export function applyForkCuaBrokerSocketEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (env[FORK_CUA_BROKER_SOCKET_ENV]?.trim()) {
    return env;
  }
  return { ...env, [FORK_CUA_BROKER_SOCKET_ENV]: resolveForkCuaBrokerSocketPath() };
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
