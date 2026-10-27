import { BROKER_SOCKET_ENV, mintBrokerSocketPath } from "@zcode/zcode-cua/broker";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { resolveWindowsCuaRuntime } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

const logger = createServiceLogger("stable-cua-transport");

export interface StableCuaWinRecipe {
  command: string;
  entryPath: string;
  root: string;
  addonPath: string;
  commandEnv: Record<string, string>;
}

let stablePipeName: string | null = null;
let recipePromise: Promise<StableCuaWinRecipe | null> | null = null;
let recipeFailureLogged = false;

/**
 * win32 稳定 pipe 名（lazy-startup spec §3.1/§9.2-D1）。
 *
 * 优先读恢复后的标准键 ZCODE_CUA_PERMISSION_BROKER_SOCKET：host bootstrap 在
 * initializeRuntimeProcessEnv 之后用 restoreZCodiumCuaBrokerSocketEnv 把 main 经
 * fork 键（ZCODIUM_CUA_BROKER_SOCKET）下发的共存层稳定名
 * （\\.\pipe\zcode-cua-helper-zcodium，§E 跨安装隔离）恢复进标准键。此前这里直接铸
 * 随机名，导致探测/spawn env/Host fork 三者用随机名自洽、共存层稳定名在 win32 CUA
 * 链路上变成死值——桌面端与插件宿主对管道名各说各话，MCP 永远连不上手工拉起的
 * helper（2026-10-27 Windows 实机验证，spec §9.1.2）。
 *
 * env 未注入时（CLI 直跑等场景）回退铸随机名，保持原兜底语义。铸名结果按进程缓存；
 * 命中 env 的值本身就是进程内常量，无需额外缓存判定。
 */
export function getStableCuaPipeName(): string {
  if (stablePipeName) return stablePipeName;
  const injected = process.env[BROKER_SOCKET_ENV]?.trim();
  stablePipeName = injected || mintBrokerSocketPath({ env: process.env });
  return stablePipeName;
}

export function resolveStableCuaWinRecipe(): Promise<StableCuaWinRecipe | null> {
  recipePromise ??= resolveWindowsCuaRuntime()
    .then((runtime) => ({
      command: runtime.command,
      entryPath: runtime.entryPath,
      root: runtime.root,
      addonPath: runtime.addonPath,
      commandEnv: runtime.commandEnv,
    }))
    .catch((error: unknown) => {
      if (!recipeFailureLogged) {
        recipeFailureLogged = true;
        logger.warn(
          undefined,
          `Windows CUA helper recipe unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      recipePromise = null;
      return null;
    });
  return recipePromise;
}

export function __resetStableCuaTransportForTest(): void {
  stablePipeName = null;
  recipePromise = null;
  recipeFailureLogged = false;
}

export const __STABLE_CUA_TRANSPORT_TEST_HOOKS = {
  BROKER_SOCKET_ENV,
};
