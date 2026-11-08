/**
 * 快速退出退避纯函数单测（真机教训 2026-11-07：spawn 崩溃循环每秒一发）。
 * 指数退避 1s→2s→4s…封顶 30s；非正计数不等待。
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  FAST_EXIT_BACKOFF_MAX_MS,
  fastExitBackoffDelayMs,
} from "#src/zcode-agent/zcodeAgentProcessManager.js";

describe("fastExitBackoffDelayMs", () => {
  it("非正计数 → 0（不退避）", () => {
    assert.equal(fastExitBackoffDelayMs(0), 0);
    assert.equal(fastExitBackoffDelayMs(-1), 0);
  });

  it("指数退避：1s、2s、4s、8s、16s", () => {
    assert.equal(fastExitBackoffDelayMs(1), 1_000);
    assert.equal(fastExitBackoffDelayMs(2), 2_000);
    assert.equal(fastExitBackoffDelayMs(3), 4_000);
    assert.equal(fastExitBackoffDelayMs(4), 8_000);
    assert.equal(fastExitBackoffDelayMs(5), 16_000);
  });

  it("封顶 30s", () => {
    assert.equal(fastExitBackoffDelayMs(6), FAST_EXIT_BACKOFF_MAX_MS);
    assert.equal(fastExitBackoffDelayMs(50), FAST_EXIT_BACKOFF_MAX_MS);
  });
});
