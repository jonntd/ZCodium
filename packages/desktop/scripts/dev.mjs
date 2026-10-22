import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareDevElectronAppBundle } from "./devElectronAppBundle.mjs";

const root = resolve(import.meta.dirname, "..");
const mainBundle = resolve(root, "out/main/index.js");
const buildReadyMarkers = [
  { name: "main", path: resolve(root, "out/.main-build-ready") },
  { name: "host", path: resolve(root, "out/.host-build-ready") },
  { name: "preload", path: resolve(root, "out/.preload-build-ready") },
];
const waitLogIntervalMs = 3_000;
const require = createRequire(import.meta.url);

function resolveLocalElectronBinary() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageRoot = resolve(electronPackageJsonPath, "..");

  // Windows 下这里之前直接 spawn("electron")，完全依赖 PATH 里恰好能找到本地 bin。
  // 在 pnpm + PowerShell 场景里，子进程经常只拿到 node 可执行而拿不到 electron 命令，
  // 导致 dev 脚本卡在 ENOENT，只能手动拆成三个终端绕过。
  // 这里显式解析当前项目安装的 Electron 二进制，避免跨 shell / 跨平台时 PATH 语义不一致。
  if (process.platform === "win32") {
    return resolve(electronPackageRoot, "dist", "electron.exe");
  }

  if (process.platform === "darwin") {
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }

  return resolve(electronPackageRoot, "dist", "electron");
}

function probeHttpUrl(url) {
  return new Promise((resolveProbe) => {
    const req = request(url, { method: "HEAD", timeout: 1_000 }, (res) => {
      res.resume();
      resolveProbe({ ok: true });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        reason: `${error.code ? `${error.code} ` : ""}${error.message}`,
      });
    });
    req.end();
  });
}

// Wait for both Vite dev server and main bundle to be ready
async function waitForReady() {
  // desktop 的 tsup 实际是 main/host/preload 三个独立 watch 构建。
  // 之前任意一个构建成功就可能放行，Electron 会在其余产物还未稳定时启动，读到半完成的 ESM/CJS 文件。
  // 现在必须等待三个构建各自写入 ready 标记，再额外确认 main bundle 已产出。
  let lastBuildWaitLogAt = 0;
  while (true) {
    const missingMarkers = buildReadyMarkers
      .filter((marker) => !existsSync(marker.path))
      .map((marker) => marker.name);
    const hasMainBundle = existsSync(mainBundle);
    if (missingMarkers.length === 0 && hasMainBundle) {
      break;
    }
    const now = Date.now();
    if (now - lastBuildWaitLogAt >= waitLogIntervalMs) {
      // dev 启动卡在等待阶段时，终端最后一行常停在 tsup watch 日志，开发者无法判断缺哪个条件。
      // 这里定期打印等待状态，让 marker 或 main bundle 缺失能直接从日志定位。
      console.log(
        `[dev] Waiting for build artifacts... missingMarkers=${
          missingMarkers.join(",") || "none"
        } mainBundle=${hasMainBundle ? "ready" : "missing"}`,
      );
      lastBuildWaitLogAt = now;
    }
    await sleep(300);
  }

  // Wait for Vite dev server
  // Vite 在不同本机 DNS/IPv6 配置下可能只监听 localhost/::1 或 127.0.0.1 其中之一。
  // 这里轮询多个 loopback 地址，避免 dev 脚本和 Vite 实际监听地址不一致导致 Electron 永远不启动。
  const viteUrls = ["http://localhost:5174", "http://127.0.0.1:5174", "http://[::1]:5174"];
  let lastViteWaitLogAt = 0;
  while (true) {
    const failures = [];
    for (const viteUrl of viteUrls) {
      const result = await probeHttpUrl(viteUrl);
      if (result.ok) {
        return viteUrl;
      }
      failures.push(`${viteUrl}: ${result.reason}`);
    }
    const now = Date.now();
    if (now - lastViteWaitLogAt >= waitLogIntervalMs) {
      console.log(`[dev] Waiting for Vite dev server... ${failures.join(" | ")}`);
      lastViteWaitLogAt = now;
    }
    await sleep(300);
  }
}

const rendererUrl = await waitForReady();
console.log("[dev] Starting Electron...");

const electronBinary = resolveLocalElectronBinary();
let electronCommand = existsSync(electronBinary) ? electronBinary : "electron";

if (process.platform === "darwin" && existsSync(electronBinary)) {
  // macOS 命令行启动的 raw Electron 没有 CFBundleURLTypes，LaunchServices 会把
  // zcodium:// 交给一个没有项目入口的 Electron 默认壳。给本地启动副本补齐产品
  // Info.plist 后，线上 Share 页面无需感知 Dev，仍可把链接投递给已运行的 Dev 实例。
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackage = JSON.parse(await readFile(electronPackageJsonPath, "utf8"));
  const electronAppPath = resolve(electronBinary, "../../..");
  const devBundle = await prepareDevElectronAppBundle({
    electronAppPath,
    runtimeRoot: resolve(root, "../../.zcode-runtime/desktop-dev"),
    electronVersion: electronPackage.version,
    arch: process.arch,
  });
  electronCommand = devBundle.executablePath;
  console.log(`[dev] Prepared macOS ZCode Dev bundle: ${devBundle.appPath}`);
}

