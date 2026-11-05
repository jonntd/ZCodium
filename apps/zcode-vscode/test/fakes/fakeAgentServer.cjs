/**
 * fakeAgentServer — 模拟 `zcodium app-server --stdio` 的内存 stdio 双端桩。
 *
 * 用法：node fakeAgentServer.cjs（行为由环境变量控制，供 vitest 拉起）
 * - FAKE_SESSION_ID：会话 ID（默认 "fake-session-1"）。
 * - FAKE_RESUME_FAIL=1：session/resume 回协议错误 -32004（sessionUnavailable）。
 * - FAKE_CREATE_DELAY_MS：create 应答前延迟（测超时/握手时序）。
 * - FAKE_SEND_SCRIPT=<JSON>：session/send 应答后按脚本回放事件序列。
 *   脚本元素：
 *   - { "type": "<session 事件类型>", "payload": {...} } → 包成 session/event notification
 *   - { "__reverseRequest": true, "method": "...", "params": {...} } → 反向 request（等宿主 response）
 *   - { "__waitMs": 100 } → 延迟
 * - FAKE_REPLAY_EVENTS=<JSON>：session/subscribe 应答里携带的历史事件数组。
 * - FAKE_CRASH_AFTER_FRAMES=<n>：写出第 n 帧后进程 exit(1)（测崩溃重启退避）。
 * - FAKE_STOP_SCRIPT=<JSON>：session/stop 应答后按脚本回放事件（测取消路径）。
 * - stdin EOF → exit(0)（正常退出边界）。
 *
 * 所有出站帧都走 NDJSON（LF 分隔）。
 */
"use strict";

const sessionId = process.env.FAKE_SESSION_ID || "fake-session-1";
const resumeFail = process.env.FAKE_RESUME_FAIL === "1";
const createDelayMs = Number(process.env.FAKE_CREATE_DELAY_MS || "0");
const sendScript = process.env.FAKE_SEND_SCRIPT ? JSON.parse(process.env.FAKE_SEND_SCRIPT) : [];
const replayEvents = process.env.FAKE_REPLAY_EVENTS
  ? JSON.parse(process.env.FAKE_REPLAY_EVENTS)
  : [];
const crashAfterFrames = Number(process.env.FAKE_CRASH_AFTER_FRAMES || "0");
// 版本守卫测试：可注入不匹配的协议名/版本。
const protocolVersion = Number(process.env.FAKE_PROTOCOL_VERSION || "1");
const protocolName = process.env.FAKE_PROTOCOL_NAME || "ZCode Protocol";
// QA 回归修复：默认按真实 wire 形态发事件（turn.completed 带 cacheStats、turn.started 带
// 实发可选字段）；FAKE_LEGACY_WIRE=1 时回放修复前的旧形态（回归盲区复现用）。
const legacyWire = process.env.FAKE_LEGACY_WIRE === "1";
// FAKE_TOOL_PROGRESS=1：send 后附带一条带 outputPreview 的 tool progress（bash 实测形态）。
const toolProgress = process.env.FAKE_TOOL_PROGRESS === "1";
// FAKE_STOP_SCRIPT=<JSON>：session/stop 应答后按 sendScript 同款脚本回放事件
// （遗留-2 验证用：取消消费了后台子代理结果的 turn → turn.failed 带
// backgroundSubagentResultConsumed，core/src/runtime/methods/turn-errors.ts L205-209 实测形态）。
const stopScript = process.env.FAKE_STOP_SCRIPT ? JSON.parse(process.env.FAKE_STOP_SCRIPT) : [];

let seq = 0;
let framesWritten = 0;
let buffer = "";

function writeFrame(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  framesWritten += 1;
  if (crashAfterFrames > 0 && framesWritten >= crashAfterFrames) {
    process.exit(1);
  }
}

