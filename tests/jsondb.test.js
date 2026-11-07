import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
process.env.MTUBE_QUIET = '1';
process.env.MTUBE_LOG_FILE = '0';
process.env.APP_SECRET = 'jsondb-test-secret-0123456789abcdef';

const { JsonDatabase, JsonDbValidationError } = await import('../data/core/JsonDatabase.js');
const { LocalFileAdapter, BlobAdapter } = await import('../data/core/StorageAdapters.js');
const { encryptText, decryptText } = await import('../data/core/helpers.js');
const { tmp } = await import('./mocks.js');

const COLS = {
  counter: { file: 'counter.json', defaults: () => ({ version: 1, n: 0, by: {} }), validate: (d) => { if (typeof d.n !== 'number') throw new Error('n must be a number'); } },
  items: { file: 'items.json', defaults: () => ({ version: 1, records: [] }), validate: (d) => { if (!Array.isArray(d.records) || d.records.length > 50) throw new Error('bad records'); } },
};
const mk = (root, o = {}) => new JsonDatabase({ adapter: new LocalFileAdapter(root), collections: COLS, backupMinIntervalMs: 0, backupKeep: 3, ...o });
const readRaw = (root, f) => fs.readFile(path.join(root, 'database', f), 'utf8');

test('init creates missing files with default data and is idempotent', async () => {
  const root = tmp();
  const db = await mk(root).init();
  assert.deepEqual(JSON.parse(await readRaw(root, 'counter.json')), { version: 1, n: 0, by: {} });
  assert.deepEqual(JSON.parse(await readRaw(root, 'items.json')).records, []);
  await db.update('counter', (d) => { d.n = 5; });
  await mk(root).init(); // must not overwrite existing data
  assert.equal(JSON.parse(await readRaw(root, 'counter.json')).n, 5);
});

test('read returns a private copy; update persists; write replaces', async () => {
  const root = tmp();
  const db = await mk(root).init();
  const a = await db.read('counter'); a.n = 99;
  assert.equal((await db.read('counter')).n, 0);
  assert.equal(await db.update('counter', (d) => { d.n += 2; return 'ret'; }), 'ret');
  assert.equal((await db.read('counter')).n, 2);
  await db.write('counter', { version: 1, n: 7, by: {} });
  assert.equal((await db.read('counter')).n, 7);
  await assert.rejects(() => db.read('nope'), /Unknown collection/);
});

test('invalid data is rejected before saving and the file is left untouched', async () => {
  const root = tmp();
  const db = await mk(root).init();
  await db.update('counter', (d) => { d.n = 3; });
  const before = await readRaw(root, 'counter.json');
  await assert.rejects(() => db.update('counter', (d) => { d.n = 'bad'; }), JsonDbValidationError);
  await assert.rejects(() => db.update('items', (d) => { for (let i = 0; i < 60; i++) d.records.push(i); }), JsonDbValidationError);
  await assert.rejects(() => db.update('counter', () => { throw new Error('abort'); }), /abort/);
  assert.equal(await readRaw(root, 'counter.json'), before);
});

test('atomic writes leave no temp or lock files behind', async () => {
  const root = tmp();
  const db = await mk(root).init();
  for (let i = 0; i < 20; i++) await db.update('counter', (d) => { d.n++; });
  const files = await fs.readdir(path.join(root, 'database'));
  assert.deepEqual(files.sort(), ['counter.json', 'items.json']);
});

test('concurrent writes in one process are serialised (no lost updates)', async () => {
  const root = tmp();
  const db = await mk(root).init();
  await Promise.all(Array.from({ length: 200 }, () => db.update('counter', (d) => { d.n += 1; })));
  assert.equal((await db.read('counter')).n, 200);
  JSON.parse(await readRaw(root, 'counter.json')); // still valid JSON
});

test('concurrent writes from several PROCESSES are safe (file lock)', async () => {
  const root = tmp();
  await mk(root).init();
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/worker.mjs');
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [worker, root, '40'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('worker failed: ' + err))));
  });
  await Promise.all([run(), run(), run(), run()]);
  const d = JSON.parse(await readRaw(root, 'counter.json'));
  assert.equal(d.n, 160);
  assert.equal(Object.values(d.by).reduce((a, b) => a + b, 0), 160);
});

