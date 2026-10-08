import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS,
  BUILTIN_SYSTEM_PROMPT_SURFACE_SEGMENT_TEXTS,
  SYSTEM_PROMPT_SEGMENT_IDS,
  type CustomSystemSegments,
  type SystemPromptSegmentId,
  type SystemPromptSurfaceId,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsBadge, SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  MAX_SYSTEM_PROMPT_SEGMENT_LENGTH,
  canonicalizeSystemPromptSegments,
  countSavedSystemPromptSegments,
  createAllOverrideMainDraft,
  createSystemPromptDraftFromSaved,
  hasOverLimitSystemPromptSegment,
  isSystemPromptDraftDirty,
  resolveLegacySystemPromptMigration,
  resolveSystemPromptSaveMessageId,
  serializeSystemPromptDraft,
  type SystemPromptDraft,
  type SystemPromptDraftMode,
} from "@/settings/systemPromptDraft.js";

/**
 * 系统提示词（docs/spec/custom-system-prompt.md v2）：分段编辑器。
 *
 * 三张常用段落卡（CLI 前缀 / Agent 身份 / 桌面上下文）各自独立选择
 * 继承 / 覆盖 / 追加 / 清空；「主身份 / 工作流子代理」两个作用域标签页。
 * 与 v1「整段替换」的关键差异：未编辑的动态段照常构建，只改被编辑的那一段。
 *
 * 组件自包含：经 useSettings 读写并触发 App 偏好同步；SettingsPage 侧用本地 Host
 * services 包裹，激活远程 workspace 时不会误读远端事实源。草稿是 UI 局部状态，
 * 未点保存不落盘，已保存事实源始终是 settings 快照。
 */
