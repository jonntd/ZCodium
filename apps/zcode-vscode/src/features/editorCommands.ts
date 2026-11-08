/**
 * 编辑器原生功能命令注册（M1 移植自 zcodium-vscode features/commands.ts）。
 *
 * 与源实现的差异只在两个落点：
 * - `submit/addContext`：源实现经 ChatViewProvider（自有 webview chat）；本插件聊天面是
 *   V4ChatPane，host → webview 走 `composer-insert` host 帧（webview 侧
 *   requestComposerTextInsert 预填 composer，与诊断注入 P1-5 同一通道）；
 * - `openSession`：`session-switch` host 帧（index.tsx 重绑 sessionId → V4ChatPane resume）。
 *
 * `generateText` 为进程内直调（oneShotText.ts）；Quick Edit / 生成提交信息 / 审阅改动 /
 * 终端送入 / Code Action 的业务语义逐字保留。
 */

import * as vscode from "vscode";
import {
  contextFromActiveFile,
  contextFromDiagnostics,
  contextFromSelection,
} from "./contextCollector";
import { contextFromRange, type PendingContext } from "./contextCollector";
import { runDiagnosticsFix } from "./codeActions";
import { runQuickEdit, type QuickEditContentProvider } from "./quickEdit";
import { generateCommitMessage, reviewChanges } from "./git";
import { sendTerminalSelection } from "./terminal";
import { pickSession } from "./history";
import { log, showLogs } from "./logger";
import type { OneShotTextOptions } from "./oneShotText";

export interface EditorCommandDependencies {
  /** 当前聚焦 folder（容器按活动工作区解析）。 */
  readonly getWorkspacePath: () => string;
  /** 活跃会话（无则草稿态；停止生成用）。 */
  readonly currentSessionId: () => string | null;
  /** 宿主帧推送（hostRuntime.pushHostFrame）。 */
  readonly pushFrame: (
    kind: "composer-insert" | "session-switch",
    payload: unknown,
  ) => void;
  readonly generateText: (
    prompt: string,
    options?: OneShotTextOptions,
  ) => Promise<string>;
  readonly quickEditProvider: QuickEditContentProvider;
  /**
   * 服务调用统一路由（PRD §8.5 单通道）：full 模式 → 共享 server 的 WS accessor；
   * pane 模式 → 进程内 ServiceCollection 结构化子集。插件自身在 full 模式下
   * 绝不 spawn agent（双实例会在 CLI 存储锁上互撞，实测 "transport is closed"）。
   */
  readonly runWithServices: <T>(
    run: (accessor: import("@zcode/services").IServiceAccessor) => Promise<T>,
  ) => Promise<T>;
  /**
   * 是否已有对话面（编辑器页签或侧栏视图）可承接 UI 帧。
   *
   * 用途：「历史会话」选中后**不再无条件 openChat**——`openChat` 在"没有编辑器
   * 页签"时会新建一个对话 TAB（与用户反馈的「点加号创建出一个 TAB」同一类：
   * 用户只想在眼前这一面切会话，却凭空多出一个窗口）。没有对话面时才需要打开。
   */
  readonly hasChatSurface: () => boolean;
}

const INSTRUCTIONS = {
  explain:
    "请解释这段代码：它解决什么问题、关键控制流是什么、有哪些隐含假设或风险。只做说明，不要修改文件。",
  fix: "这段代码有问题。请先定位根因，再直接修改文件修复；最后说明根因证据、改了什么、为什么这样改。",
  refactor:
    "请在不改变对外行为的前提下重构这段代码：减少重复、收敛状态、保持与周边代码风格一致。改完说明结构变化。",
  tests:
    "请为这段代码补测试。先确认仓库现有的测试框架与命名约定，再按同样的风格新增用例，覆盖正常路径与边界。",
} as const;

/** XML 上下文块 → 紧凑正文（composer 可读，模型同样可读；仅用于无 mention 的纯文本块）。 */
function compactContextText(item: PendingContext): string {
  const tagged =
    /^(<(\w+)[^>]*\spath="([^"]+)"[^>]*>)\n?([\s\S]*?)\n?(<\/\2>)$/.exec(
      item.text,
    );
  if (!tagged) return item.text;
  return `${tagged[3]}：\n${tagged[4]}`;
}

