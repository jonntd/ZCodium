// @vitest-environment jsdom
// 拉取选择器「探测视觉/探测全部」按钮按探测能力装配（spec: modelhub-fetch-models §6）。
//
// 故障背景（2026-11-14 VS Code 实机）：装配层曾错用 modelhubAvailable（拉取能力）
// 判定是否下发 onProbeVision，导致无探测能力的宿主（VS Code/Web 的 platform 未实现
// modelhubProbeVision）上按钮照样渲染——可点但 handleProbeVision 直接返回 null，
// 静默无结果。修复后由 ProviderCardSections 按探测能力装配；本测试锁弹窗侧契约：
// onProbeVision 缺省时不渲染探测按钮（能力装配的另一半）。
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ModelhubModelPickerDialog } from "@/settings/model-provider-section/ModelhubModelPickerDialog.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  // 断言按 message id 查询（mock 直出 id，不依赖真实词条）。
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

const MODELS = [
  { id: "glm-5.3", visionGuess: true },
  { id: "deepseek-v4", visionGuess: false },
];

function renderPicker(options?: {
  onProbeVision?: (modelId: string) => Promise<boolean | null>;
}) {
  return render(
    createElement(ModelhubModelPickerDialog, {
      open: true,
      onOpenChange: () => {},
      models: MODELS,
      existingIds: [],
      onConfirm: () => {},
      ...(options?.onProbeVision ? { onProbeVision: options.onProbeVision } : {}),
    }),
  );
}

describe("ModelhubModelPickerDialog 探测按钮能力装配", () => {
  it("无 onProbeVision（VS Code/Web 口径）：探测按钮不渲染", () => {
    renderPicker();
    expect(screen.queryByText("settings.modelhub.pick.probeChecked")).toBeNull();
    expect(screen.queryByText("settings.modelhub.pick.probeAll")).toBeNull();
    // 非探测面不受影响：全选/全不选照常。
    expect(screen.getByText("settings.modelhub.pick.selectAll")).toBeTruthy();
    cleanup();
  });

  it("有 onProbeVision（桌面口径）：探测按钮渲染且可触发", () => {
    const probe = vi.fn(async () => true);
    renderPicker({ onProbeVision: probe });
    expect(screen.getByText("settings.modelhub.pick.probeChecked")).toBeTruthy();
    expect(screen.getByText("settings.modelhub.pick.probeAll")).toBeTruthy();
    cleanup();
  });
});