export function SystemPromptSection() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const savedSegments = settings?.customSystemSegments;
  const savedJson = useMemo(
    () => JSON.stringify(canonicalizeSystemPromptSegments(savedSegments)),
    [savedSegments],
  );
  const [draft, setDraft] = useState<SystemPromptDraft>(() =>
    createSystemPromptDraftFromSaved(savedSegments),
  );
  const [saving, setSaving] = useState(false);
  const [activeSurface, setActiveSurface] = useState<SystemPromptSurfaceId>("main");

  // settings 异步加载与跨窗口广播都会更新已保存值：草稿还停留在上一个已保存值
  // （用户未输入）时跟随刷新；一旦开始编辑就保留草稿，避免广播把输入冲掉。
  const lastSavedJsonRef = useRef(savedJson);
  useEffect(() => {
    if (lastSavedJsonRef.current === savedJson) return;
    setDraft((current) =>
      JSON.stringify(serializeSystemPromptDraft(current)) === lastSavedJsonRef.current
        ? createSystemPromptDraftFromSaved(savedSegments)
        : current,
    );
    lastSavedJsonRef.current = savedJson;
  }, [savedJson, savedSegments]);

  const applyValue = useCallback(
    async (segments: CustomSystemSegments, successMessageId: string) => {
      setSaving(true);
      try {
        // 同时清空 v1 整段字段：builder 里 v1 非空会整体压过分段配置，
        // 留着它会让用户刚保存的分段静默失效。
        await update({ customSystemSegments: segments, customSystemPrompt: "" });
        setDraft(createSystemPromptDraftFromSaved(segments));
        lastSavedJsonRef.current = JSON.stringify(canonicalizeSystemPromptSegments(segments));
        toast(intl.formatMessage({ id: successMessageId }));
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "settings.systemPromptSaveFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setSaving(false);
      }
    },
    [intl, update],
  );

  // v1 → v2 一次性迁移：旧整段字段非空时折算成「Agent 身份」的覆盖值并清空旧字段。
  // 迁移后旧字段为空串，本效应不再触发（幂等）；失败只记日志，不阻塞设置页。
  const migrationAppliedRef = useRef(false);
  useEffect(() => {
    if (migrationAppliedRef.current) return;
    const migration = resolveLegacySystemPromptMigration(
      settings?.customSystemPrompt,
      savedSegments,
    );
    if (!migration) return;
    migrationAppliedRef.current = true;
    void update(migration).catch((error: unknown) => {
      logger.warn("[settings] 系统提示词 v1→v2 迁移失败", error);
    });
  }, [savedSegments, settings?.customSystemPrompt, update]);

  const savedCount = countSavedSystemPromptSegments(savedSegments);
  const dirty = isSystemPromptDraftDirty(draft, savedSegments);
  const overLimit = hasOverLimitSystemPromptSegment(draft);

  const updateSegment = useCallback(
    (
      surface: SystemPromptSurfaceId,
      segmentId: SystemPromptSegmentId,
      patch: Partial<{ mode: SystemPromptDraftMode; text: string }>,
    ) => {
      setDraft((current) => ({
        ...current,
        [surface]: {
          ...current[surface],
          [segmentId]: { ...current[surface][segmentId], ...patch },
        },
      }));
    },
    [],
  );

  const handleRestoreAll = useCallback(() => {
    void applyValue({}, "settings.systemPromptRestored");
  }, [applyValue]);

  const handleAllToCustom = useCallback(() => {
    // 只改「主身份」三段（工作流子代理的身份段是 persona 参数化段，没有静态内置原文可作起点），
    // 并保留用户在另一页签上尚未提交的编辑。等用户显式保存，不一键落盘。
    setDraft((current) => ({
      ...createAllOverrideMainDraft(BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS),
      workflowSubagent: current.workflowSubagent,
    }));
  }, []);

  const handleSave = useCallback(() => {
    const segments = serializeSystemPromptDraft(draft);
    void applyValue(segments, resolveSystemPromptSaveMessageId(segments));
  }, [applyValue, draft]);

  return (
    <SettingsGroupCard>
      <div className="px-4 pb-4 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.systemPrompt" })}
          </div>
          <SettingsBadge>
            {intl.formatMessage(
              { id: "settings.systemPromptCustomizedCount" },
              { count: savedCount },
            )}
          </SettingsBadge>
        </div>
        <div className="mt-2 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPromptDescription" })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={saving || savedCount === 0}
            onClick={handleRestoreAll}
            data-testid="settings-system-prompt-restore-all"
          >
            {intl.formatMessage({ id: "settings.systemPromptRestoreAll" })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={handleAllToCustom}
            data-testid="settings-system-prompt-all-custom"
          >
            {intl.formatMessage({ id: "settings.systemPromptAllToCustom" })}
          </Button>
        </div>

        <Tabs
          className="mt-3"
          value={activeSurface}
          onValueChange={(value) => setActiveSurface(value as SystemPromptSurfaceId)}
        >
          <TabsList>
            <TabsTrigger value="main" data-testid="settings-system-prompt-tab-main">
              {intl.formatMessage({ id: "settings.systemPrompt.tab.main" })}
            </TabsTrigger>
            <TabsTrigger value="workflowSubagent" data-testid="settings-system-prompt-tab-workflow">
              {intl.formatMessage({ id: "settings.systemPrompt.tab.workflowSubagent" })}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="main" className="mt-3 space-y-3">
            <div className="text-ui-sm leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.systemPrompt.mainHint" })}
            </div>
            {SYSTEM_PROMPT_SEGMENT_IDS.map((segmentId) => (
              <SegmentCard
                key={segmentId}
                surface="main"
                segmentId={segmentId}
                draft={draft}
                onUpdate={updateSegment}
              />
            ))}
          </TabsContent>

          <TabsContent value="workflowSubagent" className="mt-3 space-y-3">
            <div className="text-ui-sm leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.systemPrompt.workflowHint" })}
            </div>
            <SegmentCard
              surface="workflowSubagent"
              segmentId="identity"
              draft={draft}
              onUpdate={updateSegment}
            />
          </TabsContent>
        </Tabs>

        {overLimit ? (
          <div className="mt-3 text-ui-sm text-destructive">
            {intl.formatMessage(
              { id: "settings.systemPromptOverLimit" },
              { max: MAX_SYSTEM_PROMPT_SEGMENT_LENGTH.toLocaleString() },
            )}
          </div>
        ) : null}

        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="me-auto text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.systemPromptApplyHint" })}
          </span>
          <Button
            size="sm"
            disabled={saving || !dirty || overLimit}
            onClick={handleSave}
            data-testid="settings-system-prompt-save"
          >
            {intl.formatMessage({ id: "settings.systemPromptSave" })}
          </Button>
        </div>
      </div>
    </SettingsGroupCard>
  );
}