/** Code Action / 命令共用的对话入口（host 帧 → webview composer 预填）。 */
export function createCodeActionEntry(
  pushFrame: EditorCommandDependencies["pushFrame"],
): {
  submit: (
    instruction: string,
    context: readonly PendingContext[],
  ) => Promise<void>;
  addContext: (items: readonly PendingContext[]) => Promise<void>;
} {
  /**
   * Claude Code / Augment 口径：
   * - 上下文 = 结构化 mention pill（干净引用如 `client.js:9-10`），不把代码/诊断 XML
   *   塞进输入框；模型按引用自行读文件；
   * - 指令文本保持紧凑可读。
   */
  const submit = async (
    instruction: string,
    context: readonly PendingContext[],
  ): Promise<void> => {
    const mention = context.find((item) => item.mention)?.mention;
    const extraBlocks = context
      .filter((item) => !item.mention)
      .map((item) => compactContextText(item));
    const prefix = mention ? `${mention.markdown} ` : "";
    const text =
      extraBlocks.length > 0
        ? `${prefix}${instruction}\n\n${extraBlocks.join("\n\n")}`
        : `${prefix}${instruction}`;
    pushFrame(
      "composer-insert",
      mention ? { text, mention, mode: "replace" } : { text },
    );
    await vscode.commands.executeCommand("gode.openChat");
  };
  const addContext = async (
    items: readonly PendingContext[],
  ): Promise<void> => {
    const withMention = items.filter((item) => item.mention);
    if (withMention.length === 0) {
      // 兜底：无 mention 面（现有入口都带文件引用，理论不可达）→ 退回纯文本预填。
      pushFrame("composer-insert", {
        text: items.map((item) => item.text).join("\n"),
      });
      await vscode.commands.executeCommand("gode.openChat");
      return;
    }
    // 单帧批量（spec: composer-insert-delivery）：store 是单槽，N 帧连续 push 会互相
    // 覆盖只剩最后一个；mentions 数组由 composer 侧按序循环前置、按 id 去重。
    const mentions = withMention.flatMap((item) =>
      item.mention ? [item.mention] : [],
    );
    log.debug(
      "composer-insert",
      `addContext：${mentions.length} 条 mention（${mentions
        .map((mention) => mention.label)
        .join(", ")}）`,
    );
    pushFrame("composer-insert", {
      text: `${mentions.map((mention) => mention.markdown).join(" ")} `,
      mentions,
      mode: "prepend-if-missing",
    });
    await vscode.commands.executeCommand("gode.openChat");
  };
  return { submit, addContext };
}

