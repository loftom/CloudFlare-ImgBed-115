// 公共工具：环境变量解析、目录参数清洗、调用 ImgBed 列表接口。
// 这里的代码只在 Cloudflare Pages Functions（服务端）运行，不会进入浏览器 bundle。

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 60;

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|jfif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function errorResponse(err) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : '服务器内部错误';
  if (!(err instanceof HttpError)) console.error('gallery function error:', err);
  return json({ error: message }, status);
}

export function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/** 解析并校验 IMGBED_ORIGIN：只取 origin 部分；除本机 mock 外必须是 https */
export function getOrigin(env) {
  const raw = String(env.IMGBED_ORIGIN || '').trim();
  if (!raw) throw new HttpError(500, '未配置 IMGBED_ORIGIN');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(500, 'IMGBED_ORIGIN 不是合法 URL');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new HttpError(500, 'IMGBED_ORIGIN 必须是 https');
  }
  return url.origin;
}

export function getToken(env) {
  const token = String(env.IMGBED_LIST_TOKEN || '').trim();
  if (!token) throw new HttpError(500, '未配置 IMGBED_LIST_TOKEN');
  return token;
}

/** ALLOWED_DIRS="GE,HC,BBB" → ['GE','HC','BBB']；为空表示不限制 */
export function getAllowedDirs(env) {
  return String(env.ALLOWED_DIRS || '')
    .split(',')
    .map((s) => sanitizePath(s, { allowEmpty: true }))
    .filter(Boolean);
}

/**
 * 清洗目录/文件路径：去掉首尾斜杠和重复斜杠，拒绝 . / .. 段、反斜杠、控制字符和超长输入。
 * 返回不带首尾斜杠的相对路径，根目录为空串。
 */
export function sanitizePath(raw, { allowEmpty = true } = {}) {
  const value = String(raw ?? '');
  if (value.length > 1024) throw new HttpError(400, '路径过长');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new HttpError(400, '路径含非法字符');
  const segments = value.split('/').filter((s) => s !== '');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new HttpError(400, '路径不允许包含 . 或 ..');
  }
  const out = segments.join('/');
  if (!out && !allowEmpty) throw new HttpError(400, '路径不能为空');
  return out;
}

/** 目录是否落在 ALLOWED_DIRS 允许的范围内（根目录始终可列，但结果会被过滤） */
export function isDirAllowed(dir, allowed) {
  if (!allowed.length || dir === '') return true;
  return allowed.some((a) => dir === a || dir.startsWith(a + '/'));
}

export function parseIntParam(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fileKind(name, type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('image/') || IMAGE_EXT.test(name)) return 'image';
  if (t.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
  return 'other';
}

/** 只挑前端需要的字段，ImgBed 返回的其余元数据（渠道、TG 信息、IP 等）一律丢弃 */
function shapeFile(f) {
  const path = String(f?.name || '');
  const md = f?.metadata || {};
  const name = path.split('/').pop() || path;
  const size = Number(md.FileSizeBytes ?? NaN);
  return {
    path,
    name: String(md.FileName || name),
    kind: fileKind(name, md.FileType),
    ts: Number(md.TimeStamp) || 0,
    size: Number.isFinite(size) ? size : null,
    // Block / adult 文件会被 ImgBed /file 接口替换成拦截图，前端据此提示
    blocked: md.ListType === 'Block' || md.Label === 'adult',
  };
}

function shapeDirectories(list, parent) {
  const prefix = parent ? parent + '/' : '';
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const path = String(raw || '').replace(/\/+$/, '');
    if (!path || seen.has(path)) continue;
    if (prefix && !path.startsWith(prefix)) continue;
    seen.add(path);
    out.push({ path, name: path.slice(prefix.length) || path });
  }
  return out;
}

