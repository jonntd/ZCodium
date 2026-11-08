/**
 * PlatformRpcClient 超时语义单测（增量审查 X2）。
 * fake timers 驱动：超时 reject、正常响应不误伤、dispose 清理。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  PlatformRpcClient,
} from "../src/webview-react/bridge/platformRpcClient";

function createVscode() {
  const sent: unknown[] = [];
  return {
    sent,
    postMessage: (message: unknown) => {
      sent.push(message);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlatformRpcClient 超时（X2：host 不回不永挂）", () => {
  it("超时 reject 并从 pending 移除，之后迟到的响应被忽略", async () => {
    const vscode = createVscode();
    const client = new PlatformRpcClient(vscode, 1_000);
    const promise = client.call<string>("exportLogs");
    const assertion = expect(promise).rejects.toThrow("plat-req 超时（1000ms）：exportLogs");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    // 迟到响应：pending 已删，resolve 无人接收且不报错。
    const id = (vscode.sent[0] as { id: number }).id;
    expect(() =>
      client.handleMessageData({ t: "plat-res", id, ok: true, value: "late" }),
    ).not.toThrow();
  });

  it("正常响应清掉超时定时器，advance 不触发 reject", async () => {
    const vscode = createVscode();
    const client = new PlatformRpcClient(vscode, 1_000);
    const promise = client.call<number>("pickSession");
    const id = (vscode.sent[0] as { id: number }).id;
    client.handleMessageData({ t: "plat-res", id, ok: true, value: 42 });
    await expect(promise).resolves.toBe(42);
    await vi.advanceTimersByTimeAsync(DEFAULT_RPC_TIMEOUT_MS + 1); // 不 reject
  });

  it("dispose：挂起调用全部 reject 且定时器清理（advance 不再触发）", async () => {
    const vscode = createVscode();
    const client = new PlatformRpcClient(vscode, 1_000);
    const promise = client.call("showDiff");
    const assertion = expect(promise).rejects.toThrow("platform rpc client disposed");
    client.dispose();
    await assertion;
    await vi.advanceTimersByTimeAsync(5_000); // dispose 后超时回调不再执行
  });

  it("默认超时 30s（不传参时生效）", async () => {
    const vscode = createVscode();
    const client = new PlatformRpcClient(vscode);
    const promise = client.call("x");
    const assertion = expect(promise).rejects.toThrow("plat-req 超时（30000ms）：x");
    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});
