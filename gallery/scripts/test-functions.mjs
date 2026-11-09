// 不依赖外网的 Functions 自测：启动本地 mock ImgBed，直接调用 functions/ 里的处理函数。
import assert from 'node:assert/strict';
import { createMockImgbed, MOCK_TOKEN } from '../mock/imgbed-mock.mjs';
import { onRequestGet as listGet } from '../functions/api/list.js';
import { onRequestGet as coverGet } from '../functions/api/cover.js';
import { onRequestGet as configGet } from '../functions/api/config.js';
import { onRequest as fileProxy } from '../functions/file/[[path]].js';
import { sanitizePath } from '../functions/_lib/common.js';
import { verifyAccess } from '../functions/_lib/access.js';

const PORT = 18799;
const server = createMockImgbed();
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const env = { IMGBED_ORIGIN: `http://127.0.0.1:${PORT}`, IMGBED_LIST_TOKEN: MOCK_TOKEN };
const call = async (fn, path, e = env, params = {}) => {
  const res = await fn({ request: new Request('http://gallery.local' + path), env: e, params, next: () => {} });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(), res };
};
let n = 0;
const ok = (name) => console.log(`✓ ${++n}. ${name}`);

try {
  // 路径清洗
  assert.equal(sanitizePath('/GE//a/'), 'GE/a');
  assert.throws(() => sanitizePath('GE/../x'));
  assert.throws(() => sanitizePath('GE\\x'));
  assert.throws(() => sanitizePath('a\u0000b'));
  ok('sanitizePath 拒绝 .. / 反斜杠 / 控制字符');

  let r = await call(listGet, '/api/list?dir=');
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('cache-control'), 'private, max-age=300, stale-while-revalidate=600');
  assert.deepEqual(r.body.directories.map((d) => d.path), ['BBB', 'GE', 'HC']);
  ok('根目录列出 BBB / GE / HC');

  r = await call(listGet, '/api/list?dir=' + encodeURIComponent('BBB/超大合集/全集 1500P') + '&count=60&order=asc');
  assert.equal(r.body.files.length, 60);
  assert.equal(r.body.files[0].name, '001.jpg');
  assert.equal(r.body.directFileCount, 1500);
  assert.equal(r.body.hasMore, true);
  assert.ok(!('metadata' in r.body.files[0]) && !JSON.stringify(r.body).includes('TgChatId'));
  ok('asc 第一页从 001 开始，且不泄露 ImgBed 元数据');

  r = await call(listGet, '/api/list?dir=' + encodeURIComponent('BBB/超大合集/全集 1500P') + '&start=1480&count=60&order=asc&total=1500');
  assert.equal(r.body.files.length, 20);
  assert.equal(r.body.files[19].name, '1500.jpg');
  assert.equal(r.body.hasMore, false);
  ok('asc 末页（带 total 提示，单次上游请求）正确');

  r = await call(listGet, '/api/list?dir=' + encodeURIComponent('BBB/超大合集/全集 1500P') + '&count=5&order=desc');
  assert.equal(r.body.files[0].name, '1500.jpg');
  ok('desc 最新在前');

  r = await call(listGet, '/api/list?dir=GE/../HC');
  assert.equal(r.status, 400);
  assert.match(r.res.headers.get('cache-control') || '', /no-store/);
  r = await call(listGet, '/api/list?dir=GE&count=99999');
  assert.equal(r.body.count, 200);
  ok('拒绝路径穿越，count 上限 200');

  r = await call(listGet, '/api/list?dir=HC', { ...env, ALLOWED_DIRS: 'GE,BBB' });
  assert.equal(r.status, 403);
  r = await call(listGet, '/api/list?dir=', { ...env, ALLOWED_DIRS: 'GE,BBB' });
  assert.deepEqual(r.body.directories.map((d) => d.path), ['BBB', 'GE']);
  ok('ALLOWED_DIRS 限制生效');

  r = await call(listGet, '/api/list?dir=GE', { ...env, IMGBED_LIST_TOKEN: 'wrong' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /list/);
  assert.match(r.res.headers.get('cache-control') || '', /no-store/);
  ok('Token 错误时返回 502 + 中文提示');

  r = await call(coverGet, '/api/cover?dir=BBB');
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('cache-control'), 'private, max-age=86400');
  assert.ok(r.body.cover && r.body.cover.path.startsWith('BBB/'));
  assert.equal(r.body.childCount, 6);
  ok('无直接图片的目录会沿第一个子目录找封面');

  r = await call(configGet, '/api/config');
  assert.equal(r.body.imageBase, env.IMGBED_ORIGIN);
  assert.ok(!JSON.stringify(r.body).includes(MOCK_TOKEN));
  ok('/api/config 不含 Token');

  r = await call(fileProxy, '/file/GE/x.jpg', env, { path: ['GE', 'x.jpg'] });
  assert.equal(r.status, 404);
  const first = (await call(listGet, '/api/list?dir=HC&count=1')).body;
  const sub = first.directories[0].path;
  const f1 = (await call(listGet, '/api/list?dir=' + encodeURIComponent(sub) + '&count=1')).body.files[0];
  r = await call(fileProxy, '/file/x', { ...env, IMAGE_PROXY: 'true' }, { path: f1.path.split('/') });
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('content-type'), 'image/svg+xml');
  ok('同源 /file 代理默认关闭，IMAGE_PROXY=true 时可用');

  // Access JWT：本地生成 RSA 密钥，伪造 JWKS
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
  const team = 'demo.cloudflareaccess.com';
  const fakeFetch = async (u) => {
    assert.equal(u, `https://${team}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  };
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const sign = async (payload) => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const p = b64u(JSON.stringify(payload));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const aEnv = { CF_ACCESS_TEAM_DOMAIN: 'demo', CF_ACCESS_AUD: 'aud123', CF_ACCESS_ALLOWED_EMAILS: 'me@example.com' };
  const req = (tok) => new Request('http://x/api/list', { headers: tok ? { 'Cf-Access-Jwt-Assertion': tok } : {} });
  const good = await sign({ aud: ['aud123'], exp: now + 600, iat: now, iss: `https://${team}`, email: 'me@example.com' });
  assert.equal((await verifyAccess(req(good), aEnv, fakeFetch)).ok, true);
  assert.equal((await verifyAccess(req(null), aEnv, fakeFetch)).ok, false);
  assert.equal((await verifyAccess(req(await sign({ aud: ['other'], exp: now + 600, iss: `https://${team}` })), aEnv, fakeFetch)).ok, false);
  assert.equal((await verifyAccess(req(await sign({ aud: ['aud123'], exp: now - 3600, iss: `https://${team}` })), aEnv, fakeFetch)).ok, false);
  assert.equal((await verifyAccess(req(await sign({ aud: ['aud123'], exp: now + 600, iss: `https://${team}`, email: 'x@y.com' })), aEnv, fakeFetch)).ok, false);
  assert.equal((await verifyAccess(req(good.slice(0, -4) + 'AAAA'), aEnv, fakeFetch)).ok, false);
  assert.equal((await verifyAccess(req(null), {}, fakeFetch)).skipped, true);
  ok('Access JWT：有效通过；缺失/aud 错/过期/邮箱不符/签名篡改均拒绝；未配置时跳过');

  console.log(`\n全部 ${n} 项通过`);
} finally {
  server.close();
}
