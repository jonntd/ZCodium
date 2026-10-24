import { TID_V4_TIMELINE, TID_V4_TIMELINE_WORKING } from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

// WPK01：运行中胶囊吸顶 + 离屏贴底兜底（docs/spec/assistant-working-status-pill.md
// 「胶囊吸顶 / 离屏兜底」）。按 2026-10-17 吸顶契约的断言写法：以胶囊实际可见性分支，
// 不再假设「上滚 600px 后胶囊必在视口外」。
//
// 场景（controlled-stream，两轮长正文，复用 live-tail 的 prompt 标记）：
//   1. 跟随态：第二轮流式增长把胶囊顶出自然位 → 胶囊吸在滚动容器可视区顶部（±1px）；
//   2. 本轮内离底（wheel 240px）：胶囊仍可见 → 兜底 chip 必须缺席（吸顶已覆盖，
//      不重复渲染同义状态控件）；
//   3. 滚到顶（跨过第一轮长正文）：本轮整体离开视口 → 胶囊不可见，dock 上方出现
//      「工作中」兜底 chip，与「回到底部」并排共存；点击 chip 恢复跟随并贴底，chip 消失；
//   4. 终态：胶囊回归纯文本，chip 不残留，跟随不破坏。
//
// 转正流程见 .agents/skills/e2e-case-lifecycle：本文件在 manual-review/pending 期间
// 须以 ZCODE_E2E_MANUAL_REVIEW=1 实跑取证，人工审核确认后走 e2e:promote。

interface WorkingPillLayoutState {
  backToBottomVisible: boolean;
  bottomGap: number;
  chipExists: boolean;
  chipVisible: boolean;
  containerTop: number;
  following: boolean;
  hasLiveTail: boolean;
  pillExists: boolean;
  pillVisible: boolean;
  pillTop: number | null;
  scrollTop: number;
  stickyTopGap: number | null;
}

const STICKY_TOP_EPSILON_PX = 1;

async function readWorkingPillState(): Promise<WorkingPillLayoutState | null> {
  return browser.execute(
    (timelineTestId, chipTestId) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      if (!timeline) return null;
      const timelineRect = timeline.getBoundingClientRect();
      const pill = timeline.querySelector<HTMLElement>('[data-zcode-working-pill="true"]');
      const pillRect = pill?.getBoundingClientRect();
      // 吸顶类挂在状态行外层 div（sticky top-0）；胶囊贴顶以该行与容器可视区顶的差度量。
      let stickyRow: HTMLElement | null = pill ?? null;
      while (stickyRow && stickyRow !== timeline) {
        if (window.getComputedStyle(stickyRow).position === "sticky") break;
        stickyRow = stickyRow.parentElement;
      }
      const stickyRect =
        stickyRow && stickyRow !== timeline ? stickyRow.getBoundingClientRect() : null;
      const chip = document.querySelector<HTMLElement>(`[data-testid="${chipTestId}"]`);
      const chipRect = chip?.getBoundingClientRect();
      return {
        backToBottomVisible: Boolean(
          document.querySelector('[data-testid="v4-timeline-bottom"]'),
        ),
        bottomGap: Math.max(0, timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop),
        chipExists: chip !== null,
        chipVisible: Boolean(
          chip &&
          chipRect &&
          chipRect.width > 0 &&
          chipRect.height > 0 &&
          window.getComputedStyle(chip).display !== "none" &&
          window.getComputedStyle(chip).visibility !== "hidden",
        ),
        containerTop: timelineRect.top,
        following: timeline.dataset.following === "true",
        hasLiveTail: Boolean(document.querySelector('[data-v4-running-live-tail="true"]')),
        pillExists: pill !== null,
        pillTop: pillRect?.top ?? null,
        pillVisible: Boolean(
          pill &&
          pillRect &&
          pillRect.width > 0 &&
          pillRect.height > 0 &&
          pillRect.bottom > timelineRect.top &&
          pillRect.top < timelineRect.bottom,
        ),
        scrollTop: timeline.scrollTop,
        stickyTopGap: stickyRect ? stickyRect.top - timelineRect.top : null,
      };
    },
    TID_V4_TIMELINE,
    TID_V4_TIMELINE_WORKING,
  );
}

function assertState(
  label: string,
  state: WorkingPillLayoutState | null,
  expectations: Array<[keyof WorkingPillLayoutState, unknown]>,
): void {
  if (!state) throw new Error(`${label}: 无法读取 timeline 状态`);
  const mismatches = expectations
    .filter(([key]) => state[key] !== expectations.find(([k]) => k === key)?.[1])
    .map(([key, expected]) => `${key}: expected=${String(expected)} actual=${String(state[key])}`);
  if (mismatches.length > 0) {
    throw new Error(`${label} 断言未通过 [${mismatches.join("; ")}]: ${JSON.stringify(state)}`);
  }
}

/** 真实用户上滚：先给 wheel 意图（timeline 的滚动权判定只看真实输入），再落 scrollTop。 */
async function wheelUpBy(px: number): Promise<void> {
  await browser.execute(
    (timelineTestId, delta) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      if (!timeline) throw new Error("找不到 v4 timeline");
      timeline.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -delta }),
      );
      timeline.scrollTop = Math.max(0, timeline.scrollTop - delta);
      timeline.dispatchEvent(new Event("scroll"));
    },
    TID_V4_TIMELINE,
    px,
  );
}

