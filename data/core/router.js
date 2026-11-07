import { routes } from '../api/routes.js';
import { ensureReady } from './bootstrap.js';
import { ConfigError } from './config.js';
import { ApiError, log, sendJson } from './helpers.js';
import { ProviderException } from '../providers/AdapterInterface.js';
import { authenticateClient, authenticateAdmin } from '../security/ApiAuth.js';
import { FileManager } from '../backend/FileManager.js';
import { Settings } from '../database/models/Settings.js';

const PROVIDER_STATUS = {
  unsupported: [422, 'unsupported'], no_media: [404, 'no_media'], not_configured: [503, 'not_configured'], expired: [410, 'expired'],
  bad_format: [422, 'bad_format'], too_large: [413, 'too_large'], all_failed: [502, 'providers_failed'], storage_full: [503, 'storage_full'],
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return {};
  let raw = req.body;
  if (raw === undefined) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 262144) throw new ApiError(413, 'too_large', 'Request body too large.');
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!text) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { const j = JSON.parse(text); return j && typeof j === 'object' ? j : {}; } catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.'); }
}

export function handleError(res, e) {
  if (e instanceof ApiError) return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } });
  if (e instanceof ProviderException) {
    const [status, code] = PROVIDER_STATUS[e.kind] || [502, 'provider_error'];
    return sendJson(res, status, { ok: false, error: { code, message: e.message, ...(e.attempts.length ? { attempts: e.attempts } : {}) } });
  }
  if (e instanceof ConfigError) {
    log('config', e.message);
    return sendJson(res, 503, { ok: false, error: { code: 'config_error', message: e.message } });
  }
  log('app', `Unhandled ${e?.name}: ${e?.message}`, { stack: String(e?.stack || '').split('\n').slice(1, 3).join(' | ') });
  if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return undefined; }
  return sendJson(res, 500, { ok: false, error: { code: 'server_error', message: 'An unexpected error occurred. Please try again later.' } });
}

/** Builds a Vercel/Node (req,res) handler for one route name. */
export function createHandler(name) {
  return async function handler(req, res) {
    try {
      securityHeaders(res);
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      const route = routes[name];
      if (!route) throw new ApiError(404, 'not_found', 'Unknown API endpoint.');
      if (!route.methods.includes(req.method)) {
        res.setHeader('Allow', route.methods.join(', '));
        throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      }
      await ensureReady();
      const url = new URL(req.url, 'http://localhost');
      const query = Object.fromEntries(url.searchParams);
      if (route.auth !== 'admin' && route.auth !== 'none' && await Settings.isMaintenance()) throw new ApiError(503, 'maintenance', 'M-TUBE is under maintenance. Please try again later.');
      let client = null;
      if (route.auth === 'admin') client = await authenticateAdmin(req);
      else if (route.auth === 'client' && !(route.anonymous && route.anonymous(req, url))) client = await authenticateClient(req, res);
      const input = { ...query, ...(await readBody(req)) };
      await route.handle({ req, res, client, input, query, url });
      FileManager.cleanup().catch(() => {});
      return undefined;
    } catch (e) {
      return handleError(res, e);
    }
  };
}
