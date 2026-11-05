/**
 * 体积门禁脚本（架构 §7.2 预算硬指标）。
 *
 * 硬门禁（超预算以非零码退出）：
 * - dist/extension.js  ≤ 9 MB（未压缩）
 * - dist/webview/main.js ≤ 8 MB（未压缩）；gzip ≤ 2.5 MB
 * - dist/webview/styles.css ≤ 500 KB（原预算 400KB 按"@source 限定装配面"估算；
 *   实测修通 tailwind 扫描后（CLI Scanner 全量扫 packages/ui/src 类来源）minified 446KB，
 *   gzip 后 ~80KB——传输影响可忽略，预算上调并保留观测）
 * - dist/*.vsix 实测体积 ≤ 25 MB（发布产物口径，§8 DoD「vsix 体积对照 §7 预算」；
 *   package 脚本先 vsce package 再跑本门禁，因此门禁量到的是真实 vsix）
 *
 * 观测项（仅报告，不拦截）：
 * - dist 总量（不含 *.vsix）：webview 懒加载 chunk 原始字节经 vsce 压缩/内联后
 *   不等于发布产物，不能作为发布预算口径；保留报告供 §7.2 处置顺序跟踪。
 */
import { stat, readFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

const BUDGETS = {
  "dist/extension.js": 9 * 1024 * 1024,
  "dist/webview/main.js": 8 * 1024 * 1024,
  "dist/webview/styles.css": 500 * 1024,
  "dist(webview main gzip)": 2.5 * 1024 * 1024,
  "dist/*.vsix": 25 * 1024 * 1024,
};

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

const violations = [];
const report = [];

/** 单产物门禁：缺失或超预算都是 violation；✅ 只在通过时出现在报告里。 */
async function check(relPath, label, limit) {
  const abs = resolve(appRoot, relPath);
  const size = await fileSize(abs);
  if (size === null) {
    violations.push(`${label}: 产物缺失（${relPath}），请先执行 pnpm --filter zcode-vscode build`);
    return;
  }
  if (size > limit) {
    violations.push(`${label}: ${human(size)} 超预算 ${human(limit)}`);
    return;
  }
  report.push(`${label}: ${human(size)} / 预算 ${human(limit)} ✅`);
}

// 单产物
await check("dist/extension.js", "extension.js (host bundle)", BUDGETS["dist/extension.js"]);
await check("dist/webview/main.js", "webview main.js", BUDGETS["dist/webview/main.js"]);
await check("dist/webview/styles.css", "webview styles.css", BUDGETS["dist/webview/styles.css"]);

// 样式完整性门禁：tailwind 管线曾因程序化 API build([]) 静默产出零工具类 CSS
// （只剩主题层，UI 全部失去布局，Antigravity 实测）。在此断言基础工具类在产物中存在，
// 防回归。候选类来自 ui 包源码真实消费面（ConversationDraftEmptyState 等）。
{
  const stylesAbs = resolve(appRoot, "dist/webview/styles.css");
  try {
    const css = await readFile(stylesAbs, "utf8");
    const requiredUtilities = [".invisible", ".flex{", ".absolute", ".mb-10"];
    const missing = requiredUtilities.filter((needle) => !css.includes(needle));
    if (missing.length > 0) {
      violations.push(
        `styles.css 样式完整性: 缺少工具类 ${missing.join("、")}（tailwind 扫描未生效？检查 esbuild.mjs buildStyles 是否走 CLI Scanner 管线）`,
      );
    } else {
      report.push("styles.css 样式完整性: 基础工具类在位 ✅");
    }
  } catch {
    // 文件缺失时单产物 check 已报 violation，此处不重复。
  }
}

// gzip
{
  const abs = resolve(appRoot, "dist/webview/main.js");
  const size = await fileSize(abs);
  if (size !== null) {
    const gz = gzipSync(await readFile(abs)).byteLength;
    const limit = BUDGETS["dist(webview main gzip)"];
    if (gz > limit) {
      violations.push(`webview main.js gzip: ${human(gz)} 超预算 ${human(limit)}`);
    } else {
      report.push(`webview main.js gzip: ${human(gz)} / 预算 ${human(limit)} ✅`);
    }
  }
}

// vsix 实测（发布产物硬门禁）：package 脚本先 vsce 后门禁；standalone `pnpm size`
// 尚无 vsix 时报告缺失处置而非误报（单产物门禁仍然全部硬校验）。
{
  let vsixFiles = [];
  try {
    vsixFiles = (await readdir(resolve(appRoot, "dist"), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && extname(entry.name) === ".vsix")
      .map((entry) => resolve(appRoot, "dist", entry.name));
  } catch {
    // dist 不存在时单产物 check 已报缺失。
  }
  if (vsixFiles.length === 0) {
    report.push("vsix: 尚未打包（先执行 pnpm --filter zcode-vscode package，门禁将在打包后实测 vsix）");
  } else {
    for (const file of vsixFiles) {
      const size = await fileSize(file);
      const label = `vsix (${file.split("/").pop()})`;
      if (size !== null && size > BUDGETS["dist/*.vsix"]) {
        violations.push(`${label}: ${human(size)} 超预算 ${human(BUDGETS["dist/*.vsix"])}`);
      } else {
        report.push(`${label}: ${human(size)} / 预算 ${human(BUDGETS["dist/*.vsix"])} ✅`);
      }
    }
  }
}

// dist 总量（观测项，不拦截）：不含 *.vsix，避免打包后产物被重复计入。
{
  async function dirSize(dir) {
    let total = 0;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(abs);
      else if (extname(entry.name) !== ".vsix") total += (await stat(abs)).size;
    }
    return total;
  }
  const total = await dirSize(resolve(appRoot, "dist"));
  report.push(`dist 总量（观测项，不含 vsix）: ${human(total)}`);
}

console.log("── 体积门禁报告 ──");
for (const line of report) console.log(line);
if (violations.length > 0) {
  console.error("── 体积门禁未通过 ──");
  for (const line of violations) console.error(line);
  console.error("处置顺序见 architecture-p1.md §7.2：检查误引排除组件 → shiki 按需注册 → minify → 拆分懒加载 chunk");
  process.exit(1);
}
console.log("体积门禁全部通过");
