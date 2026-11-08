// 临时自动审计（跑完即删）：用插件同款服务装配（createLocalServices）对线上库**副本**
// 打真实的 archiveTask RPC，复现「归档任务失败」的拒绝原文。全程隔离在临时数据根。
import { mkdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  setDataRootPathOverride,
} from "#src/paths.js";
import {
  createLocalServices,
  type ServiceCollection,
} from "@zcode/services/node";
import { IZCodeTaskService } from "@zcode/services";
import { EMPTY_ZCODE_BUILTIN_RELEASE_JSON } from "../../../apps/zcode-vscode/src/host/serviceAssembly";

const LIVE = join(process.env["HOME"] ?? "", ".zcodium");
const DATA_ROOT = join(tmpdir(), `gode-archive-audit-${Date.now()}`);
const CANDIDATES = [
  { taskId: "session_15d1db89daab6e7f2c635e197c40da3e", workspacePath: "/tmp/gode-ui-test" },
  { taskId: "session_06db5f892c1dffbd0e2e833d5a0e9ca6", workspacePath: "/tmp/gode-ui-test" },
  { taskId: "session_0d1a432d4fe667d0be3dcd543f2c18fc", workspacePath: "/Volumes/date/augment" },
];

let services: ServiceCollection | null = null;

afterAll(() => {
  void services?.dispose?.();
  setDataRootPathOverride(null);
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe("audit: createLocalServices 全装配 archiveTask", () => {
  it("副本数据根 + 真实装配 → 逐任务重放归档", async () => {
    mkdirSync(join(DATA_ROOT, "v2"), { recursive: true });
    cpSync(join(LIVE, "v2", "tasks-index.sqlite"), join(DATA_ROOT, "v2", "tasks-index.sqlite"));
    // WAL 侧文件一并复制，保证快照完整
    for (const suffix of ["-wal", "-shm"]) {
      try {
        cpSync(join(LIVE, "v2", `tasks-index.sqlite${suffix}`), join(DATA_ROOT, "v2", `tasks-index.sqlite${suffix}`));
      } catch { /* 无 WAL 侧文件时忽略 */ }
    }
    const providerDir = join(DATA_ROOT, "provider");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "builtin.json"), EMPTY_ZCODE_BUILTIN_RELEASE_JSON);
    setDataRootPathOverride(DATA_ROOT);

    services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: join(providerDir, "builtin.json"),
    });
    const taskService = services.get(IZCodeTaskService);
    expect(taskService).toBeDefined();

    for (const candidate of CANDIDATES) {
      try {
        const meta = await taskService!.archiveTask({
          taskId: candidate.taskId,
          workspacePath: candidate.workspacePath,
        });
        console.log(
          `[OK] ${candidate.taskId} archived=${String(meta.archived)} title=${meta.title.slice(0, 16)}`,
        );
        await taskService!.unarchiveTask({
          taskId: candidate.taskId,
          workspacePath: candidate.workspacePath,
        });
      } catch (error) {
        console.log(
          `[REJECT] ${candidate.taskId} (${candidate.workspacePath}): ${
            error instanceof Error ? `${error.message} | ${error.stack?.split("\n")[1] ?? ""}` : String(error)
          }`,
        );
      }
    }
    expect(true).toBe(true);
  }, 60_000);
});
