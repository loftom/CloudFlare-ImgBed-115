// 可选：校验 Cloudflare Access 的 JWT（Cf-Access-Jwt-Assertion 头 / CF_Authorization Cookie）。
// 只有同时配置了 CF_ACCESS_TEAM_DOMAIN 和 CF_ACCESS_AUD 才启用；未配置时直接放行（由 Access 在边缘拦截）。
// 用 WebCrypto 按团队 JWKS（https://<team>.cloudflareaccess.com/cdn-cgi/access/certs）验 RS256 签名。

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map(); // teamDomain -> { keys: Map<kid, CryptoKey>, fetchedAt }

function normalizeTeamDomain(raw) {
  let d = String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (d && !d.includes('.')) d = `${d}.cloudflareaccess.com`;
  return d.toLowerCase();
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonPart(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

async function loadKeys(team, fetchImpl, force = false) {
  const cached = jwksCache.get(team);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`拉取 Access JWKS 失败：${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  jwksCache.set(team, { keys, fetchedAt: Date.now() });
  return keys;
}

function readToken(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * @returns {Promise<{ok: true, email?: string, skipped?: boolean} | {ok: false, reason: string}>}
 */
export async function verifyAccess(request, env, fetchImpl = fetch) {
  const team = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const aud = String(env.CF_ACCESS_AUD || '').trim();
  if (!team || !aud) return { ok: true, skipped: true };

  const token = readToken(request);
  if (!token) return { ok: false, reason: '缺少 Cloudflare Access 凭证' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'Access 凭证格式错误' };

  let header, payload;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
  } catch {
    return { ok: false, reason: 'Access 凭证无法解析' };
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'Access 凭证算法不受支持' };

  let keys = await loadKeys(team, fetchImpl);
  let key = keys.get(header.kid);
  if (!key) {
    // 密钥轮换后 kid 可能是新的，强制刷新一次
    keys = await loadKeys(team, fetchImpl, true);
    key = keys.get(header.kid);
  }
  if (!key) return { ok: false, reason: 'Access 凭证签名密钥未知' };

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, reason: 'Access 凭证签名无效' };

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, reason: 'Access 凭证 aud 不匹配' };
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return { ok: false, reason: 'Access 凭证已过期' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return { ok: false, reason: 'Access 凭证尚未生效' };
  if (payload.iss && payload.iss !== `https://${team}`) return { ok: false, reason: 'Access 凭证签发方不匹配' };

  const allowedEmails = String(env.CF_ACCESS_ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const email = String(payload.email || '').toLowerCase();
  if (allowedEmails.length && !allowedEmails.includes(email)) {
    return { ok: false, reason: '该账号不在允许名单内' };
  }
  return { ok: true, email };
}

export function accessMiddleware(fetchImpl) {
  return async function onRequest(context) {
    const result = await verifyAccess(context.request, context.env, fetchImpl || fetch).catch((e) => ({
      ok: false,
      reason: 'Access 校验失败：' + (e?.message || e),
    }));
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.reason }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return context.next();
  };
}