const MODE_OPTIONS: { value: SystemPromptDraftMode; labelId: string }[] = [
  { value: "inherit", labelId: "settings.systemPrompt.mode.inherit" },
  { value: "override", labelId: "settings.systemPrompt.mode.override" },
  { value: "append", labelId: "settings.systemPrompt.mode.append" },
  { value: "clear", labelId: "settings.systemPrompt.mode.clear" },
];

const SEGMENT_TITLES: Record<SystemPromptSegmentId, string> = {
  cliPrefix: "settings.systemPrompt.segment.cliPrefix",
  identity: "settings.systemPrompt.segment.identity",
  desktop: "settings.systemPrompt.segment.desktop",
};

function SegmentCard({
  surface,
  segmentId,
  draft,
  onUpdate,
}: {
  surface: SystemPromptSurfaceId;
  segmentId: SystemPromptSegmentId;
  draft: SystemPromptDraft;
  onUpdate: (
    surface: SystemPromptSurfaceId,
    segmentId: SystemPromptSegmentId,
    patch: Partial<{ mode: SystemPromptDraftMode; text: string }>,
  ) => void;
}) {
  const { intl } = useZCodeIntl();
  const entry = draft[surface][segmentId];
  // 每个作用域的内置原文不同：工作流子代理的身份段是**无 persona 的基础文本**，
  // 真实内容还会多出脚本写的 persona（见 shared 的 BUILTIN_SYSTEM_PROMPT_SURFACE_SEGMENT_TEXTS）。
  const builtinText = BUILTIN_SYSTEM_PROMPT_SURFACE_SEGMENT_TEXTS[surface][segmentId] ?? "";
  const title = intl.formatMessage({ id: SEGMENT_TITLES[segmentId] });

  return (
    <div className="rounded-lg border border-border bg-surface/40 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">{title}</span>
          <SettingsBadge>
            {intl.formatMessage({ id: "settings.systemPrompt.systemMessage" })}
          </SettingsBadge>
          {segmentId === "desktop" ? (
            <SettingsBadge>
              {intl.formatMessage({ id: "settings.systemPrompt.conditionalInjection" })}
            </SettingsBadge>
          ) : null}
        </div>
        <Select
          value={entry.mode}
          onValueChange={(value) =>
            onUpdate(surface, segmentId, { mode: value as SystemPromptDraftMode })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={`${title} ${intl.formatMessage({ id: "settings.systemPrompt.modeLabel" })}`}
            data-testid={`settings-system-prompt-mode-${surface}-${segmentId}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {intl.formatMessage({ id: option.labelId })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="mt-1 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.systemPrompt.stableSegmentHint" })}
      </div>

      {entry.mode === "clear" ? (
        <div className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPrompt.clearedHint" })}
        </div>
      ) : (
        <SettingsFormTextarea
          className={cn(
            "mt-2 min-h-32 w-full resize-y font-mono text-ui-sm",
            entry.mode === "inherit" && "text-foreground-subtle",
          )}
          readOnly={entry.mode === "inherit"}
          aria-label={title}
          data-testid={`settings-system-prompt-text-${surface}-${segmentId}`}
          value={entry.mode === "inherit" ? builtinText : entry.text}
          placeholder={intl.formatMessage({
            id:
              entry.mode === "append"
                ? "settings.systemPrompt.appendPlaceholder"
                : "settings.systemPrompt.overridePlaceholder",
          })}
          onChange={(event) => onUpdate(surface, segmentId, { text: event.target.value })}
        />
      )}
    </div>
  );
}