export function registerEditorCommands(
  deps: EditorCommandDependencies,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const register = (
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    disposables.push(vscode.commands.registerCommand(id, handler));
  };

  const codeActionEntry = createCodeActionEntry(deps.pushFrame);

  /** host 帧 → webview composer 预填（草稿态直插；会话态由 webview 侧按其口径处理）。 */
  const submitViaComposer = codeActionEntry.submit;
  const addContextViaComposer = codeActionEntry.addContext;

  register("gode.quickEdit", async () => {
    await runQuickEdit({
      generateText: deps.generateText,
      contentProvider: deps.quickEditProvider,
    });
  });

  register("gode.sendTerminalSelection", async () => {
    await sendTerminalSelection(submitViaComposer);
  });

  register("gode.generateCommitMessage", async () => {
    await generateCommitMessage(deps.generateText);
  });

  register("gode.reviewChanges", async () => {
    await reviewChanges(submitViaComposer);
  });

  register("gode.pickSession", async () => {
    const sessionId = await pickSession(() => listSessions(deps));
    if (!sessionId) return;
    deps.pushFrame("session-switch", { sessionId });
    // 已有对话面（编辑器页签 / 侧栏视图）时不再 openChat：帧已经送到眼前这一面，
    // 多余的一次 openChat 会在"没有编辑器页签"时新开一个对话 TAB（用户反馈 2026-11-08
    // 「点加号创建出一个 TAB 窗口」的同类现象）。只有一面都没有时才需要打开。
    if (!deps.hasChatSurface()) {
      await vscode.commands.executeCommand("gode.openChat");
    }
  });

  // Code Action 的三种落点：带指令提交、只加上下文、按诊断修复。
  register("gode.codeAction", async (args?: unknown) => {
    const payload = args as
      | {
          document: vscode.TextDocument;
          range: vscode.Range;
          instruction: string;
        }
      | undefined;
    if (!payload) return;
    const context = contextFromRange(payload.document, payload.range);
    await submitViaComposer(payload.instruction, context ? [context] : []);
  });

  register("gode.addRangeToChat", async (args?: unknown) => {
    const payload = args as
      | { document: vscode.TextDocument; range: vscode.Range }
      | undefined;
    if (!payload) return;
    const context = contextFromRange(payload.document, payload.range);
    if (!context) return;
    await addContextViaComposer([context]);
  });

  register(
    "gode.fixDiagnostics",
    async (uri?: unknown, range?: unknown, diagnostics?: unknown) => {
      if (!(uri instanceof vscode.Uri) || !(range instanceof vscode.Range))
        return;
      const list = Array.isArray(diagnostics) ? diagnostics.map(String) : [];
      await runDiagnosticsFix(codeActionEntry, uri, range, list);
    },
  );

  register("gode.explainSelection", async () => {
    await runOnSelection(codeActionEntry, INSTRUCTIONS.explain, false);
  });

  register("gode.fixSelection", async () => {
    await runOnSelection(codeActionEntry, INSTRUCTIONS.fix, true);
  });

  register("gode.refactorSelection", async () => {
    await runOnSelection(codeActionEntry, INSTRUCTIONS.refactor, true);
  });

  register("gode.writeTests", async () => {
    await runOnSelection(codeActionEntry, INSTRUCTIONS.tests, true);
  });

  register("gode.addToContext", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("先打开一个文件。");
      return;
    }
    // 选区与整文件互斥（应用反馈：选代码时整文件 mention 是重复 pill）——
    // 有选区只带选区 mention；无选区才回退整文件 + 光标行。
    const items = [
      contextFromSelection(editor) ?? contextFromActiveFile(editor),
      contextFromDiagnostics(editor),
    ].filter((item): item is NonNullable<typeof item> => item !== undefined);

    if (items.length === 0) {
      void vscode.window.showInformationMessage("当前没有可加入的上下文。");
      return;
    }
    await addContextViaComposer(items);
    void vscode.window.setStatusBarMessage(
      `Gode：已加入 ${items.map((item) => item.chip.label).join("、")}`,
      4000,
    );
  });

  register("gode.showEditorLogs", () => {
    showLogs();
  });

  // 停止生成：会话态经 task 包装面停止当前回合；草稿态没有可停的回合。
  register("gode.stop", async () => {
    const sessionId = deps.currentSessionId();
    if (!sessionId) {
      void vscode.window.showInformationMessage("当前没有正在执行的会话。");
      return;
    }
    try {
      await deps.runWithServices(async (accessor) => {
        await accessor.zcodeTaskService.stopGeneration({
          taskId: sessionId,
          workspacePath: deps.getWorkspacePath(),
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("stop", `停止失败：${message}`);
      void vscode.window.showErrorMessage(`停止失败：${message}`);
    }
  });

  // 资源管理器/编辑器标题：把文件（或目录结构）加入对话上下文（FR-B12 配套入口）。
  register("gode.addFileToContext", async (uri?: unknown, uris?: unknown) => {
    // 资源管理器多选（VS Code 约定第二参 = 全部选中资源）：一次加入 N 个文件/目录，
    // 走 addContext 的单帧批量 mention（spec: composer-insert-delivery）。
    const targets: vscode.Uri[] = Array.isArray(uris)
      ? uris.filter((candidate): candidate is vscode.Uri => candidate instanceof vscode.Uri)
      : uri instanceof vscode.Uri
        ? [uri]
        : vscode.window.activeTextEditor?.document.uri
          ? [vscode.window.activeTextEditor.document.uri]
          : [];
    if (targets.length === 0) {
      void vscode.window.showInformationMessage("先选中一个文件或文件夹。");
      return;
    }
    const { contextFromUri } = await import("./editorContextFiles");
    const contexts: NonNullable<Awaited<ReturnType<typeof contextFromUri>>>[] = [];
    for (const target of targets) {
      const context = await contextFromUri(target);
      if (context) contexts.push(context);
    }
    if (contexts.length === 0) {
      void vscode.window.showInformationMessage("无法读取该路径的上下文。");
      return;
    }
    log.debug(
      "editor-commands",
      `addFileToContext：${targets.length} 个目标（${targets.map((target) => target.fsPath).join(", ")}）`,
    );
    await codeActionEntry.addContext(contexts);
  });

  return disposables;
}

/** 本工作区的历史会话（CLI 侧持久化，插件不另存；与桌面端共享同一份历史）。 */
async function listSessions(deps: EditorCommandDependencies) {
  return deps.runWithServices((accessor) =>
    accessor.zcodeAgentService.listSessions({
      workspacePath: deps.getWorkspacePath(),
      limit: 30,
    }),
  );
}

/**
 * 编辑器命令 → 对话消息。
 *
 * 模式仍是用户选定的模式，插件不会因为「点了修复」就替用户切换工作模式——
 * 模式选择归 V4ChatPane 的模式控件。
 */
async function runOnSelection(
  entry: {
    submit: (
      instruction: string,
      context: readonly PendingContext[],
    ) => Promise<void>;
  },
  instruction: string,
  expectEdits: boolean,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("先打开一个文件并选中代码。");
    return;
  }
  const context = contextFromSelection(editor);
  if (!context) {
    void vscode.window.showInformationMessage("请先选中一段代码。");
    return;
  }

  await entry.submit(instruction, [context]);

  if (expectEdits) {
    void vscode.window.setStatusBarMessage(
      "Gode：已提交修改请求，写操作会先征求确认",
      5000,
    );
  }
}
