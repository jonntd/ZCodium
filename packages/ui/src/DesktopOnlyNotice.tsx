import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 桌面专属能力的统一降级说明（docs/spec/web-remote-ui-parity.md §2.2-B）。
 *
 * B 类差异的原则是「不统一功能，但统一交代方式」：Web/中继页缺少平台能力时，
 * 不再静默消失，而是用同一套组件、同一套视觉、同一批 i18n key 说明原因。
 * 两个形态：
 * - `block`：面板 / 设置页内的提示块，视觉沿用 `settings.browser.desktopOnly` 先例
 *   （圆角边框 + surface 底 + 弱化文字）。
 * - `menu`：下拉菜单内的非交互说明行，内边距对齐 DropdownMenuItem，但不可聚焦、
 *   不响应点击——避免"看起来能点"的假入口。
 *
 * 默认文案 `common.desktopOnly`（「仅桌面端可用」）；需要列举具体能力时传 messageId，
 * 由调用方提供更精确的说明（例如帮助菜单的「导出日志、更新与关于仅在桌面端可用」）。
 */
export interface DesktopOnlyNoticeProps {
  /** 覆盖默认文案 id；缺省 `common.desktopOnly`。 */
  messageId?: string;
  /** 渲染形态：块级提示或菜单内说明行。 */
  variant?: "block" | "menu";
  className?: string;
}

export function DesktopOnlyNotice({
  messageId = "common.desktopOnly",
  variant = "block",
  className,
}: DesktopOnlyNoticeProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      role="note"
      data-testid="desktop-only-notice"
      data-variant={variant}
      className={cn(
        "text-foreground-subtle",
        variant === "block" && "rounded-lg border border-border bg-surface px-4 py-3 text-ui-base",
        variant === "menu" && "px-2 py-1 text-ui-base/relaxed",
        className,
      )}
    >
      {intl.formatMessage({ id: messageId })}
    </div>
  );
}
