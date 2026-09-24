// Composer 下方统计行（1:1 移植自 deepseek-harness
// packages/client/ui-chat/src/client/chat/StatsPills.tsx 的 compact 形态：
// 「⚡ X tok/s」「🗄 缓存命中 X%」两个纯读数 pill，composer 下方居中）。
//
// 数据契约差异（deepseek 用 durable sessionStats 投影的逐步 decode 计时；
// 本仓库 snapshot 无逐请求 timing，速度改由最近一轮推导，口径见 turnStats.ts）：
//   - 流式 = 文本增量估算的 4s 滑动窗口即时速度；静默期保持最近速度
//   - 结束轮 = out ÷（endedAt − 首内容行 createdAt）
// 缓存命中与 deepseek 同一算法（formatCacheHitPercent：部分命中不进位成 100%），
// 分子/分母映射到本仓库 usage.cumulative（inputTokens 已含缓存读写的总 prompt）。
import { memo, useEffect, useMemo, useRef } from "react";
import { DatabaseIcon, GaugeIcon } from "lucide-react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  STREAM_WINDOW_MS,
  formatTokensPerSecond,
  resolveLatestTurnStats,
  type TurnStats,
} from "@/v4/composer/turnStats.js";
import { formatCacheHitPercent } from "@/v4/composer/cacheHitPercent.js";

/** deepseek StatsPills 的窗口折叠兜底在本仓库的对应物：最近一轮的 decode 读数。 */
function resolveTurnSpeed(
  stats: TurnStats,
  windowRef: { current: { turnId: string; samples: [number, number][] } | null },
  lastTpsRef: { current: number | null },
): number | null {
  if (stats.streaming) {
    const now = Date.now();
    const current = windowRef.current;
    if (!current || current.turnId !== stats.turnId) {
      windowRef.current = { turnId: stats.turnId, samples: [[now, stats.textTokens]] };
      lastTpsRef.current = null;
    } else {
      const samples = current.samples;
      const last = samples[samples.length - 1];
      if (!last || now - last[0] >= 60 || stats.textTokens !== last[1]) {
        samples.push([now, stats.textTokens]);
      }
      const floor = now - STREAM_WINDOW_MS;
      while (samples.length > 2 && samples[0]![0] < floor) samples.shift();
    }
    const samples = windowRef.current?.samples ?? [];
    let tps: number | null = null;
    if (samples.length >= 2) {
      const dt = (samples[samples.length - 1]![0] - samples[0]![0]) / 1000;
      const dtok = samples[samples.length - 1]![1] - samples[0]![1];
      if (dt >= 0.6 && dtok > 0) tps = dtok / dt;
    }
    if (tps == null) tps = lastTpsRef.current;
    if (tps != null) lastTpsRef.current = tps;
    return tps;
  }
  // 结束轮：优先冻结流式期间最后的滑动窗口速度——全轮均值（endedAt − 首内容行）
  // 的分母包含工具执行时间（deepseek 的 decode 计时不含），agentic 长轮会被低估到
  // <1 tok/s，读数会在结算瞬间消失；冻结值是真实测到的文本生成速度，保持连续。
  // 仅冷打开（本轮从未流式观测过）才用全轮均值估算，<1 tok/s 视为噪声隐藏。
  if (lastTpsRef.current != null) return lastTpsRef.current;
  if (stats.endedAt != null && stats.firstContentAt != null) {
    const decodeMs = stats.endedAt - stats.firstContentAt;
    const out = Math.max(stats.textTokens, stats.preciseOutputTokens ?? 0);
    if (decodeMs > 500 && out > 0) {
      const tps = out / (decodeMs / 1000);
      return tps >= 1 ? tps : null;
    }
  }
  return null;
}

function ComposerStatsRowImpl({ snapshot }: { snapshot: ConversationSnapshot | null }) {
  const { intl } = useZCodeIntl();
  const stats = useMemo(
    () => resolveLatestTurnStats(snapshot?.rows.window ?? []),
    [snapshot?.rows.window],
  );
  const cumulative = snapshot?.usage.cumulative;
  // deepseek hasTokens 门槛：无任何计费 token（如全部请求失败）不显示用量读数。
  const hasTokens =
    cumulative != null && (cumulative.inputTokens > 0 || cumulative.outputTokens > 0);
  const cacheHit =
    hasTokens && cumulative
      ? formatCacheHitPercent(cumulative.cacheReadTokens, cumulative.inputTokens)
      : null;

  // 流式窗口与结束轮 precise out 基线：仅跨帧瞬时量，不入 store。
  const windowRef = useRef<{ turnId: string; samples: [number, number][] } | null>(null);
  const baselineRef = useRef<{ turnId: string; baseline: number } | null>(null);
  const lastTpsRef = useRef<number | null>(null);
  useEffect(() => {
    // 换会话即重置：旧轮的窗口/基线不能泄漏到新会话。
    windowRef.current = null;
    baselineRef.current = null;
    lastTpsRef.current = null;
  }, [snapshot?.sessionId]);

  // 结束轮 out：precise（cumulative 基线差）与内容估算取大，写回 stats 供速度计算。
  // 基线必须在流式期间就按 turnId 登记——若等轮完成才登记，基线会包含本轮自己的
  // 输出，precise out 恒为 0，速度退化为纯文本估算。
  let speed: number | null = null;
  if (stats) {
    const cumulativeOutput = cumulative?.outputTokens ?? null;
    if (cumulativeOutput != null) {
      const current = baselineRef.current;
      if (!current || current.turnId !== stats.turnId) {
        // 首次观测到该轮：以当前累计为基线（turnHeader 先于内容行下发，近似轮起点）。
        baselineRef.current = { turnId: stats.turnId, baseline: cumulativeOutput };
        stats.preciseOutputTokens = 0;
      } else {
        stats.preciseOutputTokens = Math.max(0, cumulativeOutput - current.baseline);
      }
    }
    speed = resolveTurnSpeed(stats, windowRef, lastTpsRef);
  }

  if (speed === null && cacheHit === null) return null;
  return (
    <>
      {speed !== null && (
        <span className="composer-stats-pill" data-testid="v4-composer-speed-pill">
          <GaugeIcon aria-hidden />
          {intl.formatMessage(
            { id: "chat.composer.stats.tps" },
            { tps: formatTokensPerSecond(speed) },
          )}
        </span>
      )}
      {cacheHit !== null && (
        <span className="composer-stats-pill" data-testid="v4-composer-cache-pill">
          <DatabaseIcon aria-hidden />
          {intl.formatMessage({ id: "chat.composer.stats.cacheHit" }, { percent: cacheHit })}
        </span>
      )}
    </>
  );
}

export const ComposerStatsRow = memo(ComposerStatsRowImpl);
