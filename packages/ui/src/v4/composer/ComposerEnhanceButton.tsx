/**
 * ✨ 提示词增强按钮（统一链路版）。
 *
 * 读取 composer 草稿 → promptAssistService.enhancePromptDraft（跟随会话当前模型，
 * 走 Agent runtime 统一执行面，模板/校验/清洗全部在服务层）→ 整体替换草稿；
 * 误增强用编辑器原生 Cmd+Z 撤销。toast 只在空草稿、unchanged 直判与失败三种
 * 有信息量的场景出现。Ctrl+/（composer 聚焦时）快捷增强，run 经 onRegisterRun
 * 注册给 composer。统一服务对 desktop/web 全量暴露，按钮在两种环境都渲染；
 * 异常只 toast，不阻塞 composer。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";

/** 防双击/事件重放导致重复请求（与补丁一致）。 */
const RUN_COOLDOWN_MS = 1200;

function ComposerEnhanceButtonImpl(props: {
  workspacePath: string;
  workspaceIdentity?: string;
  draftText: string;
  onReplaceDraft: (text: string) => void;
  disabled?: boolean;
  /** 把 run 注册给 composer（Ctrl+/ 快捷键）；卸载时注册 null。 */
  onRegisterRun?: (run: (() => void) | null) => void;
}) {
  const { workspacePath, workspaceIdentity, draftText, onReplaceDraft, disabled, onRegisterRun } =
    props;
  const { promptAssistService } = useServices();
  const { intl } = useZCodeIntl();
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const lastRunRef = useRef(0);
  // run/注册回调读到的始终是最新 props，不进依赖数组。
  const draftRef = useRef(draftText);
  draftRef.current = draftText;
  const replaceRef = useRef(onReplaceDraft);
  replaceRef.current = onReplaceDraft;

  const available = promptAssistService != null;

  const run = useCallback(async () => {
    if (!promptAssistService || runningRef.current) return;
    const now = Date.now();
    if (now - lastRunRef.current < RUN_COOLDOWN_MS) return;
    lastRunRef.current = now;
    const draft = draftRef.current.trim();
    if (!draft) {
      toast(intl.formatMessage({ id: "chat.composer.enhance.emptyDraft" }), { variant: "warning" });
      return;
    }
    runningRef.current = true;
    setRunning(true);
    try {
      const result = await promptAssistService.enhancePromptDraft({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        text: draft,
      });
      if (result.unchanged) {
        // 短输入直判命中：输入不适合改写，保留原文，不强行替换。
        toast(intl.formatMessage({ id: "chat.composer.enhance.unchanged" }));
        return;
      }
      if (result.text.trim()) {
        // 静默替换；误增强用编辑器原生 Cmd+Z 撤销，不打扰。
        replaceRef.current(result.text);
      } else {
        // 服务端 sanitize 契约保证非空（空回退原文），这里只防异常返回空串。
        toast(
          intl.formatMessage({ id: "chat.composer.enhance.failed" }, { error: "empty result" }),
          { variant: "warning" },
        );
      }
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "chat.composer.enhance.failed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
        { variant: "warning" },
      );
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [intl, promptAssistService, workspaceIdentity, workspacePath]);

  // Ctrl+/ 快捷键：run 注册给 composer；不可用/卸载时注册 null。
  useEffect(() => {
    if (!available || !onRegisterRun) return;
    onRegisterRun(() => void run());
    return () => onRegisterRun(null);
  }, [available, onRegisterRun, run]);

  if (!available) return null;

  return (
    <span className="inline-flex items-center" data-testid="v4-composer-enhance">
      <ControlHintTooltip title={intl.formatMessage({ id: "chat.composer.enhance.tooltip" })}>
        <Button
          type="button"
          variant="ghost"
          size="default"
          data-testid="v4-composer-enhance-button"
          aria-label={intl.formatMessage({ id: "chat.composer.enhance.label" })}
          disabled={disabled || running}
          onClick={() => void run()}
          className="h-7 w-fit justify-center rounded-lg px-1.5 py-1.5 text-ui-base data-[composer-compact=true]:size-7 data-[composer-compact=true]:p-0"
        >
          {running ? (
            <Loader2Icon
              className="size-4 shrink-0 animate-spin text-foreground-subtle"
              aria-hidden
            />
          ) : (
            <SparklesIcon className="size-4 shrink-0" aria-hidden />
          )}
        </Button>
      </ControlHintTooltip>
    </span>
  );
}

export const ComposerEnhanceButton = memo(ComposerEnhanceButtonImpl);
