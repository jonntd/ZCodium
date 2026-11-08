import { describe, expect, it } from "vitest";
import { ApprovalService, allowlistKey, extractApprovalTarget, isDangerousCommand } from "../src/approvals/approvalService";
import type { ApprovalUpdate } from "../src/approvals/approvalService";
import type { ZCodePermissionResponse } from "@zcode/shared";

const PERM_PARAMS = {
  requestId: "perm-1",
  toolCallId: "t1",
  toolName: "bash",
  reason: "执行测试命令",
  riskLevel: "medium",
  input: { command: "npm test" },
  options: [
    { optionId: "allow", kind: "allow", name: "允许", response: { decision: "allow" } },
    { optionId: "deny", kind: "deny", name: "拒绝", response: { decision: "deny" } },
  ],
} as const;

function makeService() {
  const service = new ApprovalService();
  const replies: Array<{ frameId: string | number; result: ZCodePermissionResponse }> = [];
  const warnings: string[] = [];
  const updates: ApprovalUpdate[] = [];
  service.attach(
    (frameId, result) => replies.push({ frameId, result }),
    (message) => warnings.push(message),
  );
  service.onUpdate((update) => updates.push(update));
  return { service, replies, warnings, updates };
}

describe("ApprovalService", () => {
  it("反向请求 → 登记 pending 并推送卡片", () => {
    const { service, updates } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    expect(service.pendingCount).toBe(1);
    expect(updates[0]!.kind).toBe("requested");
    expect(updates[0]!.request.requestId).toBe("perm-1");
    expect(updates[0]!.request.frameId).toBe("frame-1");
  });

  it("resolve(allow) → 帧应答 {decision:'allow'}，状态 resolved", () => {
    const { service, replies, updates } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.resolve("perm-1", "allow");
    expect(replies).toEqual([
      { frameId: "frame-1", result: { decision: "allow", reason: "用户选择：allow" } },
    ]);
    expect(service.pendingCount).toBe(0);
    expect(updates.at(-1)!.kind).toBe("resolved");
  });

  it("resolve(deny) → 帧应答 {decision:'deny'}", () => {
    const { service, replies } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.resolve("perm-1", "deny");
    expect(replies[0]!.result.decision).toBe("deny");
  });

  it("幂等：同 requestId 重复 resolve 忽略并告警，不重复应答帧", () => {
    const { service, replies, warnings } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.resolve("perm-1", "allow");
    service.resolve("perm-1", "deny");
    expect(replies).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("幂等");
  });

  it("幂等：重复 requested（同 requestId）忽略", () => {
    const { service, updates } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    expect(updates).toHaveLength(1);
  });

  it("未知 requestId resolve → 告警忽略", () => {
    const { service, warnings } = makeService();
    service.resolve("nope", "allow");
    expect(warnings).toHaveLength(1);
  });

  it("allowSession → 写会话 allowlist，同键后续请求自动放行", () => {
    const { service, replies, updates } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.resolve("perm-1", "allowSession");
    expect(service.isSessionAllowed("bash", { command: "npm test" })).toBe(true);
    // 同键新请求 → 自动 allow，不进 pending
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-2" }, "frame-2");
    expect(service.pendingCount).toBe(0);
    expect(replies.at(-1)!.result.decision).toBe("allow");
    expect(replies.at(-1)!.result.reason).toContain("allowlist");
    expect(updates.at(-1)!.kind).toBe("autoAllowed");
  });

  it("critical 风险即使命中 allowlist 也不自动放行", () => {
    const { service, replies } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.resolve("perm-1", "allowSession");
    service.handleReversePermissionRequest(
      { ...PERM_PARAMS, requestId: "perm-3", riskLevel: "critical" },
      "frame-3",
    );
    expect(service.pendingCount).toBe(1);
    expect(replies).toHaveLength(1);
  });

  it("allowlist 随会话重建清空", () => {
    const { service } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.resolve("perm-1", "allowSession");
    service.clearSessionAllowlist();
    expect(service.isSessionAllowed("bash", { command: "npm test" })).toBe(false);
  });

  it("markTurnEnded → 未应答请求标 awaitingRestore；snapshot 重放推送 restored", () => {
    const { service, updates } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.markTurnEnded();
    expect(service.pendingRequests[0]!.awaitingRestore).toBe(true);
    // 连接重建后 snapshot 里仍有该权限 → pendingRestore 重放（无活跃帧）
    service.handleSnapshotPermissions(
      [
        {
          requestId: "perm-1",
          toolCallId: "t1",
          toolName: "bash",
          reason: "执行测试命令",
          riskLevel: "medium",
          input: { command: "npm test" },
          options: [...PERM_PARAMS.options],
        },
      ],
      "s1",
    );
    expect(updates.at(-1)!.kind).toBe("restored");
    expect(service.pendingRequests[0]!.state).toBe("pendingRestore");
    // pendingRestore resolve：无帧应答，仅状态收敛
    service.resolve("perm-1", "deny");
    expect(service.pendingCount).toBe(0);
  });

  it("pendingRestore 的 resolve 不发帧应答（连接已重建）", () => {
    const { service, replies } = makeService();
    service.handleSnapshotPermissions(
      [
        {
          requestId: "perm-r",
          toolCallId: "t9",
          toolName: "bash",
          reason: "",
          riskLevel: "low",
          input: {},
          options: [...PERM_PARAMS.options],
        },
      ],
      "s1",
    );
    service.resolve("perm-r", "allow");
    expect(replies).toHaveLength(0);
  });

  it("事件流 permission.resolved 镜像 → 本地收敛未决请求", () => {
    const { service } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.handleMirrorResolved("perm-1");
    expect(service.pendingCount).toBe(0);
  });

  it("参数非法的反向请求抛 E_PERMISSION_UNKNOWN_REQUEST（审批安全边界）", () => {
    const { service } = makeService();
    expect(() => service.handleReversePermissionRequest({ bad: true }, "frame-x")).toThrow(
      /参数校验失败/,
    );
  });

  it("resetForNewSession 清空请求与 allowlist", () => {
    const { service } = makeService();
    service.handleReversePermissionRequest(PERM_PARAMS, "frame-1");
    service.resolve("perm-1", "allowSession");
    service.resetForNewSession();
    expect(service.pendingCount).toBe(0);
    expect(service.isSessionAllowed("bash", { command: "npm test" })).toBe(false);
  });

  it("X4：超上限只淘汰最旧的 resolved，pending/pendingRestore 永不驱逐", () => {
    const service = new ApprovalService({ maxRetainedRequests: 2 });
    service.attach(() => {}, () => {});
    // 两轮请求并 resolve（均 resolved，插入序：perm-1 < perm-2）
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-1" }, "f1");
    service.resolve("perm-1", "allow");
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-2" }, "f2");
    service.resolve("perm-2", "allow");
    // 第三个请求 pending → 超上限，淘汰最旧 resolved（perm-1）
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-3" }, "f3");
    expect(service.requestCount).toBe(2);
    expect(service.pendingCount).toBe(1);
    expect(service.pendingRequests[0]!.requestId).toBe("perm-3");
    // 再 resolve 一个 → 又超上限，淘汰 perm-2
    service.resolve("perm-3", "allow");
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-4" }, "f4");
    expect(service.requestCount).toBe(2);
    expect(service.pendingCount).toBe(1);
  });

  it("X4：全部 pending 时无 resolved 可淘汰，条目保留不误删", () => {
    const service = new ApprovalService({ maxRetainedRequests: 2 });
    service.attach(() => {}, () => {});
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-a" }, "fa");
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-b" }, "fb");
    service.handleReversePermissionRequest({ ...PERM_PARAMS, requestId: "perm-c" }, "fc");
    expect(service.requestCount).toBe(3);
    expect(service.pendingCount).toBe(3);
  });
});

