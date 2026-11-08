// 任务维度服务解析（spec: docs/ui/task-grouped-view.md 跨工作区任务区可操作性）。
// 修复锚点：lookup 只含已开 tab 的 workspace——未开 tab 的本地任务必须回落 baseServices，
// 否则归档/删除/重命名/置顶静默 no-op；远端目标未恢复 session 时必须保持 null。
import { describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  buildWorkspaceServiceLookup,
  resolveTaskWorkspaceServices,
} from "@/lib/workspaceServiceResolver.js";

const baseServices = { marker: "base" } as unknown as IServiceAccessor;
const remoteServices = { marker: "remote" } as unknown as IServiceAccessor;

function lookupWith(overrides: Array<{
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}>) {
  return buildWorkspaceServiceLookup(
    overrides.map((tab) => ({ ...tab, remoteTarget: tab.remoteSessionId ? {} : undefined })),
    baseServices,
    {
      sessionsById: {
        "remote-session": { services: remoteServices },
      },
      sessionIdByWorkspaceIdentity: {},
      sessionIdByWorkspacePath: {},
    },
  );
}

describe("resolveTaskWorkspaceServices", () => {
  it("未开 tab 的本地任务 → 回落 baseServices（归档/删除不再静默 no-op）", () => {
    const lookup = lookupWith([{ workspacePath: "/open" }]);
    const resolved = resolveTaskWorkspaceServices(
      { workspacePath: "/closed-ws", taskId: "t1", hostId: "local" },
      lookup,
      baseServices,
    );
    expect(resolved?.services).toBe(baseServices);
    expect(resolved?.isRemoteWorkspace).toBe(false);
  });

  it("已开 tab 的任务 → 仍走 lookup（远端命中远端 session services）", () => {
    const identity = "remote:ssh:dev:22:user:/open-remote";
    const lookup = lookupWith([
      { workspacePath: "/open-remote", workspaceIdentity: identity, remoteSessionId: "remote-session" },
    ]);
    const resolved = resolveTaskWorkspaceServices(
      { workspacePath: "/open-remote", workspaceIdentity: identity, hostId: "remote:ssh:dev" },
      lookup,
      baseServices,
    );
    expect(resolved?.services).toBe(remoteServices);
    expect(resolved?.remoteSessionId).toBe("remote-session");
  });

  it("带 identity 的远端任务不在 lookup（session 未恢复）→ 保持 null 不落回本机", () => {
    const lookup = lookupWith([]);
    const resolved = resolveTaskWorkspaceServices(
      {
        workspacePath: "/offline-remote",
        workspaceIdentity: "remote:ssh:dev:22:user:/offline-remote",
      },
      lookup,
      baseServices,
    );
    expect(resolved).toBeNull();
  });

  it("无 identity 但 hostId 非本地的任务 → 保持 null（远端行不误用本机服务）", () => {
    const lookup = lookupWith([]);
    const resolved = resolveTaskWorkspaceServices(
      { workspacePath: "/remote-row", hostId: "remote:ssh:dev" },
      lookup,
      baseServices,
    );
    expect(resolved).toBeNull();
  });
});
