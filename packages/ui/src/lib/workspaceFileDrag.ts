import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";

export const WORKSPACE_FILE_DRAG_MIME = "application/x-zcode-workspace-file";
export const WORKSPACE_FILE_ADD_TO_CHAT_EVENT =
  "zcode:add-workspace-file-to-chat";
export const WORKSPACE_FILE_DRAG_STATE_EVENT =
  "zcode:workspace-file-drag-state";

/** uri-list 标准 MIME：OS 文件与 VS Code 资源管理器拖拽都会携带（内容仅 drop 时可读）。 */
export const FILE_URI_LIST_MIME = "text/uri-list";
/** VS Code 树拖拽标记前缀；webview 里只有 types 可见，内容不可读（spec: composer-explorer-file-drop）。 */
export const VSCODE_TREE_DRAG_MIME_PREFIX = "application/vnd.code.tree";
/** VS Code 资源引用 MIME（DataTransfers.RESOURCES）：树拖拽携带资源 URI 列表的实际载体。 */
export const VSCODE_RESOURCE_URI_LIST_MIME = "application/vnd.code.uri-list";

export interface WorkspaceFileDragPayload {
  type: "file" | "directory";
  workspacePath: string;
  workspaceIdentity?: string;
  path: string;
  relativePath: string;
  name: string;
}

interface WorkspaceFileComposerMention {
  markdown: string;
  value: string;
  data: {
    kind: WorkspaceFileDragPayload["type"];
    path: string;
    relativePath: string;
  };
}

interface WorkspaceFileDragStateDetail {
  dragging: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function serializeWorkspaceFileDragPayload(
  payload: WorkspaceFileDragPayload,
): string {
  return JSON.stringify(payload);
}

export function parseWorkspaceFileDragPayload(
  rawPayload: string | null | undefined,
): WorkspaceFileDragPayload | null {
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (!isRecord(parsed)) {
      return null;
    }

    const type = parsed.type;
    const workspacePath = parsed.workspacePath;
    const path = parsed.path;
    const relativePath = parsed.relativePath;
    const name = parsed.name;
    const workspaceIdentity = parsed.workspaceIdentity;

    if (
      (type !== "file" && type !== "directory") ||
      typeof workspacePath !== "string" ||
      typeof path !== "string" ||
      typeof relativePath !== "string" ||
      typeof name !== "string"
    ) {
      return null;
    }

    return {
      type,
      workspacePath,
      path,
      relativePath,
      name,
      ...(typeof workspaceIdentity === "string" && workspaceIdentity.trim()
        ? { workspaceIdentity }
        : {}),
    };
  } catch {
    return null;
  }
}

export function readWorkspaceFileDragPayload(
  dataTransfer: DataTransfer,
): WorkspaceFileDragPayload | null {
  if (!hasWorkspaceFileDragPayload(dataTransfer)) {
    return null;
  }

  return parseWorkspaceFileDragPayload(
    dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME),
  );
}

export function hasWorkspaceFileDragPayload(
  dataTransfer: DataTransfer,
): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME);
}

/**
 * VS Code 资源管理器拖拽信号（spec: composer-explorer-file-drop）：
 * - 上游 VS Code：`text/uri-list` + `application/vnd.code.tree.*`；
 * - Antigravity 实测（探针 2026-11-06）：树拖拽只有 `application/vnd.code.uri-list`
 *   （DataTransfers.RESOURCES），无 vnd.code.tree、无 Files——漏掉它会让拖拽完全失效；
 * - 只带 text/uri-list 的浏览器链接拖拽不命中，保持默认文本插入行为。
 */
export function hasExplorerResourceDragSignal(
  types: readonly string[],
): boolean {
  if (types.includes(VSCODE_RESOURCE_URI_LIST_MIME)) {
    return true;
  }
  if (!types.includes(FILE_URI_LIST_MIME)) {
    return false;
  }
  return types.some((type) => type.startsWith(VSCODE_TREE_DRAG_MIME_PREFIX));
}

/**
 * 判定一次 dragover 是否为「可投放到 composer」的本地资源拖拽（spec: composer-explorer-file-drop）。
 *
 * - OS 文件：`"Files"` 类型或 items 存在 kind==="file"（调用方传入，dragover 期间可读）；
 * - 应用内文件树：workspace MIME（composer 会以 kind="workspace" 点亮）；
 * - VS Code 资源管理器：`hasExplorerResourceDragSignal`；
 * - 其余（纯文本/链接选择等）不命中。
 */
export function hasLocalResourceDropSignal(
  types: readonly string[],
  hasFileItems = false,
): boolean {
  if (
    hasFileItems ||
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME)
  ) {
    return true;
  }
  return hasExplorerResourceDragSignal(types);
}

/**
 * 解析 uri-list 原文为 file:// URI 列表（RFC 2483：按行分隔、`#` 注释行、每行「URL [title]」）。
 * 只切分与过滤，不做 file:// → 本机路径转换（Windows 盘符/UNC 语义由 host 的
 * resolveFileDropPaths 承担），也不做百分号解码（保留 URI 规范形式给 Uri.parse）。
 */
export function parseFileUriList(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  const uris: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const token = trimmed.split(/\s+/)[0] ?? "";
    if (!token.toLowerCase().startsWith("file://")) {
      continue;
    }
    // file scheme 大小写不敏感（RFC 3986）：FILE:///a.md 与 file:///a.md 视为同一条目。
    const dedupeKey = token.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    uris.push(token);
  }
  return uris;
}

export function isWorkspaceFileDragStateEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragStateDetail> {
  return event.type === WORKSPACE_FILE_DRAG_STATE_EVENT;
}

export function dispatchWorkspaceFileDragState(dragging: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<WorkspaceFileDragStateDetail>(
      WORKSPACE_FILE_DRAG_STATE_EVENT,
      {
        detail: { dragging },
      },
    ),
  );
}

export function isWorkspaceFileAddToChatEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragPayload> {
  return event.type === WORKSPACE_FILE_ADD_TO_CHAT_EVENT;
}

export function dispatchWorkspaceFileAddToChat(
  payload: WorkspaceFileDragPayload,
): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const event = new CustomEvent(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

function isWorkspaceFilePayloadForWorkspace(
  payload: Pick<
    WorkspaceFileDragPayload,
    "workspacePath" | "workspaceIdentity"
  >,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  return (
    payload.workspacePath === workspacePath &&
    (payload.workspaceIdentity ?? "") === (workspaceIdentity ?? "")
  );
}

export function createWorkspaceFileComposerMention(
  payload: WorkspaceFileDragPayload,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceFileComposerMention {
  const sameWorkspace = isWorkspaceFilePayloadForWorkspace(
    payload,
    workspacePath,
    workspaceIdentity,
  );
  const mentionTarget = sameWorkspace ? payload.relativePath : payload.path;

  return {
    markdown: buildFileMentionMarkdown(
      mentionTarget,
      payload.name,
      payload.type,
    ),
    value: mentionTarget,
    data: {
      kind: payload.type,
      path: payload.path,
      relativePath: mentionTarget,
    },
  };
}
