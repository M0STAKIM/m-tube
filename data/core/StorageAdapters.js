import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Storage adapter contract (async):
 *   read(key) -> string|null   write(key, text) (atomic)   remove(key)   exists(key)
 *   list(prefix) -> keys[]     lock(key, fn) (cross-process lock; may be a no-op)    info: { kind, persistent }
 * The JsonDatabase only talks to this interface, so another backend can be added without touching app logic.
 */
export class LocalFileAdapter {
  constructor(root, { persistent = true } = {}) {
    this.root = path.resolve(root);
    this.kind = 'local';
    this.persistent = persistent;
  }

  resolve(key) {
    const k = String(key || '');
    if (!k || k.includes('\0') || path.isAbsolute(k) || k.split(/[\\/]/).includes('..')) throw new Error('Invalid storage key');
    const p = path.resolve(this.root, k);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return p;
  }

  async read(key) {
    try { return await fs.readFile(this.resolve(key), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  /** Atomic write: temp file in the same directory -> fsync -> rename over the target. */
  async write(key, text) {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const fh = await fs.open(tmp, 'w', 0o600);
      try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
      await fs.rename(tmp, p);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async remove(key) { await fs.unlink(this.resolve(key)).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
  async exists(key) { try { await fs.access(this.resolve(key)); return true; } catch { return false; } }

  async list(prefix = '') {
    const dir = this.resolve(prefix || '.');
    try {
      const out = [];
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.isFile() && !/\.(tmp|lock)$/.test(e.name)) out.push(path.posix.join(prefix.replace(/\\/g, '/'), e.name));
      }
      return out;
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }

  /** Cross-process lock via an exclusive lock file (stale locks are broken after staleMs). */
  async lock(key, fn, { timeoutMs = 10000, staleMs = 15000 } = {}) {
    const lockPath = this.resolve(key + '.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        const fh = await fs.open(lockPath, 'wx', 0o600);
        await fh.writeFile(String(process.pid));
        await fh.close();
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const st = await fs.stat(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) { await fs.unlink(lockPath).catch(() => {}); continue; }
        } catch { continue; }
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the database lock');
        await sleep(10 + Math.random() * 25);
      }
    }
    try { return await fn(); } finally { await fs.unlink(lockPath).catch(() => {}); }
  }
}

/**
 * Vercel Blob (object storage — not a database) adapter for persistent JSON on Vercel.
 * Blob URLs are public, so every object is AES-GCM encrypted with APP_SECRET before upload.
 * Limits: no cross-instance locking (concurrent writers = last write wins) and CDN reads can lag by
 * seconds; reads add a cache-busting query. Suitable for low-traffic data only.
 * `sdk` = { put, list, del } from '@vercel/blob' (injectable for tests).
 */
export class BlobAdapter {
  constructor(sdk, { token, prefix = 'mtube/', encrypt, decrypt }) {
    this.sdk = sdk; this.token = token; this.prefix = prefix; this.enc = encrypt; this.dec = decrypt;
    this.kind = 'blob'; this.persistent = true;
  }

  static async create({ token, encrypt, decrypt }) {
    const sdk = await import('@vercel/blob');
    return new BlobAdapter(sdk, { token, encrypt, decrypt });
  }

  #path(key) {
    const k = String(key || '');
    if (!k || k.includes('\0') || k.startsWith('/') || k.split('/').includes('..')) throw new Error('Invalid storage key');
    return this.prefix + k;
  }

  async #find(key) {
    const pathname = this.#path(key);
    const r = await this.sdk.list({ prefix: pathname, limit: 20, token: this.token });
    return (r.blobs || []).find((b) => b.pathname === pathname) || null;
  }

  async read(key) {
    const b = await this.#find(key);
    if (!b) return null;
    const res = await fetch(`${b.url}${b.url.includes('?') ? '&' : '?'}v=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Blob read failed: HTTP ' + res.status);
    return this.dec(await res.text());
  }

  async write(key, text) {
    await this.sdk.put(this.#path(key), this.enc(text), {
      access: 'public', token: this.token, addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain', cacheControlMaxAge: 60,
    });
  }

  async remove(key) { const b = await this.#find(key); if (b) await this.sdk.del(b.url, { token: this.token }); }
  async exists(key) { return !!(await this.#find(key)); }

  async list(prefix = '') {
    const r = await this.sdk.list({ prefix: this.prefix + prefix, limit: 1000, token: this.token });
    return (r.blobs || []).map((b) => b.pathname.slice(this.prefix.length));
  }

  async lock(_key, fn) { return fn(); } // no cross-instance lock available on object storage
}
