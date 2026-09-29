/**
 * Release Changelog 双语渲染回归：翻译映射命中输出中文，未命中输出隐藏 TODO，
 * 内部 ci 提交不进列表。
 *
 * 运行：node --import tsx --test packages/desktop/tests/render-release-changelog.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderChangelogEntries } from "../../../scripts/render-release-changelog.mjs";

test("release changelog renders bilingual entries and filters internal ci commits", () => {
  const commits = [
    { hash: "aaaaaaa", subject: "feat(remote): ship a built-in source" },
    { hash: "bbbbbbb", subject: "ci: internal pipeline change" },
    { hash: "ccccccc", subject: "fix: untranslated fix" },
  ];

  const output = renderChangelogEntries(commits, { aaaaaaa: "内置远程资源源。" });

  assert.equal(
    output,
    [
      "- feat(remote): ship a built-in source (aaaaaaa)",
      "  - 内置远程资源源。",
      "- fix: untranslated fix (ccccccc)",
      "  <!-- TODO(zh): add ccccccc to .github/changelog-zh.json -->",
    ].join("\n"),
  );
  assert.ok(!output.includes("internal pipeline change"), "ci 提交必须过滤");
});