/**
 * 调 ImgBed GET /api/manage/list。只转发 dir/start/count 三个参数，绝不转发 action/search 等，
 * 因此即便 Token 有 list 权限，也触发不了 action=rebuild 之类的索引操作。
 * 鉴权：Authorization: Bearer <token>，Token 需要 "list" 权限
 * （见 ImgBed functions/api/manage/_middleware.js 与 functions/utils/auth/tokenValidator.js）。
 */
export async function upstreamList(env, { dir, start, count }, fetchImpl = fetch) {
  const origin = getOrigin(env);
  const token = getToken(env);
  const url = new URL('/api/manage/list', origin);
  url.searchParams.set('dir', dir);
  url.searchParams.set('start', String(start));
  url.searchParams.set('count', String(count));

  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual',
    });
  } catch (e) {
    throw new HttpError(502, '无法连接 ImgBed：' + (e?.message || e));
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, 'ImgBed 拒绝了列表请求：请检查 IMGBED_LIST_TOKEN 是否有效、未过期、带「列出(list)」权限');
  }
  if (!res.ok) {
    throw new HttpError(502, `ImgBed 列表接口返回 ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new HttpError(502, 'ImgBed 列表接口返回的不是 JSON');
  }
  if (body && body.error) throw new HttpError(502, 'ImgBed 错误：' + String(body.message || body.error));

  return {
    files: (Array.isArray(body.files) ? body.files : []).map(shapeFile),
    directories: shapeDirectories(body.directories, dir),
    directFileCount: Number(body.directFileCount) || 0,
    totalCount: Number(body.totalCount) || 0,
    countsUnavailable: body.countsUnavailable === true,
  };
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/**
 * 分页列目录。ImgBed 固定按上传时间倒序（timestamp DESC, id ASC）分页。
 * order=asc（默认，等于上传顺序，套图通常从第 1 张开始）时，用 directFileCount 反算窗口再倒过来。
 * 计数不可用（D1 过载，countsUnavailable）时退回 desc。
 */
export async function listDirectory(env, { dir, start, count, order, totalHint }, fetchImpl = fetch) {
  if (order !== 'asc') {
    const r = await upstreamList(env, { dir, start, count }, fetchImpl);
    const hasMore = r.countsUnavailable ? r.files.length >= count : start + r.files.length < r.directFileCount;
    return { ...r, start, count, order: 'desc', hasMore };
  }

  let total = Number.isFinite(totalHint) && totalHint >= 0 ? totalHint : null;
  let probe = null;
  if (total === null) {
    probe = await upstreamList(env, { dir, start: 0, count: 1 }, fetchImpl);
    if (probe.countsUnavailable) {
      const r = await upstreamList(env, { dir, start, count }, fetchImpl);
      const hasMore = r.files.length >= count;
      return { ...r, start, count, order: 'desc', orderFallback: true, hasMore };
    }
    total = probe.directFileCount;
  }

  const end = Math.max(0, total - start);
  const upStart = Math.max(0, end - count);
  const upCount = end - upStart;
  if (upCount <= 0) {
    const r = probe || (await upstreamList(env, { dir, start: 0, count: 1 }, fetchImpl));
    return { ...r, files: [], start, count, order: 'asc', hasMore: false, directFileCount: probe ? total : r.directFileCount };
  }
  const r = await upstreamList(env, { dir, start: upStart, count: upCount }, fetchImpl);
  const files = r.files.slice().reverse();
  // 同一批上传的文件时间戳常常相同，同时间戳内按文件名自然排序（001、002…）
  files.sort((a, b) => a.ts - b.ts || collator.compare(a.name, b.name));
  return {
    ...r,
    files,
    start,
    count,
    order: 'asc',
    directFileCount: r.directFileCount || total,
    hasMore: start + upCount < (r.directFileCount || total),
  };
}

export function filterRootByAllowed(result, dir, allowed) {
  if (!allowed.length || dir !== '') return result;
  const set = new Set(allowed.map((a) => a.split('/')[0]));
  return {
    ...result,
    files: [],
    directFileCount: 0,
    hasMore: false,
    directories: result.directories.filter((d) => set.has(d.path)),
  };
}
