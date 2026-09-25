// 缓存命中百分比格式化（1:1 移植自 deepseek-harness
// packages/client/ui-chat/src/client/chat/token-format.ts）。
// 特性：整数精度优先；部分命中不会被进位成 100%（贴近 100 时自动升位到
// 99.9x，保持诚实）；无 prompt 输入时返回 null。

/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
function roundedPercentUnits(
  cacheReadTokens: number,
  denominator: number,
  decimalPlaces: 0 | 1,
): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
  const scale = unitsPerPercent * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    const threshold =
      factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale);
    if (cacheReadTokens >= threshold) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

/**
 * Display-ready cache-hit share without rounding a partial hit to 100%.
 * @param cacheReadTokens - exact prompt tokens served from cache.
 * @param promptTokens - exact aggregate prompt tokens.
 * @param decimalPlaces - ordinary-ratio precision; partial hits that would
 * round to 100 automatically use enough additional precision to stay honest.
 * @returns percentage text, or null when there was no prompt input.
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens <= 0) return null;
  // 异常上报钳制（bugfix）：cacheRead 是 prompt 的子集，不可能超过总 prompt。
  // 第三方中转（modelhub 引入的任意 OpenAI 兼容端点）可能按 Anthropic 口径上报
  // 「input 不含 cache_read」，此时下方 missedInputTokens 为负、scaledDoubleGap
  // 恒为负，`while (scaledDoubleGap <= denominatorTens)` 永不退出——渲染主线程
  // 死循环，整个窗口冻结（审核实测复现）。超界按满命中处理，负数 input 不显示。
  if (cacheReadTokens >= promptTokens) return "100";
  const missedInputTokens = promptTokens - cacheReadTokens;

  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000;
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces);

  let distinguishingPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}
