import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";

export const WORKSPACE_FILE_DRAG_MIME = "application/x-zcode-workspace-file";
export const WORKSPACE_FILE_ADD_TO_CHAT_EVENT = "zcode:add-workspace-file-to-chat";
export const WORKSPACE_FILE_DRAG_STATE_EVENT = "zcode:workspace-file-drag-state";

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

export function serializeWorkspaceFileDragPayload(payload: WorkspaceFileDragPayload): string {
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

  return parseWorkspaceFileDragPayload(dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME));
}

export function hasWorkspaceFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME);
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
    new CustomEvent<WorkspaceFileDragStateDetail>(WORKSPACE_FILE_DRAG_STATE_EVENT, {
      detail: { dragging },
    }),
  );
}

export function isWorkspaceFileAddToChatEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragPayload> {
  return event.type === WORKSPACE_FILE_ADD_TO_CHAT_EVENT;
}

export function dispatchWorkspaceFileAddToChat(payload: WorkspaceFileDragPayload): boolean {
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
  payload: Pick<WorkspaceFileDragPayload, "workspacePath" | "workspaceIdentity">,
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
    markdown: buildFileMentionMarkdown(mentionTarget, payload.name, payload.type),
    value: mentionTarget,
    data: {
      kind: payload.type,
      path: payload.path,
      relativePath: mentionTarget,
    },
  };
}

// fork：Explorer 文件拖拽的 text/uri-list 解析（v4 composer 拖放入口消费）。
export const FILE_URI_LIST_MIME = "text/uri-list";

export function hasExplorerResourceDragSignal(dataTransfer: DataTransfer | string | null): boolean {
  if (typeof dataTransfer === "string") return dataTransfer.includes(FILE_URI_LIST_MIME);
  return Boolean(dataTransfer?.types.includes(FILE_URI_LIST_MIME));
}

export function parseFileUriList(dataTransfer: DataTransfer | string | null): string[] {
  const raw = typeof dataTransfer === "string" ? dataTransfer : dataTransfer?.getData(FILE_URI_LIST_MIME);
  if (!raw) return [];
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}
