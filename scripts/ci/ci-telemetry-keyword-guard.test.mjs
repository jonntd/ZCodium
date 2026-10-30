import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// 仓库级无遥测关键词守卫（docs/merge-main-impact-check.md 合并后验收第 6 条）：
// 上游同步带回 ARMS/OTLP SDK、遥测核心或上报 IPC 通道时，随 vitest unit / nightly 直接红。
// 分工：desktop/ui/cli 各自有 no-telemetry.test.mjs 覆盖自己的 src 与依赖（verify:pre-push 与
// ci.yml 固定执行）；本守卫补齐没有专属守卫的包（server、services、rpc 等其余包源码），
// 并统一断言全部工作区 package.json 不得声明 @arms/* / @opentelemetry/* 依赖。
// 测试 fixture 与 pending 用例不在扫描面内：遥测回流必然先落在 src/或构建脚本，
// 纯 fixture 命中不代表运行时回流。
// spec：packages/desktop/specs/no-telemetry.md。禁词与豁免清单在本文件维护，新增豁免必须写明理由。
// 实现用同步 fs 且逐包圈定 src/scripts：全仓递归在外置磁盘上会把常规单测拖到分钟级。

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const FORBIDDEN_PATTERNS = [
  // SDK 包名（import 层面回流）。
  "@arms/rum-electron",
  "@opentelemetry/",
  // 遥测核心与桥接标识（desktop no-telemetry 同源禁词）。
  "createTelemetryCore",
  "createDesktopTelemetryFetch",
  "installArmsRumBridgeIpcForward",
  "registerHostNetworkTelemetry",
  // RPC 网络遥测通道与上游资源遥测能力位。
  "NetworkTelemetryChannelServer",
  "NetworkTelemetryChannelClient",
  "processResourceTelemetry",
  // 上报 IPC 通道（preload/renderer 桥回流）。
  "ReportTelemetryEvent",
  "ReportArmsCustomEvent",
  "ReportLocalTtftBatch",
  "ReportRendererActionTraceBatch",
  "SyncTelemetryContext",
];

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vite",
  "bundled-agents",
  "bundled-resources",
  "mock-cdn",
  "locales",
  "assets",
  ".e2e-home",
]);

// 只扫代码文件；JSON（登记表/上游快照）与锁文件不在关键词扫描范围，依赖检查单独做。
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

// 上游等待处置的 pending 测试本就不执行，禁词命中不代表回流。
const PENDING_SUFFIX = ".test.pending.ts";

// 每条豁免都要写明理由；路径相对仓库根（posix 分隔）。
const ALLOWED_PATHS = [
  // 守卫自身：禁词表即断言串。
  /(^|\/)ci-telemetry-keyword-guard\.test\.mjs$/,
  // merge-main 影响评估 fixture 内嵌登记标记串（fork-customizations 的 contains 值）。
  /^scripts\/merge-main-impact-check\.test\.mjs$/,
  // patch 依赖清理工具的回归夹具沿用历史 @arms 补丁名（patch 本体已删除）。
  /^scripts\/test\/bootstrap-patched-dependencies\.test\.mjs$/,
  // 打包排除清单：把 ARMS/OTLP 依赖挡在产物外，正是去遥测防线的一部分。
  /^packages\/desktop\/scripts\/bundle\.mjs$/,
  /^packages\/desktop\/electron-builder\.config\.js$/,
  // RPC 现有遥测导出面：桌面已不消费（desktop no-telemetry 禁止引用），
  // 是否删除属独立决策；本豁免不代表允许新增消费方。
  /^packages\/rpc\/src\/network-telemetry-middleware\.ts$/,
  /^packages\/rpc\/src\/index\.ts$/,
  // 上游 payload 兼容 schema 字段（processResourceTelemetry），仅解析不产生上报。
  /^packages\/shared\/src\/server-remote\.ts$/,
];

// 源码扫描目标：没有专属 no-telemetry 守卫的包的 src/ 与构建脚本、仓库级 scripts/。
// desktop/src、ui/src 与 apps/zcode-cli 由三份包级守卫负责，不重复扫描；
// 逐包显式圈定而不是全仓递归，避免把上万测试 fixture 拖进常规单测时长。
const PACKAGES_WITH_OWN_GUARD = new Set(["desktop", "ui"]);
const SRC_DIRECTORY_TARGETS = [
  ...listPackageSubdirs("packages", ["src", "scripts"], PACKAGES_WITH_OWN_GUARD),
];

// 依赖断言目标：全部工作区 package.json（含根、CLI 内部包），锁文件不算声明。
const MANIFEST_PATHS = [
  "package.json",
  ...listPackageFiles("packages"),
  ...listPackageFiles("apps"),
  ...listPackageFiles("apps/zcode-cli/packages"),
];

function listPackageSubdirs(parent, subdirs, excluded) {
  const targets = [];
  let packages;
  try {
    packages = readdirSync(join(repoRoot, parent), { withFileTypes: true });
  } catch {
    return targets;
  }
  for (const entry of packages) {
    if (excluded?.has(entry.name)) {
      continue;
    }
    for (const subdir of subdirs) {
      targets.push(`${parent}/${entry.name}/${subdir}`);
    }
  }
  return targets;
}

function listPackageFiles(parent) {
  const manifests = [];
  let packages;
  try {
    packages = readdirSync(join(repoRoot, parent), { withFileTypes: true });
  } catch {
    return manifests;
  }
  for (const entry of packages) {
    manifests.push(`${parent}/${entry.name}/package.json`);
  }
  return manifests;
}

function walkSync(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        walkSync(fullPath, onFile);
      }
    } else if (
      entry.isFile() &&
      SCANNED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf("."))) &&
      !entry.name.endsWith(PENDING_SUFFIX)
    ) {
      onFile(fullPath);
    }
  }
}

it("仓库源码无遥测关键词、依赖清单无 ARMS/OTLP SDK", () => {
  const violations = [];
  for (const target of SRC_DIRECTORY_TARGETS) {
    walkSync(join(repoRoot, target), (filePath) => {
      const relativePath = relative(repoRoot, filePath).split(sep).join("/");
      if (ALLOWED_PATHS.some((pattern) => pattern.test(relativePath))) {
        return;
      }
      const content = readFileSync(filePath, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (content.includes(pattern)) {
          violations.push(`${relativePath}: ${pattern}`);
        }
      }
    });
  }
  expect(violations, "发现遥测回流；对照 packages/desktop/specs/no-telemetry.md 处理").toEqual([]);

  const manifestViolations = [];
  for (const manifestPath of MANIFEST_PATHS) {
    let content;
    try {
      content = readFileSync(join(repoRoot, manifestPath), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        // 非工作区目录（如 packages/android、bundled-skills）没有 package.json，属正常缺省。
        continue;
      }
      throw error;
    }
    const manifest = JSON.parse(content);
    const sections = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ];
    for (const section of sections) {
      for (const name of Object.keys(section ?? {})) {
        if (name.startsWith("@arms/") || name.startsWith("@opentelemetry/")) {
          manifestViolations.push(`${manifestPath}: ${name}`);
        }
      }
    }
  }
  expect(manifestViolations, "发现遥测 SDK 依赖回流").toEqual([]);
});
