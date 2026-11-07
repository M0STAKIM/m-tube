import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config } from '../core/config.js';
import { storageDir } from '../core/paths.js';
import { seal, open, log } from '../core/helpers.js';
import { ProviderException } from '../providers/AdapterInterface.js';

const REF_TTL = 1800;
const mem = new Map(); // small in-process front for the file cache
let lastCleanup = 0;

const num = (k, d) => Number(config('storage.' + k, d));
const dirs = () => ({ temp: storageDir('temp'), cache: storageDir('cache'), downloads: storageDir('downloads'), logs: storageDir('logs'), backups: storageDir('backups') });
const cacheFile = (key) => path.join(storageDir('cache'), crypto.createHash('sha256').update(key).digest('hex').slice(0, 40) + '.json');

async function listFiles(dir) {
  try {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const st = await fs.stat(p).catch(() => null);
      if (st) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
    }
    return out;
  } catch { return []; }
}

/** Private local storage (temp, cache, downloads, logs, backups). Nothing here is ever served publicly. */
export const FileManager = {
  maxBytes: () => Math.max(1, num('max_file_size_mb', 500)) * 1048576,

  async init() {
    for (const d of Object.values(dirs())) await fs.mkdir(d, { recursive: true, mode: 0o700 });
  },

  /* ---- sealed references (stateless) ---- */
  sealRef(data) { return seal(data, REF_TTL); },
  openRef(token) { return open(token); },

  /* ---- file-backed cache ---- */
  async cacheGet(key) {
    const m = mem.get(key);
    if (m && m.exp > Date.now()) return m.v;
    try {
      const j = JSON.parse(await fs.readFile(cacheFile(key), 'utf8'));
      if (j.exp > Date.now()) { mem.set(key, { v: j.v, exp: j.exp }); return j.v; }
      await fs.unlink(cacheFile(key)).catch(() => {});
    } catch { /* miss */ }
    return null;
  },

  async cachePut(key, v, ttlSec = 300) {
    const exp = Date.now() + ttlSec * 1000;
    if (mem.size > 500) mem.clear();
    mem.set(key, { v, exp });
    try {
      await fs.mkdir(storageDir('cache'), { recursive: true });
      const f = cacheFile(key);
      const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ exp, v }), { mode: 0o600 });
      await fs.rename(tmp, f);
    } catch (e) { log('storage', 'cache write failed: ' + e.message); }
  },

  /* ---- temporary media staging (DOWNLOAD_MODE=file) ---- */
  async usage() {
    const d = dirs();
    const sum = async (dir) => (await listFiles(dir)).reduce((a, f) => a + f.size, 0);
    return { temp: await sum(d.temp), downloads: await sum(d.downloads), cache: await sum(d.cache) };
  },

  /** Make sure `needed` more bytes fit under storage.max_temp_size_mb (expired files are removed first). */
  async ensureCapacity(needed = 0) {
    const limit = num('max_temp_size_mb', 1024) * 1048576;
    let u = await this.usage();
    if (u.temp + u.downloads + needed > limit) {
      await this.cleanup({ force: true });
      u = await this.usage();
    }
    if (u.temp + u.downloads + needed > limit) throw new ProviderException('storage_full', 'Server storage is full right now. Please try again shortly.');
  },

  /** Stream a provider response into temp/ (as .part), then promote it to downloads/. */
  async stage({ stream, transform, ext, signal }) {
    await this.init();
    const id = crypto.randomBytes(12).toString('hex');
    const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin';
    const part = path.join(storageDir('temp'), id + '.part');
    const final = path.join(storageDir('downloads'), `${id}.${safeExt}`);
    try {
      await pipeline(stream, transform, createWriteStream(part, { mode: 0o600 }), { signal });
      const size = (await fs.stat(part)).size;
      await fs.rename(part, final);
      return { path: final, size, id };
    } catch (e) {
      await fs.unlink(part).catch(() => {});
      throw e;
    }
  },

  async remove(p) { await fs.unlink(p).catch(() => {}); },

  /** Delete expired temp/download/cache files and enforce size limits. Throttled to once a minute unless forced. */
  async cleanup({ force = false } = {}) {
    if (!config('storage.cleanup_enabled', true)) return null;
    if (!force && Date.now() - lastCleanup < 60000) return null;
    lastCleanup = Date.now();
    const ttl = num('temp_ttl_seconds', 3600) * 1000;
    const d = dirs();
    const removed = { temp: 0, downloads: 0, cache: 0 };
    for (const k of ['temp', 'downloads']) {
      for (const f of await listFiles(d[k])) if (Date.now() - f.mtime > ttl) { await fs.unlink(f.path).catch(() => {}); removed[k]++; }
    }
    let files = await listFiles(d.cache);
    for (const f of files) {
      let expired = Date.now() - f.mtime > 24 * 3600 * 1000;
      if (!expired && f.path.endsWith('.json')) {
        try { expired = JSON.parse(await fs.readFile(f.path, 'utf8')).exp < Date.now(); } catch { expired = true; }
      }
      if (expired || f.path.endsWith('.tmp')) { await fs.unlink(f.path).catch(() => {}); removed.cache++; }
    }
    files = (await listFiles(d.cache)).sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((a, f) => a + f.size, 0);
    const cap = num('max_cache_size_mb', 200) * 1048576;
    for (const f of files) { if (total <= cap) break; await fs.unlink(f.path).catch(() => {}); total -= f.size; removed.cache++; }
    return removed;
  },

  _resetForTests() { mem.clear(); lastCleanup = 0; },
};