let electron = null;
let shuttingDown = false;
let restarting = false;
let pendingRestart = false;
let forceKillTimer;
let hardExitTimer;

function spawnElectron() {
  const child = spawn(electronCommand, ["."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  electron = child;

  child.on("error", (error) => {
    console.error("[dev] Failed to start Electron:", error);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (child !== electron) {
      // 已被重启流程替换的旧实例，生命周期由 restartElectron 接管。
      return;
    }
    clearTimeout(forceKillTimer);
    clearTimeout(hardExitTimer);
    if (shuttingDown) {
      process.exit(0);
    }
    if (restarting) {
      // 重启流程在 waitForElectronExit 里等这个 close，这里不退出进程。
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
  return child;
}

function signalElectronTree(signal) {
  if (!electron || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    electron.kill(signal);
    return;
  }

  try {
    process.kill(-electron.pid, signal);
  } catch {
    electron.kill(signal);
  }
}

function shutdownFromSignal(signal) {
  if (shuttingDown) {
    signalElectronTree("SIGKILL");
    return;
  }

  shuttingDown = true;
  console.log(`[dev] Received ${signal}, stopping Electron...`);
  // concurrently 收到 Ctrl+C 后只会结束 node scripts/dev.mjs 这层包装进程，
  // Electron 在 macOS 上不会可靠响应 SIGINT/SIGTERM，之前会被 orphan 到 ppid=1 继续占用端口和日志。
  // 这里把 Electron 放进独立进程组并由 dev 脚本统一回收，超时后强制清掉整棵开发进程树。
  signalElectronTree("SIGTERM");
  forceKillTimer = setTimeout(() => signalElectronTree("SIGKILL"), 1_500);
  hardExitTimer = setTimeout(() => process.exit(0), 5_000);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdownFromSignal(signal));
}

// 产物重建 ⇒ 干净重启 Electron（2026-10-22 实锤：tsup watch 在 App 运行中重建 out/main
// 时，运行中的主进程可能被烧死——事件循环 100%、定时器/日志全饿死，只能重启电脑恢复）。
// 现在只要任何一个产物成功重建（main bundle 或 4 个 .build-ready 标记 mtime 变化），
// 静默 1.5s（等 tsup 这一轮多目标构建全部写完）后就 SIGTERM→SIGKILL 旧实例并重新拉起，
// 保证「运行中的 App」和「磁盘上的产物」永远不同框。ZCODE_DEV_MAIN_RESTART=0 可关闭。
const bundleWatchTargets = [
  mainBundle,
  ...buildReadyMarkers.map((marker) => marker.path),
  resolve(root, "out/.scheduler-build-ready"),
];
const RESTART_QUIET_MS = 1_500;
const RESTART_POLL_MS = 700;

function statMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function restartElectron(reason) {
  if (restarting) {
    pendingRestart = true;
    return;
  }
  restarting = true;
  console.log(`[dev] ${reason}, restarting Electron...`);
  const oldChild = electron;
  signalElectronTree("SIGTERM");
  await new Promise((resolveExit) => {
    const killTimer = setTimeout(() => {
      try {
        if (oldChild?.pid && process.platform !== "win32") {
          process.kill(-oldChild.pid, "SIGKILL");
        } else {
          oldChild?.kill("SIGKILL");
        }
      } catch {
        // 已退出
      }
      setTimeout(resolveExit, 300);
    }, 1_500);
    oldChild?.once("close", () => {
      clearTimeout(killTimer);
      resolveExit();
    });
  });
  spawnElectron();
  restarting = false;
  if (pendingRestart) {
    pendingRestart = false;
    await restartElectron("bundle changed again during restart");
  }
}

function startBundleRestartWatcher() {
  if (process.env.ZCODE_DEV_MAIN_RESTART === "0") {
    console.log("[dev] Bundle-restart watcher disabled (ZCODE_DEV_MAIN_RESTART=0)");
    return;
  }
  let baseline = Math.max(...bundleWatchTargets.map(statMtimeMs));
  let changeSeenAt = 0;
  const timer = setInterval(() => {
    const current = Math.max(...bundleWatchTargets.map(statMtimeMs));
    if (current > baseline) {
      baseline = current;
      changeSeenAt = Date.now();
    }
    if (changeSeenAt && Date.now() - changeSeenAt >= RESTART_QUIET_MS) {
      changeSeenAt = 0;
      void restartElectron("detected bundle rebuild");
    }
  }, RESTART_POLL_MS);
  timer.unref();
}

spawnElectron();
startBundleRestartWatcher();
