import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { ContextChip } from "./viewProtocol";
import type { AutoContextMode } from "./featureConfig";
import { readDirectoryContext, readFileContext } from "./editorContextFiles";

export interface PendingContext {
  readonly chip: ContextChip;
  readonly text: string;
  /** 本块覆盖的文件路径（相对工作区），供发送时避免同一文件以其他形式重复出现。 */
  readonly paths?: readonly string[];
  /**
   * 结构化 mention pill（Claude Code/Augment 口径）：composer 侧以 `prepend-if-missing`
   * 预填干净引用（如 `client.js:9-10`），内容不塞输入框正文，模型按引用读文件。
   * 缺省 = 无 mention 面（纯文本块，仅 buildPrompt 直发链路消费）。
   */
  readonly mention?: PendingContextMention;
}

/** composer mention pill 的最小结构面（与 ui ComposerMentionPrefill 结构兼容）。 */
export interface PendingContextMention {
  /** 去重身份：同 id 重复"加入上下文"不再产生第二个 pill。 */
  readonly id: string;
  readonly category: "files";
  readonly label: string;
  readonly value: string;
  readonly markdown: string;
  readonly data: { kind: "file" | "directory"; path: string; relativePath: string };
}

/** 文件引用 mention 工厂：label/转义与 ui mentionMarkdown 同口径（editorContextFiles 共用）。 */
export function fileMentionRef(
  fsPath: string,
  relativePath: string,
  label: string,
  kind: "file" | "directory" = "file",
  idSuffix = "",
): PendingContextMention {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const escapedLabel = label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  return {
    id: `file:${fsPath}${idSuffix}`,
    category: "files",
    label,
    value: kind === "directory" ? `${normalizedPath}/` : normalizedPath,
    markdown: `[${escapedLabel}](./${normalizedPath})`,
    data: { kind, path: fsPath, relativePath: normalizedPath },
  };
}

const MAX_SELECTION_LINES = 400;
const MAX_DIAGNOSTICS = 20;

/** FR-B22：自动上下文最多附加的文件数。 */
const MAX_AUTO_CONTEXT_FILES = 8;
/** FR-B22：高档位只带「最近 5 分钟内」编辑过的文件。 */
const RECENT_EDIT_WINDOW_MS = 5 * 60 * 1000;
/** 生成物目录只制造噪音：按路径段匹配，`src/dist.ts` 这类文件名不受影响。 */
const AUTO_CONTEXT_SKIP_DIRS = new Set(["node_modules", "dist"]);

function workspaceRelative(fsPath: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
  return folder ? relative(folder.uri.fsPath, fsPath) : fsPath;
}

function fenced(languageId: string, content: string): string {
  return `\`\`\`${languageId}\n${content}\n\`\`\``;
}

/** 选区 → 可直接拼进 prompt 的上下文块。 */
export function contextFromSelection(editor: vscode.TextEditor): PendingContext | undefined {
  return contextFromRange(editor.document, editor.selection);
}

/** 文档 + 范围 → 上下文块。代码操作（Code Action）拿不到 TextEditor，只能走这个入口。 */
export function contextFromRange(
  document: vscode.TextDocument,
  selection: vscode.Range,
): PendingContext | undefined {
  if (selection.isEmpty) return undefined;

  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  const raw = document.getText(selection);
  const lines = raw.split("\n");
  const clipped = lines.length > MAX_SELECTION_LINES ? lines.slice(0, MAX_SELECTION_LINES) : lines;
  const suffix = lines.length > MAX_SELECTION_LINES ? "\n…（选区过长，已截断）" : "";
  const path = workspaceRelative(document.uri.fsPath);
  const label = `${path}:${startLine}-${endLine}`;

  return {
    chip: { id: randomUUID(), label },
    mention: fileMentionRef(document.uri.fsPath, path, label, "file", `:${startLine}-${endLine}`),
    text: `<selection path="${path}" lines="${startLine}-${endLine}">\n${fenced(
      document.languageId,
      clipped.join("\n") + suffix,
    )}\n</selection>`,
  };
}

/** 当前文件（无选区时）作为上下文。 */
export function contextFromActiveFile(editor: vscode.TextEditor): PendingContext | undefined {
  const document = editor.document;
  if (document.uri.scheme !== "file") return undefined;
  const path = workspaceRelative(document.uri.fsPath);
  const cursor = editor.selection.active;
  return {
    // id 不含光标行：同一文件重复"加入上下文"按 path 去重（光标移动不产生第二个 pill）。
    chip: { id: randomUUID(), label: `${path}:${cursor.line + 1}` },
    mention: fileMentionRef(document.uri.fsPath, path, `${path}:${cursor.line + 1}`),
    text: `<active-file path="${path}" cursor-line="${cursor.line + 1}" />`,
  };
}

