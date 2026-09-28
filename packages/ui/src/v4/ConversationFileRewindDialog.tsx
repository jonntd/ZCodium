import { useEffect, useState } from "react";
import { Loader2Icon, Undo2Icon } from "lucide-react";
import {
  TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY,
  TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
} from "@zcode/shared";
import type { V4ConversationFileRewindPreviewResult } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveInitialRewindSelection, toRewindCommandPaths } from "@/v4/fileRewindSelection.js";

type FileRewindPreviewFile =
  | V4ConversationFileRewindPreviewResult["safeFiles"][number]
  | V4ConversationFileRewindPreviewResult["unsafeFiles"][number]
  | V4ConversationFileRewindPreviewResult["ignoredFiles"][number];

interface ConversationFileRewindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: V4ConversationFileRewindPreviewResult | null;
  previewLoading: boolean;
  applying: boolean;
  error: string | null;
  /** fileRewind：提交勾选的文件路径子集；editConflict 不使用。 */
  onApply: (paths: string[]) => void;
  variant?: "fileRewind" | "editConflict";
  onConversationOnly?: () => void;
  /** 按文件撤销（docs/spec/per-file-rewind.md）：单文件入口只预勾选该文件；缺省全选 safe 文件。 */
  initialSelectedPath?: string | null;
}

function formatReason(reason: string, intl: ReturnType<typeof useZCodeIntl>["intl"]) {
  const fallbackReasonKey = "chat.changeSummary.rewindDialog.reason.unsupportedCheckpoint";
  const keyByReason: Record<string, string> = {
    bash_ignored: "chat.changeSummary.rewindDialog.reason.bashIgnored",
    checkpoint_missing: "chat.changeSummary.rewindDialog.reason.checkpointMissing",
    checkpoint_unreadable: "chat.changeSummary.rewindDialog.reason.checkpointUnreadable",
    external_modified: "chat.changeSummary.rewindDialog.reason.externalModified",
    file_read_failed: "chat.changeSummary.rewindDialog.reason.fileReadFailed",
    unsupported_checkpoint: fallbackReasonKey,
  };
  return intl.formatMessage({ id: keyByReason[reason] ?? fallbackReasonKey });
}

