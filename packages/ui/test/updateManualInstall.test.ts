// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import fa from "@/i18n/locales/fa.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { deriveUpdateStatusViewModel } from "@/updateStatusModel.js";
import { toast } from "@/components/ui/toast.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: keyof typeof zhCN }, values?: Record<string, string>) =>
        String(zhCN[id] ?? id).replace("{version}", values?.version ?? ""),
    },
  }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => vi.fn() }));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

const available: UpdateStatePayload = {
  kind: "update-available",
  enabled: true,
  version: "99.0.0",
  manualInstall: true,
};

function mount({
  downloadUpdate = vi.fn(async () => {}),
  edgeToEdge = true,
  state = available,
}: {
  downloadUpdate?: () => Promise<void>;
  edgeToEdge?: boolean;
  state?: UpdateStatePayload;
} = {}) {
  const platform = {
    downloadUpdate,
    openExternal: vi.fn(),
    quitAndInstallUpdate: vi.fn(),
    getAutoUpdatePreferences: async () => ({ autoDownloadAndInstallUpdates: true }),
  } as unknown as IPlatformService;
  const props = {
    platform,
    version: "98.0.0",
    updateState: state,
    open: true,
    onOpenChange: vi.fn(),
    edgeToEdge,
  };
  return { platform, props, ...render(createElement(UpdateStatusDialogController, props)) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("手动更新安装", () => {
  it.each([true, false])(
    "实际渲染手动说明并隐藏自动安装和重启（独立窗口 %s）",
    async (edgeToEdge) => {
      mount({ edgeToEdge });
      await act(async () => {});
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByText(zhCN["updateDialog.manualInstallDescription"])).toBeTruthy();
      expect(screen.getByRole("button", { name: "前往下载并手动安装" })).toBeTruthy();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(
        screen.queryByRole("button", { name: zhCN["updateDialog.restartToUpdate"] }),
      ).toBeNull();
      expect(screen.queryByText(/98\.0\.0/)).toBeNull();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "只走既有下载命令，%s 立即释放按钮而无需超时",
    async (result) => {
      vi.useFakeTimers();
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const downloadUpdate = vi.fn(
        () =>
          new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const { platform } = mount({ downloadUpdate });
      await act(async () => {});
      const button = screen.getByRole("button", {
        name: "前往下载并手动安装",
      }) as HTMLButtonElement;
      expect(downloadUpdate).not.toHaveBeenCalled();
      fireEvent.click(button);
      fireEvent.click(button);
      expect(button.disabled).toBe(true);
      expect(downloadUpdate).toHaveBeenCalledTimes(1);
      expect(downloadUpdate).toHaveBeenCalledWith();
      await act(async () => {
        if (result === "resolve") resolve();
        else reject(new Error("openExternal failed"));
      });
      expect(button.disabled).toBe(false);
      if (result === "reject") {
        expect(toast).toHaveBeenCalledWith(zhCN["updateDialog.manualInstallOpenFailed"]);
      } else {
        expect(toast).not.toHaveBeenCalled();
      }
      expect(platform.openExternal).not.toHaveBeenCalled();
      expect(platform.quitAndInstallUpdate).not.toHaveBeenCalled();
      fireEvent.click(button);
      expect(downloadUpdate).toHaveBeenCalledTimes(2);
      await act(async () => resolve());
    },
  );

  it("manual available 不被旧 ready 缓存覆盖", () => {
    expect(
      deriveUpdateStatusViewModel({ legacyReadyVersion: "98.0.0", updateState: available }),
    ).toMatchObject({
      dialogPhase: "before-download",
      displayVersion: "99.0.0",
    });
  });

  it("已渲染 ready 后收到 manual available 必须移除重启入口", async () => {
    const { rerender, props } = mount({
      state: { kind: "update-downloaded", enabled: true, version: "98.0.0" },
    });
    await act(async () => {});
    expect(screen.getByRole("button", { name: zhCN["updateDialog.restartToUpdate"] })).toBeTruthy();
    rerender(createElement(UpdateStatusDialogController, { ...props, updateState: available }));
    expect(screen.queryByRole("button", { name: zhCN["updateDialog.restartToUpdate"] })).toBeNull();
    expect(screen.getByRole("button", { name: "前往下载并手动安装" })).toBeTruthy();
  });

  it("缺省字段保留自动下载和原生安装阶段", async () => {
    const { rerender, props } = mount({
      state: { kind: "update-available", enabled: true, version: "99.0.0" },
    });
    await act(async () => {});
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载更新" })).toBeTruthy();
    rerender(
      createElement(UpdateStatusDialogController, {
        ...props,
        updateState: { kind: "update-downloaded", enabled: true, version: "99.0.0" },
      }),
    );
    expect(screen.getByRole("button", { name: zhCN["updateDialog.restartToUpdate"] })).toBeTruthy();
    expect(screen.queryByText(zhCN["updateDialog.manualInstallDescription"])).toBeNull();
  });

  it("三种语言都明确手动安装限制和架构选择", () => {
    for (const messages of [zhCN, enUS, fa]) {
      expect(messages["updateDialog.manualInstall"]).toBeTruthy();
      expect(messages["updateDialog.manualInstallDescription"]).toContain("DMG");
      expect(messages["updateDialog.manualInstallDescription"]).toContain("Releases");
      expect(messages["updateDialog.manualInstallDescription"]).toContain("Intel");
    }
  });
});
