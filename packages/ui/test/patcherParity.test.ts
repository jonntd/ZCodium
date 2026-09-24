import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_WINDOW_MS,
  estimateTokens,
  formatTokensPerSecond,
  resolveLatestTurnStats,
} from "../src/v4/composer/turnStats.js";
import { formatCacheHitPercent } from "../src/v4/composer/cacheHitPercent.js";
import { buildAppUsageModelPieChartViewModel } from "../src/settings/usage-stats/appUsageModelPieChartViewModel.js";

const intl = { formatMessage: ({ id }: { id: string }) => id };

function row(base: Record<string, unknown>) {
  return base;
}

test("estimateTokens: CJK 按字计、拉丁按 4 字符计", () => {
  assert.equal(estimateTokens("继续"), 2);
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("ab继续"), 3); // 2*0.25 + 2*1 = 2.5 → round → 3
});

test("resolveLatestTurnStats: 取 rowId 最大的 turnHeader 并聚合内容行", () => {
  const rows = [
    row({
      rowId: 1,
      kind: "turnHeader",
      turnId: "t1",
      state: "completedSuccess",
      startedAt: 1000,
      endedAt: 2000,
    }),
    row({ rowId: 2, kind: "userInput", turnId: "t1", createdAt: 1050 }),
    row({ rowId: 3, kind: "assistantText", turnId: "t1", createdAt: 1200, text: "继续输出" }),
    row({ rowId: 4, kind: "turnHeader", turnId: "t2", state: "running", startedAt: 3000 }),
    row({ rowId: 5, kind: "assistantText", turnId: "t2", createdAt: 3300, text: "abcdefgh" }),
  ] as never[];
  const stats = resolveLatestTurnStats(rows);
  assert.ok(stats);
  assert.equal(stats.turnId, "t2");
  assert.equal(stats.streaming, true);
  assert.equal(stats.startedAt, 3000);
  assert.equal(stats.firstContentAt, 3300);
  assert.equal(stats.textTokens, 2); // "abcdefgh" = 8 chars / 4
});

test("resolveLatestTurnStats: 空行返回 null", () => {
  assert.equal(resolveLatestTurnStats([]), null);
});

test("resolveLatestTurnStats: turnHeader 滚出窗口时按最后内容行定位当前轮", () => {
  const rows = [
    row({
      rowId: 9,
      kind: "assistantText",
      turnId: "t2",
      createdAt: 3300,
      text: "abcdefgh",
      state: "streaming",
    }),
  ] as never[];
  const stats = resolveLatestTurnStats(rows);
  assert.ok(stats);
  assert.equal(stats.turnId, "t2");
  assert.equal(stats.streaming, true); // 无 header 时由内容行 streaming 态判定
  assert.equal(stats.firstContentAt, 3300);
  assert.equal(stats.endedAt, null);
});

test("resolveLatestTurnStats: 结束轮无 header 时以最后内容行近似 endedAt", () => {
  const rows = [
    row({
      rowId: 10,
      kind: "assistantText",
      turnId: "t3",
      createdAt: 4000,
      text: "ab",
      state: "complete",
    }),
    row({
      rowId: 11,
      kind: "assistantText",
      turnId: "t3",
      createdAt: 4800,
      text: "cd",
      state: "complete",
    }),
  ] as never[];
  const stats = resolveLatestTurnStats(rows);
  assert.ok(stats);
  assert.equal(stats.turnId, "t3");
  assert.equal(stats.streaming, false);
  assert.equal(stats.endedAt, 4800);
  assert.equal(stats.firstContentAt, 4000);
  assert.equal(stats.textTokens, 1); // "ab"+"cd" = 4 chars / 4
});

test("STREAM_WINDOW_MS 与补丁版 4s 滑动窗口一致", () => {
  assert.equal(STREAM_WINDOW_MS, 4000);
});

test("用量饼图去截断：>5 个模型不再合并为「其他模型」", () => {
  const snapshot = {
    models: [
      { modelId: "model-a", totalTokens: 500 },
      { modelId: "model-b", totalTokens: 400 },
      { modelId: "model-c", totalTokens: 300 },
      { modelId: "model-d", totalTokens: 200 },
      { modelId: "model-e", totalTokens: 100 },
      { modelId: "model-f", totalTokens: 50 },
      { modelId: "model-g", totalTokens: 10 },
    ],
  } as never;
  const view = buildAppUsageModelPieChartViewModel({ intl, snapshot });
  // 7 个全部出块，无「其他模型」合并块
  assert.equal(view.chartData.length, 7);
  assert.equal(view.totalModelTokens, 1560);
  const shares = view.chartData.map((slice) => slice.totalTokens);
  assert.deepEqual(shares, [500, 400, 300, 200, 100, 50, 10]);
});

test("用量饼图：0 用量模型不出块", () => {
  const snapshot = {
    models: [
      { modelId: "model-a", totalTokens: 10 },
      { modelId: "model-b", totalTokens: 0 },
    ],
  } as never;
  const view = buildAppUsageModelPieChartViewModel({ intl, snapshot });
  assert.equal(view.chartData.length, 1);
});

test("formatTokensPerSecond（deepseek 口径）：≥10 取整、<10 保留 1 位、负值钳 0", () => {
  assert.equal(formatTokensPerSecond(87.4), "87");
  assert.equal(formatTokensPerSecond(9.84), "9.8");
  assert.equal(formatTokensPerSecond(-3), "0");
});

test("formatCacheHitPercent（deepseek 1:1）：常规取整、满命中、空输入", () => {
  assert.equal(formatCacheHitPercent(910, 1000), "91");
  assert.equal(formatCacheHitPercent(500, 1000), "50");
  assert.equal(formatCacheHitPercent(1000, 1000), "100");
  assert.equal(formatCacheHitPercent(0, 0), null);
});

test("formatCacheHitPercent：部分命中不进位成 100%（99.9x 升位保持诚实）", () => {
  // 9999/10000 = 99.99%，整数精度会进位到 100，算法升位并保尾差
  assert.equal(formatCacheHitPercent(9999, 10000), "99.99");
  assert.notEqual(formatCacheHitPercent(9999, 10000), "100");
  // 更贴近 1 的比例升到更多位
  assert.equal(formatCacheHitPercent(999999, 1000000), "99.9999");
});
