/**
 * ✨ 提示词增强按钮（zcode-patcher --enhance-btn 原生版，行为与 zcode-enhance.js 对齐）。
 *
 * 主按钮：读取 composer 草稿 → 经 IPlatformService.enhancePromptDraft 由桌面 main
 * 进程调用指定（或自动评分）渠道改写 → 整体替换草稿；toast 提供一键撤销。
 * 下拉菜单：改写模式（简洁/创意）+ 增强模型（按渠道分组列出全部模型，含 ★当前渠道 /
 * 无凭据 / P 优先级徽标）；选择持久化在 localStorage，与补丁同键（升级迁移无缝）。
 * Ctrl+/（composer 聚焦时）快捷增强，run 经 onRegisterRun 注册给 composer。
 * 平台不支持（Web / 缺少 preload bridge）时整体不渲染；异常只 toast，不阻塞 composer。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import type { EnhanceListModelsResult } from "@zcode/shared";

type EnhanceSelection = { channel: string; model: string };
/** 显式「自动」；与补丁 {channel,model} 同库存储，补丁的旧指定数据天然兼容。 */
type StoredSelection = { auto: true } | EnhanceSelection;

const SEL_KEY = "zcode-enhance-model";
/** 防双击/事件重放导致重复请求（与补丁一致）。 */
const RUN_COOLDOWN_MS = 1200;

