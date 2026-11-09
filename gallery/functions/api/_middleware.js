import { accessMiddleware } from '../_lib/access.js';

// /api/* 只允许 GET / HEAD；可选校验 Cloudflare Access JWT
async function methodGuard(context) {
  const m = context.request.method;
  if (m !== 'GET' && m !== 'HEAD') {
    return new Response(JSON.stringify({ error: '只支持 GET' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' },
    });
  }
  return context.next();
}

export const onRequest = [methodGuard, accessMiddleware()];
