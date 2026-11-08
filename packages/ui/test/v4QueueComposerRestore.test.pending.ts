/**
 * PENDING —— 目标函数 resolveQueuedComposerRestore / shouldRestoreQueuedComposerFromAck
 * 尚未在 @/v4/SessionPane 落地（PA158 队列撤回恢复）。函数落地后把本文件改名为
 * .test.ts 转正；勿在未落地时转正（vitest 会因 import undefined 全红）。
 */

describe("v4 queue composer restore（PA158：函数落地后改名 .test.ts 转正）", () => {
  it("PA158 撤回使用队列项自身权限/Plan/模型，不借用当前 Composer 配置", () => {
    const snapshot = makeSnapshot();
    Object.assign(snapshot.queue.items[0]!, {
      mode: "yolo",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
    expect(resolveQueuedComposerRestore(snapshot, "q-1")?.config).toEqual({
      mode: "yolo",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("提取完整输入并保持附件顺序，供权威删除后恢复 composer", () => {
    expect(resolveQueuedComposerRestore(makeSnapshot(), "q-1")).toEqual({
      baseRevision: 7,
      queueItemId: "q-1",
      sourceCommandId: "cmd-q1",
      inputKind: "sendText",
      text: "排队原文",
      attachments: [
        { ref: "ref-b", fileName: "b.png", mime: "image/png", bytes: 2 },
        { ref: "ref-a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
      ],
    });
    expect(resolveQueuedComposerRestore(makeSnapshot(), "missing")).toBeNull();
  });

  it("goal 恢复可见 slash 文本，compact 明确剪枝", () => {
    const goal = makeSnapshot();
    goal.queue.items[0] = {
      ...goal.queue.items[0]!,
      kind: "sendGoalCommand",
      text: "修复登录",
    };
    expect(resolveQueuedComposerRestore(goal, "q-1")?.text).toBe("/goal 修复登录");

    const compact = makeSnapshot();
    compact.queue.items[0] = {
      ...compact.queue.items[0]!,
      kind: "compact",
      text: "/compact",
      attachments: [],
    };
    expect(resolveQueuedComposerRestore(compact, "q-1")).toBeNull();
  });

  it("只允许 accepted/duplicate 恢复，其他 ACK 分支保持 composer 不变", () => {
    expect(shouldRestoreQueuedComposerFromAck("accepted")).toBe(true);
    expect(shouldRestoreQueuedComposerFromAck("duplicate")).toBe(true);
    expect(shouldRestoreQueuedComposerFromAck("noop")).toBe(false);
    expect(shouldRestoreQueuedComposerFromAck("stale")).toBe(false);
    expect(shouldRestoreQueuedComposerFromAck("rejected")).toBe(false);
    expect(shouldRestoreQueuedComposerFromAck("failed")).toBe(false);
  });

  it("只在绑定 session/workspace 的空 composer 幂等恢复文字与附件", () => {
    const request: ComposerRestoreRequest = {
      requestId: 1,
      sessionId: "session-1",
      workspaceKey: "remote:ssh:host:/workspace",
      inputKind: "sendText",
      text: "排队原文",
      attachments: [{ ref: "ref-1", fileName: "a.png", mime: "image/png", bytes: 1 }],
      config: { mode: "yolo", planEnabled: false },
    };
    const inputApi = {
      focus: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const restoreSessionOwnedAttachments = vi.fn(() => true);
    const restoreDraftConfig = vi.fn();

    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: null,
        currentSessionId: "session-1",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: false,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(1);
    expect(inputApi.setText).toHaveBeenCalledWith("排队原文");
    expect(updateText).toHaveBeenCalledWith("排队原文");
    expect(requestFocus).toHaveBeenCalledTimes(1);
    expect(scheduleDraftPersist).toHaveBeenCalledTimes(1);
    expect(restoreSessionOwnedAttachments).toHaveBeenCalledWith(request.attachments);

    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: 1,
        currentSessionId: "session-1",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: false,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(1);
    expect(inputApi.setText).toHaveBeenCalledTimes(1);
    expect(restoreSessionOwnedAttachments).toHaveBeenCalledTimes(1);

    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: null,
        currentSessionId: "session-other",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: false,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBeNull();
    expect(
      applyComposerRestoreRequestToComposer({
        appliedRequestId: null,
        currentSessionId: "session-1",
        currentWorkspaceKey: "remote:ssh:host:/workspace",
        hasDraftContent: true,
        inputApi,
        request,
        requestFocus,
        restoreSessionOwnedAttachments,
        restoreDraftConfig,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBeNull();
    expect(inputApi.setText).toHaveBeenCalledTimes(1);
    expect(restoreDraftConfig).toHaveBeenCalledExactlyOnceWith(request.config);
  });
});
