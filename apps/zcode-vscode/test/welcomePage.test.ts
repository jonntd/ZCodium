/**
 * T13：onboarding 引导面（P1-10.2 / P1-10.3）。
 *
 * - 3 步上手卡内容模型与引导态投影（CLI 未找到 → 安装引导 + 「重新检测」项）；
 * - capabilities 降级说明成文进引导面（P1-10.3，文案源复用 webview 侧
 *   CAPABILITY_UNSUPPORTED_HINT，杜绝两处标注漂移）；
 * - Claude 导入入口引用组4 面板（import-claude-sessions 词 + code.importClaudeSessions
 *   命令面，不改组4 文件）；
 * - WelcomePage 呈现器端口分发（纯层，vscode 端口注入 fake）。
 *
 * 纯层测试：src/ui/welcomePage.ts 不 import vscode，vitest 直测。
 */

import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_DEGRADATION_NOTES,
  CLI_MISSING_ACTIONS,
  CLI_NOT_FOUND_GUIDANCE,
  CLI_NOT_FOUND_LOG,
  CLAUDE_IMPORT_ENTRY,
  ONBOARDING_DOCS,
  ONBOARDING_STEPS,
  WELCOME_CARD_ACTIONS,
  WelcomePage,
  projectOnboardingState,
  type WelcomePagePorts,
} from "../src/ui/welcomePage";
import { CAPABILITY_UNSUPPORTED_HINT } from "../src/webview-react/capabilities";

// ── 内容模型 ──