function snapshot(sessionStatus, extraProjection) {
  return {
    protocol: { name: protocolName, version: protocolVersion },
    session: {
      sessionId,
      workspace: { workspacePath: "/tmp/fake-ws", workspaceKey: "fake-ws" },
      title: "Fake 会话",
      mode: "build",
      status: sessionStatus,
      // 契约必填字段（legacy-types L85-93）：真实 wire 的 sessionInfo 一定携带。
      sessionKind: "interactive",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    settings: {},
    projection: Object.assign(
      {
        sessionId,
        status: sessionStatus,
        mode: "build",
        turnCount: 0,
        totalTokenCount: 0,
        contextUsed: 0,
        contextWindow: 200_000,
        pendingPermissions: [],
        activeToolCalls: [],
        backgroundJobs: [],
      },
      extraProjection || {},
    ),
    runtime: {},
    messages: [],
  };
}

function emitSessionEvent(type, payload) {
  seq += 1;
  writeFrame({
    method: "session/event",
    params: {
      eventId: `evt-${seq}`,
      sessionId,
      turnId: payload && payload.turnId,
      seq,
      timestamp: Date.now(),
      type,
      payload,
    },
  });
}

/** 按脚本回放事件/反向请求/延迟（send 与 stop 共用）。 */
async function runScript(script) {
  for (const step of script) {
    if (step.__waitMs) {
      await sleep(step.__waitMs);
    } else if (step.__reverseRequest) {
      // 反向 request：带 id，等待宿主 response（本桩不校验应答内容）。
      await new Promise((resolve) => {
        pendingReverseResolves.set("__any__", resolve);
        writeFrame({ id: nextReverseId(), method: step.method, params: step.params });
      });
    } else {
      emitSessionEvent(step.type, step.payload);
    }
  }
}

async function runSendScript() {
  await runScript(sendScript);
}

let reverseId = 100;
function nextReverseId() {
  reverseId += 1;
  return reverseId;
}
const pendingReverseResolves = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleRequest(msg) {
  switch (msg.method) {
    case "session/create": {
      if (createDelayMs > 0) await sleep(createDelayMs);
      writeFrame({ id: msg.id, result: snapshot("idle") });
      break;
    }
    case "session/resume": {
      if (resumeFail) {
        writeFrame({
          id: msg.id,
          error: { code: -32004, message: "session unavailable" },
        });
      } else {
        writeFrame({ id: msg.id, result: snapshot("idle") });
      }
      break;
    }
    case "session/subscribe": {
      writeFrame({
        id: msg.id,
        result: {
          sessionId,
          eventSeq: replayEvents.length,
          events: replayEvents,
          snapshot: snapshot("idle"),
        },
      });
      break;
    }
    case "session/send": {
      writeFrame({ id: msg.id, result: { sessionId, accepted: true, stateRevision: 1 } });
      emitSessionEvent(
        "turn.started",
        legacyWire
          ? { turnNumber: 1, input: msg.params.content, inputId: "input-1" }
          : {
              // 真实 wire 形态（core runtime L492-515 实测：常发 foregroundExecutionId/
              // inputSource 等可选字段，契约 L1536-1543）。
              turnNumber: 1,
              input: msg.params.content,
              inputId: "input-1",
              queryId: "query-1",
              messageId: "msg-1",
              foregroundExecutionId: "fg-1",
              inputSource: "subagent",
              inputVisibility: "user-visible",
              executionKind: "agent",
            },
      );
      void runSendScript().then(() => {
        if (toolProgress) {
          emitSessionEvent("tool.updated", {
            kind: "progress",
            toolCallId: "tc-progress-1",
            toolName: "bash",
            elapsedMs: 120,
            pid: 4242,
            stdoutBytes: 100,
            stderrBytes: 0,
            outputBytes: 100,
            // 真实 wire：bash 工具 progress 携带 outputPreview（契约 L1714）。
            outputPreview: { kind: "text", text: "hello" },
            stdoutTail: "hello",
          });
        }
        emitSessionEvent(
          "turn.completed",
          legacyWire
            ? {
                response: "",
                tokenCount: 10,
                toolCallCount: 0,
                duration: 5,
                resultType: "success",
              }
            : {
                // 真实 wire：core runtime/methods/turn.ts L909 无条件附带 cacheStats。
                response: "",
                tokenCount: 10,
                toolCallCount: 0,
                duration: 5,
                resultType: "success",
                cacheStats: {
                  totalMessages: 3,
                  cachedMessages: 1,
                  lastCacheHit: true,
                  cacheReadTokens: 128,
                },
                inputId: "input-1",
              },
        );
      });
      break;
    }
    case "session/stop": {
      writeFrame({ id: msg.id, result: {} });
      void runScript(stopScript);
      break;
    }
    case "session/close": {
      writeFrame({ id: msg.id, result: { closed: true } });
      break;
    }
    default: {
      writeFrame({
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      });
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method && msg.id !== undefined) {
      void handleRequest(msg);
    } else if (msg.id !== undefined && msg.method === undefined) {
      // 宿主对反向 request 的 response（本桩不区分 method，直接放行脚本继续）
      const resolve = pendingReverseResolves.get("__any__");
      if (resolve) {
        pendingReverseResolves.delete("__any__");
        resolve();
      }
    }
  }
});
process.stdin.on("end", () => {
  // 正常退出边界：stdin EOF。
  process.exit(0);
});
