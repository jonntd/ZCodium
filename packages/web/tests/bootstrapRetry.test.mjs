// Web bootstrap 有界重试策略的测试（契约见 docs/spec/web-bootstrap-delivery-point.md）。
//
// 重点钉住「有界」这条：任何一次瞬时失败都允许重试，但次数上限一旦回归成无限重连，
// 真实离线会永远停在 loading 壳 —— 所以这里两侧都断言：
//   - 失败后重试、且退避按 1s/2s 递增
//   - 超过上限必须抛出**最后一次**错误，尝试次数恰好等于上限
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WEB_BOOTSTRAP_MAX_ATTEMPTS,
  connectWithBoundedRetry,
} from "../src/bootstrapRetry.ts";

/** 记录退避时长的 wait 替身：让退避在毫秒内跑完，同时可断言序列。 */
function createWaitRecorder() {
  const delays = [];
  return {
    delays,
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
  };
}

test("首次成功：不重试、不等待", async () => {
  const recorder = createWaitRecorder();
  let calls = 0;
  const result = await connectWithBoundedRetry(
    async () => {
      calls += 1;
      return "ok";
    },
    { wait: recorder.wait },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(recorder.delays, []);
});

test("先失败后成功：自动重试一次并返回结果", async () => {
  const recorder = createWaitRecorder();
  const failures = [];
  let calls = 0;
  const result = await connectWithBoundedRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("WebSocket closed before ready: host-offline");
        failures.push(error);
        throw error;
      }
      return "recovered";
    },
    { wait: recorder.wait },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 2);
  assert.deepEqual(recorder.delays, [1_000], "默认退避 1s");
  assert.equal(failures.length, 1);
});

test("默认上限是有界的：连续失败只尝试 2 次并抛出最后一次错误", async () => {
  const recorder = createWaitRecorder();
  let calls = 0;
  await assert.rejects(
    connectWithBoundedRetry(
      async () => {
        calls += 1;
        throw new Error(`attempt-${calls}`);
      },
      { wait: recorder.wait },
    ),
    /attempt-2/,
    "必须抛出最后一次错误，保留真实失败原因",
  );
  assert.equal(calls, WEB_BOOTSTRAP_MAX_ATTEMPTS, "尝试次数必须等于上限，不能无限重连");
  assert.deepEqual(recorder.delays, [1_000]);
});

test("提高上限时退避指数递增（1s / 2s）", async () => {
  const recorder = createWaitRecorder();
  let calls = 0;
  await assert.rejects(
    connectWithBoundedRetry(
      async () => {
        calls += 1;
        throw new Error(`attempt-${calls}`);
      },
      { maxAttempts: 3, wait: recorder.wait },
    ),
    /attempt-3/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(recorder.delays, [1_000, 2_000]);
});
