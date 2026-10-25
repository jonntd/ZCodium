#!/usr/bin/env node
// 合并 main 前的影响对比 —— 在把上游 ref（默认 origin/main）合入当前分支之前，
// 先算出「对方会带进来什么」与「本分支改过什么」的交集，把冲突/覆盖风险摆到桌面上，
// 防止 fork 定制（DMG 布局、specs、release 工作流、应用身份等）被上游同路径文件静默
// 覆盖。v3.15.1 再基线曾把 electron-builder DMG contents 覆盖成上游简化版，直到打包
// 后挂载窗口错乱才被发现——本脚本把这类事故拦截在合并动作本身。
//
// 用法：
//   node scripts/merge-main-impact-check.mjs [ref]              预览模式，默认 origin/main
//   node scripts/merge-main-impact-check.mjs --merge [ref]      评估通过后执行真正的 git merge
//   node scripts/merge-main-impact-check.mjs [ref] --json       结构化输出
//
// 退出码：0 无交集或已放行合并；1 --merge 被拦截 / 用法错误；2 预览模式存在交集。
//
// 为什么拦截点在包装命令而不是 pre-merge-commit 钩子里：实测 git 2.56 在
// pre-merge-commit 执行时既不传待合并 ref（$1 为空）也尚未写入 MERGE_HEAD，
// 钩子拿不到「要合入谁」，无法计算影响。因此 .husky/pre-merge-commit 只做
// 闸门（未经过本脚本评估的直接 git merge 一律拦下并给指引），真正的对比在
// 本脚本完成后再放行合并，评估结论通过 ZCODE_MERGE_IMPACT_ACK=1 传递给钩子。
//
// 边界：FF 合并不产生 merge commit、不经过 pre-merge-commit 钩子；本仓库长期分支
// 与 main 必然分叉，同步上游总是 merge commit。有文本冲突的合并不会自动提交、
// 同样不触发该钩子，冲突本身已强制人工介入；本脚本主要拦截「无文本冲突但语义
// 被覆盖」的高危场景（例如同名文件双方都改、fork 标记被上游版本冲掉）。

import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// fork 身份/定制标记：交集中任一文件在当前分支版本里含有这些内容，即视为
// 「上游不知道本分支定制、合并方向以对方为准时会丢」的高危文件。大小写不敏感。
const FORK_MARKERS = [/zcodium/i, /解除拦截/];

// fork 定制登记表：与 scripts/fork-customization-guard.test.mjs 共用同一份事实源。
// 交集文件命中登记标记 → 报告点名定制点 id；守护测试则断言标记在 HEAD 的存活状态，
// 让「合并/再基线冲掉定制」在 CI 就炸，而不是等打包后由用户发现（v3.15.1 事故）。
const FORK_CUSTOMIZATION_REGISTRY = JSON.parse(
  readFileSync(new URL("./fork-customizations.json", import.meta.url), "utf8"),
);
// Map<文件路径, Array<{ contains, absent?, id }>>：正向标记出现 = 定制在场（被上游覆盖会丢）；
// absent 标记出现 = 定制已被冲掉（上游实现回流）。两种命中在影响报告里都是最高危信号。
const FORK_FILE_MARKERS = new Map();
for (const customization of FORK_CUSTOMIZATION_REGISTRY.customizations) {
  for (const marker of customization.markers ?? []) {
    const entries = FORK_FILE_MARKERS.get(marker.file) ?? [];
    entries.push({ ...marker, id: customization.id });
    FORK_FILE_MARKERS.set(marker.file, entries);
  }
}

export const ACK_ENV = "ZCODE_MERGE_IMPACT_ACK";
const DEFAULT_REF = "origin/main";

async function defaultRunGit(cwd, ...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { cwd, encoding: "utf8", maxBuffer: 32 << 20 });
  return stdout.trim();
}

// 解析 git diff --name-status 输出为 Map<path, status>。
// R/C 行（重命名/复制）取新路径为准：合并影响关注的是合并后这个路径会变成什么样。
export function parseNameStatus(output) {
  const files = new Map();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...pathParts] = line.split("\t");
    const path = pathParts[pathParts.length - 1];
    if (path) files.set(path, status);
  }
  return files;
}

function hasForkMarker(content) {
  return FORK_MARKERS.some((marker) => marker.test(content));
}

// 纯逻辑：给定双方 name-status 与 HEAD 文件内容读取器（异步），产出交集风险清单。
export async function classifyOverlap({ incomingFiles, localFiles, readHeadFile }) {
  const overlap = [];
  for (const [path, incomingStatus] of incomingFiles) {
    const localStatus = localFiles.get(path);
    if (localStatus === undefined) continue;
    const headFile = await readHeadFile(path);
    // 登记标记命中判定：contains 在 HEAD 内容中出现即命中——正向标记代表定制在场
    // （被上游覆盖会丢），absent 标记代表定制已被冲掉（上游实现回流）。
    const registryHits = (FORK_FILE_MARKERS.get(path) ?? []).filter((marker) =>
      headFile.includes(marker.contains),
    );
    overlap.push({
      path,
      incomingStatus,
      localStatus,
      forkCustomized: hasForkMarker(headFile) || registryHits.length > 0,
      forkCustomizations: [...new Set(registryHits.map((marker) => marker.id))],
    });
  }
  return overlap;
}

