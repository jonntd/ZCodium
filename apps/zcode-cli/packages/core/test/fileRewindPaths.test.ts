import assert from "node:assert/strict";
import test from "node:test";
import { previewWorkspaceFileRewind } from "../src/runtime/methods/file-rewind.js";
import { applyWorkspaceFileRewind } from "../src/runtime/methods/file-rewind.js";
import { RewindScope, SessionEventType } from "../src/runtime/deps.js";

// 按文件撤销（docs/spec/per-file-rewind.md）core 计划语义：
// 1) paths 过滤后只裁决子集，未选中文件的不安全状态不阻断；
// 2) 本轮此前 file_summary_rewind 已撤销的路径整体排除（revertedPaths），
//    避免已还原文件被误判 external_modified，剩余文件可继续撤销。

const WORKSPACE_ROOT = "/repo";
const TURN_MESSAGE_ID = "m1";

interface TestFile {
  afterContent: string;
  beforeContent: string;
  path: string;
}

function checkpointEvent(files: TestFile[], snapshotRef: string) {
  return {
    id: snapshotRef,
    sessionId: "sess",
    sequenceNumber: 0,
    timestamp: new Date(0),
    traceId: "trace",
    type: SessionEventType.CheckpointCreated,
    payload: {
      checkpointId: snapshotRef,
      messageId: TURN_MESSAGE_ID,
      scope: RewindScope.Workspace,
      snapshotRef,
      fileCount: files.length,
    },
    turnId: "turn1",
  };
}

function priorRewindEvent(files: string[]) {
  return {
    id: `rewind-${files.join(",")}`,
    sessionId: "sess",
    sequenceNumber: 0,
    timestamp: new Date(0),
    traceId: "trace",
    type: SessionEventType.RewindTriggered,
    payload: {
      rewindId: `rewind_${files.join("_")}`,
      scope: RewindScope.Workspace,
      strategy: "active_chain",
      targetMessageId: TURN_MESSAGE_ID,
      reason: "file_summary_rewind",
      files,
    },
    turnId: "turn1",
  };
}

function artifactJson(files: TestFile[]): string {
  return JSON.stringify({
    version: 1,
    kind: "workspace_file_before_change",
    createdAt: new Date(0).toISOString(),
    toolCallId: "tool1",
    toolName: "Write",
    files: files.map((file) => ({
      path: file.path,
      existedBefore: true,
      beforeContent: file.beforeContent,
      afterContent: file.afterContent,
      structuredPatch: [],
    })),
  });
}

/** currentContentByPath 键为绝对路径；返回 null 模拟文件不存在。 */
function createRuntimeStub(
  events: unknown[],
  artifacts: Map<string, string>,
  currentContentByPath: Map<string, string>,
) {
  const emittedEvents: Array<{ payload: Record<string, unknown>; type: unknown }> = [];
  const writtenFiles: Array<{ content: string; path: string }> = [];
  const runtime = {
    sessionId: "sess",
    workspaceRoot: WORKSPACE_ROOT,
    rootTraceContext: undefined,
    logger: undefined,
    eventStore: { getEvents: async () => events },
    artifactStore: {
      readToolResultArtifact: async (input: { uri: string }) => {
        const content = artifacts.get(input.uri);
        if (content === undefined) throw new Error(`missing artifact ${input.uri}`);
        return { content };
      },
    },
    fileSystemPort: {
      readTextFile: async (input: { path: string }) => {
        const content = currentContentByPath.get(input.path);
        if (content === null) {
          const error = new Error(`not found: ${input.path}`) as Error & { code?: string };
          error.code = "not_found";
          throw error;
        }
        return { content };
      },
      writeTextFile: async (input: { content: string; path: string }) => {
        writtenFiles.push({ path: input.path, content: input.content });
        currentContentByPath.set(input.path, input.content);
      },
    },
    createEvent: (type: unknown, payload: Record<string, unknown>) => ({
      id: `evt-${emittedEvents.length + 1}`,
      sessionId: "sess",
      sequenceNumber: emittedEvents.length + 1,
      timestamp: new Date(0),
      traceId: "trace",
      type,
      payload,
      turnId: "turn1",
    }),
    appendEvent: async (event: { payload: Record<string, unknown>; type: unknown }) => {
      emittedEvents.push(event);
    },
    emittedEvents,
    writtenFiles,
  };
  return runtime;
}

const FILE_A: TestFile = {
  afterContent: "after-a",
  beforeContent: "before-a",
  path: "src/a.ts",
};
const FILE_B: TestFile = {
  afterContent: "after-b",
  beforeContent: "before-b",
  path: "src/b.ts",
};

function baseArtifacts(): Map<string, string> {
  return new Map([
    ["cp-a", artifactJson([FILE_A])],
    ["cp-b", artifactJson([FILE_B])],
  ]);
}

function baseCurrentContents(): Map<string, string> {
  return new Map([
    [`${WORKSPACE_ROOT}/src/a.ts`, FILE_A.afterContent],
    [`${WORKSPACE_ROOT}/src/b.ts`, FILE_B.afterContent],
  ]);
}

test("整轮预览返回全部 safe 文件且不带 revertedPaths", async () => {
  const runtime = createRuntimeStub(
    [checkpointEvent([FILE_A], "cp-a"), checkpointEvent([FILE_B], "cp-b")],
    baseArtifacts(),
    baseCurrentContents(),
  );
  const preview = await previewWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
  });
  assert.equal(preview.canApply, true);
  // preview 的 safeFiles 必须与 artifact 原始路径同形（fileChanges items /
  // RewindTriggered.files 也用该形态），UI 跨数据源匹配才不会失配。
  assert.deepEqual(preview.safeFiles.map((file) => file.path).sort(), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(preview.revertedPaths, []);
});

