import { useState } from "react";
import {
  BUILTIN_SYSTEM_PROMPT_SURFACE_SEGMENT_TEXTS,
  type SystemPromptSegmentId,
  type SystemPromptSurfaceId,
} from "@zcode/shared";
import { Sparkles } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsBadge } from "@/settings/SettingsPageParts.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  RECOMMENDED_IDENTITY_TEMPLATES,
  type RecommendedSystemPromptTemplate,
} from "@/settings/systemPromptTemplates.js";
import type { SystemPromptDraft, SystemPromptDraftMode } from "@/settings/systemPromptDraft.js";

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

export function SystemPromptSegmentCard({
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
  // 推荐模板只给主身份的 Agent 身份（codex_ui 还原说明 §15）：工作流子代理的身份段
  // 是参数化段，模板覆盖会连 persona 与工作流契约一起删掉。
  const templatesEnabled = surface === "main" && segmentId === "identity";
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const applyTemplate = (template: RecommendedSystemPromptTemplate) => {
    onUpdate(surface, segmentId, { mode: "override", text: template.body });
    setTemplatesOpen(false);
  };

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
        {/* 模式切换用分段按钮（codex_ui 还原说明 §12）：当前模式高亮，一击切换。 */}
        <div
          className="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
          role="radiogroup"
          aria-label={`${title} ${intl.formatMessage({ id: "settings.systemPrompt.modeLabel" })}`}
        >
          {MODE_OPTIONS.map((option) => {
            const active = entry.mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`settings-system-prompt-mode-${surface}-${segmentId}-${option.value}`}
                onClick={() => onUpdate(surface, segmentId, { mode: option.value })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-ui-sm transition-colors",
                  active
                    ? "bg-surface-hover text-foreground"
                    : "text-foreground-subtle hover:bg-surface/60 hover:text-foreground",
                )}
              >
                {intl.formatMessage({ id: option.labelId })}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-1 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.systemPrompt.stableSegmentHint" })}
      </div>

      {templatesEnabled ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setTemplatesOpen((open) => !open)}
            aria-expanded={templatesOpen}
            data-testid="settings-system-prompt-templates-toggle"
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface/60 text-ui-sm text-foreground-subtle transition-colors hover:bg-surface hover:text-foreground"
          >
            <Sparkles className="size-3.5" aria-hidden={true} />
            {intl.formatMessage(
              { id: "settings.systemPrompt.recommendedTemplates" },
              { count: RECOMMENDED_IDENTITY_TEMPLATES.length },
            )}
          </button>
          {templatesOpen ? (
            <div className="mt-2 space-y-2">
              {RECOMMENDED_IDENTITY_TEMPLATES.map((template) => (
                <div
                  key={template.id}
                  className="rounded-lg border border-border bg-surface/40 p-2"
                >
                  <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-ui-sm text-foreground-subtle">
                    {template.body}
                  </pre>
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => applyTemplate(template)}
                      data-testid={`settings-system-prompt-template-${template.id}`}
                    >
                      {intl.formatMessage({ id: "settings.systemPrompt.applyTemplate" })}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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
