// 本地任务的按根目录自动归属（spec: ide-workspace-project-binding）。
// 插件 workspace-first 入口新建任务时 projectId 为空：只要本 Host 已有非软删工程
// 精确声明了该 workspacePath 就复用；精确根匹配不猜项目，子目录不命中父目录工程。
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { expect, it, describe } from "vitest";
import { ProjectRepository } from "#src/project-storage/project-repository.js";
import { addProjectSchema } from "#src/project-storage/schema.js";

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function makeRepository(): { repo: ProjectRepository; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT,
    title TEXT DEFAULT '', provider TEXT DEFAULT 'glm', title_overridden INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
    unread_at INTEGER, task_status TEXT DEFAULT 'completed',
    created_at INTEGER DEFAULT 1, updated_at INTEGER DEFAULT 2);`);
  addProjectSchema(db);
  // saveProject 直接写 projects 表（FK → hosts）；生产路径由 ensureHost 先建行。
  db.prepare("INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES('local','local',0)").run();
  return { repo: new ProjectRepository(db, "local"), db };
}

function storedProjectId(db: DatabaseSync, taskId: string): string | null {
  const row = db.prepare("SELECT project_id FROM tasks WHERE task_id=?").get(taskId) as
    | { project_id: string | null }
    | undefined;
  return row ? row.project_id : null;
}

describe("reserveCreatedTask 本地精确根归属", () => {
  it("本地未传 projectId：已有工程声明该根目录 → 任务归入该工程", () => {
    const { repo, db } = makeRepository();
    const project = repo.saveProject({ roots: ["/repo"], primaryRoot: "/repo" });
    repo.reserveCreatedTask({
      task: { taskId: "t1", workspacePath: "/repo" },
      projectId: null,
    });
    expect(storedProjectId(db, "t1")).toBe(project.id);
  });

  it("精确根匹配不猜项目：子目录任务不归入声明根为父目录的工程", () => {
    const { repo, db } = makeRepository();
    repo.saveProject({ roots: ["/repo"], primaryRoot: "/repo" });
    repo.reserveCreatedTask({
      task: { taskId: "t2", workspacePath: "/repo/sub" },
      projectId: null,
    });
    expect(storedProjectId(db, "t2")).toBeNull();
  });

  it("无工程声明该根目录 → 保持未归类（不自动建工程）", () => {
    const { repo, db } = makeRepository();
    repo.reserveCreatedTask({
      task: { taskId: "t3", workspacePath: "/elsewhere" },
      projectId: null,
    });
    expect(storedProjectId(db, "t3")).toBeNull();
  });

  it("软删工程的根目录不复用；显式 projectId 优先于自动归属", () => {
    const { repo, db } = makeRepository();
    const project = repo.saveProject({ roots: ["/gone"], primaryRoot: "/gone" });
    repo.deleteProject(project.id);
    repo.reserveCreatedTask({
      task: { taskId: "t4", workspacePath: "/gone" },
      projectId: null,
    });
    expect(storedProjectId(db, "t4")).toBeNull();

    const other = repo.saveProject({ roots: ["/other"], primaryRoot: "/other" });
    repo.reserveCreatedTask({
      task: { taskId: "t5", workspacePath: "/other" },
      projectId: other.id,
    });
    expect(storedProjectId(db, "t5")).toBe(other.id);
  });
});
