// Composer 上下文占用环（1:1 移植自 deepseek-harness
// packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx 与
// context-occupancy.ts：14px viewBox 圆环 + 百分比读数，点击展开面板显示
// 标题句、~used / window 读数与占用条）。
//
// 2026-09-26 收口（spec §5）：原工具条 ChatContextUsage 面板的占用明细
// （breakdown，按来源估算的字符占比）与平均缓存命中率并入本展开面板——
// 工具条触发器是「移动」到统计行而非删除，功能随面板一并保留。
//
// 可见性由父组件 ComposerStatsRow 统一裁决（spec §5）：本组件被挂载即渲染读数，
// 容量未知（usage.contextWindow 为 null，如新会话首个 ModelComplete 之前）时以
// 0% 占位、环不画进度弧；展开面板仍以真实 contextWindow 为前提，点击不展开，
// 避免 ~0 / 0 的无意义读数。
//
// 数据契约差异：deepseek 的 contextPressure/contextBreakdown 投影在本仓库对应
// usage.contextWindow（usedTokens/maxTokens）；breakdown 为 chars 计数而非 token，
// 因此面板走 deepseek 的「无 breakdown」路径（单色占用条），不做 chars 冒充 token。
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BREAKDOWN_SOURCE_LABEL_ID,
  buildContextUsageBreakdownSegments,
  formatContextCacheHitRateLabel,
  getBreakdownToneStyle,
} from "@/chat-input-toolbar/contextUsage.js";

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = "\u0000";

/**
 * Format a token count for the compact context panel.
 * @param value - token count.
 * @returns Compact count using K or M when needed.
 */