describe("3 步上手卡（P1-10.2）", () => {
  it("恰好 3 步，id/标题/说明齐全且有序", () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual(["install", "chat", "configure"]);
    for (const step of ONBOARDING_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it("第 1 步指向 CLI 安装（cliPath / app-server 事实），第 3 步指向配置与导入", () => {
    expect(ONBOARDING_STEPS[0]!.detail).toContain("code.cliPath");
    expect(ONBOARDING_STEPS[0]!.detail).toContain("app-server --stdio");
    expect(ONBOARDING_STEPS[2]!.detail).toContain("allowlist");
    expect(ONBOARDING_STEPS[2]!.detail).toContain("~/.claude/projects");
  });
});

// ── 引导态投影 ──

describe("projectOnboardingState（CLI 探测结果 → 引导态）", () => {
  it("CLI 就绪：无安装引导，卡面不含重新检测项", () => {
    const state = projectOnboardingState({ cli: { path: "/usr/local/bin/zcodium", version: "1.2.3" } });
    expect(state.cliMissing).toBe(false);
    expect(state.cliGuidance).toBeNull();
    expect(state.card.some((item) => item.action === WELCOME_CARD_ACTIONS.recheckCli)).toBe(false);
  });

  it("CLI 未找到：安装引导提及 cliPath 与重新检测，卡面追加重新检测项", () => {
    const state = projectOnboardingState({ cli: null });
    expect(state.cliMissing).toBe(true);
    expect(state.cliGuidance).toBe(CLI_NOT_FOUND_GUIDANCE);
    expect(state.cliGuidance).toContain("code.cliPath");
    expect(state.cliGuidance).toContain("重新检测");
    const recheck = state.card.find((item) => item.action === WELCOME_CARD_ACTIONS.recheckCli);
    expect(recheck?.label).toContain("重新检测");
  });

  it("卡面恒为 3 步说明项在前 + Claude 导入入口项在后", () => {
    for (const cli of [null, { path: "/x/zcodium" }]) {
      const state = projectOnboardingState({ cli });
      expect(state.card.slice(0, 3).map((item) => item.action)).toEqual([
        "step-install",
        "step-chat",
        "step-configure",
      ]);
      expect(state.card.at(-1)?.action).toBe(WELCOME_CARD_ACTIONS.openClaudeImport);
    }
  });

  it("非桌面（isDesktop=false）：导入入口标注不可用而非隐藏", () => {
    const state = projectOnboardingState({ cli: null, isDesktop: false });
    expect(state.claudeImport.supported).toBe(false);
    const importItem = state.card.at(-1);
    expect(importItem?.detail).toContain("仅桌面");
    expect(importItem?.action).toBe(WELCOME_CARD_ACTIONS.openClaudeImport);
  });
});

// ── Claude 导入入口（组4 面板引用）与文档引用 ──

describe("引导面引用事实（不改被引用文件）", () => {
  it("Claude 导入入口对齐组4 面板 open-panel 词与命令面", () => {
    expect(CLAUDE_IMPORT_ENTRY.panel).toBe("import-claude-sessions");
    expect(CLAUDE_IMPORT_ENTRY.commandId).toBe("code.importClaudeSessions");
    expect(CLAUDE_IMPORT_ENTRY.note).toContain("原文件不删除");
  });

  it("文档引用覆盖 contract-check（桥 wire / shared 锁定 / v4 消费清单）", () => {
    const paths = ONBOARDING_DOCS.map((doc) => doc.path);
    expect(paths).toContain("docs/contract-check.md");
    expect(paths).toContain("src/CONTRACT.md");
  });
});

// ── capabilities 降级说明（P1-10.3） ──

describe("CAPABILITY_DEGRADATION_NOTES（成文进引导面）", () => {
  it("投影携带降级说明，且文案源与 webview 侧「当前 CLI 版本不支持」一致", () => {
    const state = projectOnboardingState({ cli: null });
    expect(state.degradationNotes).toBe(CAPABILITY_DEGRADATION_NOTES);
    expect(state.degradationNotes.join("\n")).toContain(CAPABILITY_UNSUPPORTED_HINT);
  });

  it("覆盖四类降级口径：capabilities 缺失 / base64 退化 / 重建会话生效 / 桌面门", () => {
    const joined = CAPABILITY_DEGRADATION_NOTES.join("\n");
    expect(joined).toContain("hello.capabilities");
    expect(joined).toContain("base64 文本帧");
    expect(joined).toContain("重建会话生效");
    expect(joined).toContain("仅在桌面环境可用");
    expect(joined).toContain("请升级 CLI");
  });
});

// ── CLI 引导对接（container.ts [cli] 诊断日志语义） ──

describe("CLI 引导与既有诊断语义对接", () => {
  it("CLI_NOT_FOUND_LOG 与 container.ts 检测分支的同源行一字不差", () => {
    expect(CLI_NOT_FOUND_LOG).toBe(
      "[cli] 未找到 zcodium CLI：侧栏将呈现引导（安装后点击「重新检测」或执行 ZCodium: 重启 Agent）",
    );
  });

  it("信息条动作按钮固定三项：重新检测 / 3 步上手 / 查看日志", () => {
    expect([...CLI_MISSING_ACTIONS]).toEqual(["重新检测", "3 步上手", "查看日志"]);
  });
});

// ── 呈现器端口分发 ──

function fakePorts(): {
  ports: WelcomePagePorts;
  calls: {
    logs: string[];
    informations: Array<{ message: string; actions: readonly string[] }>;
    cards: Array<readonly { label: string; action: string }[]>;
    revealChat: number;
    revealImport: number;
    showLogs: number;
    recheck: number;
  };
  state: { nextInformation?: string; nextCard?: string; recheckResult: boolean };
} {
  const calls = {
    logs: [] as string[],
    informations: [] as Array<{ message: string; actions: readonly string[] }>,
    cards: [] as Array<readonly { label: string; action: string }[]>,
    revealChat: 0,
    revealImport: 0,
    showLogs: 0,
    recheck: 0,
  };
  // 端口闭包共享同一份可变态（showInformation/showCard 读取返回值）。
  const state: { nextInformation?: string; nextCard?: string; recheckResult: boolean } = {
    recheckResult: false,
  };
  return {
    calls,
    state,
    ports: {
      log: (message) => calls.logs.push(message),
      showInformation: async (message, actions) => {
        calls.informations.push({ message, actions });
        return state.nextInformation;
      },
      showCard: async (items) => {
        calls.cards.push(items.map((item) => ({ label: item.label, action: item.action })));
        return state.nextCard;
      },
      revealChat: () => {
        calls.revealChat += 1;
      },
      revealClaudeImportPanel: () => {
        calls.revealImport += 1;
      },
      showLogs: () => {
        calls.showLogs += 1;
      },
      recheckCli: async () => {
        calls.recheck += 1;
        return state.recheckResult;
      },
    },
  };
}

describe("WelcomePage 呈现器（端口注入）", () => {
  it("presentCliMissing：呈现安装引导；选「重新检测」→ 重跑探测并记录诊断", async () => {
    const ports = fakePorts();
    ports.state.nextInformation = CLI_MISSING_ACTIONS[0];
    ports.state.recheckResult = true;
    const page = new WelcomePage(ports.ports);
    await page.presentCliMissing();
    expect(ports.calls.informations).toHaveLength(1);
    expect(ports.calls.informations[0]!.message).toBe(CLI_NOT_FOUND_GUIDANCE);
    expect([...ports.calls.informations[0]!.actions]).toEqual([...CLI_MISSING_ACTIONS]);
    expect(ports.calls.recheck).toBe(1);
    expect(ports.calls.logs[0]).toContain("[cli] 重新检测：已找到");
  });

  it("presentCliMissing：选「3 步上手」→ 呈现卡面；选「查看日志」→ 打开诊断", async () => {
    const ports = fakePorts();
    ports.state.nextInformation = CLI_MISSING_ACTIONS[1];
    const page = new WelcomePage(ports.ports);
    await page.presentCliMissing();
    expect(ports.calls.cards).toHaveLength(1);
    expect(ports.calls.cards[0]![0]!.action).toBe("step-install");

    const ports2 = fakePorts();
    ports2.state.nextInformation = CLI_MISSING_ACTIONS[2];
    await new WelcomePage(ports2.ports).presentCliMissing();
    expect(ports2.calls.showLogs).toBe(1);
  });

  it("presentCliMissing：未选择动作 → 不触发任何副作用", async () => {
    const ports = fakePorts();
    ports.state.nextInformation = undefined;
    await new WelcomePage(ports.ports).presentCliMissing();
    expect(ports.calls.recheck).toBe(0);
    expect(ports.calls.cards).toHaveLength(0);
    expect(ports.calls.showLogs).toBe(0);
  });

  it("presentOnboarding：先显出侧栏再呈现卡面；选导入项 → open-panel 入口；选重新检测 → 探测", async () => {
    const ports = fakePorts();
    ports.state.nextCard = WELCOME_CARD_ACTIONS.openClaudeImport;
    await new WelcomePage(ports.ports).presentOnboarding({ cli: null });
    expect(ports.calls.revealChat).toBe(1);
    expect(ports.calls.cards).toHaveLength(1);
    expect(ports.calls.revealImport).toBe(1);

    const ports2 = fakePorts();
    ports2.state.nextCard = WELCOME_CARD_ACTIONS.recheckCli;
    ports2.state.recheckResult = false;
    await new WelcomePage(ports2.ports).presentOnboarding({ cli: null });
    expect(ports2.calls.recheck).toBe(1);
    expect(ports2.calls.logs[0]).toContain("[cli] 重新检测：仍未找到");
  });

  it("CLI 就绪的卡面选导入项仍可达（onboarding 不以 CLI 缺失为前提）", async () => {
    const ports = fakePorts();
    ports.state.nextCard = WELCOME_CARD_ACTIONS.openClaudeImport;
    await new WelcomePage(ports.ports).presentOnboarding({ cli: { path: "/usr/local/bin/zcodium" } });
    expect(
      ports.calls.cards[0]!.some((item) => item.action === WELCOME_CARD_ACTIONS.recheckCli),
    ).toBe(false);
    expect(ports.calls.revealImport).toBe(1);
  });
});

// ── recheck 诊断行（对接 [cli] 日志语义的回归锁定） ──

describe("recheck 诊断行", () => {
  it("找到 / 未找到两态都有 [cli] 前缀行且可读", async () => {
    const found = fakePorts();
    found.state.recheckResult = true;
    await new WelcomePage(found.ports).recheck();
    expect(found.calls.logs).toEqual([
      "[cli] 重新检测：已找到 zcodium CLI，Agent 运行时已重置（下次对话重拉）",
    ]);

    const missing = fakePorts();
    missing.state.recheckResult = false;
    await new WelcomePage(missing.ports).recheck();
    expect(missing.calls.logs).toEqual([
      "[cli] 重新检测：仍未找到 zcodium CLI（检查 PATH 或设置 code.cliPath）",
    ]);
  });
});
