import type { ComponentPropsWithoutRef } from "react";
import { LoaderIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildConversationWorkingStatusPillModel } from "@/v4/conversationWorkingStatusPillModel.js";

export interface ConversationWorkingStatusPillProps extends ComponentPropsWithoutRef<"span"> {
  /** 已格式化的工作时长（formatConversationWorkDuration）；null 时「用时」段整体不渲染。 */
  durationLabel: string | null;
}

/**
 * 运行中工作状态胶囊（docs/spec/assistant-working-status-pill.md）：
 * 图标 + 状态词（扫光）+ 已用时 + 动态省略号。图标保持静态——长驻运行态
 * 不放旋转动画是仓库既有性能规则，「仍在进行」由扫光与省略号表达。
 */
export function ConversationWorkingStatusPill({
  durationLabel,
  className,
  ...props
}: ConversationWorkingStatusPillProps) {
  const { intl } = useZCodeIntl();
  const model = buildConversationWorkingStatusPillModel({ durationLabel });

  return (
    <span
      data-zcode-working-pill="true"
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-border bg-surface px-3.5 py-1.5 text-ui-base",
        className,
      )}
      {...props}
    >
      <LoaderIcon aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
      <span className="animated-gradient-text font-medium">
        {intl.formatMessage({ id: model.statusMessageId })}
      </span>
      {model.elapsedMessageId && durationLabel ? (
        <span className="text-foreground-subtlest">
          {intl.formatMessage({ id: model.elapsedMessageId }, { duration: durationLabel })}
        </span>
      ) : null}
      <span aria-hidden="true" className="flex items-center gap-1 text-foreground-subtlest">
        <span data-working-pill-dot="true" className="size-1 rounded-full bg-current" />
        <span data-working-pill-dot="true" className="size-1 rounded-full bg-current" />
        <span data-working-pill-dot="true" className="size-1 rounded-full bg-current" />
      </span>
    </span>
  );
}