test('backups are created, pruned to the limit, listed newest first and restorable', async () => {
  const root = tmp();
  const db = await mk(root).init();
  for (let i = 1; i <= 8; i++) { await db.update('counter', (d) => { d.n = i; }); await new Promise((r) => setTimeout(r, 3)); }
  const list = await db.listBackups('counter');
  assert.equal(list.length, 3); // backupKeep
  assert.ok(list[0].id > list[1].id);
  const forced = await db.backup('counter');
  assert.ok(forced);
  await db.update('counter', (d) => { d.n = 1000; });
  const restoredId = await db.restore('counter', forced);
  assert.equal(restoredId, forced);
  assert.equal((await db.read('counter')).n, 8);
  await assert.rejects(() => db.restore('counter', 'nope'), /No matching backup/);
});

test('corrupted file is quarantined and recovered from the newest valid backup', async () => {
  const root = tmp();
  const db = await mk(root).init();
  await db.update('counter', (d) => { d.n = 41; });
  await db.update('counter', (d) => { d.n = 42; });
  await fs.writeFile(path.join(root, 'database/counter.json'), '{"version":1,"n":4'); // truncated write / crash
  const d = await db.read('counter');
  assert.ok([41, 42].includes(d.n), 'restored from a backup, got ' + d.n);
  JSON.parse(await readRaw(root, 'counter.json'));
  const corrupt = (await fs.readdir(path.join(root, 'backups'))).filter((f) => f.includes('.corrupt.'));
  assert.equal(corrupt.length, 1);
  // schema-invalid (valid JSON, wrong shape) is also treated as corruption
  await fs.writeFile(path.join(root, 'database/counter.json'), '{"version":1,"n":"x"}');
  assert.equal(typeof (await db.read('counter')).n, 'number');
});

test('corruption with no backup resets to defaults (and keeps the corrupt copy)', async () => {
  const root = tmp();
  const db = await mk(root, { backupMinIntervalMs: 10 ** 9 }).init();
  await fs.writeFile(path.join(root, 'database/items.json'), 'not json at all');
  assert.deepEqual((await db.read('items')).records, []);
  assert.ok((await fs.readdir(path.join(root, 'backups'))).some((f) => f.includes('.corrupt.')));
});

test('data persists across a restart (new instances on the same files)', async () => {
  const root = tmp();
  let db = await mk(root).init();
  await db.update('items', (d) => { d.records.push({ a: 1 }, { a: 2 }); });
  db = await mk(root).init();
  assert.deepEqual((await db.read('items')).records, [{ a: 1 }, { a: 2 }]);
  assert.equal((await db.stats()).items.records, 2);
});

test('adapter rejects path traversal and absolute keys', async () => {
  const root = tmp();
  const a = new LocalFileAdapter(root);
  for (const k of ['../x.json', 'a/../../x', '/etc/passwd', '', 'a\0b', '..\\x']) await assert.rejects(() => a.write(k, 'x'), /Invalid storage key/, k);
  await a.write('ok/inner.json', '{}');
  assert.equal(await a.read('ok/inner.json'), '{}');
  assert.equal(await a.read('missing.json'), null);
  assert.deepEqual(await a.list('ok'), ['ok/inner.json']);
});

test('Vercel Blob adapter: encrypted at rest, same JsonDatabase interface (fake SDK)', async () => {
  const store = new Map();
  const sdk = { // mirrors the @vercel/blob calls the adapter makes (put / list / del)
    put: async (p, body) => { store.set(p, body); return { url: 'https://blob.example/' + p, pathname: p }; },
    list: async ({ prefix }) => ({ blobs: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ pathname: k, url: 'https://blob.example/' + k })) }),
    del: async (url) => { store.delete(url.replace('https://blob.example/', '')); },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { const k = String(u).replace('https://blob.example/', '').split('?')[0]; return store.has(k) ? new Response(store.get(k)) : new Response('', { status: 404 }); };
  try {
    const adapter = new BlobAdapter(sdk, { token: 't', encrypt: encryptText, decrypt: decryptText });
    const db = new JsonDatabase({ adapter, collections: COLS, backupMinIntervalMs: 0, backupKeep: 2 });
    await db.init();
    await Promise.all(Array.from({ length: 5 }, () => db.update('counter', (d) => { d.n += 1; })));
    assert.equal((await db.read('counter')).n, 5);
    const raw = [...store.values()].join('\n');
    assert.ok(!raw.includes('"version"') && !raw.includes('"n"'), 'blob content must be encrypted');
    assert.ok((await db.listBackups('counter')).length >= 1);
    assert.equal(adapter.persistent, true);
  } finally { globalThis.fetch = realFetch; }
});
