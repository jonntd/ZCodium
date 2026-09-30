// cuaPermissionStatusStore 看门狗行为（spec: docs/spec/cua-runtime-builtin.md §D）。
//
// 故障背景（2026-09-30 真机实证）：renderer→host 的 getStatus 存在静默丢失路径，旧实现里
// 单次未 settle 的查询会把 slot.inFlight 永久锁死——后续所有刷新被去重合并、永不发出，
// 设置页卡死在「已授权，正在验证 + 未知」且无任何自愈入口。这里验证修复后的核心保证：
// 看门狗超时释放查询槽 → 退避重试流动 → 服务恢复后状态收敛到真实值。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CuaPermissionStatus,
  CuaPermissionStatusResult,
  ICuaPermissionService,
} from "@zcode/services";
import { BufferWriter, ChannelClient, serialize } from "@zcode/rpc";
import type { VSBuffer } from "@zcode/rpc";

import {
  cuaPermissionStatusKey,
  fetchCuaPermissionStatus,
  getCuaPermissionStatusSnapshot,
} from "../src/lib/cuaPermissionStatusStore.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const grantedStatus = (): CuaPermissionStatus => ({
  grantOwner: "tester",
  accessibility: "granted",
  accessibilityProbeOk: true,
  screenRecording: "granted",
  screenCaptureProbeOk: true,
});

interface FakeService extends ICuaPermissionService {
  readonly calls: number;
}

function fakeService(
  behavior: (callIndex: number) => Promise<CuaPermissionStatusResult>,
): FakeService {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async getStatus(): Promise<CuaPermissionStatusResult> {
      calls += 1;
      return behavior(calls);
    },
    async restartHelper() {
      return { ok: false, reason: "not implemented in test" };
    },
  } as FakeService;
}

test("watchdog releases a hung getStatus; merged refresh refetches; backoff converges once healthy", async () => {
  const path = "/test/cua-watchdog-recovery";
  // 前两次调用永远挂起（复现查询丢失），之后返回真实已授权状态。
  const service = fakeService((callIndex) =>
    callIndex <= 2
      ? new Promise<CuaPermissionStatusResult>(() => {})
      : Promise.resolve(grantedStatus()),
  );

  // 挂载查询 + 紧随其后的开关 refresh（被去重合并进 rerunRequested）。
  fetchCuaPermissionStatus({ service, workspacePath: path, watchdogMs: 30 });
  fetchCuaPermissionStatus({ service, workspacePath: path, watchdogMs: 30 });

  // 看门狗 30ms 触发：释放第一次挂起查询 → 发现 rerunRequested → 立即补查（第 2 次调用，
  // 仍挂起）→ 它的看门狗再次释放 → 排入 1s 退避重试。此窗口内调用数应为 2：
  // 证明 slot 没有被第一次挂起永久锁死（修复前恒为 1，且永远不会出现第 2 次）。
  await sleep(150);
  assert.equal(service.calls, 2);
  const snapshot = getCuaPermissionStatusSnapshot(cuaPermissionStatusKey(path));
  assert.equal(snapshot.status, null);
  assert.equal(snapshot.settled, false);

  // 退避重试（≈1s）命中已恢复的服务 → 状态收敛为 settled=true 的真实值。
  await sleep(1400);
  assert.ok(service.calls >= 3, `expected the backoff retry to call the service, got ${service.calls}`);
  const converged = getCuaPermissionStatusSnapshot(cuaPermissionStatusKey(path));
  assert.equal(converged.settled, true);
  assert.equal(converged.fresh, true);
  assert.equal(converged.status?.accessibility, "granted");
  assert.equal(converged.status?.screenRecording, "granted");
});

test("ChannelClient rejects a promise request instead of hanging when the transport send throws", async () => {
  // send 抛错（端口关闭等）此前被静默吞掉、请求 promise 永久 pending——上层 in-flight
  // 去重槽位会被单次丢失请求永久占用（dispose() 的 fail-closed 原则，send 路径漏了）。
  let onMessageHandler: ((buffer: VSBuffer) => void) | null = null;
  const client = new ChannelClient({
    onMessage(handler) {
      onMessageHandler = handler;
      return { dispose() {} };
    },
    send() {
      throw new Error("port closed");
    },
  });
  // 模拟 server 已完成 Initialize 握手：client 进入 Idle 后 doRequest 才会真正走到 send。
  // 消息形态对齐 ChannelServer.send：serialize(header) + serialize(body)。
  const writer = new BufferWriter();
  serialize(writer, [200]); // ResponseType.Initialize（const enum，运行时取字面量）
  serialize(writer, undefined);
  onMessageHandler?.(writer.buffer);

  await assert.rejects(
    client.getChannel("cua-permission").call("getStatus", []),
    /failed to send request/,
  );
});
