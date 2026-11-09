import type { CoverResponse, GalleryConfig, ListResponse, Order } from './types';

// 浏览器只访问同源 /api/*（Pages Functions）。Token 只存在于服务端环境变量中。

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, credentials: 'same-origin', headers: { Accept: 'application/json' } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error || `请求失败（HTTP ${res.status}）`;
    throw new Error(msg);
  }
  return body as T;
}

let configPromise: Promise<GalleryConfig> | null = null;
export function getConfig(): Promise<GalleryConfig> {
  if (!configPromise) {
    configPromise = getJson<GalleryConfig>('/api/config').catch((e) => {
      configPromise = null;
      throw e;
    });
  }
  return configPromise;
}

export function fetchList(
  params: { dir: string; start: number; count: number; order: Order; total?: number },
  signal?: AbortSignal,
): Promise<ListResponse> {
  const q = new URLSearchParams({
    dir: params.dir,
    start: String(params.start),
    count: String(params.count),
    order: params.order,
  });
  if (params.total != null && params.order === 'asc') q.set('total', String(params.total));
  return getJson<ListResponse>(`/api/list?${q}`, signal);
}

// ---- 封面请求：会话内缓存 + 并发上限（目录墙一次可能有几百张卡片） ----
const COVER_CONCURRENCY = 4;
const coverCache = new Map<string, Promise<CoverResponse>>();
let coverActive = 0;
const coverQueue: Array<() => void> = [];

function pumpCovers() {
  while (coverActive < COVER_CONCURRENCY && coverQueue.length) {
    coverActive++;
    coverQueue.shift()!();
  }
}

export function fetchCover(dir: string): Promise<CoverResponse> {
  const cached = coverCache.get(dir);
  if (cached) return cached;
  const p = new Promise<CoverResponse>((resolve, reject) => {
    coverQueue.push(() => {
      getJson<CoverResponse>(`/api/cover?${new URLSearchParams({ dir })}`)
        .then(resolve, (e) => {
          coverCache.delete(dir);
          reject(e);
        })
        .finally(() => {
          coverActive--;
          pumpCovers();
        });
    });
    pumpCovers();
  });
  coverCache.set(dir, p);
  return p;
}

/** ImgBed 原图地址：`${imageBase}/file/<path>`，imageBase 为空表示走同源 /file 代理 */
export function imageUrl(base: string, path: string): string {
  return `${base}/file/${path.split('/').map(encodeURIComponent).join('/')}`;
}
