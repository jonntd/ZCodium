// IDE 工程绑定模块（spec: ide-workspace-project-binding）。
// 只钉契约面：幂等复用、缺失才注册、路径 normalize 同口径、服务缺席/失败静默降级。
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import type { IProjectService, ProjectTree } from "@zcode/services";
import {
  ensureWorkspaceProjectBinding,
  type WorkspaceProjectBindingDeps,
} from "../src/features/workspaceProjectBinding";

vi.mock("../src/features/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fakeService(tree: ProjectTree): IProjectService & {
  saved: Array<{ roots?: string[]; primaryRoot?: string }>;
} {
  const saved: Array<{ roots?: string[]; primaryRoot?: string }> = [];
  return {
    saved,
    readTree: vi.fn(async () => tree),
    saveProject: vi.fn(async (input: { roots?: string[]; primaryRoot?: string }) => {
      saved.push(input);
      return {
        id: `p-${saved.length}`,
        hostId: "local",
        name: "auto",
        nameOverridden: false,
        position: 0,
        pinned: false,
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
        roots: (input.roots ?? []).map((rootPath, position) => ({
          rootPath,
          position,
          isPrimary: rootPath === input.primaryRoot,
        })),
      };
    }),
  } as unknown as IProjectService & {
    saved: Array<{ roots?: string[]; primaryRoot?: string }>;
  };
}

function deps(
  service: IProjectService | undefined,
  folders: readonly string[],
): WorkspaceProjectBindingDeps {
  return { getProjectService: () => service, listFolders: () => folders };
}

const EMPTY_TREE: ProjectTree = { projects: [], tasks: [] };

describe("ensureWorkspaceProjectBinding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未注册的 folder → saveProject 新建（roots+primaryRoot，不传 name）", async () => {
    const service = fakeService(EMPTY_TREE);
    await ensureWorkspaceProjectBinding(deps(service, ["/Users/example/gode-ui-test"]));
    expect(service.saved).toEqual([
      { roots: ["/Users/example/gode-ui-test"], primaryRoot: "/Users/example/gode-ui-test" },
    ]);
  });

  it("临时工作区不登记（真机冒烟 /tmp/zc-ext-host-smoke.* 污染回归）", async () => {
    const service = fakeService(EMPTY_TREE);
    await ensureWorkspaceProjectBinding(
      deps(service, [
        "/tmp/zc-ext-host-smoke.6rGUDC/ws",
        "/private/tmp/zc-ext-host-smoke.ULuVxN/ws",
      ]),
    );
    expect(service.saved).toEqual([]);
  });

  it("已有工程精确声明该根目录 → 复用不新建（幂等）", async () => {
    const service = fakeService({
      projects: [
        {
          id: "p1",
          hostId: "local",
          name: "gode-ui-test",
          nameOverridden: false,
          position: 0,
          pinned: false,
          deleted: false,
          createdAt: 1,
          updatedAt: 1,
          roots: [{ rootPath: "/Users/example/gode-ui-test", position: 0, isPrimary: true }],
        },
      ],
      tasks: [],
    });
    await ensureWorkspaceProjectBinding(deps(service, ["/Users/example/gode-ui-test"]));
    expect(service.saved).toEqual([]);
  });

  it("多 folder 混合场景：命中的跳过，缺失的逐个注册", async () => {
    const service = fakeService({
      projects: [
        {
          id: "p1",
          hostId: "local",
          name: "claimed",
          nameOverridden: false,
          position: 0,
          pinned: false,
          deleted: false,
          createdAt: 1,
          updatedAt: 1,
          roots: [{ rootPath: "/w/a", position: 0, isPrimary: true }],
        },
      ],
      tasks: [],
    });
    await ensureWorkspaceProjectBinding(
      deps(service, ["/w/a", "/w/b", "/w/b"]),
    );
    expect(service.saved).toEqual([
      { roots: ["/w/b"], primaryRoot: "/w/b" },
    ]);
  });

  it("软删工程的根目录不复用（readTree includeDeleted=false 语义由调用方过滤）", async () => {
    const service = fakeService({
      projects: [
        {
          id: "p-del",
          hostId: "local",
          name: "deleted",
          nameOverridden: false,
          position: 0,
          pinned: false,
          deleted: true,
          createdAt: 1,
          updatedAt: 1,
          roots: [{ rootPath: "/gone", position: 0, isPrimary: true }],
        },
      ],
      tasks: [],
    });
    await ensureWorkspaceProjectBinding(deps(service, ["/gone"]));
    expect(service.saved).toHaveLength(1);
  });

  it("服务未装配 → 静默跳过", async () => {
    await expect(
      ensureWorkspaceProjectBinding(deps(undefined, ["/w/a"])),
    ).resolves.toBeUndefined();
  });

  it("folder 为空（IDE 未打开目录）→ 不触发 readTree", async () => {
    const service = fakeService(EMPTY_TREE);
    await ensureWorkspaceProjectBinding(deps(service, []));
    expect(vi.mocked(service.readTree)).not.toHaveBeenCalled();
  });

  it("注册失败 → 记 warn 不抛出（对话面不受阻）", async () => {
    const service = fakeService(EMPTY_TREE);
    vi.mocked(service.saveProject).mockRejectedValue(new Error("db locked"));
    await expect(
      ensureWorkspaceProjectBinding(deps(service, ["/w/a"])),
    ).resolves.toBeUndefined();
    const { log } = (await import("../src/features/logger")) as unknown as {
      log: { warn: Mock };
    };
    expect(log.warn).toHaveBeenCalledWith(
      "project-binding",
      expect.stringContaining("db locked"),
    );
  });
});
