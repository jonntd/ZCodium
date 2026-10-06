import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsBadge, SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/** 与 shared 的 customSystemPromptSchema 同一量程；提交前拦截，避免整份设置被 schema 拒绝。 */
const MAX_CUSTOM_SYSTEM_PROMPT_LENGTH = 200_000;

/**
 * 自定义系统提示词（docs/spec/custom-system-prompt.md）。
 * 语义为整段替换：非空值替换内置 stable 身份段并跳过动态 system 段；空串 = 内置默认，
 * 「恢复默认」就是提交空串（RPC 会丢弃 undefined，空串是唯一能穿越边界的清空载体）。
 * 组件自包含：经 useSettings 读写并触发 App 偏好同步，SettingsPage 侧用本地 Host
 * services 包裹，激活远程 workspace 时不会误读远端事实源。
 */
export function SystemPromptSection() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const savedValue =
    typeof settings?.customSystemPrompt === "string" ? settings.customSystemPrompt : "";
  const [draft, setDraft] = useState(savedValue);
  const [saving, setSaving] = useState(false);
  // settings 异步加载与跨窗口广播都会更新 savedValue：草稿还停留在上一个已保存值
  // （用户未输入）时跟随刷新；一旦开始编辑就保留草稿，避免广播把输入冲掉。
  const lastSavedValueRef = useRef(savedValue);
  useEffect(() => {
    if (lastSavedValueRef.current === savedValue) return;
    setDraft((current) => (current === lastSavedValueRef.current ? savedValue : current));
    lastSavedValueRef.current = savedValue;
  }, [savedValue]);

  const isDefault = savedValue.trim() === "";
  const dirty = draft.trim() !== savedValue.trim();
  const overLimit = draft.length > MAX_CUSTOM_SYSTEM_PROMPT_LENGTH;

  const applyValue = useCallback(
    async (value: string, successMessageId: string) => {
      setSaving(true);
      try {
        await update({ customSystemPrompt: value });
        setDraft(value);
        lastSavedValueRef.current = value;
        toast(intl.formatMessage({ id: successMessageId }));
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "settings.systemPromptSaveFailed" },
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      } finally {
        setSaving(false);
      }
    },
    [intl, update],
  );

  const handleSave = useCallback(() => {
    // 与 CLI handler 相同的 trim 规则，保证保存后草稿与已保存值严格一致（不再显示 dirty）。
    const normalized = draft.trim();
    void applyValue(
      normalized,
      isDefault ? "settings.systemPromptRestored" : "settings.systemPromptSaved",
    );
  }, [applyValue, draft, isDefault]);

  const handleRestore = useCallback(() => {
    void applyValue("", "settings.systemPromptRestored");
  }, [applyValue]);

  return (
    <SettingsGroupCard>
      <div className="px-4 pb-4 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.systemPrompt" })}
          </div>
          <SettingsBadge>
            {intl.formatMessage({
              id: isDefault
                ? "settings.systemPromptDefaultBadge"
                : "settings.systemPromptCustomizedBadge",
            })}
          </SettingsBadge>
        </div>
        <div className="mt-2 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPromptDescription" })}
        </div>
        <SettingsFormTextarea
          className="mt-3 min-h-40 w-full resize-y font-mono text-ui-sm"
          aria-label={intl.formatMessage({ id: "settings.systemPrompt" })}
          data-testid="settings-system-prompt-textarea"
          value={draft}
          placeholder={intl.formatMessage({ id: "settings.systemPromptPlaceholder" })}
          onChange={(event) => setDraft(event.target.value)}
        />
        {overLimit ? (
          <div className="mt-2 text-ui-sm text-destructive">
            {intl.formatMessage({ id: "settings.systemPromptOverLimit" })}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={saving || (isDefault && draft.trim() === "")}
            onClick={handleRestore}
          >
            {intl.formatMessage({ id: "settings.systemPromptRestore" })}
          </Button>
          <Button size="sm" disabled={saving || !dirty || overLimit} onClick={handleSave}>
            {intl.formatMessage({ id: "settings.systemPromptSave" })}
          </Button>
        </div>
      </div>
    </SettingsGroupCard>
  );
}
