// Child process used by the cross-process concurrency test: increments a shared counter N times.
import { JsonDatabase } from '../../data/core/JsonDatabase.js';
import { LocalFileAdapter } from '../../data/core/StorageAdapters.js';
const [root, n] = process.argv.slice(2);
const db = new JsonDatabase({
  adapter: new LocalFileAdapter(root),
  collections: { counter: { file: 'counter.json', defaults: () => ({ version: 1, n: 0, by: {} }), validate: (d) => { if (typeof d.n !== 'number') throw new Error('n must be a number'); } } },
  backupMinIntervalMs: 0, backupKeep: 3,
});
await db.init();
await Promise.all(Array.from({ length: Number(n) }, () => db.update('counter', (d) => { d.n += 1; d.by[process.pid] = (d.by[process.pid] || 0) + 1; })));
