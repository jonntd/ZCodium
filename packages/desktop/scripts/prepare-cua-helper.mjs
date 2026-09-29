#!/usr/bin/env node
// CUA helper 随包准备（docs/spec/cua-runtime-builtin.md §B）。
//
// darwin：从官方发布 CDN 抽 Developer-ID 签名的 "ZCode Computer Use.app"，落到
//   bundled-cua-helper/<key>/，由 electron-builder extraResources 放进
//   Contents/Resources/cua-helper。生产态 vendor runtime 只认 bundled 来源且要求
//   内嵌 build id 与 helper 的 Info.plist ZCodeCUAHelperBuildId 一致（信任门：
//   非 adhoc + TeamIdentifier 8A5X4JJ39T），所以这里把 buildId 落盘 build-id.txt，
//   CI 据此导出 ZCODE_CUA_HELPER_BUILD_ID 注入构建 define。
// win32：helper runtime 直接引用入库的 runtimes/cua-helper（含 runtime-manifest.json
//   + sha256，运行时由 windowsCuaDevRuntime fail-closed 校验），这里只做完整性自检。
//
// 失败语义：网络/下载与签名/身份校验失败统一 warn + skip（安装包照常产出，CUA 报
// 未安装；坏 helper 不会随包，具体原因看日志）。ZCODE_SKIP_CUA_HELPER=1 显式跳过；
// 已就位且未强制时幂等复用。

import process from "node:process";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {Readable} from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand, runCommandAndReadStdout } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const HELPER_APP_NAME = "ZCode Computer Use.app";
// 与 runtimes/zcode-cua vendor 的 HELPER_TEAM_ID 一致；上游 Developer ID 是唯一可用信任源。
const HELPER_TEAM_ID = "8A5X4JJ39T";
// pin 的官方版本：官方 CDN 目前最新为 3.14.4（3.14.5+ 是本 fork 自己的版本号，CDN 404）。
// helper 的 buildId/短版本从产物读出，不随 pin 手抄；换 pin 无需改其他代码。
const DEFAULT_SOURCE_APP_VERSION = "3.14.4";
const OFFICIAL_RELEASE_CDN_BASE = "https://cdn-zcode.z.ai/zcode/electron/releases";
// vendor normalizeHelperBuildId 的同款合法性约束，提前挡掉 plist 读出的脏值。
const HELPER_BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WIN_HELPER_RUNTIME_REQUIRED_PATHS = [
  "runtime-manifest.json",
  "dist/windows-helper.js",
  "build/Release/ax_native.node",
];

export function resolveCuaHelperSourceUrl({
  cdnBase = OFFICIAL_RELEASE_CDN_BASE,
  appVersion,
  arch,
} = {}) {
  // arch 命名沿用 install.sh 的 ZIP_ARCH 映射（macos-arm64 / macos-x64）。
  return `${cdnBase.replace(/\/+$/, "")}/${appVersion}/macos-${arch}/ZCode-${appVersion}-mac-${arch}.zip`;
}

export function resolveStagedCuaHelperDir(desktopRoot, platformKey) {
  return resolve(desktopRoot, "bundled-cua-helper", platformKey);
}

// 单次尝试整体（含响应体流）超时：CDN 挂起时落到下一次重试/最终 warn+skip，
// 不让 CI 的 prepare 步骤吊到全局超时。
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

