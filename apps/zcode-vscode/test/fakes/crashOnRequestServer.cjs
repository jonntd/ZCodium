/**
 * crashOnRequestServer — 收到第一个请求即 exit(1) 的桩。
 * 用于验证「请求发出后进程死亡 → pending 以 E_TRANSPORT_CLOSED reject」。
 */
"use strict";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = String(chunk);
  const newlineIndex = text.indexOf("\n");
  if (newlineIndex < 0) return;
  const frame = JSON.parse(text.slice(0, newlineIndex));
  // 先不回包，直接崩溃：模拟请求在途时进程死亡。
  process.stderr.write(`crash-on-request: got ${frame.method}\n`);
  process.exit(1);
});
