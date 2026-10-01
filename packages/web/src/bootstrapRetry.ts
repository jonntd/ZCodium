/**
 * Web bootstrap 的**有界**自动重试策略（契约见 docs/spec/web-bootstrap-delivery-point.md）。
 *
 * 为什么要有：`connectViaWebSocket` 现在以「收到服务端 `Initialize`」为交付点，因此
 * 「桌面刚重启 / relay 宽限到期」这类**瞬时**失败会明确抛错。整页重新连一次通常就能成功，
 * 这比让用户在错误页上手动点「重试」体验好；但绝不能无限重连——真实离线必须尽快落到错误页。
 *
 * 默认上限 2 次尝试（即 1 次自动重试）：最坏情况只多等「一次连接 + 1s 退避」。
 * 若将来提高上限，退避按 1s / 2s / 4s 递增，避免对 relay 放大压力。
 */
export const WEB_BOOTSTRAP_MAX_ATTEMPTS = 2;
export const WEB_BOOTSTRAP_RETRY_BASE_DELAY_MS = 1_000;

export interface BoundedRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** 测试注入点：默认 setTimeout；注入后可在毫秒内跑完退避。 */
  wait?: (delayMs: number) => Promise<void>;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * 失败后按指数退避做**有界**重试；超过上限抛出**最后一次**错误（保留真实失败原因，
 * 供错误页展示）。成功即返回，不产生任何多余等待。
 */
export async function connectWithBoundedRetry<T>(
  attempt: () => Promise<T>,
  options: BoundedRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? WEB_BOOTSTRAP_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? WEB_BOOTSTRAP_RETRY_BASE_DELAY_MS;
  const wait = options.wait ?? defaultWait;
  let lastError: unknown;
  for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (attemptIndex < maxAttempts) {
        await wait(baseDelayMs * 2 ** (attemptIndex - 1));
      }
    }
  }
  throw lastError;
}
