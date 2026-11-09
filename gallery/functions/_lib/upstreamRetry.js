// 上游列表的重试判定、退避和 Cache API 键。
// 全部是可注入 sleep/fetch/cache 的纯函数，不读环境变量，也不接触 Token。

export const D1_OVERLOAD_MARK = 'D1 DB is overloaded';
export const DEFAULT_MAX_RETRIES = 3;
/** 第 1/2/3 次重试前的基准等待。实际值再加 ±20% 抖动。 */
export const RETRY_BACKOFF_MS = [300, 800, 1600];
export const UPSTREAM_CACHE_SECONDS = 300;

const CACHE_QUERY_KEYS = new Set(['dir', 'start', 'count']);
const FORBIDDEN_CACHE_HEADERS = ['authorization', 'cookie', 'cf-access-jwt-assertion'];

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeMaxRetries(value, fallback = DEFAULT_MAX_RETRIES) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(8, Math.floor(n));
}

/**
 * 是否值得再打一次上游。
 * 401/403 以及其它 4xx（除 429）一律不重试，哪怕 body 里提到 D1。
 * 5xx、429、fetch 抛错，以及非 4xx 响应正文含 D1 过载文案时重试。
 */
export function isRetryableUpstreamFailure({ status, bodyText, networkError } = {}) {
  if (networkError) return true;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  if (typeof bodyText === 'string' && bodyText.includes(D1_OVERLOAD_MARK)) return true;
  return false;
}

/** attempt 从 0 起：第 1 次重试前约 300ms，然后 800ms、1.6s，之后按 2 倍继续。 */
export function retryDelayMs(attempt, random = Math.random) {
  const i = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const last = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  const base = i < RETRY_BACKOFF_MS.length ? RETRY_BACKOFF_MS[i] : last * 2 ** (i - (RETRY_BACKOFF_MS.length - 1));
  const roll = typeof random === 'function' ? Number(random()) : 0.5;
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0.5;
  const delta = Math.round((unit - 0.5) * 2 * base * 0.2);
  return Math.max(0, base + delta);
}

async function discardBody(res) {
  try {
    if (res?.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
      return;
    }
  } catch {
    /* 丢掉失败的响应体即可 */
  }
  try {
    await res?.arrayBuffer?.();
  } catch {
    /* ignore */
  }
}

/** 只在状态本身还不能判定时才读取 body（避免无谓地吃掉 401/404 正文）。 */
export async function responseShouldRetry(res) {
  const status = Number(res?.status);
  if (isRetryableUpstreamFailure({ status })) return true;
  if (status >= 400 && status < 500) return false;
  let bodyText = '';
  try {
    bodyText = await res.clone().text();
  } catch {
    return false;
  }
  return isRetryableUpstreamFailure({ status, bodyText });
}

/**
 * 调用 doRequest，对可重试失败做指数退避。
 * doRequest 抛错视为网络错误。重试耗尽后：有响应就返回最后一次响应，否则把最后一次异常抛出。
 * @param {() => Promise<Response>} doRequest
 * @param {{ sleep?: (ms: number) => Promise<void>, random?: () => number, maxRetries?: number }} [options]
 */
export async function fetchWithRetry(doRequest, options = {}) {
  if (typeof doRequest !== 'function') throw new TypeError('doRequest must be a function');
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const maxRetries = normalizeMaxRetries(options.maxRetries);
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs(attempt - 1, random));
    try {
      const res = await doRequest();
      if (!res || typeof res.status !== 'number') {
        throw new TypeError('upstream fetch did not return a response');
      }
      const retry = await responseShouldRetry(res);
      if (!retry || attempt === maxRetries) return res;
      await discardBody(res);
    } catch (err) {
      lastError = err;
      const status = err && typeof err === 'object' ? err.status : undefined;
      const retryable = typeof status === 'number'
        ? isRetryableUpstreamFailure({ status })
        : isRetryableUpstreamFailure({ networkError: true });
      if (!retryable || attempt === maxRetries) throw err;
    }
  }
  throw lastError;
}

/** 上游列表 URL。调用方须先把 dir/start/count 规范化，这里不再读其它字段。 */
export function buildUpstreamListUrl(origin, { dir, start, count }) {
  const url = new URL('/api/manage/list', origin);
  url.searchParams.set('dir', String(dir ?? ''));
  url.searchParams.set('start', String(start ?? 0));
  url.searchParams.set('count', String(count ?? 0));
  return url;
}

/**
 * Cache API 的键。全新的 GET Request，不复制任何请求头。
 * 共享缓存的键里不能出现 Authorization、Cookie 或 Access JWT。
 */
export function createCacheRequest(url) {
  return new Request(String(url), { method: 'GET', headers: new Headers() });
}

export function isSafeCacheRequest(request) {
  if (!request || typeof request.url !== 'string' || request.method !== 'GET') return false;
  for (const name of FORBIDDEN_CACHE_HEADERS) {
    if (request.headers?.has?.(name)) return false;
  }
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.pathname !== '/api/manage/list') return false;
  if (url.username || url.password) return false;
  const keys = [...url.searchParams.keys()];
  if (!keys.length || keys.some((key) => !CACHE_QUERY_KEYS.has(key))) return false;
  for (const key of CACHE_QUERY_KEYS) {
    if (!url.searchParams.has(key)) return false;
  }
  return true;
}

export function isCacheableListBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.error) return false;
  if (!Array.isArray(body.files)) return false;
  try {
    if (JSON.stringify(body).includes(D1_OVERLOAD_MARK)) return false;
  } catch {
    return false;
  }
  return true;
}

export function bodyMentionsSecret(body, secret) {
  const needle = String(secret || '');
  if (!needle) return false;
  try {
    return JSON.stringify(body).includes(needle);
  } catch {
    return true;
  }
}

function defaultCacheStore() {
  try {
    if (typeof caches !== 'undefined' && caches && caches.default) return caches.default;
  } catch {
    /* Node 单测或未开放 Cache API 的运行时 */
  }
  return null;
}

export function resolveCache(cache) {
  if (cache === null) return null;
  if (cache !== undefined) return cache;
  return defaultCacheStore();
}

export async function readCachedJson(cache, request) {
  if (!cache || !isSafeCacheRequest(request)) return null;
  const res = await cache.match(request);
  if (!res || res.status !== 200) return null;
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('json')) return null;
  const cc = String(res.headers.get('cache-control') || '').toLowerCase();
  if (cc.includes('no-store')) return null;
  try {
    const body = await res.json();
    return isCacheableListBody(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * 只写入 200 JSON。Cache-Control 用 public,max-age，
 * 因为 caches.default 遇到 private / no-store 会拒绝 put（413）。
 * 这是边缘共享缓存里的内部副本，不是返回给浏览器的那份响应。
 */
export async function writeCachedJson(cache, request, body, maxAge = UPSTREAM_CACHE_SECONDS) {
  if (!cache || !isSafeCacheRequest(request) || !isCacheableListBody(body)) return false;
  const age = Number.isFinite(maxAge) ? Math.max(1, Math.floor(maxAge)) : UPSTREAM_CACHE_SECONDS;
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${age}`,
    },
  });
  await cache.put(request, response);
  return true;
}
