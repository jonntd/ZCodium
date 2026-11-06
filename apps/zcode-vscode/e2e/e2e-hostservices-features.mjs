/**
 * E2E（live server × HostServices 全功能面）：用扩展真实的 HostServices 类
 * （src/fullui/hostServices.ts，含新加的会话协议握手）建立通道，逐一验证
 * 所有经该通道的功能：
 *   1. saveProject/readProjects —— 工作区注册（幂等守卫依赖）
 *   2. sendConversationCommandV4 —— "发进对话"直发（本次 handshakeRequired 报错点）
 *   3. generateWorkspaceText —— Quick Edit / 提交信息 / 解释·修复·重构·写测试
 *   4. listSessions —— 会话历史
 *   5. stopGeneration —— 停止生成
 * 成功判据：全部五类调用无 fault.connection.handshakeRequired 且业务结果正确。
 */
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { HostServices } from "../src/fullui/hostServices";
import { uuidv7 } from "@zcode/shared";

const WS_PATH = join(homedir(), ".zcodium", "workspace", "default");

const serverPid = execSync("pgrep -f 'entry-http.js' | head -1").toString().trim();
if (!serverPid) {
  console.log("E2E-RESULT: FAIL（live server 未运行）");
  process.exit(1);
}
const listenLine = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${serverPid}`).toString();
const portMatch = listenLine.match(/127\.0\.0\.1:(\d+)/);
if (!portMatch) {
  console.log("E2E-RESULT: FAIL（server 未监听）");
  process.exit(1);
}
const PORT = portMatch[1];
console.log(`live server: pid=${serverPid} port=${PORT}`);

const hostServices = new HostServices({
  getWsUrl: async () => `ws://127.0.0.1:${PORT}/ws`,
});

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}: ${detail}`);
};

try {
  // 1) 工作区注册（saveProject / readProjects，幂等路径）
  const saved = await hostServices.use(async (accessor) => {
    const projects = await accessor.projectService.readProjects();
    const existing = projects.find((p) => p.roots?.some((r) => r.rootPath === WS_PATH));
    if (existing) return { id: existing.id, reused: true };
    return accessor.projectService.saveProject({ name: "default", roots: [WS_PATH], primaryRoot: WS_PATH });
  });
  record("saveProject/readProjects", Boolean(saved?.id), `项目 ${saved.id}${saved.reused ? "（复用）" : "（新建）"}`);

  // 2) "发进对话"直发：sendConversationCommandV4 sendText 到已有会话（无则建）
  let sessionId = null;
  const sessions0 = await hostServices.use((a) => a.zcodeAgentService.listSessions({ workspacePath: WS_PATH, limit: 5 }));
  const sessionList = Array.isArray(sessions0) ? sessions0 : (sessions0?.sessions ?? []);
  const first = sessionList[0] ?? null;
  sessionId = first?.sessionId ?? first?.id ?? null;
  if (!sessionId) {
    const ack = await hostServices.use((a) =>
      a.zcodeAgentService.sendConversationCommandV4({
        workspacePath: WS_PATH,
        envelope: {
          commandId: uuidv7(), clientId: "zcode-vscode-host", sessionId: null,
          type: "createSession",
          payload: { workspaceId: WS_PATH, firstInput: { text: "自动化功能面测试：请只回复 OK。" } },
          issuedAt: Date.now(),
        },
      }),
    );
    sessionId = ack?.sessionId ?? ack?.payload?.sessionId ?? null;
  }
  if (!sessionId) throw new Error("无法获得 sessionId");
  await hostServices.use((a) =>
    a.zcodeAgentService.sendConversationCommandV4({
      workspacePath: WS_PATH,
      envelope: {
        commandId: uuidv7(), clientId: "zcode-vscode-host", sessionId,
        type: "sendText",
        payload: { text: "功能面测试消息 2：请只回复 OK。" },
        issuedAt: Date.now(),
      },
    }),
  );
  record("sendConversationCommandV4（发进对话）", true, `sessionId=${sessionId}，sendText 已接受`);

  // 3) generateWorkspaceText（oneShotText 同协议方法；selection 必填）
  const text = await hostServices.use((a) =>
    a.zcodeAgentService.generateWorkspaceText({
      workspacePath: WS_PATH,
      selection: { providerId: "83300596-753f-416b-8f56-cbeb7fdc3299", modelId: "agnes-2.5-flash" },
      prompt: "请只回复两个字：收到",
      querySource: "vscode-extension",
      requestTimeoutMs: 120_000,
    }),
  );
  const textOut = typeof text === "string" ? text : (text?.text ?? JSON.stringify(text));
  record("generateWorkspaceText（Quick Edit 等一次性生成）", Boolean(textOut && String(textOut).length > 0), `回复：${String(textOut).slice(0, 60)}`);

  // 4) listSessions（会话历史）
  const sessions = await hostServices.use((a) => a.zcodeAgentService.listSessions({ workspacePath: WS_PATH, limit: 10 }));
  const count = (Array.isArray(sessions) ? sessions : (sessions?.sessions ?? [])).length;
  record("listSessions（会话历史）", count > 0, `${count} 个会话`);

  // 5) stopGeneration（停止生成）
  await hostServices.use((a) =>
    a.zcodeTaskService.stopGeneration({ sessionId, workspacePath: WS_PATH }),
  );
  record("stopGeneration（停止生成）", true, `sessionId=${sessionId} 停止指令已接受`);

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0
    ? `E2E-RESULT: PASS（${results.length}/${results.length} 项功能全部通过，无 handshakeRequired）`
    : `E2E-RESULT: FAIL（${failed.length}/${results.length} 项失败）`);
} catch (error) {
  console.log(`❌ 异常：${error instanceof Error ? error.message : String(error)}`);
  console.log("E2E-RESULT: FAIL（异常中断）");
} finally {
  hostServices.dispose();
}
