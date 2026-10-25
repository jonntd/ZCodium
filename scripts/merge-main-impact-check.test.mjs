import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  classifyOverlap,
  computeMergeImpact,
  parseNameStatus,
} from "./merge-main-impact-check.mjs";

const execFile = promisify(execFileCallback);

const createdDirs = [];

function git(cwd, ...args) {
  // 必须同步执行：setup 的每一步提交都是下一步的前置，异步化会产生竞态。
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "merge-impact-"));
  createdDirs.push(dir);
  git(dir, "init", "-b", "main", ".");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(join(dir, "common.txt"), "base\n");
  writeFileSync(join(dir, "custom.txt"), "ZCodium 定制内容\n");
  writeFileSync(join(dir, "plain.txt"), "plain\n");
  writeFileSync(join(dir, "drop.txt"), "main 侧将删除的文件\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  return dir;
}

function commitFeatureBranch(dir) {
  git(dir, "checkout", "-b", "feat");
  writeFileSync(join(dir, "common.txt"), "base\nfeat line\n");
  writeFileSync(join(dir, "custom.txt"), "ZCodium 定制内容\nfeat 定制追加\n");
  writeFileSync(join(dir, "drop.txt"), "feat 侧仍在修改的文件\n");
  writeFileSync(join(dir, "fork-only.txt"), "fork 新增\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat change");
  git(dir, "checkout", "main");
}

