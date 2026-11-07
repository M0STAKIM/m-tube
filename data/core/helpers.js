import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { storageDir, isServerless } from './paths.js';

export const env = (k, d) => {
  const v = process.env[k];
  return v !== undefined && v !== '' ? v : d;
};
export const isProd = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
export const isPlaceholder = (v) => v == null || String(v).trim() === '' || /^YOUR_/i.test(String(v));

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* ---------- secrets / logging ---------- */
function secrets() {
  const s = [];
  try {
    const cfg = loadConfig();
    for (const p of Object.values(cfg.providers || {})) {
      for (const k of [p.api_key, p.mcp && p.mcp.api_key]) {
        if (typeof k === 'string' && k.length >= 8 && !isPlaceholder(k)) s.push(k);
      }
    }
  } catch { /* config unavailable */ }
  for (const k of ['APP_SECRET', 'ADMIN_TOKEN', 'BLOB_READ_WRITE_TOKEN']) {
    const v = env(k);
    if (v && v.length >= 6) s.push(v);
  }
  return s;
}
export function redact(text) {
  let t = String(text);
  for (const s of secrets()) t = t.split(s).join('[redacted]');
  return t;
}
let logBytes = null;
function fileLog(line) {
  if (process.env.MTUBE_LOG_FILE === '0') return;
  try {
    const dir = storageDir('logs');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'app.log');
    if (logBytes === null) { try { logBytes = fs.statSync(f).size; } catch { logBytes = 0; } }
    if (logBytes > 5 * 1048576) { // rotate: app.log -> app.log.1 -> app.log.2 -> app.log.3
      for (let i = 2; i >= 1; i--) { try { fs.renameSync(`${f}.${i}`, `${f}.${i + 1}`); } catch { /* none */ } }
      try { fs.renameSync(f, f + '.1'); } catch { /* none */ }
      logBytes = 0;
    }
    fs.appendFileSync(f, line + '\n', { mode: 0o600 });
    logBytes += line.length + 1;
  } catch { /* logging must never break a request */ }
}
export function log(channel, msg, ctx = {}) {
  const line = redact(JSON.stringify({ t: new Date().toISOString(), channel, msg, ...ctx }));
  if (process.env.MTUBE_QUIET !== '1') console.log(line);
  fileLog(line);
}

/* ---------- crypto: opaque, expiring, authenticated tokens ---------- */
/**
 * Secret used to seal tokens. Serverless: APP_SECRET is required (instances do not share a disk).
 * Local/VPS: APP_SECRET, or a random secret generated once and kept in data/storage/.secret.
 */