/** 当前文件的诊断，交给模型判断「改完是否还会红」。 */
export function contextFromDiagnostics(editor: vscode.TextEditor): PendingContext | undefined {
  const document = editor.document;
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .slice(0, MAX_DIAGNOSTICS)
    .map((item) => {
      const line = item.range.start.line + 1;
      return `- [${item.severity}] line ${line}: ${item.message}`;
    });
  if (diagnostics.length === 0) return undefined;

  const path = workspaceRelative(document.uri.fsPath);
  return {
    chip: { id: randomUUID(), label: `诊断 ${diagnostics.length} 条` },
    // 文件 pill（path 级 id，与 active-file pill 去重）；诊断明细走 compactContextText 压缩正文。
    mention: fileMentionRef(document.uri.fsPath, path, path),
    text: `<diagnostics path="${path}">\n${diagnostics.join("\n")}\n</diagnostics>`,
  };
}

const MENTION_PATTERN = /@([\w./\\-]+)/gu;
const MAX_MENTIONS = 5;

/**
 * 解析消息里的 `@路径`。
 *
 * 与 Claude Code 的 `@file` 同一语义：用户在自然语言里写路径就能带上文件，
 * 不用先点按钮。解析失败的 token 原样保留（模型仍能看到它），不报错打断发送。
 */
export async function resolveMentions(text: string): Promise<PendingContext[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return [];

  const tokens = [...text.matchAll(MENTION_PATTERN)]
    .map((match) => match[1]?.trim())
    .filter((token): token is string => Boolean(token))
    .slice(0, MAX_MENTIONS);

  const resolved: PendingContext[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const uri = vscode.Uri.joinPath(root, token);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const context =
        stat.type === vscode.FileType.Directory
          ? await readDirectoryContext(uri)
          : await readFileContext(uri);
      if (context) resolved.push(context);
    } catch {
      // 不是有效路径就跳过：@ 也可能是普通文本。
    }
  }
  return resolved;
}

/**
 * FR-B22 自动上下文：发送时按设置附加「打开的文件 / 最近编辑」，只给路径不给内容
 * （不塞全文避免上下文爆炸）。拆成两层以便离线校验：
 * `autoContextSnapshot` 从 VS Code API 收集数据，`buildAutoContext` 纯函数拼块。
 */
export interface AutoContextOpenFile {
  readonly fsPath: string;
  /** 可见编辑器才有光标行；不可见 tab 降级为只给路径。 */
  readonly cursorLine?: number;
}

export interface AutoContextRecentEdit {
  readonly fsPath: string;
  readonly editedAt: number;
}

export interface AutoContextSnapshot {
  readonly openEditors: readonly AutoContextOpenFile[];
  readonly recentEdits: readonly AutoContextRecentEdit[];
  /** 当前活动文件的 fsPath，用于「超过 8 个时取最相关」的置顶排序。 */
  readonly activeFsPath?: string;
  readonly now: number;
}

// 模块级记录 fsPath → 最后编辑时刻；由 trackRecentEdits 写入，收集时读出。
const recentEdits = new Map<string, number>();

/** 记录最近编辑（5 分钟窗口），供自动上下文高档位使用。 */
export function trackRecentEdits(): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0) return; // 仅脏状态/保存等元变化，不算编辑
    if (event.document.uri.scheme !== "file") return;
    const now = Date.now();
    recentEdits.set(event.document.uri.fsPath, now);
    // 顺手清理过期条目，避免长会话下 Map 无限增长。
    for (const [fsPath, editedAt] of recentEdits) {
      if (now - editedAt > RECENT_EDIT_WINDOW_MS) recentEdits.delete(fsPath);
    }
  });
}

/** 收集自动上下文快照。`now` 可注入，供离线检查脚本固定时间窗。 */
export function autoContextSnapshot(
  editor: vscode.TextEditor | undefined,
  now = Date.now(),
): AutoContextSnapshot {
  const cursorByFsPath = new Map<string, number>();
  for (const visible of vscode.window.visibleTextEditors) {
    if (visible.document.uri.scheme !== "file") continue;
    cursorByFsPath.set(visible.document.uri.fsPath, visible.selection.active.line + 1);
  }

  const openEditors: AutoContextOpenFile[] = [];
  const seen = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      // TabInputText/TabInputCustom 都带 uri；用属性探测而非 instanceof，diff 等输入也兼容。
      const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (!uri || uri.scheme !== "file") continue;
      if (seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      openEditors.push({ fsPath: uri.fsPath, cursorLine: cursorByFsPath.get(uri.fsPath) });
    }
  }

  return {
    openEditors,
    recentEdits: [...recentEdits].map(([fsPath, editedAt]) => ({ fsPath, editedAt })),
    activeFsPath: editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined,
    now,
  };
}

function isSkippedAutoContextPath(fsPath: string): boolean {
  return fsPath.split(/[\\/]/).some((segment) => AUTO_CONTEXT_SKIP_DIRS.has(segment));
}

/** 「最相关」排序：活动文件置顶，其余保持 tab 顺序（tab 大致按打开/使用顺序）。 */
function sortOpenEditors(
  files: readonly AutoContextOpenFile[],
  activeFsPath: string | undefined,
): AutoContextOpenFile[] {
  const active = files.find((file) => file.fsPath === activeFsPath);
  const rest = files.filter((file) => file.fsPath !== activeFsPath);
  return active ? [active, ...rest] : rest;
}

