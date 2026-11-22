/**
 * composer-insert / 诊断注入落点 workspace 解析回归（spec:
 * composer-insert-delivery「落点 key」规则，2026-11-22 修订）。
 *
 * 事故（2026-11-21「右键加入 Gode 对话」全量失效）：1915364a 起侧栏挂载桌面 Root，
 * 可见对话区的 workspace 归 Root tabStore 所有；App/bootstrap 层 workspacePath 是
 * 独立状态，Root 页签内切换工作区不发 host workspace 帧 → App 层 key 冻结在
 * bootstrap folder。旧实现把 requestComposerTextInsert 写进 App 层 key：面板页签
 * 停在别的工作区时（当日实证：tasks-index 里 23:45 在 zcode-patcher 建了任务，
 * 23:49 起在 IDE 主 folder 6 次右键全部落空），请求落进无可见 composer 消费的
 * store 桶——host 日志显示帧已推送、链路无错，用户侧毫无反应。
 *
 * 本测试锁死口径（resolveComposerInsertTarget）：
 * 1. tabStore 无 active workspace（Root 未挂载）→ 回退 App 层 key（原行为）；
 * 2. App 层 key 与 tabStore active 分叉（本 bug 现场）→ 落点 = active workspace；
 * 3. settings 页签覆盖 → 落点回退被覆盖的 workspace 页签（与 Root shell target 同口径）；
 * 4. 页签带 workspaceIdentity → identity 随落点透传（store key = identity||path）；
 * 5. App 层兜底 folder 候选口径不变（聚焦 folder ∉ folders → folders[0]）。
 */
import { describe, expect, it } from "vitest";
import {
  fallbackInsertTarget,
  resolveComposerInsertTarget,
  type TabStoreTargetState,
} from "../src/webview-react/composer/insertTarget";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const BOOTSTRAP_FOLDER = "/w/claude-code";

function workspaceTab(
  id: string,
  workspacePath: string,
  extra?: Partial<WorkspaceTabState>,
): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    label: workspacePath.split("/").at(-1) ?? workspacePath,
    workspacePath,
    ...extra,
  };
}

describe("resolveComposerInsertTarget（落点 key = 可见对话区 workspace）", () => {
  it("tabStore 未挂载（Provider 未挂树）：回退 App 层 key，identity 缺省", () => {
    expect(
      resolveComposerInsertTarget(null, BOOTSTRAP_FOLDER, [BOOTSTRAP_FOLDER]),
    ).toEqual({ workspacePath: BOOTSTRAP_FOLDER });
  });

  it("tabStore 无 active workspace（Root 未挂载）：回退 App 层 key，identity 缺省", () => {
    const empty: TabStoreTargetState = {
      tabs: [],
      activeTabId: null,
      activeWorkspacePath: null,
      activeWorkspaceIdentity: null,
    };
    expect(
      resolveComposerInsertTarget(empty, BOOTSTRAP_FOLDER, [BOOTSTRAP_FOLDER]),
    ).toEqual({ workspacePath: BOOTSTRAP_FOLDER });
  });

  it("分叉现场（本 bug）：active 页签是另一本地工作区 → 落点跟随页签而非 App 层 key", () => {
    const diverged: TabStoreTargetState = {
      tabs: [
        workspaceTab("t1", BOOTSTRAP_FOLDER),
        workspaceTab("t2", "/Volumes/date/download/zcode-patcher"),
      ],
      activeTabId: "t2",
      activeWorkspacePath: "/Volumes/date/download/zcode-patcher",
      activeWorkspaceIdentity: null,
    };
    expect(
      resolveComposerInsertTarget(diverged, BOOTSTRAP_FOLDER, [BOOTSTRAP_FOLDER]),
    ).toEqual({ workspacePath: "/Volumes/date/download/zcode-patcher" });
  });

  it("settings 页签覆盖 active：落点回退被覆盖的 workspace 页签", () => {
    const settingsOverWorkspace: TabStoreTargetState = {
      tabs: [
        workspaceTab("t1", BOOTSTRAP_FOLDER),
        { id: "__settings__", kind: "settings", label: "settings" },
      ],
      activeTabId: "__settings__",
      // tabStore 在 settings 覆盖期仍保留 workspace 回退值（Root 同口径）
      activeWorkspacePath: BOOTSTRAP_FOLDER,
      activeWorkspaceIdentity: null,
    };
    expect(
      resolveComposerInsertTarget(settingsOverWorkspace, BOOTSTRAP_FOLDER, [
        BOOTSTRAP_FOLDER,
      ]),
    ).toEqual({ workspacePath: BOOTSTRAP_FOLDER });
  });

  it("active 页签带 workspaceIdentity：identity 随落点透传（store key = identity||path）", () => {
    const identityTab: TabStoreTargetState = {
      tabs: [
        workspaceTab("t1", "/remote/ws", { workspaceIdentity: "identity-remote" }),
      ],
      activeTabId: "t1",
      activeWorkspacePath: "/remote/ws",
      activeWorkspaceIdentity: "identity-remote",
    };
    expect(resolveComposerInsertTarget(identityTab, BOOTSTRAP_FOLDER, [BOOTSTRAP_FOLDER])).toEqual({
      workspacePath: "/remote/ws",
      workspaceIdentity: "identity-remote",
    });
  });

  it("identity 仅含空白时视为缺省（不透传空串 identity）", () => {
    const blankIdentity: TabStoreTargetState = {
      tabs: [workspaceTab("t1", BOOTSTRAP_FOLDER, { workspaceIdentity: "  " })],
      activeTabId: "t1",
      activeWorkspacePath: BOOTSTRAP_FOLDER,
      activeWorkspaceIdentity: "  ",
    };
    expect(
      resolveComposerInsertTarget(blankIdentity, BOOTSTRAP_FOLDER, [BOOTSTRAP_FOLDER]),
    ).toEqual({ workspacePath: BOOTSTRAP_FOLDER });
  });
});

describe("fallbackInsertTarget（App 层兜底口径保持原行为）", () => {
  it("聚焦 folder 在 folders 里 → 原样", () => {
    expect(fallbackInsertTarget("/w/a", ["/w/a", "/w/b"])).toBe("/w/a");
  });
  it("聚焦 folder 不在 folders → 首个 folder", () => {
    expect(fallbackInsertTarget("/elsewhere", ["/w/a", "/w/b"])).toBe("/w/a");
  });
  it("无 folders → 聚焦 folder 兜底", () => {
    expect(fallbackInsertTarget("/w/a", [])).toBe("/w/a");
  });
});
