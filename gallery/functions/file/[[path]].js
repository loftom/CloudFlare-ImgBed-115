import { HttpError, errorResponse, getOrigin, sanitizePath, getAllowedDirs, isDirAllowed, isTruthy } from '../_lib/common.js';

// 可选的同源图片代理：只有 IMAGE_PROXY=true 才启用，否则 404（默认浏览器直连 ImgBed /file/*）。
// 只转发 GET/HEAD 和缓存/Range 相关请求头，不附带任何 Token，也不带 Referer。
const FORWARD_REQ = ['range', 'if-none-match', 'if-modified-since', 'accept'];
const FORWARD_RES = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition',
];

export async function onRequest(context) {
  try {
    const { request, env, params } = context;
    if (!isTruthy(env.IMAGE_PROXY)) return new Response('Not Found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const segs = Array.isArray(params.path) ? params.path : [params.path];
    const path = sanitizePath(segs.join('/'), { allowEmpty: false });
    const allowed = getAllowedDirs(env);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (allowed.length && (dir === '' || !isDirAllowed(dir, allowed))) throw new HttpError(403, '不在允许范围内');

    const upstream = new URL('/file/' + path.split('/').map(encodeURIComponent).join('/'), getOrigin(env));
    const headers = new Headers();
    for (const h of FORWARD_REQ) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    const res = await fetch(upstream.toString(), { method: request.method, headers, redirect: 'follow' });
    const out = new Headers();
    for (const h of FORWARD_RES) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    if (!out.has('cache-control')) out.set('cache-control', 'private, max-age=86400');
    out.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers: out });
  } catch (err) {
    return errorResponse(err);
  }
}
