import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
process.env.NODE_ENV = 'test';
process.env.MTUBE_QUIET = '1';
process.env.APP_SECRET = 'storage-test-secret-0123456789abcdef';
const { tmp, writeConfig } = await import('./mocks.js');
const dir = tmp();
process.env.MTUBE_DATA_DIR = dir;
process.env.MTUBE_CONFIG_PATH = writeConfig(dir, { mcp: 'http://127.0.0.1:1/mcp', httpBase: 'http://127.0.0.1:1', overrides: {
  storage: { driver: 'local', max_file_size_mb: 1, cleanup_enabled: true, temp_ttl_seconds: 60, max_temp_size_mb: 1, max_cache_size_mb: 1, backups: { keep: 3, min_interval_seconds: 0 } },
} });

const { FileManager } = await import('../data/backend/FileManager.js');
const { TagPrefixer, Metadata } = await import('../data/backend/Metadata.js');
const { storageDir, persistence, dbDir } = await import('../data/core/paths.js');
const { getDb } = await import('../data/database/Db.js');
const { Users } = await import('../data/database/models/Users.js');
const { Downloads } = await import('../data/database/models/Downloads.js');
const { SearchHistory } = await import('../data/database/models/SearchHistory.js');
const { Analytics } = await import('../data/database/models/Analytics.js');
const { Settings } = await import('../data/database/models/Settings.js');
const { log } = await import('../data/core/helpers.js');

const old = async (p, ageSec) => { const t = new Date(Date.now() - ageSec * 1000); await fs.utimes(p, t, t); };

test('storage folders are created under data/storage layout and are local+persistent here', async () => {
  await FileManager.init();
  for (const d of ['temp', 'cache', 'downloads', 'logs', 'backups']) assert.ok((await fs.stat(storageDir(d))).isDirectory(), d);
  assert.deepEqual(persistence(), { adapter: 'local', mode: 'local', persistent: true });
  assert.equal(dbDir(), path.join(dir, 'database'));
});

test('JSON database files, repositories and defaults', async () => {
  await getDb();
  for (const f of ['users', 'downloads', 'search-history', 'analytics', 'settings']) assert.ok((await fs.stat(path.join(dbDir(), f + '.json'))).isFile(), f);
  assert.deepEqual(await Settings.get(), { maintenance: false, logging: true });
  const k = await Users.create('bot one');
  assert.match(k.key, /^mt_[a-f0-9]{48}$/);
  assert.equal((await Users.verify(k.key)).name, 'bot one');
  const stored = await fs.readFile(path.join(dbDir(), 'users.json'), 'utf8');
  assert.ok(!stored.includes(k.key), 'the key itself must never be stored');
  assert.equal(await Users.verify('mt_wrong'), null);
  assert.equal(await Users.revoke(k.id), true);
  assert.equal(await Users.verify(k.key), null);
  await Downloads.record({ provider: 'p', type: 'audio', title: 'T', platform: 'youtube', status: 'ok', bytes: 10, ip: '1.2.3.4' });
  const rec = (await Downloads.recent(1))[0];
  assert.equal(rec.title, 'T');
  assert.ok(!JSON.stringify(rec).includes('1.2.3.4'), 'raw IP must not be stored');
  await SearchHistory.record({ query: 'abc', provider: 'x', results: 3, ip: '1.2.3.4' });
  await Analytics.bump(['a', 'b']); await Analytics.bump('a');
  assert.deepEqual({ a: (await Analytics.totals()).a, b: (await Analytics.totals()).b }, { a: 2, b: 1 });
  assert.deepEqual(await Settings.set({ maintenance: true, bogus: 1, logging: 'no' }), { maintenance: true, logging: true });
  await Settings.set({ maintenance: false });
});

test('history/analytics writes are capped (oldest removed)', async () => {
  const db = await getDb();
  await db.update('downloads', (d) => { d.records = Array.from({ length: 4999 }, (_, i) => ({ id: 'x' + i, status: 'ok' })); });
  for (let i = 0; i < 3; i++) await Downloads.record({ status: 'ok', title: 'n' + i });
  const n = (await db.read('downloads')).records.length;
  assert.equal(n, 5000);
});

