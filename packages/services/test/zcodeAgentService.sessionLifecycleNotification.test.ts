// 阶段 2a-3 接线回归：`session/lifecycle/changed` 与 `startup/pluginsDegraded` 两条通知此前在
// zcodeAgentService 的 onNotification 里无人路由，sessionLifecycleEmitter 与
// pluginStartupDegradedEmitter 因此从不 fire，UI 只能靠 listManagedProcesses 回放兜底。
// 上游 main（upstream/main:2631-2649）有这两条路由，是在与上游并集时丢失的；本文件用假 client
// 钉住「路由 → schema 校验 → emitter fire → 消费端契约」整条链，防止再次静默丢失。
import { describe, expect, it, vi } from "vitest";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type SessionLifecycleSnapshot,
} from "@zcode/shared";

const WORKSPACE = { workspacePath: "/workspace" };

const SNAPSHOT: SessionLifecycleSnapshot = {
  sessionId: "session-lifecycle-1",
  state: "ready",
  generation: 3,
  revision: 7,
  lastError: null,
};

type NotificationMessage = { method: string; params?: unknown };
type NotificationListener = (message: NotificationMessage) => void;

async function createHarness(overrides: Record<string, unknown> = {}) {
  let notificationListener: NotificationListener | null = null;
  const getState = vi.fn(async () => SNAPSHOT);
  const client = {
    request: vi.fn(async () => ({})),
    transportKind: "stdio",
    // 降级标记与释放状态由 ZCodeProtocolClient 自身维护（zcodeProtocolClient.ts:106/143），
    // 路由直接读取，因此假 client 上给出同名可辨字段。
    pluginStartupDegraded: true,
    isDisposed: false,
    sessionLifecycle: { getState },
    onNotification: (listener: NotificationListener) => {
      notificationListener = listener;
      return { dispose() {} };
    },
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
    ...overrides,
  };

  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      listManagedProcesses() {
        // 回放分支只读当前工作区进程；本用例只验证通知驱动的 fire，进程表留空。
        return [];
      }
      async getClient() {
        return client;
      }
      disposeAll() {}
      async disposeAllAndWait() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService();
  const notify = (message: NotificationMessage) => {
    notificationListener?.(message);
  };
  // 通知监听器在 wireClient 里注册，先走一次只读取客户端把 client 接上并登记 active entry。
  await service.getSessionLifecycle({ ...WORKSPACE, sessionId: SNAPSHOT.sessionId });
  return { service, getState, notify };
}

describe("zcodeAgentService 会话生命周期与插件降级通知路由", () => {
  it("session/lifecycle/changed 经校验后投递给 onDynamicSessionLifecycle", async () => {
    const { service, getState, notify } = await createHarness();
    expect(getState).toHaveBeenCalledWith(SNAPSHOT.sessionId);

    const received: SessionLifecycleSnapshot[] = [];
    const subscription = service.onDynamicSessionLifecycle(WORKSPACE)((snapshot) =>
      received.push(snapshot),
    );
    const updated: SessionLifecycleSnapshot = { ...SNAPSHOT, state: "faulted", revision: 8 };

    notify({ method: zcodeProtocolMethods.sessionLifecycleChanged, params: updated });
    expect(received).toEqual([updated]);

    // 未通过 sessionLifecycleSnapshotSchema 的载荷必须整条丢弃，不能把未校验对象透给 UI。
    notify({ method: zcodeProtocolMethods.sessionLifecycleChanged, params: { sessionId: "" } });
    expect(received).toHaveLength(1);

    subscription.dispose();
    await service.disposeAllAndWait();
  });

  it("其他 workspace 的 lifecycle 快照不投递", async () => {
    const { service, notify } = await createHarness();
    const received: SessionLifecycleSnapshot[] = [];
    const subscription = service.onDynamicSessionLifecycle({ workspacePath: "/other" })(
      (snapshot) => received.push(snapshot),
    );

    notify({ method: zcodeProtocolMethods.sessionLifecycleChanged, params: SNAPSHOT });
    expect(received).toEqual([]);

    subscription.dispose();
    await service.disposeAllAndWait();
  });

  it("startup/pluginsDegraded 投递给 onDynamicPluginStartupDegraded 且按 client 去重", async () => {
    const { service, notify } = await createHarness();
    let calls = 0;
    const subscription = service.onDynamicPluginStartupDegraded(WORKSPACE)(() => {
      calls += 1;
    });

    notify({
      method: zcodeProtocolNotifications.pluginStartupDegraded,
      params: { reason: "timeout" },
    });
    expect(calls).toBe(1);

    // 同一个 client 只通知一次：消费端按 client 身份去重，避免回放与通知叠加成两次提醒。
    notify({
      method: zcodeProtocolNotifications.pluginStartupDegraded,
      params: { reason: "timeout" },
    });
    expect(calls).toBe(1);

    subscription.dispose();
    await service.disposeAllAndWait();
  });

  it("已释放的 client 不再投递降级通知", async () => {
    const { service, notify } = await createHarness({ isDisposed: true });
    let calls = 0;
    const subscription = service.onDynamicPluginStartupDegraded(WORKSPACE)(() => {
      calls += 1;
    });

    notify({
      method: zcodeProtocolNotifications.pluginStartupDegraded,
      params: { reason: "timeout" },
    });
    expect(calls).toBe(0);

    subscription.dispose();
    await service.disposeAllAndWait();
  });
});
