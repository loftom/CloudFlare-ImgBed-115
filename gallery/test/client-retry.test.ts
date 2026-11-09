import { afterEach, describe, expect, it } from 'vitest';
import { COVER_CONCURRENCY, fetchCover } from '../src/lib/api';
import { ApiError, listRetryDelayMs, runWithRetry, shouldRetryListError } from '../src/lib/retry';

describe('列表接口前端重试', () => {
  it('5xx / 429 / 网络错误会退避重试，4xx 和取消不重试', () => {
    expect(shouldRetryListError(new ApiError('上游 502', 502))).toBe(true);
    expect(shouldRetryListError(new ApiError('上游 500', 500))).toBe(true);
    expect(shouldRetryListError(new ApiError('限流', 429))).toBe(true);
    expect(shouldRetryListError(new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryListError(new ApiError('未授权', 401))).toBe(false);
    expect(shouldRetryListError(new ApiError('禁止', 403))).toBe(false);
    expect(shouldRetryListError(new ApiError('没有', 404))).toBe(false);
    expect(shouldRetryListError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(false);
    expect(listRetryDelayMs(0, () => 0.5)).toBe(300);
    expect(listRetryDelayMs(1, () => 0.5)).toBe(800);
  });

  it('失败两次后成功，只睡两次', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await runWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new ApiError('ImgBed 列表接口返回 500', 502);
      return { ok: true };
    }, {
      maxRetries: 2,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([300, 800]);
  });

  it('网络错误重试后成功', async () => {
    let calls = 0;
    const result = await runWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return 'ok';
    }, { maxRetries: 2, sleep: async () => {}, random: () => 0.5 });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it.each([401, 403, 404])('HTTP %s 不重试', async (status) => {
    let calls = 0;
    await expect(runWithRetry(async () => {
      calls += 1;
      throw new ApiError('no', status);
    }, {
      maxRetries: 2,
      sleep: async () => {
        throw new Error('should not sleep');
      },
    })).rejects.toMatchObject({ status });
    expect(calls).toBe(1);
  });

  it('重试用尽后把最后一次错误抛出', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(runWithRetry(async () => {
      calls += 1;
      throw new ApiError('ImgBed 列表接口返回 500', 502);
    }, {
      maxRetries: 2,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    })).rejects.toMatchObject({ message: 'ImgBed 列表接口返回 500', status: 502 });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([300, 800]);
  });

  it('退避期间被取消则不再发下一次请求', async () => {
    let calls = 0;
    await expect(runWithRetry(async () => {
      calls += 1;
      throw new ApiError('暂时失败', 502);
    }, {
      maxRetries: 2,
      sleep: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });
});

describe('封面并发', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('同时最多 2 个 /api/cover，失败只体现在该请求本身', async () => {
    expect(COVER_CONCURRENCY).toBe(2);
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<(res: Response) => void> = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith('/api/cover')) return originalFetch(input);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((resolve) => {
        resolvers.push((res) => {
          active -= 1;
          resolve(res);
        });
      });
    }) as typeof fetch;

    const dirs = ['cover-a', 'cover-b', 'cover-c', 'cover-d'];
    let settled = 0;
    const pending = dirs.map((dir) => fetchCover(dir).then(
      () => 'ok' as const,
      () => 'fail' as const,
    ).finally(() => {
      settled += 1;
    }));
    expect(resolvers).toHaveLength(2);
    expect(maxActive).toBe(2);

    const fail = () => new Response(JSON.stringify({ error: '封面失败' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
    for (let turn = 0; turn < 8 && settled < dirs.length; turn++) {
      const batch = resolvers.splice(0, resolvers.length);
      for (const resolve of batch) resolve(fail());
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(maxActive).toBe(2);
    expect(settled).toBe(dirs.length);
    expect(await Promise.all(pending)).toEqual(['fail', 'fail', 'fail', 'fail']);
  });
});