function commitMainSide(dir) {
  writeFileSync(join(dir, "common.txt"), "base\nmain line\n");
  writeFileSync(join(dir, "custom.txt"), "main 侧覆盖版\n");
  rmSync(join(dir, "drop.txt"));
  writeFileSync(join(dir, "main-new.txt"), "main 新增\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "main change");
}

afterEach(() => {
  for (const dir of createdDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const dir of createdDirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseNameStatus", () => {
  it("解析增删改状态；重命名取新路径", () => {
    const files = parseNameStatus(
      ["M\tsrc/a.ts", "D\tsrc/b.ts", "A\tsrc/c.ts", "R100\tsrc/old.ts\tsrc/new.ts", ""].join("\n"),
    );

    expect(files.get("src/a.ts")).toBe("M");
    expect(files.get("src/b.ts")).toBe("D");
    expect(files.get("src/c.ts")).toBe("A");
    expect(files.has("src/old.ts")).toBe(false);
    expect(files.get("src/new.ts")).toBe("R100");
  });
});

describe("computeMergeImpact", () => {
  it("交集文件命中 fork 定制登记表时点名定制点；absent 标记以出现为命中", async () => {
    // electron-builder.config.js 在登记表里挂了 dmg-install-guide（两条正向标记）
    // 与 github-update-provider（一条正向标记）：标记出现 → 报告点名 id。
    // http.ts 的去遥测是 absent 标记：上游实现回流（processResourceTelemetry 出现）
    // 才算命中，健康态（不含）不得误报——正向与反向的命中语义在这里钉死。
    const overlap = await classifyOverlap({
      incomingFiles: new Map([
        ["packages/desktop/electron-builder.config.js", "M"],
        ["packages/server/src/http.ts", "M"],
        ["packages/ui/src/lib/taskListMetaSync.ts", "M"],
      ]),
      localFiles: new Map([
        ["packages/desktop/electron-builder.config.js", "M"],
        ["packages/server/src/http.ts", "M"],
        ["packages/ui/src/lib/taskListMetaSync.ts", "M"],
      ]),
      readHeadFile: async (path) => {
        if (path === "packages/server/src/http.ts") {
          return "export function processResourceTelemetry() {}";
        }
        if (path === "packages/ui/src/lib/taskListMetaSync.ts") {
          return "export function otherHelper() {}";
        }
        return [
          'background: "build/dmg_background.png",',
          'provider: "github",',
          "contents: [{ x: 150, y: 120 }],",
        ].join("\n");
      },
    });

    const byPath = new Map(overlap.map((item) => [item.path, item]));
    const dmgEntry = byPath.get("packages/desktop/electron-builder.config.js");
    expect(dmgEntry.forkCustomized).toBe(true);
    expect(dmgEntry.forkCustomizations).toEqual(
      expect.arrayContaining(["dmg-install-guide", "github-update-provider"]),
    );
    const telemetryEntry = byPath.get("packages/server/src/http.ts");
    expect(telemetryEntry.forkCustomized).toBe(true);
    expect(telemetryEntry.forkCustomizations).toEqual(["de-telemetry-baseline"]);
    // 健康文件（登记标记均未出现）不因登记表接入而误报。
    const healthyEntry = byPath.get("packages/ui/src/lib/taskListMetaSync.ts");
    expect(healthyEntry.forkCustomized).toBe(false);
    expect(healthyEntry.forkCustomizations).toEqual([]);
  });

  it("识别双方同路径改动，并按 fork 定制标记区分高危项", async () => {
    const dir = initRepo();
    commitFeatureBranch(dir);
    commitMainSide(dir);

    const impact = await computeMergeImpact({ ref: "main", head: "feat", cwd: dir });

    expect(impact.incomingCommits).toBe(1);
    const overlapPaths = impact.overlap.map((item) => item.path).sort();
    expect(overlapPaths).toEqual(["common.txt", "custom.txt", "drop.txt"]);
    const byPath = new Map(impact.overlap.map((item) => [item.path, item]));
    // custom.txt 在当前分支版本含 "ZCodium" → fork 定制高危；common.txt 无标记。
    expect(byPath.get("custom.txt").forkCustomized).toBe(true);
    expect(byPath.get("common.txt").forkCustomized).toBe(false);
    expect(byPath.get("custom.txt").incomingStatus).toBe("M");
    expect(byPath.get("custom.txt").localStatus).toBe("M");
  });

  it("对方删除、本分支修改的路径按 modify/delete 组合如实标注", async () => {
    const dir = initRepo();
    commitFeatureBranch(dir);
    commitMainSide(dir);

    const impact = await computeMergeImpact({ ref: "main", head: "feat", cwd: dir });

    const drop = impact.overlap.find((item) => item.path === "drop.txt");
    expect(drop.incomingStatus).toBe("D");
    expect(drop.localStatus).toBe("M");
  });

  it("双方改动互不相交时 overlap 为空", async () => {
    const dir = initRepo();
    git(dir, "checkout", "-b", "feat");
    writeFileSync(join(dir, "fork-only.txt"), "fork 新增\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "feat change");
    git(dir, "checkout", "main");
    writeFileSync(join(dir, "main-new.txt"), "main 新增\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "main change");

    const impact = await computeMergeImpact({ ref: "main", head: "feat", cwd: dir });

    expect(impact.overlap).toEqual([]);
  });

  it("CLI 预览模式按交集有无返回 0/2，--json 输出结构化结果", async () => {
    const dir = initRepo();
    commitFeatureBranch(dir);
    commitMainSide(dir);
    // CLI 以 HEAD 为本分支侧，切回 feat 才是真实使用姿势（站在特性分支上合并 main）。
    git(dir, "checkout", "feat");
    const script = join(process.cwd(), "scripts", "merge-main-impact-check.mjs");

    const overlapRun = await execFile("node", [script, "main", "--json"], {
      cwd: dir,
      encoding: "utf8",
    }).catch((error) => error);
    expect(overlapRun.code).toBe(2);
    const payload = JSON.parse(overlapRun.stdout);
    expect(payload.overlap.map((item) => item.path).sort()).toEqual([
      "common.txt",
      "custom.txt",
      "drop.txt",
    ]);

    // 显式以 main 为起点：disjoint 与 main 无任何同路径改动，才构成无交集场景。
    git(dir, "checkout", "-b", "disjoint", "main");
    // 退出 0 时 promise 正常 resolve；非零会直接 reject 使本用例失败。
    const cleanRun = await execFile("node", [script, "main", "--json"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(JSON.parse(cleanRun.stdout).overlap).toEqual([]);
  });

  describe("--merge 模式", () => {
    const script = join(process.cwd(), "scripts", "merge-main-impact-check.mjs");

    function headIsMergeCommit(dir) {
      // merge 完成的标志：HEAD 有两个父提交。
      return git(dir, "log", "-1", "--format=%P").trim().split(/\s+/).length === 2;
    }

    it("有交集且未确认时在合并前拦截，HEAD 不变", async () => {
      const dir = initRepo();
      commitFeatureBranch(dir);
      commitMainSide(dir);
      git(dir, "checkout", "feat");

      const blocked = await execFile("node", [script, "--merge", "main"], {
        cwd: dir,
        encoding: "utf8",
      }).catch((error) => error);

      expect(blocked.code).toBe(1);
      expect(headIsMergeCommit(dir)).toBe(false);
    });

    it("有交集但 ZCODE_MERGE_IMPACT_ACK=1 时放行并完成 merge", async () => {
      const dir = initRepo();
      // 双方改同一文件的不同区域：有交集但可干净自动合并，验证 ACK 后 merge 真正完成。
      git(dir, "checkout", "-b", "feat");
      writeFileSync(join(dir, "common.txt"), "base\nfeat line\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "feat change");
      git(dir, "checkout", "main");
      writeFileSync(join(dir, "common.txt"), "main line\nbase\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "main change");
      git(dir, "checkout", "feat");

      // 退出 0 时 promise 正常 resolve；非零会直接 reject 使本用例失败。
      await execFile("node", [script, "--merge", "main"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ZCODE_MERGE_IMPACT_ACK: "1" },
      });
      expect(headIsMergeCommit(dir)).toBe(true);
    });

    it("无交集时直接放行合并", async () => {
      const dir = initRepo();
      git(dir, "checkout", "-b", "feat");
      writeFileSync(join(dir, "fork-only.txt"), "fork 新增\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "feat change");
      git(dir, "checkout", "main");
      writeFileSync(join(dir, "main-new.txt"), "main 新增\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "main change");
      git(dir, "checkout", "feat");

      await execFile("node", [script, "--merge", "main"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(headIsMergeCommit(dir)).toBe(true);
    });
  });
});
