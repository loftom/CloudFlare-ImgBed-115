import { describe, expect, it } from 'vitest';
import { HttpError, upstreamList } from '../functions/_lib/common.js';
import { accessMiddleware } from '../functions/_lib/access.js';
import {
  D1_OVERLOAD_MARK,
  buildUpstreamListUrl,
  createCacheRequest,
  isCacheableListBody,
  isRetryableUpstreamFailure,
  isSafeCacheRequest,
  readCachedJson,
  retryDelayMs,
  writeCachedJson,
} from '../functions/_lib/upstreamRetry.js';

const TOKEN = 'imgbed_unit_test_token';
const env = { IMGBED_ORIGIN: 'https://imgbed.test', IMGBED_LIST_TOKEN: TOKEN };
const D1_BODY = {
  error: 'Internal server error',
  message: 'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window',
};

function goodBody() {
  return {
    files: [{
      name: 'GE/a.jpg',
      metadata: {
        FileName: 'a.jpg',
        FileType: 'image/jpeg',
        TimeStamp: 1,
        FileSizeBytes: 10,
        TgChatId: 'secret-chat',
      },
    }],
    directories: ['GE/sub'],
    directFileCount: 1,
    totalCount: 4,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (!steps.length) throw new Error('unexpected extra fetch');
    const next = steps.shift();
    if (typeof next === 'function') return next();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

function testHooks(extra = {}) {
  const sleeps = [];
  return {
    sleeps,
    cache: null,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  };
}

function createMemoryCache() {
  const entries = new Map();
  const puts = [];
  const matches = [];
  return {
    puts,
    matches,
    async match(request) {
      matches.push(request);
      const hit = entries.get(request.url);
      return hit ? hit.clone() : undefined;
    },
    async put(request, response) {
      const body = await response.text();
      puts.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get('authorization'),
        cookie: request.headers.get('cookie'),
        accessJwt: request.headers.get('cf-access-jwt-assertion'),
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        contentType: response.headers.get('content-type'),
        body,
      });
      entries.set(request.url, new Response(body, { status: response.status, headers: response.headers }));
    },
  };
}

describe('isRetryableUpstreamFailure / retryDelayMs', () => {
  it('5xx、429、网络错误和 D1 正文可重试；4xx 不可', () => {
    expect(isRetryableUpstreamFailure({ status: 500 })).toBe(true);
    expect(isRetryableUpstreamFailure({ status: 503 })).toBe(true);
    expect(isRetryableUpstreamFailure({ status: 429 })).toBe(true);
    expect(isRetryableUpstreamFailure({ networkError: true })).toBe(true);
    expect(isRetryableUpstreamFailure({ status: 200, bodyText: `prefix ${D1_OVERLOAD_MARK} suffix` })).toBe(true);
    expect(isRetryableUpstreamFailure({ status: 401 })).toBe(false);
    expect(isRetryableUpstreamFailure({ status: 403 })).toBe(false);
    expect(isRetryableUpstreamFailure({ status: 404 })).toBe(false);
    expect(isRetryableUpstreamFailure({ status: 400 })).toBe(false);
    expect(isRetryableUpstreamFailure({ status: 404, bodyText: D1_OVERLOAD_MARK })).toBe(false);
    expect(isRetryableUpstreamFailure({ status: 401, bodyText: D1_OVERLOAD_MARK })).toBe(false);
    expect(isRetryableUpstreamFailure({ status: 200, bodyText: '{"files":[]}' })).toBe(false);
  });

  it('退避基准是 300 / 800 / 1600，抖动落在 ±20%', () => {
    expect(retryDelayMs(0, () => 0.5)).toBe(300);
    expect(retryDelayMs(1, () => 0.5)).toBe(800);
    expect(retryDelayMs(2, () => 0.5)).toBe(1600);
    expect(retryDelayMs(0, () => 0)).toBe(240);
    expect(retryDelayMs(0, () => 1)).toBe(360);
    expect(retryDelayMs(1, () => 0)).toBe(640);
    expect(retryDelayMs(1, () => 1)).toBe(960);
    expect(retryDelayMs(2, () => 0)).toBe(1280);
    expect(retryDelayMs(2, () => 1)).toBe(1920);
  });
});

