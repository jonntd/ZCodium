import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveInitialRewindSelection,
  toRewindCommandPaths,
} from "../src/v4/fileRewindSelection.js";

// 按文件撤销（docs/spec/per-file-rewind.md）弹窗勾选规则：
// 整轮入口缺省全选（保持一键整轮撤销习惯）；单文件入口只勾选目标文件，
// 目标文件预检不安全（不在 safe 列表）时保持空选，绝不静默扩大撤销范围。

const SAFE_PATHS = ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"];

test("整轮入口缺省全选 safe 文件", () => {
  const selection = resolveInitialRewindSelection(SAFE_PATHS);
  assert.deepEqual([...selection].sort(), SAFE_PATHS);
});

test("单文件入口只勾选目标文件", () => {
  const selection = resolveInitialRewindSelection(SAFE_PATHS, "/repo/src/b.ts");
  assert.deepEqual([...selection], ["/repo/src/b.ts"]);
});

test("单文件已被外部修改（不在 safe 列表）时保持空选", () => {
  const selection = resolveInitialRewindSelection(SAFE_PATHS, "/repo/src/tampered.ts");
  assert.equal(selection.size, 0);
});

test("没有 safe 文件时任何入口都得到空选", () => {
  assert.equal(resolveInitialRewindSelection([], null).size, 0);
  assert.equal(resolveInitialRewindSelection([], "/repo/src/a.ts").size, 0);
});

test("toRewindCommandPaths 输出去重后的路径数组", () => {
  assert.deepEqual(toRewindCommandPaths(new Set(["/repo/a.ts", "/repo/b.ts"])), [
    "/repo/a.ts",
    "/repo/b.ts",
  ]);
  assert.deepEqual(toRewindCommandPaths(new Set()), []);
});
