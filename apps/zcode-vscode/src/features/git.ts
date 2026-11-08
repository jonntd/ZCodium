import * as vscode from "vscode";
import type { OneShotTextOptions } from "./oneShotText";
import type { PendingContext } from "./contextCollector";
import { log } from "./logger";

interface GitInputBox {
  value: string;
}

interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: GitInputBox;
  diff(cached: boolean): Promise<string>;
  state: { HEAD?: { name?: string }; workingTreeChanges?: unknown[]; indexChanges?: unknown[] };
}

interface GitAPI {
  repositories: GitRepository[];
}

const MAX_DIFF_CHARS = 24_000;

/** 懒激活内置 Git 扩展，避免在没装 Git 的环境里拖慢启动。 */
async function ensureGitApi(): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitAPI }>("vscode.git");
  if (!extension) return undefined;
  if (!extension.isActive) await extension.activate();
  return extension.exports?.getAPI(1);
}

async function readDiff(repo: GitRepository): Promise<{ diff: string; staged: boolean }> {
  const staged = await repo.diff(true);
  if (staged.trim()) return { diff: staged, staged: true };
  const unstaged = await repo.diff(false);
  return { diff: unstaged, staged: false };
}

/**
 * 用当前改动生成提交信息，并写进 SCM 输入框。
 *
 * 走 `workspace/generateText`（无工具、无会话回合），与桌面端「生成提交信息」同一能力。
 */
export async function generateCommitMessage(
  generateText: (prompt: string, options?: OneShotTextOptions) => Promise<string>,
): Promise<void> {
  const api = await ensureGitApi();
  const repo = api?.repositories[0];
  if (!repo) {
    void vscode.window.showWarningMessage("没有可用的 Git 仓库。");
    return;
  }

  const { diff, staged } = await readDiff(repo);
  if (!diff.trim()) {
    void vscode.window.showInformationMessage("当前没有可提交的改动。");
    return;
  }

  const truncated = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…（已截断）` : diff;
  const prompt = [
    "根据下面的 git diff 生成一条提交信息。",
    "要求：",
    "1. 使用 Conventional Commits 前缀（feat/fix/refactor/docs/test/chore）；",
    "2. 标题一行不超过 72 个字符，说明「做了什么」，不要复述 diff；",
    "3. 如有必要，空一行后补 1–3 条要点，解释「为什么」；",
    "4. 只输出提交信息本身，不要代码围栏、不要额外解释。",
    "",
    `（改动来源：${staged ? "已暂存" : "工作区"}）`,
    truncated,
  ].join("\n");

  let message: string;
  try {
    message = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: "Gode 正在生成提交信息…" },
      () => generateText(prompt, { maxOutputTokens: 1024 }),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("git", detail);
    void vscode.window.showErrorMessage(`生成提交信息失败：${detail}`);
    return;
  }

  const cleaned = stripFence(message).trim();
  if (!cleaned) {
    void vscode.window.showWarningMessage("模型没有返回可用的提交信息。");
    return;
  }
  repo.inputBox.value = cleaned;
  void vscode.commands.executeCommand("workbench.view.scm");
  void vscode.window.setStatusBarMessage("Gode：提交信息已填入 SCM 输入框", 4000);
}

/** 把当前改动作为上下文发到对话，用于「审阅这次改动」。 */
export async function reviewChanges(
  submit: (instruction: string, context: readonly PendingContext[]) => Promise<void>,
): Promise<void> {
  const api = await ensureGitApi();
  const repo = api?.repositories[0];
  if (!repo) {
    void vscode.window.showWarningMessage("没有可用的 Git 仓库。");
    return;
  }

  const { diff, staged } = await readDiff(repo);
  if (!diff.trim()) {
    void vscode.window.showInformationMessage("当前没有可审阅的改动。");
    return;
  }

  const truncated = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…（已截断）` : diff;
  const context: PendingContext = {
    chip: { id: `git-diff-${Date.now()}`, label: `git diff（${staged ? "已暂存" : "工作区"}）` },
    text: `<git-diff source="${staged ? "staged" : "working-tree"}">\n${truncated}\n</git-diff>`,
  };

  await submit(
    [
      "请审阅上面的改动，像做 code review 一样：",
      "1. 指出真正的缺陷或风险（不要罗列风格偏好）；",
      "2. 说明触发条件与影响范围；",
      "3. 如果需要改，直接修改文件，并说明改了什么。",
    ].join("\n"),
    [context],
  );
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}