function readSelection(): StoredSelection | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEL_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      if ((parsed as { auto?: unknown }).auto === true) return { auto: true };
      const candidate = parsed as EnhanceSelection;
      if (typeof candidate.channel === "string" && typeof candidate.model === "string") {
        return { channel: candidate.channel, model: candidate.model };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function writeSelection(sel: StoredSelection | null): void {
  try {
    if (sel) localStorage.setItem(SEL_KEY, JSON.stringify(sel));
    else localStorage.removeItem(SEL_KEY);
  } catch {
    /* 静默 */
  }
}

function ComposerEnhanceButtonImpl(props: {
  draftText: string;
  onReplaceDraft: (text: string) => void;
  disabled?: boolean;
  /** composer 当前选中的模型；未指定增强模型时的默认目标。 */
  currentProviderId?: string | null;
  currentModelId?: string | null;
  /** 把 run 注册给 composer（Ctrl+/ 快捷键）；不可用/卸载时注册 null。 */
  onRegisterRun?: (run: (() => void) | null) => void;
}) {
  const { draftText, onReplaceDraft, disabled, currentProviderId, currentModelId, onRegisterRun } =
    props;
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  const [selection, setSelection] = useState<StoredSelection | null>(() => readSelection());
  const [channels, setChannels] = useState<EnhanceListModelsResult | null>(null);
  const [running, setRunning] = useState(false);
  const channelsRef = useRef<EnhanceListModelsResult | null>(null);
  const runningRef = useRef(false);
  const lastRunRef = useRef(0);
  // run/注册回调读到的始终是最新 props/state，不进依赖数组。
  const draftRef = useRef(draftText);
  draftRef.current = draftText;
  const replaceRef = useRef(onReplaceDraft);
  replaceRef.current = onReplaceDraft;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const currentTargetRef = useRef<{ channel?: string | null; model?: string | null }>({
    channel: currentProviderId,
    model: currentModelId,
  });
  currentTargetRef.current = { channel: currentProviderId, model: currentModelId };

  const available = platform?.enhancePromptDraft != null;

  const run = useCallback(async () => {
    if (!platform?.enhancePromptDraft || runningRef.current) return;
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
      const sel = selectionRef.current;
      // 目标优先级（与补丁一致）：面板指定 > enhance-config 手动（main 侧处理）> 评分链；
      // 本地默认档「跟随当前模型」介于指定与评分之间——composer 选中的模型最可靠，
      // main 侧解析不到（渠道禁用/模型已删）时自动回落评分链。
      let channel: string | undefined;
      let model: string | undefined;
      if (sel && "channel" in sel) {
        channel = sel.channel;
        model = sel.model;
      } else if (!sel) {
        channel = currentTargetRef.current.channel ?? undefined;
        model = currentTargetRef.current.model ?? undefined;
      }
      const result = await platform.enhancePromptDraft({
        text: draft,
        ...(channel && model ? { channel, model } : {}),
      });
      if (result.ok && result.unchanged) {
        // 独立链路命中：输入难以改进或不适合改动，保留原文，不强行替换。
        toast(intl.formatMessage({ id: "chat.composer.enhance.unchanged" }));
        return;
      }
      if (result.ok && result.text && result.text.trim()) {
        // 静默替换；误增强用编辑器原生 Cmd+Z 撤销，不打扰。
        replaceRef.current(result.text);
      } else {
        toast(
          intl.formatMessage({ id: "chat.composer.enhance.failed" }, { error: result.error ?? "" }),
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
  }, [intl, platform]);

  // Ctrl+/ 快捷键：run 注册给 composer；平台不支持时注册 null。
  useEffect(() => {
    if (!available || !onRegisterRun) return;
    onRegisterRun(() => void run());
    return () => onRegisterRun(null);
  }, [available, onRegisterRun, run]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open || channelsRef.current || !platform?.enhanceListModels) return;
      void platform
        .enhanceListModels()
        .then((result) => {
          // 失败结果不进缓存（bugfix）：channelsRef 只在 ok 时落值，否则一次
          // 瞬时失败后菜单在整个组件生命周期内只剩「跟随/自动」，无法自愈；
          // 置空让下次展开重试。
          channelsRef.current = result.ok ? result : null;
          setChannels(result);
          // 指定的渠道已失效（被删/禁用/官方渠道）→ 清掉恢复自动评分链（与补丁一致）。
          const sel = selectionRef.current;
          if (
            sel &&
            !("auto" in sel) &&
            result.ok &&
            !result.channels.some((entry) => entry.id === sel.channel)
          ) {
            selectionRef.current = null;
            setSelection(null);
            writeSelection(null);
            toast(
              intl.formatMessage(
                { id: "chat.composer.enhance.restoredAuto" },
                { channel: sel.channel },
              ),
            );
          }
        })
        .catch(() => {
          /* 渠道列表拿不到时菜单只剩「自动」，主流程不受影响 */
        });
    },
    [intl, platform],
  );

  const handleSelectModel = useCallback((channel: string, model: string) => {
    const sel = { channel, model };
    selectionRef.current = sel;
    setSelection(sel);
    writeSelection(sel);
  }, []);

  // 方案 A：菜单内勾选可见化 —— follow/auto 用一个 RadioGroup，各渠道模型
  // 子菜单各用一个 RadioGroup；value 全部由持久化的 selection 派生。
  const sourceValue = selection == null ? "follow" : "auto" in selection ? "auto" : "";
  const pinnedModelIn = useCallback(
    (channelId: string): string | null =>
      selection && !("auto" in selection) && selection.channel === channelId
        ? selection.model
        : null,
    [selection],
  );
  const handleSourceChange = useCallback((value: string) => {
    if (value === "auto") {
      selectionRef.current = { auto: true };
      setSelection({ auto: true });
      writeSelection({ auto: true });
      return;
    }
    selectionRef.current = null;
    setSelection(null);
    writeSelection(null);
  }, []);
  const statusTarget = (() => {
    if (selection == null) {
      return currentModelId
        ? intl.formatMessage(
            { id: "chat.composer.enhance.followCurrent" },
            { model: currentModelId },
          )
        : intl.formatMessage({ id: "chat.composer.enhance.channel.auto" });
    }
    if ("auto" in selection) {
      return intl.formatMessage({ id: "chat.composer.enhance.channel.auto" });
    }
    // 指定模型时用渠道显示名（work），不用裸 UUID。
    const channelName =
      channelsRef.current?.channels.find((entry) => entry.id === selection.channel)?.name ??
      selection.channel;
    return `${channelName} / ${selection.model}`;
  })();

  if (!available) return null;

  const usableChannels = channels?.ok ? channels.channels : [];

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
          className="h-7 w-fit justify-center rounded-l-lg px-1.5 py-1.5 text-ui-base data-[composer-compact=true]:size-7 data-[composer-compact=true]:p-0"
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
      <DropdownMenu onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            aria-label={intl.formatMessage({ id: "chat.composer.enhance.options" })}
            disabled={disabled || running}
            className="h-7 w-fit justify-center rounded-l-none rounded-r-lg px-0.5 py-1.5 text-ui-base"
          >
            <ChevronDownIcon className="size-3 shrink-0 text-foreground-subtle" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          {/* 当前增强目标状态行（方案 A）：先于一切选项展示实际生效的目标。 */}
          <DropdownMenuLabel data-testid="v4-composer-enhance-current">
            {intl.formatMessage({ id: "chat.composer.enhance.current" }, { target: statusTarget })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sourceValue}
            onValueChange={(value) => handleSourceChange(value)}
          >
            <DropdownMenuRadioItem value="follow" disabled={!currentModelId}>
              {intl.formatMessage(
                { id: "chat.composer.enhance.followCurrent" },
                { model: currentModelId ?? "" },
              )}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="auto">
              {intl.formatMessage({ id: "chat.composer.enhance.channel.auto" })}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {channels?.manual ? (
            <DropdownMenuItem disabled>
              {intl.formatMessage(
                { id: "chat.composer.enhance.manualHint" },
                { model: channels.manual.model },
              )}
            </DropdownMenuItem>
          ) : null}
          {channels?.ok && usableChannels.length === 0 ? (
            <DropdownMenuItem disabled>
              {intl.formatMessage({ id: "chat.composer.enhance.noChannels" })}
            </DropdownMenuItem>
          ) : null}
          {usableChannels.map((entry) => (
            <DropdownMenuSub key={entry.id}>
              <DropdownMenuSubTrigger>
                <span className="min-w-0 truncate">
                  {entry.name || entry.id}
                  <span className="text-foreground-subtle">
                    {" "}
                    · {entry.kind || "?"}
                    {entry.selected
                      ? ` · ${intl.formatMessage({ id: "chat.composer.enhance.badge.current" })}`
                      : ""}
                    {!entry.hasKey
                      ? ` · ${intl.formatMessage({ id: "chat.composer.enhance.badge.noKey" })}`
                      : ""}
                  </span>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                <DropdownMenuRadioGroup
                  value={pinnedModelIn(entry.id) ?? ""}
                  onValueChange={(modelId) => handleSelectModel(entry.id, modelId)}
                >
                  {entry.models.map((model) => (
                    <DropdownMenuRadioItem key={model.id} value={model.id}>
                      {/* priority 仅作 main 侧排序元数据；按产品规则不在 UI
                          显示优先级徽标（spec：patcher-parity §6）。 */}
                      <span className="min-w-0 flex-1 truncate font-mono text-ui-sm">
                        {model.id}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

export const ComposerEnhanceButton = memo(ComposerEnhanceButtonImpl);