async function downloadWithRetry(
  url,
  destPath,
  { attempts = 3, timeoutMs = DOWNLOAD_ATTEMPT_TIMEOUT_MS } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[prepare:cua-helper] download attempt ${attempt}/${attempts} failed: ${error}`);
    }
  }
  throw lastError;
}

function readHelperIdentity(helperAppPath) {
  const infoPlist = join(helperAppPath, "Contents", "Info.plist");
  // 验 plist 用 plutil（勿用 defaults：多值/转义行为不可靠）。
  const buildId = runCommandAndReadStdout("/usr/bin/plutil", [
    "-extract",
    "ZCodeCUAHelperBuildId",
    "raw",
    "-o",
    "-",
    "--",
    infoPlist,
  ]).trim();
  if (!HELPER_BUILD_ID_PATTERN.test(buildId)) {
    throw new Error(
      `[prepare:cua-helper] helper 缺少合法的 ZCodeCUAHelperBuildId（got "${buildId}"），拒绝随包`,
    );
  }
  const helperVersion = runCommandAndReadStdout("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    "--",
    infoPlist,
  ]).trim();
  return { buildId, helperVersion };
}

function assertHelperSignature(helperAppPath) {
  // deep+strict 对应 vendor verify 的入口语义；签名无效直接 fail-fast。
  runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", helperAppPath]);
  // codesign -dv 把身份信息打到 stderr，必须合并读取（只读 stdout 会误判成未签名）。
  const result = spawnSync("/usr/bin/codesign", ["-dv", helperAppPath], { encoding: "utf8" });
  const display = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const teamMatch = display.match(/^TeamIdentifier=(.*)$/m)?.[1]?.trim();
  if (teamMatch !== HELPER_TEAM_ID) {
    throw new Error(
      `[prepare:cua-helper] helper TeamIdentifier=${teamMatch ?? "<not set>"} != ${HELPER_TEAM_ID}，` +
        "运行时信任门必拒，拒绝随包",
    );
  }
}

// patch helper 内嵌的 local-dev 信任门并 adhoc 重签（install.sh 的同款配方）。
// 为什么必须 patch：stock 发布 helper 把 launcher 校验门 `allowUnsignedLauncherLocalDev`
// 编译为 false——它要求启动方与 broker 客户端父链满足 Apple 锚定的 ZCode 签名要求，
// 而 ZCodium 是 adhoc 签名 app，永远无法满足；官方 Developer-ID app 才走原始信任模型。
// fork 的对应偏离（docs/spec/cua-runtime-builtin.md §B）：随包 helper 一律为
// patch+adhoc 变体，运行时以 local_dev_unsigned 模式信任它（plan.allowUnsignedLocalDev）。
// TCC 稳定性：helper 字节内容在同一上游版本间不变，adhoc 签名对相同字节是确定性的
// （cdhash 稳定），因此跨更新 TCC 授权不重置。
const LOCAL_DEV_GATE_PATTERN = Buffer.from("var allowUnsignedLauncherLocalDev = false;");
const LOCAL_DEV_GATE_PATCHED = Buffer.from("var allowUnsignedLauncherLocalDev = true ;");
// helper 的第二道编译门：tokenless（local-dev 无 token）启动要求
// isCuaLocalDevelopmentRuntime(env) 为 true，而 release helper 把它烙死成 false——
// 不翻这个字面量，任何 env/flag 组合都会在 --token-file 检查处退出（等长替换，cdhash 逻辑同上）。
const COMPILED_DEV_GATE_PATTERN = Buffer.from(
  "var COMPILED_LOCAL_DEVELOPMENT_RUNTIME = true ? false :",
);
const COMPILED_DEV_GATE_PATCHED = Buffer.from(
  "var COMPILED_LOCAL_DEVELOPMENT_RUNTIME = true ? true  :",
);

function patchBytesOnce(data, pattern, replacement, label) {
  const idx = data.indexOf(pattern);
  if (idx < 0) {
    if (data.includes(replacement)) return data;
    throw new Error(`[prepare:cua-helper] helper 二进制里找不到 ${label} 字面量，上游结构变了，拒绝盲patch`);
  }
  return Buffer.concat([
    data.subarray(0, idx),
    replacement,
    data.subarray(idx + pattern.length),
  ]);
}

function patchHelperLocalDevGate(helperAppPath) {
  // SEA 内嵌 JS 是明文，可直接按字节替换（与 install.sh 的 python 补丁一致，长度不变）。
  const binPath = join(helperAppPath, "Contents", "MacOS", "ZCode Computer Use");
  if (!existsSync(binPath)) {
    throw new Error(`[prepare:cua-helper] 未找到 helper 可执行文件（${binPath}），patch 失败`);
  }
  let data = readFileSync(binPath);
  data = patchBytesOnce(data, LOCAL_DEV_GATE_PATTERN, LOCAL_DEV_GATE_PATCHED, "launcher 信任门");
  data = patchBytesOnce(data, COMPILED_DEV_GATE_PATTERN, COMPILED_DEV_GATE_PATCHED, "编译期 dev 运行时门");
  writeFileSync(binPath, data);
  // 字节修改使原签名失效，必须 adhoc 重封；对相同字节是确定性的（cdhash 稳定）。
  runCommand("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", helperAppPath]);
  runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", helperAppPath]);
}

async function prepareDarwinHelper(target) {
  const stagedDir = resolveStagedCuaHelperDir(desktopRoot, target.key);
  const stagedAppPath = join(stagedDir, HELPER_APP_NAME);
  const stagedBuildIdFile = join(stagedDir, "build-id.txt");
  const forceRefresh = process.env.ZCODE_FORCE_PREPARE_CUA_HELPER === "1";
  if (!forceRefresh && existsSync(stagedAppPath) && existsSync(stagedBuildIdFile)) {
    console.log(
      `[prepare:cua-helper] reuse staged helper at ${stagedDir} (ZCODE_FORCE_PREPARE_CUA_HELPER=1 强制刷新)`,
    );
    return;
  }

  // 本地源：本机已装的官方 ZCode.app（Contents/Resources/cua-helper）与 CDN 发布件是
  // 同一个 Developer-ID 签名 helper。开发机上指到本地 app 可跳过 ~200MB 整包下载；
  // CI 不设该变量，仍走 CDN。两条路径的签名/身份校验完全一致。
  const localSourceApp = process.env.ZCODE_CUA_HELPER_LOCAL_APP?.trim() || undefined;
  const appVersion =
    process.env.ZCODE_CUA_HELPER_SOURCE_APP?.trim() || DEFAULT_SOURCE_APP_VERSION;
  const url = resolveCuaHelperSourceUrl({ appVersion, arch: target.arch });
  let tempDir = null;
  try {
    let sourceAppPath;
    if (localSourceApp) {
      sourceAppPath = join(localSourceApp, "Contents", "Resources", "cua-helper", HELPER_APP_NAME);
      if (!existsSync(sourceAppPath)) {
        throw new Error(
          `[prepare:cua-helper] ZCODE_CUA_HELPER_LOCAL_APP=${localSourceApp} 下没有 ${HELPER_APP_NAME}`,
        );
      }
      console.log(`[prepare:cua-helper] staging helper from local app: ${localSourceApp}`);
    } else {
      tempDir = mkdtempSync(join(tmpdir(), "zcode-cua-helper-"));
      const zipPath = join(tempDir, "zcode-release.zip");
      console.log(`[prepare:cua-helper] fetching official helper (app ${appVersion}, ${target.arch})…`);
      await downloadWithRetry(url, zipPath);
      const extractDir = join(tempDir, "x");
      runCommand("/usr/bin/unzip", [
        "-q",
        "-o",
        zipPath,
        `ZCode.app/Contents/Resources/cua-helper/*`,
        "-d",
        extractDir,
      ]);
      sourceAppPath = join(
        extractDir,
        "ZCode.app",
        "Contents",
        "Resources",
        "cua-helper",
        HELPER_APP_NAME,
      );
      if (!existsSync(sourceAppPath)) {
        throw new Error(`[prepare:cua-helper] 发布 zip 中没有 ${HELPER_APP_NAME}`);
      }
    }

    rmSync(stagedDir, { recursive: true, force: true });
    mkdirSync(stagedDir, { recursive: true });
    // ditto 保持 bundle 元数据与签名完整性（与 install.sh 既有用法一致）。
    runCommand("/usr/bin/ditto", [sourceAppPath, stagedAppPath]);
    // 清 quarantine，避免后续 codesign 校验在 Gatekeeper 策略下出现误报。
    try {
      runCommand("/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedAppPath]);
    } catch {
      // 无 quarantine 属性时 xattr 非零退出属正常。
    }

    assertHelperSignature(stagedAppPath);
    // 先对 pristine Developer-ID 件验明正身（TeamID），再打 local-dev 补丁并 adhoc 重签——
    // ZCodium 的 adhoc 外壳无法通过 stock helper 的 launcher 信任门（见 patchHelperLocalDevGate 注释）。
    patchHelperLocalDevGate(stagedAppPath);
    const { buildId, helperVersion } = readHelperIdentity(stagedAppPath);
    writeFileSync(stagedBuildIdFile, `${buildId}\n`);
    writeFileSync(
      join(stagedDir, "helper-meta.json"),
      `${JSON.stringify(
        {
          buildId,
          helperVersion,
          patchedLocalDev: true,
          sourceAppVersion: localSourceApp ? "local-app" : appVersion,
          teamIdentifier: HELPER_TEAM_ID,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `[prepare:cua-helper] staged ${HELPER_APP_NAME} → ${stagedDir} ` +
        `(helper ${helperVersion}, buildId ${buildId}, local-dev patched + adhoc)`,
    );
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function assertWindowsHelperRuntime() {
  const runtimeRoot = resolve(repoRoot, "runtimes", "cua-helper");
  const missing = WIN_HELPER_RUNTIME_REQUIRED_PATHS.filter(
    (relativePath) => !existsSync(join(runtimeRoot, relativePath)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[prepare:cua-helper] runtimes/cua-helper 缺少随包必需文件: ${missing.join(", ")}`,
    );
  }
  console.log(
    `[prepare:cua-helper] windows helper runtime ok at ${runtimeRoot}（extraResources 直引，未真机验证）`,
  );
}

async function main() {
  const target = getTargetPlatform();
  if (target.os !== "darwin" && target.os !== "win32") {
    console.log(`[prepare:cua-helper] skip: ${target.os} 无 CUA helper`);
    return;
  }
  if (process.env.ZCODE_SKIP_CUA_HELPER === "1") {
    console.log("[prepare:cua-helper] skip: ZCODE_SKIP_CUA_HELPER=1");
    return;
  }

  if (target.os === "darwin") {
    try {
      await prepareDarwinHelper(target);
    } catch (error) {
      // 下载/解包层面的失败不让整包发布挂掉：CUA 是可选能力，缺失时运行时报未安装。
      // 签名/身份校验失败已在内部抛错路径中同样落到这里——语义是“这次没带 helper”，
      // 但日志会带出具体原因供排查。
      console.warn(
        `[prepare:cua-helper] WARN: helper 未随包（${error.message}）。` +
          "本产物 Computer Use 将报未安装；如需阻断构建请改用 fail-fast 分支排查。",
      );
    }
    return;
  }
  assertWindowsHelperRuntime();
}

// 这里用 pathToFileURL 而不是手拼 file:// ：Windows 上 argv[1] 是 `C:\...` 盘符路径，
// 手拼的 file:// 永远不等于 import.meta.url，脚本会被当成纯模块静默退出（build.mjs 同款教训）。
const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectEntry) {
  await main();
}