test('stage(): writes via temp (.part) into downloads, ID3 prefixed, deletable', async () => {
  const body = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(1000, 5)]);
  const tag = Metadata.id3('T', 'A');
  const s = await FileManager.stage({ stream: Readable.from([body]), transform: new TagPrefixer(tag, 1 << 20), ext: 'mp3' });
  assert.equal(s.size, tag.length + body.length);
  assert.equal(path.dirname(s.path), storageDir('downloads'));
  assert.deepEqual(await fs.readdir(storageDir('temp')), ['.gitkeep'].filter(() => false));
  await FileManager.remove(s.path);
  await assert.rejects(() => fs.stat(s.path));
});

test('stage(): enforces the max file size and removes the partial file', async () => {
  const big = Readable.from([Buffer.alloc(700 * 1024), Buffer.alloc(700 * 1024)]);
  await assert.rejects(() => FileManager.stage({ stream: big, transform: new TagPrefixer(Buffer.alloc(0), FileManager.maxBytes()), ext: 'mp4' }), { kind: 'too_large' });
  assert.deepEqual(await fs.readdir(storageDir('temp')), []);
});

test('storage limit: ensureCapacity refuses when the temp quota would be exceeded', async () => {
  await fs.writeFile(path.join(storageDir('downloads'), 'filler.mp4'), Buffer.alloc(900 * 1024));
  await assert.rejects(() => FileManager.ensureCapacity(300 * 1024), { kind: 'storage_full' });
  await FileManager.ensureCapacity(10 * 1024); // still fits
  await fs.unlink(path.join(storageDir('downloads'), 'filler.mp4'));
});

test('cleanup removes expired temp/download files and expired cache, keeps fresh ones', async () => {
  const t = path.join(storageDir('temp'), 'stale.part'); const d1 = path.join(storageDir('downloads'), 'stale.mp3'); const fresh = path.join(storageDir('downloads'), 'fresh.mp3');
  await fs.writeFile(t, 'x'); await fs.writeFile(d1, 'x'); await fs.writeFile(fresh, 'x');
  await old(t, 7200); await old(d1, 7200);
  await FileManager.cachePut('k-expired', { a: 1 }, -1); await FileManager.cachePut('k-live', { a: 2 }, 600);
  FileManager._resetForTests();
  const removed = await FileManager.cleanup({ force: true });
  assert.ok(removed.temp >= 1 && removed.downloads >= 1 && removed.cache >= 1, JSON.stringify(removed));
  await assert.rejects(() => fs.stat(t)); await assert.rejects(() => fs.stat(d1)); await fs.stat(fresh);
  assert.deepEqual(await FileManager.cacheGet('k-live'), { a: 2 });
  assert.equal(await FileManager.cacheGet('k-expired'), null);
  await fs.unlink(fresh);
});

test('file cache survives a restart (read back from disk, not memory)', async () => {
  await FileManager.cachePut('persist-me', { v: 'ok' }, 600);
  FileManager._resetForTests(); // drops the in-memory front
  assert.deepEqual(await FileManager.cacheGet('persist-me'), { v: 'ok' });
});

test('logs are written to data/storage/logs and secrets are redacted', async () => {
  log('test', 'hello world', { secret: process.env.APP_SECRET });
  const text = await fs.readFile(path.join(storageDir('logs'), 'app.log'), 'utf8');
  assert.ok(text.includes('hello world'));
  assert.ok(!text.includes(process.env.APP_SECRET) && text.includes('[redacted]'));
});

test('private storage is not under public/ (nothing in the static root)', async () => {
  const pub = path.resolve('public');
  for (const p of [dbDir(), storageDir()]) assert.ok(!path.resolve(p).startsWith(pub + path.sep));
  assert.ok(!(await fs.readdir(pub)).some((f) => /\.json$|storage|database/.test(f)));
});

test('Vercel mode without Blob is reported as ephemeral (not persistent)', async () => {
  const keep = { V: process.env.VERCEL, B: process.env.BLOB_READ_WRITE_TOKEN };
  process.env.VERCEL = '1'; delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    assert.deepEqual(persistence(), { adapter: 'local', mode: 'ephemeral', persistent: false });
    process.env.BLOB_READ_WRITE_TOKEN = 'x';
    assert.deepEqual(persistence(), { adapter: 'blob', mode: 'blob', persistent: true });
  } finally { if (keep.V === undefined) delete process.env.VERCEL; else process.env.VERCEL = keep.V; if (keep.B === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = keep.B; }
});