describe("WPK01 运行中胶囊吸顶与离屏贴底兜底", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("吸顶恒可见、本轮离屏出兜底 chip、点击回贴底、终态收口", async function () {
    this.timeout(260000);

    await prepareV4ConversationE2E();
    // 第一轮：制造超过一屏的完成态长历史，为「本轮整体滚出视口」提供前置内容。
    await sendV4Prompt(
      "E2E_CHAT_LOADING_REAL_LINES FOLLOWING 请输出足够长的完整说明文字，不要只依赖换行数量",
    );
    await waitForV4TimelineContaining("CHAT_LOADING_LINE_36", 45000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "第一轮流式回复结束后会话没有回到 idle",
      30000,
    );

    // 第二轮：running 轮 + 可离底溢出。
    await sendV4Prompt(
      "E2E_CHAT_LOADING_REAL_LINES DETACHED 请继续输出足够长的完整说明文字，确保自然换行后仍然超过一屏",
    );
    await browser.waitUntil(
      async () => {
        const state = await readWorkingPillState();
        return Boolean(
          state && state.hasLiveTail && state.bottomGap <= 48 && state.following,
        );
      },
      {
        timeout: 45000,
        interval: 100,
        timeoutMsg: "第二轮 running live tail 出现后 timeline 没有进入跟随贴底态",
      },
    );

    // 1. 跟随态吸顶：工作行持续增长会把胶囊顶出自然位，吸顶必须把它钉在容器可视区顶部。
    //    贴底时「回到底部」不出现，兜底 chip 也不允许出现。
    await browser.waitUntil(
      async () => {
        const state = await readWorkingPillState();
        return Boolean(
          state &&
          state.pillVisible &&
          state.stickyTopGap !== null &&
          Math.abs(state.stickyTopGap) <= STICKY_TOP_EPSILON_PX,
        );
      },
      {
        timeout: 45000,
        interval: 200,
        timeoutMsg: "跟随态下胶囊没有被吸顶钉在滚动容器可视区顶部（±1px）",
      },
    );
    const pinnedWhileFollowing = await readWorkingPillState();
    assertState("跟随态吸顶", pinnedWhileFollowing, [
      ["following", true],
      ["pillExists", true],
      ["pillVisible", true],
      ["chipExists", false],
      ["backToBottomVisible", false],
    ]);

    // 2. 本轮内离底（240px）：胶囊仍在视口内（吸顶覆盖）→ 不得出现第二个同义状态控件。
    await wheelUpBy(240);
    await browser.waitUntil(
      async () => {
        const state = await readWorkingPillState();
        return Boolean(state && !state.following && state.bottomGap > 48);
      },
      {
        timeout: 5000,
        interval: 50,
        timeoutMsg: "本轮内 wheel 240px 后 timeline 没有进入 detached",
      },
    );
    const withinTurnDetached = await readWorkingPillState();
    assertState("本轮内离底", withinTurnDetached, [
      ["following", false],
      ["pillVisible", true],
      ["chipExists", false],
      ["backToBottomVisible", true],
    ]);

    // 3. 滚到顶：跨过第一轮长正文，本轮（含胶囊）整体离开视口 → 兜底 chip 出现，
    //    与「回到底部」并排共存。
    await browser.execute((timelineTestId) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      if (!timeline) throw new Error("找不到 v4 timeline");
      timeline.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: -timeline.scrollTop,
        }),
      );
      timeline.scrollTop = 0;
      timeline.dispatchEvent(new Event("scroll"));
    }, TID_V4_TIMELINE);
    await browser.waitUntil(
      async () => {
        const state = await readWorkingPillState();
        return Boolean(state && !state.following && state.chipExists && state.chipVisible);
      },
      {
        timeout: 8000,
        interval: 100,
        timeoutMsg: "本轮整体滚出视口后 dock 上方没有出现「工作中」兜底 chip",
      },
    );
    const offscreen = await readWorkingPillState();
    if (offscreen && offscreen.pillVisible) {
      // 布置失败（第一轮历史不足一屏，本轮没被顶出视口），如实报状态而不是误判产品缺陷。
      throw new Error(
        `WPK01 场景布置失败：滚到顶后胶囊仍在视口内（第一轮历史不足以把本轮顶出视口）: ${JSON.stringify(offscreen)}`,
      );
    }
    assertState("本轮离屏兜底", offscreen, [
      ["following", false],
      ["chipExists", true],
      ["chipVisible", true],
      ["backToBottomVisible", true],
      ["hasLiveTail", true],
    ]);

    // 4. 点击 chip = 回到贴底（与「回到底部」同义，不新增第三种滚动语义），chip 随贴底消失。
    await browser.execute((chipTestId) => {
      const chip = document.querySelector<HTMLElement>(`[data-testid="${chipTestId}"]`);
      if (!chip) throw new Error("贴底状态兜底 chip 不存在");
      chip.click();
    }, TID_V4_TIMELINE_WORKING);
    await browser.waitUntil(
      async () => {
        const state = await readWorkingPillState();
        return Boolean(state && state.following && state.bottomGap <= 48 && !state.chipExists);
      },
      {
        timeout: 10000,
        interval: 50,
        timeoutMsg: "点击兜底 chip 后没有恢复跟随并贴底、chip 没有消失",
      },
    );

    // 5. 终态：胶囊回归纯文本，兜底 chip 不残留，跟随不被破坏。
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "第二轮流式回复结束后会话没有回到 idle",
      30000,
    );
    await browser.waitUntil(
      async () => {
        const state = await readWorkingPillState();
        return Boolean(state && !state.hasLiveTail);
      },
      {
        timeout: 15000,
        interval: 100,
        timeoutMsg: "终态后 live tail 未消失",
      },
    );
    const terminal = await readWorkingPillState();
    if (!terminal) throw new Error("终态收口: 无法读取 timeline 状态");
    assertState("终态收口", terminal, [
      ["pillExists", false],
      ["chipExists", false],
      ["following", true],
    ]);
    if (terminal.bottomGap > 48) {
      throw new Error(`WPK01 终态贴底被破坏: ${JSON.stringify(terminal)}`);
    }
  });
});