function autoContextBlock(entry: AutoContextEntry): PendingContext {
  const path = workspaceRelative(entry.fsPath);
  if (entry.kind === "openEditor" && entry.cursorLine !== undefined) {
    return {
      chip: { id: randomUUID(), label: `${path}:${entry.cursorLine}` },
      paths: [path],
      text: `<open-file path="${path}" cursor-line="${entry.cursorLine}" />`,
    };
  }
  if (entry.kind === "openEditor") {
    return {
      chip: { id: randomUUID(), label: path },
      paths: [path],
      text: `<open-file path="${path}" />`,
    };
  }
  return {
    chip: { id: randomUUID(), label: path },
    paths: [path],
    text: `<recent-edit path="${path}" />`,
  };
}

type AutoContextEntry =
  | { readonly kind: "openEditor"; readonly fsPath: string; readonly cursorLine?: number }
  | { readonly kind: "recentEdit"; readonly fsPath: string; readonly editedAt: number };

/**
 * 按档位把快照拼成上下文块：
 * - `off`：不加（自动上下文完全消失）；
 * - `openEditors`：打开的文件路径 + 光标行；
 * - `openEditorsAndRecentEdits`：再加最近 5 分钟内编辑过的文件路径。
 *
 * 超过 8 个只取前 8 个（打开中的文件优先于最近编辑）；`node_modules`/`dist` 跳过；
 * 同一文件既打开又编辑过只出现一次。
 */
export function buildAutoContext(
  snapshot: AutoContextSnapshot,
  mode: AutoContextMode,
): PendingContext[] {
  if (mode === "off") return [];

  const entries: AutoContextEntry[] = sortOpenEditors(snapshot.openEditors, snapshot.activeFsPath)
    .filter((file) => !isSkippedAutoContextPath(file.fsPath))
    .map((file) => ({ kind: "openEditor", fsPath: file.fsPath, cursorLine: file.cursorLine }));

  if (mode === "openEditorsAndRecentEdits") {
    const openedPaths = new Set(entries.map((entry) => entry.fsPath));
    const recent = snapshot.recentEdits
      .filter(
        (edit) =>
          !openedPaths.has(edit.fsPath) &&
          !isSkippedAutoContextPath(edit.fsPath) &&
          snapshot.now - edit.editedAt <= RECENT_EDIT_WINDOW_MS,
      )
      .sort((a, b) => b.editedAt - a.editedAt)
      .map(
        (edit): AutoContextEntry => ({
          kind: "recentEdit",
          fsPath: edit.fsPath,
          editedAt: edit.editedAt,
        }),
      );
    entries.push(...recent);
  }

  return entries.slice(0, MAX_AUTO_CONTEXT_FILES).map(autoContextBlock);
}

export interface PromptOptions {
  readonly includeActiveFile: boolean;
  readonly includeDiagnostics: boolean;
  readonly autoContext: AutoContextMode;
}

/**
 * 把「待发送上下文 + 用户输入」拼成一条 prompt。
 *
 * 上下文走文本块而不是 `session/send` 的 `attachments`：附件字段是 CLI 内部
 * 附件上传链的入口（需要 host 侧寄存），而纯文本块在模型侧等价、且不依赖
 * 插件实现文件寄存。
 */
export async function buildPrompt(
  text: string,
  context: readonly PendingContext[],
  editor: vscode.TextEditor | undefined,
  options: PromptOptions,
): Promise<{ content: string; labels: string[] }> {
  const parts: string[] = [];
  const labels: string[] = [];

  for (const item of context) {
    parts.push(item.text);
    labels.push(item.chip.label);
  }

  // `@路径` 与显式 chip 可能指向同一文件，按 chip 标签去重，避免同一份内容发两遍。
  for (const mention of await resolveMentions(text)) {
    if (labels.includes(mention.chip.label)) continue;
    parts.push(mention.text);
    labels.push(mention.chip.label);
  }

  // FR-B22 自动上下文：mention 带文件内容而这里只有路径，信息不重复，不做交叉去重。
  const autoContext = buildAutoContext(autoContextSnapshot(editor), options.autoContext);
  const coveredPaths = new Set<string>();
  for (const item of autoContext) {
    parts.push(item.text);
    labels.push(item.chip.label);
    for (const path of item.paths ?? []) coveredPaths.add(path);
  }

  if (editor) {
    // 活动文件已被自动上下文覆盖（openEditors 档）时不再重复 active-file 块。
    const activeCovered = coveredPaths.has(workspaceRelative(editor.document.uri.fsPath));
    if (options.includeActiveFile && !activeCovered) {
      const active = contextFromActiveFile(editor);
      if (active) {
        parts.push(active.text);
        labels.push(active.chip.label);
      }
    }
    if (options.includeDiagnostics) {
      const diagnostics = contextFromDiagnostics(editor);
      if (diagnostics) {
        parts.push(diagnostics.text);
        labels.push(diagnostics.chip.label);
      }
    }
  }

  if (parts.length === 0) return { content: text, labels };
  return {
    content: `<context>\n${parts.join("\n")}\n</context>\n\n${text}`,
    labels,
  };
}
