#!/usr/bin/env node
/**
 * 生成 release Changelog 的中英双语条目列表。
 *
 * 翻译映射在 .github/changelog-zh.json（短 hash → 中文说明）。缺少翻译时输出英文条目
 * 并附一条渲染后不可见的 HTML 注释待办，提醒维护者在发版前补上中文。
 *
 * 用法：
 *   node scripts/render-release-changelog.mjs --from v3.14.5 --to v3.14.6
 *   node scripts/render-release-changelog.mjs --from <base> --to <tag> --translations <path>
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function renderChangelogEntries(commits, translations) {
  const lines = [];
  for (const { hash, subject } of commits) {
    // 内部 CI 提交不进 Changelog（与原 grep -v '^- ci' 行为一致）。
    if (/^ci[: ]/u.test(subject)) {
      continue;
    }
    lines.push(`- ${subject} (${hash})`);
    const zh = findTranslation(translations, hash)?.trim();
    if (zh) {
      lines.push(`  - ${zh}`);
    } else {
      lines.push(`  <!-- TODO(zh): add ${hash} to .github/changelog-zh.json -->`);
    }
  }
  return lines.join("\n");
}

// 翻译 key 与 git %h 都是完整 SHA 的唯一前缀（key 固定 7 字符；仓库对象增长后 %h
// 可能输出 8+ 字符）。两个唯一前缀指向同一提交当且仅当互为前缀——不同提交不可能
// 共享一个唯一缩写前缀，因此无歧义。空串 key 跳过（startsWith("") 恒真）。
function findTranslation(translations, hash) {
  for (const [key, value] of Object.entries(translations)) {
    if (key && (hash.startsWith(key) || key.startsWith(hash))) {
      return value;
    }
  }
  return undefined;
}

function listCommits(from, to) {
  const output = execFileSync(
    "git",
    ["log", "--no-merges", "--pretty=%h%x1f%s", `${from}..${to}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash, subject] = line.split("\x1f");
      return { hash, subject };
    });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--from") {
      args.from = argv[++index];
    } else if (token === "--to") {
      args.to = argv[++index];
    } else if (token === "--translations") {
      args.translations = argv[++index];
    } else {
      throw new Error(`[render-release-changelog] unknown argument: ${token}`);
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    throw new Error("[render-release-changelog] --from and --to are required");
  }
  const translationsPath = resolve(repoRoot, args.translations ?? ".github/changelog-zh.json");
  const translations = JSON.parse(readFileSync(translationsPath, "utf8"));
  const commits = listCommits(args.from, args.to);
  const output = renderChangelogEntries(commits, translations);
  // 空区间输出 0 字节（不写尾随换行）：调用方用 `[ -s ]` 区分「有条目」与「无代码变更」。
  if (output) {
    process.stdout.write(`${output}\n`);
  }
}
