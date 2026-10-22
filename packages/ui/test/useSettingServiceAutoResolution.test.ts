// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL, type AppSettings } from "@zcode/shared";

const settingService = {
  get: vi.fn<() => Promise<AppSettings>>(),
  update: vi.fn<(patch: Partial<AppSettings>) => Promise<void>>(),
};
const broadcastService = {
  send: vi.fn<(message: { channel: string; payload: unknown }) => Promise<void>>(),
};
const zcodeAgentService = {
  syncAppRuntimePreferences:
    vi.fn<
      (preferences: {
        askUserQuestionAutoResolutionEnabled: boolean;
        modelIoFullRetentionEnabled: boolean;
      }) => Promise<void>
    >(),
};
const botsService = {
  syncAppRuntimePreferences:
    vi.fn<
      (preferences: {
        askUserQuestionAutoResolutionEnabled: boolean;
        modelIoFullRetentionEnabled: boolean;
      }) => Promise<void>
    >(),
};

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    broadcastService,
    settingService,
    zcodeAgentService,
    botsService,
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

describe("useSettings AskUserQuestion runtime preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingService.get.mockResolvedValue({
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
    } as AppSettings);
    settingService.update.mockResolvedValue(undefined);
    broadcastService.send.mockResolvedValue(undefined);
    zcodeAgentService.syncAppRuntimePreferences.mockResolvedValue(undefined);
    botsService.syncAppRuntimePreferences.mockResolvedValue(undefined);
  });

  it("persists, waits for the current Host ACK, then broadcasts the strict preference", async () => {
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const hook = renderHook(() => useSettings());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let releaseBotSync: (() => void) | undefined;
    botsService.syncAppRuntimePreferences.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseBotSync = resolve;
      }),
    );

    let updatePromise: Promise<void> | undefined;
    act(() => {
      updatePromise = hook.result.current.update({
        askUserQuestionAutoResolutionEnabled: false,
      });
    });
    await waitFor(() => expect(botsService.syncAppRuntimePreferences).toHaveBeenCalledOnce());
    expect(broadcastService.send).not.toHaveBeenCalled();
    releaseBotSync?.();
    await act(async () => {
      await updatePromise;
    });

    expect(settingService.update).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
    });
    // fork 在快照里额外下发删除保护两项、自定义系统提示词/分段与回复语言（空串/{} 表示
    // 「已恢复默认」，必须原样下发），上游断言只列了两个字段。
    const expectedPreferences = {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
      deleteProtectionEnabled: true,
      batchDeleteApprovalThreshold: 50,
      customSystemPrompt: "",
      customSystemSegments: {},
      language: "",
    };
    expect(zcodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith(expectedPreferences);
    expect(botsService.syncAppRuntimePreferences).toHaveBeenCalledWith(expectedPreferences);
    expect(broadcastService.send).toHaveBeenCalledWith({
      channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
      payload: expectedPreferences,
    });
    expect(zcodeAgentService.syncAppRuntimePreferences.mock.invocationCallOrder[0]).toBeLessThan(
      broadcastService.send.mock.invocationCallOrder[0] ?? 0,
    );
    expect(botsService.syncAppRuntimePreferences.mock.invocationCallOrder[0]).toBeLessThan(
      broadcastService.send.mock.invocationCallOrder[0] ?? 0,
    );

    hook.unmount();
  });

  it("persists and synchronizes ModelIO full retention with the complete preference snapshot", async () => {
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const hook = renderHook(() => useSettings());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.update({ modelIoFullRetentionEnabled: true });
    });

    expect(settingService.update).toHaveBeenCalledWith({
      modelIoFullRetentionEnabled: true,
    });
    // 同上：fork 的完整快照还包含删除保护、系统提示词与回复语言字段。
    const preferences = {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: true,
      deleteProtectionEnabled: true,
      batchDeleteApprovalThreshold: 50,
      customSystemPrompt: "",
      customSystemSegments: {},
      language: "",
    };
    expect(zcodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith(preferences);
    expect(botsService.syncAppRuntimePreferences).toHaveBeenCalledWith(preferences);
    expect(broadcastService.send).toHaveBeenCalledWith({
      channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
      payload: preferences,
    });

    hook.unmount();
  });
});