describe('upstreamList 重试', () => {
  it('5xx 重试后成功', async () => {
    const cache = createMemoryCache();
    const hooks = testHooks({ cache });
    const script = scriptedFetch([
      jsonResponse(500, { error: 'Internal server error', message: D1_BODY.message }),
      jsonResponse(503, { error: 'unavailable' }),
      jsonResponse(200, goodBody()),
    ]);
    const result = await upstreamList(env, { dir: 'GE', start: 0, count: 1, action: 'rebuild' }, script.fn, hooks);
    expect(script.calls).toHaveLength(3);
    expect(hooks.sleeps).toEqual([300, 800]);
    expect(result.files[0]).toMatchObject({ path: 'GE/a.jpg', name: 'a.jpg', kind: 'image' });
    expect(JSON.stringify(result)).not.toContain('TgChatId');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    for (const call of script.calls) {
      const url = new URL(call.url);
      expect([...url.searchParams.keys()].sort()).toEqual(['count', 'dir', 'start']);
      expect(url.searchParams.get('action')).toBeNull();
      expect(call.url).not.toContain(TOKEN);
      expect(call.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.init.method).toBe('GET');
    }
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].body).not.toContain(D1_OVERLOAD_MARK);
  });

  it('429 会重试', async () => {
    const hooks = testHooks();
    const script = scriptedFetch([
      jsonResponse(429, { error: 'slow down' }),
      jsonResponse(200, goodBody()),
    ]);
    const result = await upstreamList(env, { dir: 'GE', start: 0, count: 2 }, script.fn, hooks);
    expect(script.calls).toHaveLength(2);
    expect(hooks.sleeps).toEqual([300]);
    expect(result.directFileCount).toBe(1);
  });

  it('网络错误会重试', async () => {
    const hooks = testHooks();
    const script = scriptedFetch([
      () => { throw new TypeError('connect ECONNRESET'); },
      jsonResponse(200, goodBody()),
    ]);
    const result = await upstreamList(env, { dir: 'GE', start: 0, count: 1 }, script.fn, hooks);
    expect(script.calls).toHaveLength(2);
    expect(hooks.sleeps).toEqual([300]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).not.toContain(TOKEN);
  });

  it('HTTP 200 但正文含 D1 DB is overloaded 时重试，不把这次错误写入缓存', async () => {
    const cache = createMemoryCache();
    const hooks = testHooks({ cache });
    const script = scriptedFetch([
      jsonResponse(200, D1_BODY),
      jsonResponse(200, goodBody()),
    ]);
    const result = await upstreamList(env, { dir: 'GE', start: 0, count: 1 }, script.fn, hooks);
    expect(script.calls).toHaveLength(2);
    expect(hooks.sleeps).toEqual([300]);
    expect(result.files[0].name).toBe('a.jpg');
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].status).toBe(200);
    expect(cache.puts[0].body).not.toContain(D1_OVERLOAD_MARK);
    expect(cache.puts[0].body).not.toContain(TOKEN);
  });

  it.each([401, 403, 404])('HTTP %s 不重试，即使正文提到 D1', async (status) => {
    const cache = createMemoryCache();
    const hooks = testHooks({ cache });
    const script = scriptedFetch([
      jsonResponse(status, { error: 'no', message: D1_OVERLOAD_MARK }),
    ]);
    await expect(upstreamList(env, { dir: 'GE', start: 0, count: 1 }, script.fn, hooks)).rejects.toMatchObject({
      status: 502,
    });
    expect(script.calls).toHaveLength(1);
    expect(hooks.sleeps).toEqual([]);
    expect(cache.puts).toHaveLength(0);
    const again = scriptedFetch([jsonResponse(status, { message: D1_OVERLOAD_MARK })]);
    const err = await upstreamList(env, { dir: 'GE', start: 0, count: 1 }, again.fn, testHooks()).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toMatch(/Bearer/);
    if (status === 404) expect(err.message).toContain('返回 404');
    else expect(err.message).toContain('list');
    expect(again.calls).toHaveLength(1);
  });

  it('重试用尽后保持原来的 502 错误形态', async () => {
    const cache = createMemoryCache();
    const hooks = testHooks({ cache });
    const script = scriptedFetch([
      jsonResponse(500, D1_BODY),
      jsonResponse(500, D1_BODY),
      jsonResponse(502, { error: 'bad gateway' }),
      jsonResponse(500, D1_BODY),
    ]);
    await expect(upstreamList(env, { dir: 'GE', start: 0, count: 1 }, script.fn, hooks)).rejects.toMatchObject({
      status: 502,
      message: 'ImgBed 列表接口返回 500',
    });
    expect(script.calls).toHaveLength(4);
    expect(hooks.sleeps).toEqual([300, 800, 1600]);
    expect(cache.puts).toHaveLength(0);
  });

  it('网络错误重试用尽后仍是「无法连接 ImgBed」', async () => {
    const hooks = testHooks();
    const script = scriptedFetch([
      () => { throw new TypeError('connect ECONNRESET'); },
      () => { throw new TypeError('connect ECONNRESET'); },
      () => { throw new TypeError('connect ECONNRESET'); },
      () => { throw new TypeError('connect ECONNRESET'); },
    ]);
    await expect(upstreamList(env, { dir: 'GE', start: 0, count: 1 }, script.fn, hooks)).rejects.toMatchObject({
      status: 502,
      message: '无法连接 ImgBed：connect ECONNRESET',
    });
    expect(script.calls).toHaveLength(4);
    expect(hooks.sleeps).toEqual([300, 800, 1600]);
  });

  it('5xx 之后若遇到 401 立刻停止，不再继续重试', async () => {
    const hooks = testHooks();
    const script = scriptedFetch([
      jsonResponse(500, { error: 'Internal server error' }),
      jsonResponse(401, { error: 'denied' }),
      jsonResponse(200, goodBody()),
    ]);
    await expect(upstreamList(env, { dir: 'GE', start: 0, count: 1 }, script.fn, hooks)).rejects.toMatchObject({
      status: 502,
    });
    expect(script.calls).toHaveLength(2);
    expect(hooks.sleeps).toEqual([300]);
  });
});