function formatTokens(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/** deepseek context-occupancy.ts 的同款有界读数。 */
interface ContextOccupancy {
  percent: number;
  usedTokens: number;
  contextWindow: number;
}

/**
 * 已知容量（maxTokens > 0）才返回读数；null = 容量未知，读数按 0% 占位。
 * ComposerStatsRow 的整行可见性门槛复用同一判定，不另写第二份口径。
 */
export function contextOccupancy(
  pressure: { usedTokens: number; maxTokens: number } | null | undefined,
): ContextOccupancy | null {
  if (!pressure || pressure.maxTokens <= 0) return null;
  return {
    percent: Math.min(100, Math.round((pressure.usedTokens / pressure.maxTokens) * 100)),
    usedTokens: pressure.usedTokens,
    contextWindow: pressure.maxTokens,
  };
}

export function ComposerContextMeter({ snapshot }: { snapshot: ConversationSnapshot | null }) {
  const { intl, locale } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const context = contextOccupancy(snapshot?.usage.contextWindow ?? null);
  const available = context !== null;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // A model switch can temporarily remove capacity while this component stays
  // mounted. Close the now-unavailable panel instead of preserving stale UI.
  useEffect(() => {
    if (!available && open) setOpen(false);
  }, [available, open]);

  // Anchored position: side 'top', gap 8, margin 12（deepseek useAnchoredPosition 参数）。
  // 测量放在 open 变化后的 effect 里：内联 ref 回调中 setPos 会形成
  // 「渲染 → ref → setPos → 渲染」的无限更新循环（React #185，实测触发）。
  // setPos 按位置去重，滚动/窗口变化时也只在真正位移后写入。
  useEffect(() => {
    if (!open || !available) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      const panel = panelRef.current;
      if (!root || !panel) return;
      const rect = root.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const left = Math.min(
        Math.max(12, rect.left + rect.width / 2 - panelRect.width / 2),
        window.innerWidth - panelRect.width - 12,
      );
      const top = rect.top - panelRect.height - 8;
      setPos((current) =>
        current && Math.abs(current.left - left) < 1 && Math.abs(current.top - top) < 1
          ? current
          : { left, top },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [open, available, context?.percent]);

  useEffect(() => {
    if (!open || !available) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [available, open]);

  // deepseek useDismissOnOutsidePointer：面板打开时，点击 anchor 与面板之外即关闭。
  useEffect(() => {
    if (!open || !available) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [available, open]);

  // 2026-09-26 收口（spec §5）：工具条面板的占用明细与缓存命中率并入本面板，
  // 数据源同为 usage.contextWindow 的可选字段；全部为派生量，不落 store。
  const contextWindow = snapshot?.usage.contextWindow ?? null;
  const breakdownSegments = useMemo(
    () => buildContextUsageBreakdownSegments(contextWindow?.breakdown),
    [contextWindow?.breakdown],
  );
  const cacheHitRateLabel = useMemo(
    () =>
      formatContextCacheHitRateLabel(contextWindow?.cache?.hitRate, locale, {
        showBelowThreshold: import.meta.env.DEV,
      }),
    [contextWindow?.cache?.hitRate, locale],
  );
  const percentFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: "percent" }),
    [locale],
  );

  if (context === null) {
    // 容量未知（spec §5）：整行已由父组件裁决在场，这里渲染 0% 占位并禁用展开
    // （点击不 setOpen，避免 ~0 / 0 的无意义面板）；数据到位后原位更新。
    return (
      <span ref={rootRef} className="context-meter-root">
        <ControlHintTooltip
          standalone
          title={intl.formatMessage({ id: "chat.composer.context.aria" }, { percent: "0%" })}
        >
          <button
            type="button"
            className="context-meter-trigger"
            data-testid="v4-composer-context-meter"
            aria-label={intl.formatMessage({ id: "chat.composer.context.aria" }, { percent: "0%" })}
          >
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
              <circle className="context-meter-track" cx="7" cy="7" r={RADIUS} />
            </svg>
            <span>0%</span>
          </button>
        </ControlHintTooltip>
      </span>
    );
  }
  const percent = context.percent;
  const reading = `${percent}%`;
  const [headBefore = "", headAfter = ""] = intl
    .formatMessage({ id: "chat.composer.context.aria" }, { percent: READING_SLOT })
    .split(READING_SLOT)
    .map((part) => part.trim());

  return (
    <span ref={rootRef} className="context-meter-root">
      <ControlHintTooltip
        standalone
        title={intl.formatMessage({ id: "chat.composer.context.aria" }, { percent: reading })}
      >
        <button
          type="button"
          className="context-meter-trigger"
          data-testid="v4-composer-context-meter"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={intl.formatMessage(
            { id: "chat.composer.context.aria" },
            { percent: reading },
          )}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className="context-meter-track" cx="7" cy="7" r={RADIUS} />
            {/* 0% 时不画进度弧：stroke-linecap round 会把 0 长度 dash 渲染成
                顶部圆点，看起来像脏点而非空环。 */}
            {percent > 0 && (
              <circle
                className="context-meter-fill"
                cx="7"
                cy="7"
                r={RADIUS}
                strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
                transform="rotate(-90 7 7)"
              />
            )}
          </svg>
          <span>{reading}</span>
        </button>
      </ControlHintTooltip>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="context-meter-panel"
            role="dialog"
            aria-label={intl.formatMessage({ id: "chat.composer.context.used" })}
            style={pos ?? { position: "fixed", visibility: "hidden", left: 0, top: 0 }}
          >
            <div className="context-meter-header">
              {/* Empty sides collapse through `:empty` so the locale that needs
                  no leading (or trailing) text spends no header gap. */}
              <span className="context-meter-headline">{headBefore}</span>
              <span className="context-meter-percent">{reading}</span>
              <span className="context-meter-headline">{headAfter}</span>
              <span className="context-meter-figures">
                {`~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`}
              </span>
            </div>
            <div className="context-meter-bar">
              <div className="context-meter-segment" style={{ width: `${percent}%` }} />
            </div>
            {/* 2026-09-26 自工具条 ChatContextUsage 面板并入：占用明细（按来源
                字符占比）与平均缓存命中率，功能随触发器一并「移动」到统计行。 */}
            {breakdownSegments.length > 0 ? (
              <div
                aria-label={intl.formatMessage({ id: "chat.contextUsage.breakdown" })}
                className="context-meter-breakdown"
              >
                {breakdownSegments.map((segment, index) => (
                  <div className="context-meter-breakdown-row" key={segment.source}>
                    <span
                      aria-hidden="true"
                      className="context-meter-breakdown-dot"
                      style={getBreakdownToneStyle(index)}
                    />
                    <span className="context-meter-breakdown-label">
                      {intl.formatMessage({ id: BREAKDOWN_SOURCE_LABEL_ID[segment.source] })}
                    </span>
                    <span className="context-meter-breakdown-value">
                      {percentFormatter.format(segment.percent)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {cacheHitRateLabel ? (
              <div
                className={
                  breakdownSegments.length > 0
                    ? "context-meter-cache-row context-meter-cache-row-divided"
                    : "context-meter-cache-row"
                }
              >
                <span className="context-meter-breakdown-label">
                  {intl.formatMessage({ id: "chat.contextUsage.cacheHitRate" })}
                </span>
                <span className="context-meter-breakdown-value">{cacheHitRateLabel}</span>
              </div>
            ) : null}
          </div>,
          document.body,
        )}
    </span>
  );
}
