#!/usr/bin/env node
/**
 * 本地 Mock 大模型服务器（Anthropic Messages API 兼容）。
 *
 * 用途：Gode E2E 自动化测试。把 provider 的 baseUrl 指到本服务即可让
 * server/agent 全链路走"本地假模型"——不出网、不烧 token、回复确定性。
 *
 * 协议面：
 *   POST /v1/messages           —— 流式（SSE）与非流式 JSON 都支持
 *   GET  /healthz               —— 就绪探测
 *
 * 回复策略（确定性，便于断言）：
 *   - prompt 里含 "OK-OK"        → 回复 "OK-OK"
 *   - prompt 里含 "回复两个字：收到" → 回复 "收到"
 *   - 其他                        → 回复 "MOCK-OK"
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_MODEL_PORT ?? 18101);

function extractText(body) {
  const parts = [];
  if (typeof body.system === "string") parts.push(body.system);
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (typeof block === "string") parts.push(block);
      else if (block?.text) parts.push(block.text);
    }
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (typeof message.content === "string") parts.push(message.content);
      else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "text" && block.text) parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n");
}

function pickReply(text) {
  if (text.includes("OK-OK")) return "OK-OK";
  if (text.includes("回复两个字：收到") || text.includes("请只回复两个字：收到")) return "收到";
  if (text.includes("请只回复 OK")) return "OK";
  return "MOCK-OK";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found_error", message: `no route: ${req.method} ${req.url}` } }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "bad json" } }));
      return;
    }
    const reply = pickReply(extractText(body));
    const inputTokens = Math.max(1, Math.ceil(extractText(body).length / 4));
    const model = body.model ?? "mock-model";
    console.log(`[mock-model] ${new Date().toISOString()} stream=${Boolean(body.stream)} model=${model} reply=${reply}`);

    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_mock_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: reply }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 2 },
        }),
      );
      return;
    }

    // 流式（SSE）：message_start → content_block_start → deltas → stop → message_delta → message_stop
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const messageId = `msg_mock_${Date.now()}`;
    send("message_start", {
      type: "message_start",
      message: {
        id: messageId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
    send("content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" },
    });
    // 分两次 delta，覆盖增量拼接路径。
    const half = Math.ceil(reply.length / 2);
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(0, half) } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(half) } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    send("message_stop", { type: "message_stop" });
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-model] listening on http://127.0.0.1:${PORT}/v1/messages`);
});
