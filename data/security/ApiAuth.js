import { ApiError, env, open, seal, safeEqual, clientIp } from '../core/helpers.js';
import { RateLimiter } from './RateLimiter.js';
import { Users } from '../database/models/Users.js';

const WEB_TTL = 3600;

export function sameOrigin(req) {
  const h = req.headers || {};
  if (h['sec-fetch-site'] === 'same-origin') return true;
  if (h.origin && h.host) {
    try { return new URL(h.origin).host === h.host; } catch { return false; }
  }
  return false;
}

/** Short-lived token for the website itself (stateless replacement for the PHP CSRF session). */
export function issueWebToken(req) {
  if (!sameOrigin(req)) throw new ApiError(403, 'forbidden', 'Cross-origin token requests are not allowed. Use an API key.');
  return { token: seal({ k: 'web' }, WEB_TTL), expires_in: WEB_TTL };
}

function apiKeyFrom(req) {
  const h = req.headers || {};
  if (h['x-api-key']) return String(h['x-api-key']).trim();
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || '');
  return m ? m[1].trim() : null;
}

async function verifyKey(key) {
  for (const k of String(env('API_KEYS', '')).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (k.length >= 16 && safeEqual(k, key)) return { type: 'key', id: 'env:' + k.slice(0, 4) + '…' + k.length };
  }
  const row = await Users.verify(key);
  return row ? { type: 'key', id: 'db:' + row.id } : null;
}

/** API key (bots) or same-origin web token (the website). Applies rate limiting. */
export async function authenticateClient(req, res) {
  let client;
  let limit;
  const key = apiKeyFrom(req);
  if (key !== null) {
    client = await verifyKey(key);
    if (!client) throw new ApiError(401, 'invalid_api_key', 'Invalid or revoked API key.');
    limit = Number(env('RATE_LIMIT_API', '60'));
  } else {
    const tok = req.headers['x-web-token'];
    const p = tok ? open(tok) : null;
    if (!p || p.k !== 'web' || !sameOrigin(req)) throw new ApiError(401, 'unauthorized', 'An API key is required.');
    client = { type: 'session', id: 'ip:' + clientIp(req) };
    limit = Number(env('RATE_LIMIT_WEB', '30'));
  }
  const r = await RateLimiter.hit('api', client.id, Math.max(1, limit));
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, r.reset - Math.floor(Date.now() / 1000))));
    throw new ApiError(429, 'rate_limited', 'Too many requests. Please slow down.');
  }
  return client;
}

export async function authenticateAdmin(req) {
  const token = env('ADMIN_TOKEN', '');
  if (token.length < 16) throw new ApiError(403, 'forbidden', 'Admin endpoints are disabled.');
  const r = await RateLimiter.hit('admin', clientIp(req), Number(env('RATE_LIMIT_ADMIN', '30')));
  if (!r.allowed) throw new ApiError(429, 'rate_limited', 'Too many requests.');
  if (!safeEqual(token, req.headers['x-admin-token'] || '')) throw new ApiError(403, 'forbidden', 'Invalid admin token.');
  return { type: 'admin', id: 'admin' };
}
