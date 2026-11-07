import path from 'node:path';
import { JsonDatabase } from '../core/JsonDatabase.js';
import { LocalFileAdapter, BlobAdapter } from '../core/StorageAdapters.js';
import { dbDir, storageDir, persistence } from '../core/paths.js';
import { config } from '../core/config.js';
import { env, log, encryptText, decryptText } from '../core/helpers.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const str = (v, max) => typeof v === 'string' && v.length <= max;
const records = (max, check) => (d) => {
  need(d.version === 1, 'version must be 1');
  need(Array.isArray(d.records), 'records must be an array');
  need(d.records.length <= max, `too many records (max ${max})`);
  d.records.forEach((r) => { need(isObj(r), 'record must be an object'); check(r); });
};
const counters = (o) => { need(isObj(o), 'counters must be an object'); for (const [k, v] of Object.entries(o)) need(str(k, 120) && Number.isFinite(v), 'invalid counter'); };

export const COLLECTIONS = {
  users: {
    file: 'users.json',
    defaults: () => ({ version: 1, users: [] }),
    validate(d) {
      need(d.version === 1 && Array.isArray(d.users), 'invalid shape');
      need(d.users.length <= 1000, 'too many users');
      for (const u of d.users) {
        need(isObj(u) && str(u.id, 32) && str(u.name, 100), 'invalid user');
        need(/^[a-f0-9]{64}$/.test(u.key_hash) && typeof u.revoked === 'boolean' && str(u.created_at, 40), 'invalid user key');
      }
    },
  },
  downloads: { file: 'downloads.json', defaults: () => ({ version: 1, records: [] }), validate: records(5000, (r) => need(str(r.id, 32) && str(r.status, 20), 'invalid download record')) },
  'search-history': { file: 'search-history.json', defaults: () => ({ version: 1, records: [] }), validate: records(2000, (r) => need(str(r.id, 32) && str(r.query, 200), 'invalid search record')) },
  analytics: {
    file: 'analytics.json',
    defaults: () => ({ version: 1, totals: {}, daily: {} }),
    validate(d) {
      need(d.version === 1, 'version must be 1');
      counters(d.totals);
      need(isObj(d.daily) && Object.keys(d.daily).length <= 400, 'invalid daily');
      Object.values(d.daily).forEach(counters);
    },
  },
  settings: {
    file: 'settings.json',
    defaults: () => ({ version: 1, settings: { maintenance: false, logging: true } }),
    validate(d) {
      need(d.version === 1 && isObj(d.settings), 'invalid shape');
      need(typeof d.settings.maintenance === 'boolean' && typeof d.settings.logging === 'boolean', 'invalid settings');
    },
  },
};

let cached = null;

/** Singleton JSON database (initialised once per process). */
export function getDb() {
  cached ||= (async () => {
    const p = persistence();
    let adapter;
    let dir = 'database';
    let backupDir = 'backups';
    if (p.adapter === 'blob') adapter = await BlobAdapter.create({ token: env('BLOB_READ_WRITE_TOKEN'), encrypt: encryptText, decrypt: decryptText });
    else {
      // database files and backups live in two different roots; map both through one adapter rooted at the common parent
      adapter = new LocalFileAdapter(commonRoot(), { persistent: p.persistent });
      dir = rel(dbDir()); backupDir = rel(storageDir('backups'));
    }
    const cfg = config('storage.backups', {});
    const db = new JsonDatabase({ adapter, collections: COLLECTIONS, dir, backupDir, backupKeep: cfg.keep ?? 10, backupMinIntervalMs: (cfg.min_interval_seconds ?? 60) * 1000, log });
    await db.init();
    return db;
  })();
  return cached;
}

function commonRoot() {
  const a = path.resolve(dbDir()); const b = path.resolve(storageDir('backups'));
  const pa = a.split(path.sep); const pb = b.split(path.sep);
  const out = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i] === pb[i]; i++) out.push(pa[i]);
  return out.join(path.sep) || path.sep;
}
const rel = (p) => path.relative(commonRoot(), path.resolve(p)).split(path.sep).join('/');

export function resetDb() { cached = null; }
export const loggingEnabled = () => env('JSON_DB_LOGGING', 'on') !== 'off';
