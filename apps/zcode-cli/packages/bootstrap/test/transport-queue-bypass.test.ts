import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { zcodeProtocolMethods } from "@zcode/shared";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";

// 串行队列旁路面回归（提示词增强卡死修复）：
//
// worker 的 NDJSON 传输把普通请求排成一条串行队列。workspace/generateText
// （提示词增强 / Git 提交消息共用）是长请求（单次模型调用最长 60s），若走
// 串行队列，模型返回前会阻塞 worker 的所有其它协议请求——UI 表现为
// 「点击增强后整个程序卡死」。修复后它与 session/stop、workspace/cancelGenerateText
// 一样旁路队列。本文件用受控的慢 handler 钉住三条时序事实：
// 1) generateText 在前方普通请求挂起时仍能立即进入 handler（不被队列阻塞）；
// 2) generateText 在 handler 挂起期间，后续普通请求不被它阻塞（它也不阻塞队列）；
// 3) 普通请求之间保持既有串行语义（前方请求未离开 handler 时，后方请求不进 handler）。

interface PendingRequest {
  id: string;
  method: string;
  resolve(result: unknown): void;
}

function createConnection() {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = "";
  output.on("data", (chunk: Buffer) => {
    outputText += chunk.toString("utf8");
  });
  const inboundHandlers: Array<(message: unknown) => void> = [];
  const pendingFromServer: PendingRequest[] = [];

  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    // 模拟 server.handleMessage：普通请求立即返回；反向 request（这里用不到）不处理。
    // 测试通过 resolvePending 手动放行指定请求，用来观察传输层的排队事实。
    handleMessage: async (message) => {
      for (const handler of inboundHandlers) handler(message);
      if ("id" in message && "method" in message) {
        return new Promise((resolve) => {
          pendingFromServer.push({
            id: message.id,
            method: message.method,
            resolve: (result) => resolve({ id: message.id, result }),
          });
        });
      }
      return undefined;
    },
  });
  connection.start();

  const sendLine = (line: object) => input.write(`${JSON.stringify(line)}\n`);
  const responses = () =>
    outputText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id?: string; result?: unknown });
  const responseIds = () =>
    responses()
      .filter((message) => "result" in message || "error" in message)
      .map((message) => message.id);

  return { connection, sendLine, responses, responseIds, pendingFromServer, inboundHandlers };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("workspace/generateText bypasses the serial queue (not blocked by a hung normal request)", async () => {
  const { sendLine, responseIds, pendingFromServer } = createConnection();

  // 普通请求 a：进入串行队列并挂住 handler（模拟前方请求尚未返回）。
  sendLine({ id: "a", method: zcodeProtocolMethods.sessionList, params: {} });
  await tick();
  await tick();
  assert.deepEqual(
    responseIds(),
    [],
    "normal request must stay pending until its handler resolves",
  );

  // generateText b：必须旁路队列立即进入 handler 并能先于 a 返回。
  sendLine({
    id: "b",
    method: zcodeProtocolMethods.workspaceGenerateText,
    params: { workspace: { workspaceKey: "k", workspacePath: "/tmp/x" }, selection: {}, querySource: "prompt_enhance" },
  });
  await tick();
  await tick();
  const bPending = pendingFromServer.find((entry) => entry.id === "b");
  assert.ok(bPending, "generateText must reach the handler immediately (bypass)");
  bPending.resolve({ text: "ok" });
  await tick();
  await tick();
  assert.deepEqual(responseIds(), ["b"], "generateText response must not wait behind request a");
});

test("workspace/generateText does not block the serial queue while its handler is pending", async () => {
  const { sendLine, pendingFromServer } = createConnection();

  // generateText 先到并挂住 handler。
  sendLine({
    id: "gen",
    method: zcodeProtocolMethods.workspaceGenerateText,
    params: { workspace: { workspaceKey: "k", workspacePath: "/tmp/x" }, selection: {}, querySource: "prompt_enhance" },
  });
  await tick();
  await tick();

  // 普通请求 a、c：必须不等待 gen，直接依次进入 handler。
  sendLine({ id: "a", method: zcodeProtocolMethods.sessionList, params: {} });
  await tick();
  await tick();
  assert.ok(
    pendingFromServer.some((entry) => entry.id === "a"),
    "normal request must not be blocked by a pending bypassed generateText",
  );

  // 普通请求之间仍串行：a 未 resolve 前，c 不得进入 handler。
  sendLine({ id: "c", method: zcodeProtocolMethods.sessionList, params: {} });
  await tick();
  await tick();
  assert.ok(
    !pendingFromServer.some((entry) => entry.id === "c"),
    "normal requests must stay serialized behind each other",
  );
});

test("workspace/cancelGenerateText can still cancel a bypassed generateText (ordering gate preserved)", async () => {
  const { sendLine, pendingFromServer } = createConnection();

  sendLine({
    id: "gen",
    method: zcodeProtocolMethods.workspaceGenerateText,
    params: { workspace: { workspaceKey: "k", workspacePath: "/tmp/x" }, selection: {}, querySource: "prompt_enhance" },
  });
  await tick();
  await tick();

  // 取消请求同样旁路队列，必须能紧跟被旁路的 generateText 进入 handler。
  sendLine({
    id: "cancel",
    method: zcodeProtocolMethods.workspaceCancelGenerateText,
    params: { operationId: "op-1" },
  });
  await tick();
  await tick();
  assert.ok(
    pendingFromServer.some((entry) => entry.id === "cancel"),
    "cancel must bypass the queue and reach the handler",
  );
});