describe('上游列表缓存', () => {
  it('只缓存成功的 JSON，且缓存键不含 Authorization / Cookie / token', async () => {
    const cache = createMemoryCache();
    const hooks = testHooks({ cache });
    const script = scriptedFetch([jsonResponse(200, goodBody())]);
    const result = await upstreamList(
      env,
      { dir: '/GE//a/', start: '0', count: '1', action: 'rebuild', search: 'secret' },
      script.fn,
      hooks,
    );
    expect(result.files[0].name).toBe('a.jpg');
    // goodBody 的子目录是 GE/sub，不属于 GE/a，规范化后会被滤掉。
    expect(result.directories).toEqual([]);
    expect(cache.puts).toHaveLength(1);
    const put = cache.puts[0];
    expect(put.status).toBe(200);
    expect(put.method).toBe('GET');
    expect(put.authorization).toBeNull();
    expect(put.cookie).toBeNull();
    expect(put.accessJwt).toBeNull();
    expect(put.cacheControl).toBe('public, max-age=300');
    expect(put.contentType).toContain('application/json');
    expect(put.url).not.toContain(TOKEN);
    expect(put.url).not.toContain('Bearer');
    expect(put.url).not.toContain('action');
    expect(put.url).not.toContain('search');
    const key = new URL(put.url);
    expect(key.pathname).toBe('/api/manage/list');
    expect([...key.searchParams.keys()].sort()).toEqual(['count', 'dir', 'start']);
    expect(key.searchParams.get('dir')).toBe('GE/a');
    expect(key.searchParams.get('start')).toBe('0');
    expect(key.searchParams.get('count')).toBe('1');
    expect(key.username).toBe('');
    expect(key.password).toBe('');

    const again = scriptedFetch([]);
    const hit = await upstreamList(env, { dir: 'GE/a', start: 0, count: 1 }, again.fn, testHooks({ cache }));
    expect(again.calls).toHaveLength(0);
    expect(hit.files[0].name).toBe('a.jpg');
    expect(JSON.stringify(hit)).not.toContain('TgChatId');
    expect(cache.matches.every((req) => req.headers.get('authorization') == null)).toBe(true);
    expect(cache.matches.every((req) => req.headers.get('cookie') == null)).toBe(true);
  });

  it('错误响应、非 200、非 JSON、带 error 字段的正文都不会写入缓存', async () => {
    const cases = [
      { name: '500', response: jsonResponse(500, D1_BODY) },
      { name: '429', response: jsonResponse(429, { error: 'slow' }) },
      { name: '401', response: jsonResponse(401, { error: 'no' }) },
      { name: '403', response: jsonResponse(403, { error: 'no' }) },
      { name: '404', response: jsonResponse(404, { error: 'missing' }) },
      {
        name: '200 text',
        response: new Response('<html>nope</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      },
      { name: '200 error json', response: jsonResponse(200, { error: 'bad', message: 'nope' }) },
      {
        name: '200 D1 json',
        response: jsonResponse(200, D1_BODY),
      },
    ];
    for (const item of cases) {
      const cache = createMemoryCache();
      const script = scriptedFetch([item.response]);
      await expect(upstreamList(
        env,
        { dir: 'GE', start: 0, count: 1 },
        script.fn,
        testHooks({ cache, maxRetries: 0 }),
      )).rejects.toBeInstanceOf(HttpError);
      expect(cache.puts, item.name).toHaveLength(0);
    }
  });

  it('正文里出现上游 token 时不缓存', async () => {
    const cache = createMemoryCache();
    const body = goodBody();
    body.files[0].metadata.TgChatId = TOKEN;
    const script = scriptedFetch([jsonResponse(200, body)]);
    const result = await upstreamList(env, { dir: 'GE', start: 0, count: 1 }, script.fn, testHooks({ cache }));
    expect(result.files).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(cache.puts).toHaveLength(0);
  });

  it('缓存里的非 200 / 非列表 JSON 视为未命中', async () => {
    const url = buildUpstreamListUrl('https://imgbed.test', { dir: 'GE', start: 0, count: 1 });
    const request = createCacheRequest(url);
    const cache = {
      async match() {
        return jsonResponse(500, D1_BODY);
      },
      async put() {
        throw new Error('should not put');
      },
    };
    expect(await readCachedJson(cache, request)).toBeNull();

    const errorCache = {
      async match() {
        return jsonResponse(200, { error: 'Internal server error', message: D1_OVERLOAD_MARK });
      },
      async put() {
        throw new Error('should not put');
      },
    };
    expect(await readCachedJson(errorCache, request)).toBeNull();
  });

  it('带 Authorization 的请求不能当作缓存键', async () => {
    const url = buildUpstreamListUrl('https://imgbed.test', { dir: 'GE', start: 0, count: 1 });
    const bad = new Request(url, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(isSafeCacheRequest(bad)).toBe(false);
    const cache = createMemoryCache();
    expect(await writeCachedJson(cache, bad, goodBody())).toBe(false);
    expect(cache.puts).toHaveLength(0);

    const cookieReq = new Request(url, { method: 'GET', headers: { Cookie: 'CF_Authorization=jwt' } });
    expect(isSafeCacheRequest(cookieReq)).toBe(false);
    const extra = new Request(`${url}&action=rebuild`, { method: 'GET' });
    expect(isSafeCacheRequest(extra)).toBe(false);
    expect(isCacheableListBody(goodBody())).toBe(true);
    expect(isCacheableListBody(D1_BODY)).toBe(false);
    expect(isCacheableListBody({ files: [] })).toBe(true);
    expect(isCacheableListBody(null)).toBe(false);
  });
});

describe('Access 先于缓存', () => {
  it('未通过 Access 的请求不会进入后续处理，因此读不到缓存内容', async () => {
    const mw = accessMiddleware();
    let nextCalled = false;
    const res = await mw({
      request: new Request('https://gallery.test/api/list?dir=GE', {
        headers: { Cookie: 'CF_Authorization=not-a-jwt', Authorization: `Bearer ${TOKEN}` },
      }),
      env: { CF_ACCESS_TEAM_DOMAIN: 'demo', CF_ACCESS_AUD: 'aud123' },
      next() {
        nextCalled = true;
        return new Response('cached-listing', { status: 200 });
      },
    });
    expect(nextCalled).toBe(false);
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).not.toContain('cached-listing');
  });
});
