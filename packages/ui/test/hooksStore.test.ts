import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHooksCacheKey, useHooksStore } from "@/store/hooksStore.js";
import type { IHooksService } from "@zcode/services";

function serviceReturning(hooks: Array<Pick<import("@zcode/shared").Hook, "id">>) {
  return {
    loadHooks: vi.fn(async () => ({ hooks: hooks as never[] })),
    saveHooks: vi.fn(async () => undefined),
  };
}

describe("hooksStore", () => {
  beforeEach(() => {
    useHooksStore.setState({
      workspacePath: null,
      workspaceIdentity: null,
      authorityKey: null,
      scope: null,
      loadedWorkspaceKey: null,
      hooks: [],
      loading: false,
      error: null,
      operatingHookId: null,
    });
  });

  it("投影 key 含 scope：本机「用户」与同路径项目的 key 不同", () => {
    // Bug 回归：本机「用户」锚点与项目路径相同时，旧 key（path|identity|authority）完全一致，
    // inflight 去重会让项目视图复用 user-scope 的加载结果。scope 必须参与 key。
    expect(getHooksCacheKey("/repo", undefined, undefined, "user")).toBe("user\0/repo");
    expect(getHooksCacheKey("/repo", undefined, undefined, "workspace")).toBe("workspace\0/repo");
    expect(getHooksCacheKey("/repo", undefined, undefined, "user")).not.toBe(
      getHooksCacheKey("/repo", undefined, undefined, "workspace"),
    );
    // authority 仍然参与 key：两台设备同 home 路径互不串投影。
    expect(getHooksCacheKey("/home/dev", undefined, "source-settings:a", "user")).toBe(
      "source-settings:a\0user\0/home/dev",
    );
    expect(getHooksCacheKey("/home/dev", undefined, "source-settings:b", "user")).not.toBe(
      getHooksCacheKey("/home/dev", undefined, "source-settings:a", "user"),
    );
    // 未传 scope 的旧调用方保持项目视图语义。
    expect(getHooksCacheKey("/repo", undefined, undefined)).toBe("workspace\0/repo");
  });

  it("本机「用户」加载 in-flight 时切到同路径项目，项目视图必须用自己的 service 重载", async () => {
    const userService = serviceReturning([{ id: "user-hook" }]);
    const projectService = serviceReturning([{ id: "project-hook" }]);

    // 先发起用户视图加载，不 await（保持 in-flight）。
    const userLoad = useHooksStore
      .getState()
      .initialize("/repo", undefined, userService as unknown as IHooksService, undefined, "user");

    // 同锚点、同 authority 的项目视图并发初始化：不得复用用户视图的 inflight 结果。
    await useHooksStore
      .getState()
      .initialize("/repo", undefined, projectService as unknown as IHooksService, undefined, "workspace");

    expect(useHooksStore.getState().hooks.map((hook) => hook.id)).toEqual(["project-hook"]);
    expect(useHooksStore.getState().loadedWorkspaceKey).toBe("workspace\0/repo");

    // 用户视图的迟到结果写入前被漂移守卫丢弃，不覆盖项目投影。
    await userLoad;
    expect(useHooksStore.getState().hooks.map((hook) => hook.id)).toEqual(["project-hook"]);
  });

  it("同目标重复初始化时复用 in-flight 请求，不重复发起 loadHooks", async () => {
    const service = serviceReturning([{ id: "shared-hook" }]);
    const hooksService = service as unknown as IHooksService;

    const first = useHooksStore
      .getState()
      .initialize("/repo", undefined, hooksService, undefined, "workspace");
    const second = useHooksStore
      .getState()
      .initialize("/repo", undefined, hooksService, undefined, "workspace");
    await Promise.all([first, second]);

    expect(service.loadHooks).toHaveBeenCalledTimes(1);
    expect(useHooksStore.getState().hooks.map((hook) => hook.id)).toEqual(["shared-hook"]);
  });
});