let cachedSecret = null;
export function appSecret() {
  const s = env('APP_SECRET');
  if (s) return s;
  if (isServerless()) throw new ApiError(503, 'not_configured', 'APP_SECRET environment variable is not set.');
  if (cachedSecret) return cachedSecret;
  const f = path.join(storageDir(), '.secret');
  try { cachedSecret = fs.readFileSync(f, 'utf8').trim(); } catch { /* create below */ }
  if (!cachedSecret || cachedSecret.length < 32) {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}
const key = () => crypto.createHash('sha256').update('mtube:' + appSecret()).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

/** AES-256-GCM sealed + deflated JSON with expiry. The browser can carry it but never read it. */
export function seal(obj, ttlSec) {
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify({ ...obj, e: Math.floor(Date.now() / 1000) + ttlSec })));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(payload), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}
export function open(token) {
  try {
    const raw = Buffer.from(String(token), 'base64url');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    const obj = JSON.parse(zlib.inflateRawSync(pt).toString('utf8'));
    return obj.e >= Math.floor(Date.now() / 1000) ? obj : null;
  } catch {
    return null;
  }
}
/** AES-256-GCM text encryption without expiry (used to protect objects in public object storage). */
export function encryptText(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(String(text), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
export function decryptText(token) {
  const raw = Buffer.from(String(token).trim(), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------- request helpers ---------- */
export function clientIp(req) {
  const h = req.headers || {};
  const first = (v) => String(v || '').split(',')[0].trim();
  if (isServerless()) return first(h['x-vercel-forwarded-for']) || first(h['x-real-ip']) || first(h['x-forwarded-for']) || req.socket?.remoteAddress || '0.0.0.0';
  if (env('TRUST_PROXY') === '1') return first(h['x-forwarded-for']) || req.ip || req.socket?.remoteAddress || '0.0.0.0';
  return req.socket?.remoteAddress || '0.0.0.0'; // direct connection: never trust client-supplied headers
}
export function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

/* ---------- data helpers (ported from the PHP version) ---------- */
const isObj = (v) => v !== null && typeof v === 'object';
const empty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (isObj(v) && !Array.isArray(v) && Object.keys(v).length === 0);

export function pick(obj, keys, def = null) {
  for (const k of keys) {
    let v = obj;
    for (const part of k.split('.')) {
      if (isObj(v) && Object.prototype.hasOwnProperty.call(v, part)) v = v[part];
      else { v = null; break; }
    }
    if (!empty(v)) return v;
  }
  return def;
}

export function toText(v) {
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(', ');
  if (isObj(v)) {
    if ('name' in v || 'title' in v || 'username' in v) return toText(pick(v, ['name', 'title', 'username']));
    return Object.values(v).map(toText).filter(Boolean).join(', ');
  }
  return '';
}

export function toSeconds(v, ms = false) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{1,2}(:\d{2}){1,2}$/.test(v)) return v.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  if ((typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) && Number.isFinite(Number(v))) {
    let n = Number(v);
    if (ms) n /= 1000;
    return n > 0 ? Math.round(n) : null;
  }
  return null;
}

const httpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
export function firstUrl(v) {
  if (typeof v === 'string') return httpUrl(v) ? v : '';
  if (isObj(v)) {
    let best = '';
    let bw = -1;
    for (const it of Array.isArray(v) ? v : Object.values(v)) {
      const u = isObj(it) ? pick(it, ['url', 'src']) : it;
      const w = isObj(it) ? Number(pick(it, ['width'], 0)) || 0 : 0;
      if (httpUrl(u) && w >= bw) { best = u; bw = w; }
    }
    return best;
  }
  return '';
}

const KNOWN_PLATFORMS = {
  'youtube.com': 'youtube', 'youtu.be': 'youtube', 'soundcloud.com': 'soundcloud', 'spotify.com': 'spotify',
  'instagram.com': 'instagram', 'tiktok.com': 'tiktok', 'facebook.com': 'facebook', 'fb.watch': 'facebook',
  'twitter.com': 'twitter', 'x.com': 'twitter', 'vimeo.com': 'vimeo', 'dailymotion.com': 'dailymotion',
  'reddit.com': 'reddit', 'pinterest.com': 'pinterest', 'twitch.tv': 'twitch',
};
export function detectPlatform(url) {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch { /* ignore */ }
  h = h.replace(/^(www\.|m\.)/, '');
  for (const [d, p] of Object.entries(KNOWN_PLATFORMS)) if (h === d || h.endsWith('.' + d)) return p;
  return 'other';
}

export function parseQuality(raw, type) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  const s = String(raw);
  let n;
  let m;
  if (type === 'video' && (m = /(\d{3,4})\s*[x×]\s*(\d{3,4})/.exec(s))) n = Number(m[2]);
  else if (typeof raw === 'number' || /^\d+(\.\d+)?$/.test(s)) n = Math.trunc(Number(raw));
  else if ((m = /(\d{2,5})/.exec(s))) n = Number(m[1]);
  else return null;
  if (type === 'audio') {
    if (n >= 8000) n = Math.trunc(n / 1000);
    return n >= 32 && n <= 512 ? n : null;
  }
  return n >= 100 && n <= 4400 ? n : null;
}

export function makeFormat(type, url, ext, quality, size = null) {
  return {
    type, ext, quality,
    quality_label: quality ? (type === 'video' ? quality + 'p' : quality + ' kbps') : 'Best available',
    size, url,
  };
}

const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', '3gp': 'video/3gpp' };
export const mimeFromExt = (ext) => MIME[String(ext).toLowerCase()] || 'application/octet-stream';
const MIME_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov' };
export const extFromMime = (ct) => MIME_EXT[String(ct || '').split(';')[0].trim().toLowerCase()] || '';

export function sanitizeFilename(title, ext) {
  let t = String(title ?? '').normalize('NFC');
  t = t.replace(/[\u0000-\u001F\u007F]/g, '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
  if (!t) t = 'M-TUBE Download';
  t = Array.from(t).slice(0, 150).join('').replace(/^[ .]+|[ .]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t += '_';
  const e = String(ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return t + (e ? '.' + e : '');
}

export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
