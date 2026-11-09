import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, HttpError, json, errorResponse, sanitizePath, parseIntParam,
  getAllowedDirs, isDirAllowed, listDirectory, filterRootByAllowed,
} from '../_lib/common.js';

/**
 * GET /api/list?dir=BBB/合集A&start=0&count=60&order=asc&total=123
 * 返回：{ dir, directories:[{path,name}], files:[{path,name,kind,ts,size,blocked}],
 *        start, count, order, directFileCount, totalCount, hasMore, countsUnavailable }
 *
 * Access 校验在 api/_middleware.js 中先于本函数。上游 Cache API 的读取在 listDirectory 内，
 * 因此未通过鉴权的请求拿不到缓存内容。返回给浏览器的是 private 缓存，CDN 不会共享这份响应。
 */
export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const dir = sanitizePath(url.searchParams.get('dir') || '');
    const allowed = getAllowedDirs(context.env);
    if (!isDirAllowed(dir, allowed)) throw new HttpError(403, '该目录不在允许范围内');

    const start = parseIntParam(url.searchParams.get('start'), 0, 0, 10_000_000);
    const count = parseIntParam(url.searchParams.get('count'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
    const totalRaw = url.searchParams.get('total');
    const totalHint = totalRaw === null ? NaN : parseIntParam(totalRaw, NaN, 0, 100_000_000);

    let result = await listDirectory(context.env, { dir, start, count, order, totalHint });
    result = filterRootByAllowed(result, dir, allowed);
    return json({ dir, ...result }, 200, {
      'Cache-Control': 'private, max-age=300, stale-while-revalidate=600',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
