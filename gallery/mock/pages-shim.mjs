// 本地开发用：在 Vite dev server 里按 Cloudflare Pages Functions 的约定执行 gallery/functions 下的真实代码
// （中间件链 + onRequest/onRequestGet + [[path]] 参数），上游指向本地 mock ImgBed。
// 只用于 `npm run dev`，不会被打进 dist。
import { createMockImgbed, MOCK_TOKEN } from './imgbed-mock.mjs';

const MOCK_PORT = Number(process.env.MOCK_IMGBED_PORT || 18787);

async function loadRoutes(load) {
  const apiMw = await load('/functions/api/_middleware.js');
  const fileMw = await load('/functions/file/_middleware.js');
  const list = await load('/functions/api/list.js');
  const cover = await load('/functions/api/cover.js');
  const config = await load('/functions/api/config.js');
  const file = await load('/functions/file/[[path]].js');
  const mw = (m) => (Array.isArray(m.onRequest) ? m.onRequest : [m.onRequest]);
  const handler = (m, method) => m[`onRequest${method[0]}${method.slice(1).toLowerCase()}`] || m.onRequest;
  return (pathname, method) => {
    const table = { '/api/list': list, '/api/cover': cover, '/api/config': config };
    if (table[pathname]) {
      const h = handler(table[pathname], method);
      return h ? { chain: [...mw(apiMw), h], params: {} } : { chain: [...mw(apiMw), () => new Response('Method Not Allowed', { status: 405 })], params: {} };
    }
    if (pathname.startsWith('/api/')) return { chain: [...mw(apiMw), () => new Response('Not Found', { status: 404 })], params: {} };
    if (pathname.startsWith('/file/')) {
      const segs = pathname.slice(6).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      return { chain: [...mw(fileMw), file.onRequest], params: { path: segs } };
    }
    return null;
  };
}

function toRequest(req, origin) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(new URL(req.url, origin), { method: req.method, headers });
}

async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  const buf = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  res.end(buf);
}

export function pagesShim() {
  let mockServer;
  return {
    name: 'gallery-pages-functions-shim',
    apply: 'serve',
    async configureServer(server) {
      mockServer = createMockImgbed({ delayMs: Number(process.env.MOCK_DELAY ?? 80) });
      await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
      server.config.logger.info(`  ➜  mock ImgBed: http://127.0.0.1:${MOCK_PORT}（Functions 运行于 Vite 中间件）`);
      server.httpServer?.on('close', () => mockServer.close());

      const env = {
        IMGBED_ORIGIN: process.env.IMGBED_ORIGIN || `http://127.0.0.1:${MOCK_PORT}`,
        IMGBED_LIST_TOKEN: process.env.IMGBED_LIST_TOKEN || MOCK_TOKEN,
        IMAGE_PROXY: process.env.IMAGE_PROXY || 'false',
        ALLOWED_DIRS: process.env.ALLOWED_DIRS || '',
        CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || '',
        CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || '',
      };
      const load = (p) => server.ssrLoadModule(p);

      server.middlewares.use(async (req, res, next) => {
        try {
          const pathname = new URL(req.url, 'http://x').pathname;
          const route = await loadRoutes(load).then((r) => r(pathname, req.method || 'GET'));
          if (!route) return next();
          const request = toRequest(req, `http://${req.headers.host || 'localhost'}`);
          let i = 0;
          const context = {
            request,
            env,
            params: route.params,
            data: {},
            waitUntil: () => {},
            next: async () => {
              const fn = route.chain[i++];
              return fn ? fn(context) : new Response('Not Found', { status: 404 });
            },
          };
          await sendResponse(res, await context.next());
        } catch (e) {
          server.config.logger.error(String(e?.stack || e));
          res.statusCode = 500;
          res.end('shim error');
        }
      });
    },
  };
}