function PreviewFileList({
  files,
  type,
}: {
  files: readonly FileRewindPreviewFile[];
  type: "safe" | "unsafe" | "ignored";
}) {
  const { intl } = useZCodeIntl();
  if (files.length === 0) return null;
  return (
    <div className="grid gap-1">
      {files.map((file) => (
        <div
          key={`${type}:${file.path}`}
          className="flex items-center justify-between gap-3 rounded-md border border-border bg-input/30 px-2 py-1.5"
        >
          <span className="min-w-0 truncate font-mono text-ui-xs text-foreground">{file.path}</span>
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            {"reason" in file
              ? formatReason(file.reason, intl)
              : intl.formatMessage(
                  { id: "chat.changeSummary.rewindDialog.operationCount" },
                  { count: String(file.operationCount) },
                )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 可撤销文件的勾选列表：每行独立勾选，头部提供全选/全不选。 */
function SafeFileSelectList({
  files,
  selected,
  onToggle,
  onToggleAll,
}: {
  files: V4ConversationFileRewindPreviewResult["safeFiles"];
  selected: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onToggleAll: () => void;
}) {
  const { intl } = useZCodeIntl();
  const allSelected = files.length > 0 && files.every((file) => selected.has(file.path));
  const someSelected = files.some((file) => selected.has(file.path));
  return (
    <div className="grid gap-1">
      {files.length > 1 ? (
        <label className="flex items-center gap-2 px-2 py-1 text-ui-xs text-foreground-subtle">
          <Checkbox
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={onToggleAll}
            aria-label={intl.formatMessage({ id: "chat.changeSummary.rewindDialog.selectAll" })}
          />
          {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.selectAll" })}
        </label>
      ) : null}
      {files.map((file) => (
        <label
          key={`safe:${file.path}`}
          className="flex items-center gap-2 rounded-md border border-border bg-input/30 px-2 py-1.5"
        >
          <Checkbox
            checked={selected.has(file.path)}
            onCheckedChange={() => onToggle(file.path)}
            aria-label={file.path}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground">
            {file.path}
          </span>
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.changeSummary.rewindDialog.operationCount" },
              { count: String(file.operationCount) },
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

export function ConversationFileRewindDialog({
  open,
  onOpenChange,
  preview,
  previewLoading,
  applying,
  error,
  onApply,
  variant = "fileRewind",
  onConversationOnly,
  initialSelectedPath,
}: ConversationFileRewindDialogProps) {
  const { intl } = useZCodeIntl();
  const safeCount = preview?.safeFiles.length ?? 0;
  const unsafeCount = preview?.unsafeFiles.length ?? 0;
  const ignoredCount = preview?.ignoredFiles.length ?? 0;
  const revertedCount = preview?.revertedPaths?.length ?? 0;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open || variant !== "fileRewind" || !preview) return;
    // 每次打开/预览就绪重置勾选（规则见 fileRewindSelection.ts）。
    setSelected(
      resolveInitialRewindSelection(
        preview.safeFiles.map((file) => file.path),
        initialSelectedPath,
      ),
    );
  }, [initialSelectedPath, open, preview, variant]);

  const togglePath = (path: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((previous) => {
      if (!preview) return previous;
      const safe = preview.safeFiles.map((file) => file.path);
      const allSelected = safe.length > 0 && safe.every((path) => previous.has(path));
      return new Set(allSelected ? [] : safe);
    });
  };

  const selectedCount = selected.size;
  const isFileRewind = variant === "fileRewind";
  const confirmLabelId = isFileRewind
    ? selectedCount === 1
      ? "chat.changeSummary.rewindDialog.confirmCount.one"
      : "chat.changeSummary.rewindDialog.confirmCount.other"
    : "chat.changeSummary.rewindDialog.confirm";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid={variant === "editConflict" ? TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG : undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id:
                variant === "editConflict"
                  ? "chat.edit.workspaceConflict.title"
                  : "chat.changeSummary.rewindDialog.title",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({
              id:
                variant === "editConflict"
                  ? "chat.edit.workspaceConflict.description"
                  : "chat.changeSummary.rewindDialog.description",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
          {previewLoading ? (
            <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-3.5 animate-spin" />
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.loading" })}
            </div>
          ) : preview ? (
            <>
              {variant === "fileRewind" ? (
                <section className="grid gap-1">
                  <h3 className="text-ui-base font-medium">
                    {intl.formatMessage(
                      { id: "chat.changeSummary.rewindDialog.safeTitle" },
                      { count: String(safeCount) },
                    )}
                  </h3>
                  <SafeFileSelectList
                    files={preview.safeFiles}
                    selected={selected}
                    onToggle={togglePath}
                    onToggleAll={toggleAll}
                  />
                </section>
              ) : null}
              <section className="grid gap-1">
                <h3 className="text-ui-base font-medium">
                  {intl.formatMessage(
                    { id: "chat.changeSummary.rewindDialog.unsafeTitle" },
                    { count: String(unsafeCount) },
                  )}
                </h3>
                <PreviewFileList files={preview.unsafeFiles} type="unsafe" />
              </section>
              {ignoredCount > 0 ? (
                <section className="grid gap-1">
                  <h3 className="text-ui-base font-medium">
                    {intl.formatMessage(
                      { id: "chat.changeSummary.rewindDialog.ignoredTitle" },
                      { count: String(ignoredCount) },
                    )}
                  </h3>
                  <PreviewFileList files={preview.ignoredFiles} type="ignored" />
                </section>
              ) : null}
              {variant === "fileRewind" && selectedCount > 0 && selectedCount < safeCount ? (
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.partialHint" })}
                </p>
              ) : null}
              {variant === "fileRewind" && revertedCount > 0 ? (
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "chat.changeSummary.rewindDialog.revertedNote" },
                    { count: String(revertedCount) },
                  )}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.noPreview" })}
            </p>
          )}
          {error ? <p className="text-ui-base text-danger">{error}</p> : null}
          {variant === "fileRewind" && preview && safeCount === 0 ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.cannotApply" })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {variant === "editConflict" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={applying}
                onClick={() => onOpenChange(false)}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                disabled={applying || previewLoading}
                data-testid={TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY}
                onClick={onConversationOnly}
              >
                {applying ? <Loader2Icon className="animate-spin" /> : null}
                {intl.formatMessage({ id: "chat.edit.workspaceConflict.conversationOnly" })}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={!preview || previewLoading || applying || selectedCount === 0}
              onClick={() => onApply(toRewindCommandPaths(selected))}
            >
              {applying ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
              {intl.formatMessage({ id: confirmLabelId }, { count: String(selectedCount) })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
