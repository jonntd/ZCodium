import { useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 回复语言（docs/spec/response-language.md）：声明模型回复的首选语言。
 * 固定列表（各语言的本地写法），不做自由文本，避免把任意内容注入 prompt。
 * 挂在系统提示词分区底部——它与「Preferred response language」提示行同属 prompt
 * 作用域，但不参与分段草稿/保存流程（选中即保存）。radix Select 不允许空字符串
 * value，「跟随用户消息」用哨兵值 FOLLOW_USER 表示，落盘时映射回空串。
 */
const FOLLOW_USER = "__follow_user__";

export const RESPONSE_LANGUAGE_OPTIONS = [
  "简体中文",
  "繁體中文",
  "English",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Español",
] as const;

export function ResponseLanguageField() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const savedLanguage = settings?.language ?? "";
  const onSelect = useCallback(
    (value: string) => {
      void update({ language: value === FOLLOW_USER ? "" : value }).catch((error) => {
        logger.warn("[settings] 保存回复语言失败", error);
      });
    },
    [update],
  );

  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <div className="min-w-0">
        <div className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "settings.responseLanguage" })}
        </div>
        <div className="text-ui-sm leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.responseLanguageDescription" })}
        </div>
      </div>
      <Select value={savedLanguage || FOLLOW_USER} onValueChange={onSelect}>
        <SelectTrigger className="w-[180px] shrink-0" data-testid="settings-response-language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_USER}>
            {intl.formatMessage({ id: "settings.responseLanguageFollow" })}
          </SelectItem>
          {RESPONSE_LANGUAGE_OPTIONS.map((language) => (
            <SelectItem key={language} value={language}>
              {language}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
