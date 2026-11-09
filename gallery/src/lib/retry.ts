// 浏览器侧列表请求的退避重试。不引入任何服务端模块，避免把 Token / manage 路径打进 bundle。

export const LIST_MAX_RETRIES = 2;
const LIST_BACKOFF_MS = [300, 800];

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

/** 网络错误、429、5xx 重试；401/403/404 以及其它 4xx 不重试。取消的请求不重试。 */
export function shouldRetryListError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status?: number }).status) : NaN;
  if (!Number.isFinite(status)) return true;
  if (status === 429 || status >= 500) return true;
  return false;
}

/** attempt 从 0 起：约 300ms、800ms，±20% 抖动。 */
export function listRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const i = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const last = LIST_BACKOFF_MS[LIST_BACKOFF_MS.length - 1];
  const base = i < LIST_BACKOFF_MS.length ? LIST_BACKOFF_MS[i] : last * 2 ** (i - (LIST_BACKOFF_MS.length - 1));
  const roll = Number(random());
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0.5;
  const delta = Math.round((unit - 0.5) * 2 * base * 0.2);
  return Math.max(0, base + delta);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runWithRetry<T>(
  run: () => Promise<T>,
  options: {
    maxRetries?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    shouldRetry?: (err: unknown) => boolean;
    delayMs?: (attempt: number, random: () => number) => number;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? LIST_MAX_RETRIES;
  const sleep = options.sleep ?? ((ms) => delay(ms));
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? shouldRetryListError;
  const delayMs = options.delayMs ?? listRetryDelayMs;
  let last: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await run();
    } catch (err) {
      last = err;
      if (!shouldRetry(err) || attempt >= maxRetries) throw err;
      await sleep(delayMs(attempt, random));
    }
  }
  throw last;
}
