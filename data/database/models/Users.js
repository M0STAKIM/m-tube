import crypto from 'node:crypto';
import { getDb } from '../Db.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/** API clients ("users"): only a SHA-256 hash of each key is stored. */
export const Users = {
  async create(name) {
    const db = await getDb();
    const key = 'mt_' + crypto.randomBytes(24).toString('hex');
    const id = crypto.randomBytes(8).toString('hex');
    const clean = String(name || 'client').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 100) || 'client';
    await db.update('users', (d) => { d.users.push({ id, name: clean, role: 'api', key_hash: sha(key), key_prefix: key.slice(0, 8), revoked: false, created_at: now(), last_used_at: null }); });
    return { id, name: clean, key };
  },

  async verify(key) {
    if (!key || key.length > 100) return null;
    const db = await getDb();
    const hash = sha(key);
    const u = (await db.read('users')).users.find((x) => x.key_hash === hash && !x.revoked);
    if (!u) return null;
    if (!u.last_used_at || Date.now() - Date.parse(u.last_used_at) > TOUCH_EVERY_MS) {
      db.update('users', (d) => { const t = d.users.find((x) => x.id === u.id); if (t) t.last_used_at = now(); }).catch(() => {});
    }
    return { id: u.id, name: u.name };
  },

  async revoke(id) {
    const db = await getDb();
    return db.update('users', (d) => { const u = d.users.find((x) => x.id === id); if (!u) return false; u.revoked = true; return true; });
  },

  async all() {
    const db = await getDb();
    return (await db.read('users')).users.map((u) => ({ id: u.id, name: u.name, prefix: u.key_prefix, revoked: u.revoked, created_at: u.created_at, last_used_at: u.last_used_at }));
  },
};
