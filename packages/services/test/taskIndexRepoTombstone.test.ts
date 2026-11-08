// 墓碑单调回归（spec: sidebar-task-service-resolution；skill I14）。
// 实测缺陷：CLI 删除拒绝（busy）后，存活事实回源经 writeRecord upsert 把 tombstone 行
// 复活（deleted 1→0），表现为「删除了的任务又在列表出现/归档报不存在」。任何 upsert
// 不得把已有墓碑清回存活；CLI 存活事实只能经由明确的反向事件（现无）处理。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-tombstone-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

function meta(taskId: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/workspace/project",
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    provider: "glm",
  };
}

function deletedFlag(target: TaskIndexRepo, taskId: string): number {
  const row = (
    target as unknown as {
      getTaskRow(params: { workspacePath: string; taskId: string }): { deleted: number } | null;
    }
  ).getTaskRow({ workspacePath: "/workspace/project", taskId });
  return row ? Number(row.deleted) : -1;
}

describe("task index 墓碑单调", () => {
  it("tombstone 后 CLI 存活事实回源（applyCliFacts deleted=false）不清除墓碑", async () => {
    const m = meta("s-tombstone");
    await repo.applyCliFacts({ meta: m });
    // 归档后删除（deleteArchivedTask 的 tombstone 写入）
    await repo.updateTaskState({
      workspacePath: m.workspacePath,
      taskId: m.taskId,
      patch: { archived: true },
    });
    expect(await repo.deleteArchivedTask({ workspacePath: m.workspacePath, taskId: m.taskId })).not.toBeNull();
    expect(deletedFlag(repo, m.taskId)).toBe(1);
    // CLI 存活事实回源（seed/refresh 场景）
    await repo.applyCliFacts({ meta: { ...m, updatedAt: 30 } });
    expect(deletedFlag(repo, m.taskId)).toBe(1);
  });

  it("幽灵预留行回收：无 CLI 事实的占位行在启动时清除；携带事实的行与存活行不受影响", async () => {
    // 先驱动 ensureReady（初始化是懒触发），再直接对 repo 库插两类行：
    // 幽灵占位（created_at=0、cli_created_at NULL，实测残留形态）与正常回源行（有 CLI 事实）。
    await repo.applyCliFacts({ meta: meta("warmup") });
    const db = (
      repo as unknown as { getDatabase(): { prepare(sql: string): { run(...p: unknown[]): unknown } } }
    ).getDatabase();
    // 镜像真实预留行形态（reserveCreatedTask：带 host_id/root_path/handoff_pending=8，
    // 无 CLI 事实）；缺 host_id 会被 reconcileLegacy 的身份初始化转成 cli_created_at=0。
    db.prepare(
      "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,handoff_pending) VALUES('/w','/w','/w','ghost-1',0,0,'local','/w',8)",
    ).run();
    db.prepare(
      "INSERT INTO tasks(workspace_key,workspace_path,task_id,created_at,updated_at,cli_created_at) VALUES('/w','/w','alive-1',5,6,7)",
    ).run();
    await repo.applyCliFacts({ meta: meta("alive-2") });

    // 重开 repo 触发 initialize → sweep
    repo.close();
    repo = new TaskIndexRepo();
    await repo.applyCliFacts({ meta: meta("post-reopen") });

    const rows = (
      repo as unknown as { getDatabase(): { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }
    ).getDatabase()
      .prepare("SELECT task_id FROM tasks ORDER BY task_id")
      .all() as Array<{ task_id: string }>;
    const ids = rows.map((row) => row.task_id);
    expect(ids).not.toContain("ghost-1");
    expect(ids).toContain("alive-1");
    expect(ids).toContain("alive-2");
  });

  it("tombstone 后 updateTaskState 拒绝（不复活、不误报成功）", async () => {
    const m = meta("s-tombstone-2");
    await repo.applyCliFacts({ meta: m });
    await repo.updateTaskState({
      workspacePath: m.workspacePath,
      taskId: m.taskId,
      patch: { archived: true },
    });
    await repo.deleteArchivedTask({ workspacePath: m.workspacePath, taskId: m.taskId });
    // 错误语义拆分（P0-2）：已删除行报「已删除」，与「不存在」区分——
    // 归档/删除失败的日志由此可精确定位（此前笼统「不存在」掩盖了复活缺陷）。
    await expect(
      repo.updateTaskState({
        workspacePath: m.workspacePath,
        taskId: m.taskId,
        patch: { archived: true },
      }),
    ).rejects.toThrow(/已删除/);
  });
});
