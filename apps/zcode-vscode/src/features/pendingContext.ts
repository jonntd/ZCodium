/**
 * PendingContext 契约叶子（架构：断开 contextCollector ↔ editorContextFiles 循环依赖）。
 *
 * contextCollector 需要 editorContextFiles 的 readFileContext/readDirectoryContext
 * （contextFromUri 复用），editorContextFiles 需要 PendingContext/fileMentionRef——
 * 两者互相 import 成环（architecture:check cycle）。把两边共用的类型与 mention 工厂
 * 抽到这个无依赖叶子：editorContextFiles → pendingContext，contextCollector → 两者，成 DAG。
 * contextCollector 继续转口导出（既有 import 面不变）。
 */

import type { ContextChip } from "./viewProtocol";

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
  readonly data: {
    kind: "file" | "directory";
    path: string;
    relativePath: string;
    /** 选区上下文的 1-based 起止行：仅影响 pill 展示文案（spec: composer-insert-delivery）。 */
    startLine?: number;
    endLine?: number;
  };
}

/** 文件引用 mention 工厂：label/转义与 ui mentionMarkdown 同口径（editorContextFiles 共用）。 */
export function fileMentionRef(
  fsPath: string,
  relativePath: string,
  label: string,
  kind: "file" | "directory" = "file",
  idSuffix = "",
  range?: { startLine: number; endLine: number },
): PendingContextMention {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const escapedLabel = label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return {
    id: `file:${fsPath}${idSuffix}`,
    category: "files",
    label,
    value: kind === "directory" ? `${normalizedPath}/` : normalizedPath,
    markdown: `[${escapedLabel}](./${normalizedPath})`,
    data: {
      kind,
      path: fsPath,
      relativePath: normalizedPath,
      ...(range ?? {}),
    },
  };
}
