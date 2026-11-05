/**
 * settings/WorkspaceInstructionsPanel.tsx — 自定义指令/回复语言/分段提示词面板（T12，P1-13）。
 *
 * - 读写走 services setting 频道既有方法（ISettingService.get/update patch：
 *   customSystemPrompt/customSystemSegments/language——改动随下次会话生效，UI 明示）；
 *   分段提示词（P1-13.1）经 services 既有写穿（workspace/updateSystemSegments）生效；
 * - 「从 CLAUDE.md/ZCODIUM.md 一次性导入」：plat importWorkspaceInstructions（组2 读面）
 *   → workspacePreferences.mapInstructionImport 幂等映射 → 确认后随表单写回；
 * - 交互式提问（ElicitationDialog）回执面：由对话区 V4InteractionDialogs 承载
 *   （v4 resolveInteraction 的 elicitation 回执 action/content），不在本面板。
 */

import { useCallback, useEffect, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import {
  SYSTEM_PROMPT_SEGMENT_IDS,
  SYSTEM_PROMPT_SURFACE_IDS,
  type AppSettings,
  type CustomSystemSegments,
  type SystemPromptSegmentId,
  type SystemPromptSurfaceId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  MAX_SYSTEM_PROMPT_SEGMENT_LENGTH,
  createSystemPromptDraftFromSaved,
  hasOverLimitSystemPromptSegment,
  serializeSystemPromptDraft,
  type SystemPromptDraft,
  type SystemPromptDraftMode,
} from "@/settings/systemPromptDraft.js";
import type { PlatPort } from "./McpSettingsPanel";
import {
  buildInstructionsPatch,
  mapInstructionImport,
  projectInstructionsForm,
  type InstructionImportOutcome,
  type InstructionsForm,
} from "./workspacePreferences";

/** 分段提示词的静态标签（面板中文文案；与 docs/spec/custom-system-prompt.md v2 对齐）。 */
const SURFACE_IDS = SYSTEM_PROMPT_SURFACE_IDS;
const SEGMENT_IDS = SYSTEM_PROMPT_SEGMENT_IDS;
const SEGMENT_SURFACE_LABELS: Record<SystemPromptSurfaceId, string> = {
  main: "主身份",
  workflowSubagent: "工作流子代理",
};
const SEGMENT_LABELS: Record<SystemPromptSegmentId, string> = {
  cliPrefix: "CLI 前缀",
  identity: "Agent 身份",
  desktop: "桌面上下文",
};
const SEGMENT_MODE_OPTIONS: ReadonlyArray<{ value: SystemPromptDraftMode; label: string }> = [
  { value: "inherit", label: "继承内置" },
  { value: "override", label: "覆盖" },
  { value: "append", label: "追加" },
  { value: "clear", label: "清空" },
];

export interface WorkspaceInstructionsPanelProps {
  services: IServiceAccessor;
  plat: PlatPort;
  onClose?: () => void;
}

export function WorkspaceInstructionsPanel({
  services,
  plat,
  onClose,
}: WorkspaceInstructionsPanelProps) {
  const [form, setForm] = useState<InstructionsForm | null>(null);
  const [segmentDraft, setSegmentDraft] = useState<SystemPromptDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importOutcome, setImportOutcome] = useState<InstructionImportOutcome | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let active = true;
    void services.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        const projected = projectInstructionsForm(settings);
        setForm(projected);
        setSegmentDraft(createSystemPromptDraftFromSaved(projected.customSystemSegments));
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [services]);

  const patchSegment = useCallback(
    (
      surface: SystemPromptSurfaceId,
      segmentId: SystemPromptSegmentId,
      patch: Partial<{ mode: SystemPromptDraftMode; text: string }>,
    ) => {
      setSegmentDraft((current) =>
        current
          ? {
              ...current,
              [surface]: {
                ...current[surface],
                [segmentId]: { ...current[surface][segmentId], ...patch },
              },
            }
          : current,
      );
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!form) return;
    if (segmentDraft && hasOverLimitSystemPromptSegment(segmentDraft)) {
      setError(`分段文本超过单段上限（${MAX_SYSTEM_PROMPT_SEGMENT_LENGTH} 字符），请缩减后保存`);
      return;
    }
    try {
      // 分段提示词（P1-13.1）：AppSettings.customSystemSegments 经 services 既有写穿生效。
      const segments: CustomSystemSegments | undefined = segmentDraft
        ? serializeSystemPromptDraft(segmentDraft)
        : undefined;
      await services.settingService.update(
        buildInstructionsPatch({
          ...form,
          ...(segments !== undefined ? { customSystemSegments: segments } : {}),
        }),
      );
      setMessage(
        "已保存（自定义指令/回复语言/分段提示词随下次会话生效；空提示词 = 恢复内置默认。" +
          "整段提示词非空时优先于分段配置生效）",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [form, segmentDraft, services]);

  const handleImport = useCallback(async () => {
    if (!form) return;
    setImporting(true);
    try {
      const result = (await plat.call("importWorkspaceInstructions")) as { files: unknown[] };
      const outcome = mapInstructionImport(result.files as never, form.customSystemPrompt);
      setImportOutcome(outcome);
      if (outcome.imported.length > 0) {
        setForm({ ...form, customSystemPrompt: outcome.promptDraft });
        setMessage(
          `已从 ${outcome.imported.length} 个文件一次性拷贝到提示词草稿（保存后新会话生效）` +
            (outcome.skipped.length > 0 ? `；${outcome.skipped.length} 个已导入过，跳过` : ""),
        );
      } else {
        setMessage(
          outcome.skipped.length > 0
            ? "未发现新文件可导入（均已导入过）"
            : "未找到 ZCODIUM.md / CLAUDE.md（每 folder 取首个命中）",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [form, plat]);

  return (
    <div
      data-testid="workspace-instructions-panel"
      className="border-t border-card-border bg-card px-2 py-1 text-ui-xs"
    >
      <div className="flex items-center gap-1">
        <span>自定义指令 / 回复语言</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          disabled={!form || importing}
          onClick={() => void handleImport()}
        >
          从 CLAUDE.md/ZCODIUM.md 导入
        </Button>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 enabled:cursor-pointer"
            onClick={onClose}
          >
            收起
          </Button>
        ) : null}
      </div>
      {error ? <div className="pb-1 text-foreground-subtle">{error}</div> : null}
      {message ? (
        <div className="pb-1 text-foreground-subtle" data-testid="instructions-message">
          {message}
        </div>
      ) : null}
      {importOutcome && importOutcome.warnings.length > 0 ? (
        <ul className="pb-1 text-foreground-subtle">
          {importOutcome.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {form === null ? (
        <div className="pb-1 text-foreground-subtle">读取设置中…</div>
      ) : (
        <div className="pb-2">
          <div className="text-foreground-subtle">
            自定义系统提示词（非空 = 替换内置身份段；空 = 恢复默认；非空时优先于分段配置生效）
          </div>
          <textarea
            className="h-32 w-full rounded border border-card-border bg-background p-1 font-mono text-ui-xs"
            data-testid="instructions-prompt"
            value={form.customSystemPrompt}
            onChange={(event) => setForm({ ...form, customSystemPrompt: event.target.value })}
          />
          {segmentDraft ? (
            <div className="mt-2" data-testid="instructions-segments">
              <div className="text-foreground-subtle">
                分段提示词（P1-13.1；未改写的段照常继承内置构建，保存随下次会话生效）
              </div>
              {SURFACE_IDS.map((surface) => (
                <div key={surface} className="mt-1">
                  <div className="text-foreground-subtle">{SEGMENT_SURFACE_LABELS[surface]}</div>
                  {SEGMENT_IDS.map((segmentId) => {
                    const entry = segmentDraft[surface][segmentId];
                    const editable = entry.mode === "override" || entry.mode === "append";
                    return (
                      <div key={`${surface}:${segmentId}`} className="mt-0.5">
                        <div className="flex items-center gap-1">
                          <span className="w-20 shrink-0 text-foreground-subtle">
                            {SEGMENT_LABELS[segmentId]}
                          </span>
                          <select
                            className="h-6 rounded border border-card-border bg-background px-1 text-ui-xs"
                            data-testid={`instructions-segment-mode-${surface}-${segmentId}`}
                            value={entry.mode}
                            onChange={(event) =>
                              patchSegment(surface, segmentId, {
                                mode: event.target.value as SystemPromptDraftMode,
                              })
                            }
                          >
                            {SEGMENT_MODE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        {editable ? (
                          <textarea
                            className="mt-0.5 h-16 w-full rounded border border-card-border bg-background p-1 font-mono text-ui-xs"
                            data-testid={`instructions-segment-text-${surface}-${segmentId}`}
                            value={entry.text}
                            onChange={(event) =>
                              patchSegment(surface, segmentId, { text: event.target.value })
                            }
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex items-center gap-1">
            <span className="text-foreground-subtle">回复语言（空 = 跟随用户消息）</span>
            <Input
              value={form.language}
              placeholder="如 zh-CN"
              className="h-6 w-32 text-ui-xs"
              data-testid="instructions-language"
              onChange={(event) => setForm({ ...form, language: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 enabled:cursor-pointer"
              onClick={() => void handleSave()}
            >
              保存
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