test("paths 过滤只裁决子集：未选中文件被外部修改也不阻断", async () => {
  const currentContents = baseCurrentContents();
  currentContents.set(`${WORKSPACE_ROOT}/src/b.ts`, "externally-tampered");
  const runtime = createRuntimeStub(
    [checkpointEvent([FILE_A], "cp-a"), checkpointEvent([FILE_B], "cp-b")],
    baseArtifacts(),
    currentContents,
  );
  const preview = await previewWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
    paths: ["src/a.ts"],
  });
  assert.equal(preview.canApply, true, "子集内的文件安全即可撤销");
  assert.deepEqual(
    preview.safeFiles.map((file) => file.path),
    ["src/a.ts"],
  );
});

test("不传 paths 时外部修改仍阻断整轮撤销（现状回归）", async () => {
  const currentContents = baseCurrentContents();
  currentContents.set(`${WORKSPACE_ROOT}/src/b.ts`, "externally-tampered");
  const runtime = createRuntimeStub(
    [checkpointEvent([FILE_A], "cp-a"), checkpointEvent([FILE_B], "cp-b")],
    baseArtifacts(),
    currentContents,
  );
  const preview = await previewWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
  });
  assert.equal(preview.canApply, false);
  assert.ok(preview.unsafeFiles.some((file) => file.reason === "external_modified"));
});

test("此前已撤销的路径被排除并进入 revertedPaths，剩余文件可继续撤销", async () => {
  const runtime = createRuntimeStub(
    [
      checkpointEvent([FILE_A], "cp-a"),
      checkpointEvent([FILE_B], "cp-b"),
      priorRewindEvent(["src/a.ts"]),
    ],
    baseArtifacts(),
    baseCurrentContents(),
  );
  const preview = await previewWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
  });
  assert.deepEqual(preview.revertedPaths, ["src/a.ts"]);
  assert.deepEqual(
    preview.safeFiles.map((file) => file.path),
    ["src/b.ts"],
  );
  assert.equal(preview.canApply, true);
});

test("已撤销路径不在可勾选范围：paths 指向它时无可撤销文件", async () => {
  const runtime = createRuntimeStub(
    [
      checkpointEvent([FILE_A], "cp-a"),
      checkpointEvent([FILE_B], "cp-b"),
      priorRewindEvent(["src/a.ts"]),
    ],
    baseArtifacts(),
    baseCurrentContents(),
  );
  const preview = await previewWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
    paths: ["src/a.ts"],
  });
  assert.deepEqual(preview.safeFiles, []);
  assert.equal(preview.canApply, false);
});

test("按文件撤销 apply 只写回选中文件，事件携带 files 账本", async () => {
  const events = [checkpointEvent([FILE_A], "cp-a"), checkpointEvent([FILE_B], "cp-b")];
  const runtime = createRuntimeStub(events, baseArtifacts(), baseCurrentContents());
  const result = await applyWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
    paths: ["src/a.ts"],
  });
  assert.equal(result.applied, true);
  assert.deepEqual(runtime.writtenFiles, [{ path: "/repo/src/a.ts", content: "before-a" }]);
  const rewindEvent = runtime.emittedEvents.at(-1)!;
  assert.equal(rewindEvent.payload.reason, "file_summary_rewind");
  assert.deepEqual(rewindEvent.payload.files, ["src/a.ts"]);
});

test("apply 不带 paths 保持整轮撤销旧语义：写回全部且事件不带 files", async () => {
  const events = [checkpointEvent([FILE_A], "cp-a"), checkpointEvent([FILE_B], "cp-b")];
  const runtime = createRuntimeStub(events, baseArtifacts(), baseCurrentContents());
  const result = await applyWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
  });
  assert.equal(result.applied, true);
  assert.deepEqual(runtime.writtenFiles.map((file) => file.path).sort(), [
    "/repo/src/a.ts",
    "/repo/src/b.ts",
  ]);
  const rewindEvent = runtime.emittedEvents.at(-1)!;
  assert.equal("files" in rewindEvent.payload, false);
});

test("apply 在此前部分撤销后只还原剩余文件", async () => {
  const events = [
    checkpointEvent([FILE_A], "cp-a"),
    checkpointEvent([FILE_B], "cp-b"),
    priorRewindEvent(["src/a.ts"]),
  ];
  // 此前撤销 a 后，磁盘上 a 已是 before-a（stub 同步该状态）。
  const currentContents = baseCurrentContents();
  currentContents.set(`${WORKSPACE_ROOT}/src/a.ts`, FILE_A.beforeContent);
  const runtime = createRuntimeStub(events, baseArtifacts(), currentContents);
  const result = await applyWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
  });
  assert.equal(result.applied, true, "已撤销文件被排除，不触发 external_modified");
  assert.deepEqual(runtime.writtenFiles, [{ path: "/repo/src/b.ts", content: "before-b" }]);
});

test("apply 子集内文件不安全时 fail-closed：不写任何文件", async () => {
  const events = [checkpointEvent([FILE_A], "cp-a"), checkpointEvent([FILE_B], "cp-b")];
  const currentContents = baseCurrentContents();
  currentContents.set(`${WORKSPACE_ROOT}/src/a.ts`, "externally-tampered");
  const runtime = createRuntimeStub(events, baseArtifacts(), currentContents);
  const result = await applyWorkspaceFileRewind.call(runtime as never, {
    targetMessageIds: [TURN_MESSAGE_ID],
    paths: ["src/a.ts"],
  });
  assert.equal(result.applied, false);
  assert.deepEqual(runtime.writtenFiles, [], "不安全时不落任何写入");
  assert.deepEqual(runtime.emittedEvents, [], "失败不追加 RewindTriggered 事件");
});
