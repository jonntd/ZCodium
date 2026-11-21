/**
 * sendTerminalSelection（终端选区送入对话）单测。
 *
 * 核心行为面：
 * 1. 无活动终端 → 明确提示，不走剪贴板链路；
 * 2. 有选区 → copySelection → 读剪贴板 → **恢复用户原剪贴板**（无残留副作用）→
 *    submit 收到 terminal-output 块 + 行数 chip；
 * 3. 空选区 → 提示且剪贴板恢复仍发生。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const { executeCommand, clipboard, showInformationMessage } = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  clipboard: { readText: vi.fn(), writeText: vi.fn() },
  showInformationMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    activeTerminal: undefined,
    showInformationMessage,
  },
  env: { clipboard },
  commands: { executeCommand },
}));

import { sendTerminalSelection } from "../src/features/terminal";

/** mock 模块的 window 可写句柄（activeTerminal 在用例间切换）。 */
function windowMock(): { activeTerminal: unknown } {
  return vscode.window as unknown as { activeTerminal: unknown };
}

describe("sendTerminalSelection：终端选区 → 对话上下文", () => {
  beforeEach(() => {
    windowMock().activeTerminal = undefined;
    executeCommand.mockClear();
    clipboard.readText.mockReset();
    clipboard.writeText.mockReset();
    showInformationMessage.mockClear();
  });

  it("无活动终端：提示且不执行 copySelection", async () => {
    await sendTerminalSelection(vi.fn());

    expect(showInformationMessage).toHaveBeenCalledWith(
      "先聚焦一个终端，并选中要发送的内容。",
    );
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("有选区：submit 收到 terminal-output 块与行数 chip，剪贴板先存后恢复", async () => {
    windowMock().activeTerminal = { name: "zsh" };
    clipboard.readText
      .mockResolvedValueOnce("保存的原剪贴板内容") // 第 1 次：备份
      .mockResolvedValueOnce("  Error: boom\n  at main.ts:1  \n"); // 第 2 次：copySelection 结果
    const submit = vi.fn().mockResolvedValue(undefined);

    await sendTerminalSelection(submit);

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.terminal.copySelection");
    // 恢复用户原剪贴板：发送完不留副作用
    expect(clipboard.writeText).toHaveBeenCalledWith("保存的原剪贴板内容");
    expect(submit).toHaveBeenCalledTimes(1);
    const [instruction, context] = submit.mock.calls[0] as [string, readonly unknown[]];
    expect(instruction).toContain("请定位根因");
    const block = context[0] as { chip: { label: string }; text: string };
    expect(block.chip.label).toBe("终端输出 2 行");
    // 选区 trim 后进 <terminal-output> 块
    expect(block.text).toBe("<terminal-output>\nError: boom\n  at main.ts:1\n</terminal-output>");
  });

  it("空选区：提示且剪贴板恢复仍发生（不吞副作用）", async () => {
    windowMock().activeTerminal = { name: "zsh" };
    clipboard.readText
      .mockResolvedValueOnce("原内容")
      .mockResolvedValueOnce("   ");
    const submit = vi.fn();

    await sendTerminalSelection(submit);

    expect(showInformationMessage).toHaveBeenCalledWith("终端里没有选中内容。");
    expect(submit).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith("原内容");
  });

  it("剪贴板读失败：备份回退空串，链路不崩", async () => {
    windowMock().activeTerminal = { name: "zsh" };
    clipboard.readText
      .mockRejectedValueOnce(new Error("clipboard locked"))
      .mockResolvedValueOnce("报错文本");
    const submit = vi.fn().mockResolvedValue(undefined);

    await sendTerminalSelection(submit);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith("");
  });

  // 回归（审查 medium）：内核 copySelection 在终端无选区时**不写剪贴板**（只弹警告），
  // 此后读回的正是用户原有剪贴板内容——旧内容被包装成 <terminal-output> 发送，
  // 「终端里没有选中内容」防护分支永不触发。修复后以哨兵探测判定复制是否发生。
  it("终端无选区（内核不写剪贴板）：不把旧剪贴板内容当终端输出发送", async () => {
    windowMock().activeTerminal = { name: "zsh" };
    let lastWrite: string | undefined;
    clipboard.writeText.mockImplementation((value: string) => {
      lastWrite = value;
      return Promise.resolve();
    });
    // 第 1 次读 = 备份用户原内容；之后读回 = 最后写入（哨兵仍在 ⇒ 内核没有复制）
    clipboard.readText
      .mockResolvedValueOnce("用户之前复制的内容")
      .mockImplementation(() => Promise.resolve(lastWrite ?? ""));
    const submit = vi.fn();

    await sendTerminalSelection(submit);

    expect(showInformationMessage).toHaveBeenCalledWith("终端里没有选中内容。");
    expect(submit).not.toHaveBeenCalled();
    // 用户原剪贴板内容恢复（不留哨兵/选区残留）
    expect(clipboard.writeText).toHaveBeenCalledWith("用户之前复制的内容");
  });

  // 哨兵探测不误伤：用户剪贴板恰好等于选中文本时仍能正确发送。
  it("剪贴板内容恰好等于选中文本：仍按有选区发送", async () => {
    windowMock().activeTerminal = { name: "zsh" };
    clipboard.readText
      .mockResolvedValueOnce("Error: boom") // 备份（恰好等于选区）
      .mockResolvedValueOnce("Error: boom"); // copySelection 后读回
    const submit = vi.fn().mockResolvedValue(undefined);

    await sendTerminalSelection(submit);

    expect(submit).toHaveBeenCalledTimes(1);
  });
});