export async function computeMergeImpact({
  ref,
  cwd = process.cwd(),
  head = "HEAD",
  runGit = defaultRunGit,
}) {
  const base = await runGit(cwd, "merge-base", head, ref);
  const headBranch = await runGit(cwd, "rev-parse", "--abbrev-ref", head).catch(() => head);
  const incomingFiles = parseNameStatus(await runGit(cwd, "diff", "--name-status", base, ref));
  const localFiles = parseNameStatus(await runGit(cwd, "diff", "--name-status", base, head));
  // 交集通常只有个位数文件，无需缓存；读取失败的路径按无标记处理（git show 对
  // 对方新增/本分支删除的路径会失败，这类路径本来也没有分支侧内容可供比对）。
  const readHeadFile = (path) => runGit(cwd, "show", `${head}:${path}`).catch(() => "");
  const overlap = await classifyOverlap({ incomingFiles, localFiles, readHeadFile });
  const incomingCommits = Number(await runGit(cwd, "rev-list", "--count", `${base}..${ref}`));
  return { base, ref, headBranch, incomingCommits, incomingFiles, localFiles, overlap };
}

function formatReport({
  base,
  ref,
  headBranch,
  incomingCommits,
  incomingFiles,
  localFiles,
  overlap,
}) {
  const lines = [];
  lines.push(`[merge-impact] 合并 ${ref} → ${headBranch}`);
  lines.push(`[merge-impact] merge-base: ${base.slice(0, 12)}`);
  lines.push(
    `[merge-impact] 对方引入：${incomingCommits} 个提交 / ${incomingFiles.size} 个文件；本分支改动：${localFiles.size} 个文件`,
  );
  if (overlap.length === 0) {
    lines.push("[merge-impact] 双方无同路径改动，合并无覆盖风险。");
    return lines;
  }
  lines.push(`[merge-impact] 双方同时改动（冲突/覆盖风险）${overlap.length} 个：`);
  for (const { path, incomingStatus, localStatus, forkCustomized, forkCustomizations } of overlap) {
    const tags = [`对方:${incomingStatus}`, `本分支:${localStatus}`];
    if (forkCustomized) tags.push("含 fork 定制标记");
    if (forkCustomizations?.length > 0) tags.push(`定制点:${forkCustomizations.join("、")}`);
    lines.push(`  ! ${path}  [${tags.join(" + ")}]`);
  }
  lines.push(
    "[merge-impact] 结论：先逐个 review 以上文件（重点看 fork 定制标记项），确认可合并后再继续。",
  );
  return lines;
}

function formatJson(impact) {
  return JSON.stringify(
    {
      ref: impact.ref,
      headBranch: impact.headBranch,
      base: impact.base,
      incomingCommits: impact.incomingCommits,
      incomingFileCount: impact.incomingFiles.size,
      localFileCount: impact.localFiles.size,
      overlap: impact.overlap,
    },
    null,
    2,
  );
}

// --merge 模式：评估通过后执行真正的 git merge。ACK=1 表示影响已确认，
// 会透传给 pre-merge-commit 钩子放行；其余合并参数原样透传给 git merge。
async function runMergeMode({ ref, cwd, passthroughArgs }) {
  // 先刷新远端状态，避免用陈旧的 origin/main 算出虚假的"无影响"。
  if (ref.startsWith("origin/")) {
    try {
      await defaultRunGit(
        cwd,
        "fetch",
        ref.slice(0, ref.indexOf("/")),
        ref.slice(ref.indexOf("/") + 1),
      );
    } catch (error) {
      console.warn(`[merge-impact] fetch ${ref} 失败，按本地已有引用评估：${error.message}`);
    }
  }

  const impact = await computeMergeImpact({ ref, cwd });
  for (const line of formatReport(impact)) console.log(line);

  if (impact.overlap.length > 0 && process.env[ACK_ENV] !== "1") {
    console.error(
      `[merge-impact] 已拦截合并：存在 ${impact.overlap.length} 个双方同路径改动。逐个 review 后确认可合并，再执行：${ACK_ENV}=1 pnpm merge:main ${ref}`,
    );
    process.exit(1);
  }
  if (impact.overlap.length > 0) {
    console.log(`[merge-impact] ${ACK_ENV}=1 已确认，继续合并。`);
  }

  const child = spawn("git", ["merge", ref, ...passthroughArgs], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, [ACK_ENV]: "1" },
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const mergeMode = args.includes("--merge");
  const jsonMode = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("--"));

  if (positional.length > 1) {
    console.error(
      "[merge-impact] 用法：node scripts/merge-main-impact-check.mjs [--merge] [ref] [--json]",
    );
    process.exit(1);
  }
  const ref = positional[0] ?? DEFAULT_REF;
  const cwd = process.cwd();

  if (mergeMode) {
    // 透传给 git merge 的参数不含模式开关、--json 和已消费的 ref 本身。
    const passthroughArgs = args.filter(
      (arg) => arg !== "--merge" && arg !== "--json" && arg !== ref,
    );
    await runMergeMode({ ref, cwd, passthroughArgs });
    return;
  }

  const impact = await computeMergeImpact({ ref, cwd });

  if (jsonMode) {
    // 退出码语义与文本模式一致：消费方也可只读 overlap 字段自行判定。
    console.log(formatJson(impact));
  } else {
    for (const line of formatReport(impact)) console.log(line);
  }

  if (impact.overlap.length > 0) {
    process.exit(2);
  }
}

await main();