describe("危险命令判定（保守静态规则）", () => {
  it.each([
    ["rm -rf /", true],
    ["rm -fr ./build", true],
    ["sudo apt install x", true],
    ["git push --force origin main", true],
    ["git push -f origin main", false],
    ["echo /etc/passwd", true],
    ["npm test", false],
    ["ls -la", false],
    ["rm file.txt", false],
  ])("%s → %s", (command, expected) => {
    expect(isDangerousCommand(command)).toBe(expected);
  });
});

describe("allowlistKey 归一化", () => {
  it("bash 命令按全文归一化", () => {
    expect(allowlistKey("bash", { command: " npm test " })).toBe("bash#npm test");
  });
  it("文件编辑按路径归一化", () => {
    expect(allowlistKey("edit_file", { path: "/a/b.ts" })).toBe("edit_file#/a/b.ts");
    expect(allowlistKey("edit_file", { file_path: "/a/b.ts" })).toBe("edit_file#/a/b.ts");
  });
  it("无目标 → 仅工具名", () => {
    expect(allowlistKey("search", {})).toBe("search#");
  });
  it("extractApprovalTarget 提取命令与路径", () => {
    expect(extractApprovalTarget("bash", { command: "ls" })).toEqual({ command: "ls" });
    expect(extractApprovalTarget("x", "not-object")).toEqual({});
  });
});
