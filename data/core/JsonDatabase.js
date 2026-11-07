import crypto from 'node:crypto';

export class JsonDbValidationError extends Error {}

/**
 * Small JSON file database.
 *  - files are created and initialised with defaults automatically
 *  - every write is validated, serialised, parse-checked, then written atomically (temp file + rename)
 *  - writes are serialised in-process (mutex) and across processes (adapter lock)
 *  - timestamped backups are kept (pruned); a corrupt file is quarantined and restored from the newest valid backup
 * `collections`: { name: { file, defaults(): object, validate(data): void (throws) } }
 */
export class JsonDatabase {
  constructor({ adapter, collections, dir = 'database', backupDir = 'backups', backupKeep = 10, backupMinIntervalMs = 60000, log = () => {} }) {
    this.adapter = adapter;
    this.collections = collections;
    this.dir = dir;
    this.backupDir = backupDir;
    this.keep = Math.max(1, backupKeep);
    this.minInterval = backupMinIntervalMs;
    this.log = log;
    this.queues = new Map();
    this.lastBackup = new Map();
  }

  #col(name) {
    const c = this.collections[name];
    if (!c) throw new Error(`Unknown collection "${name}"`);
    return c;
  }
  #key(name) { return `${this.dir}/${this.#col(name).file}`; }

  #validate(name, data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new JsonDbValidationError(`${name}: root must be an object`);
    try { this.#col(name).validate(data); } catch (e) { throw new JsonDbValidationError(`${name}: ${e.message}`); }
  }

  /** Create missing files with defaults; recover broken ones. */
  async init() {
    for (const name of Object.keys(this.collections)) await this.#serial(name, () => this.adapter.lock(this.#key(name), () => this.#load(name)));
    return this;
  }

  #serial(name, fn) {
    const prev = this.queues.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.queues.set(name, run.catch(() => {}));
    return run;
  }

  async #load(name) {
    const key = this.#key(name);
    const text = await this.adapter.read(key);
    if (text === null) {
      const d = this.#col(name).defaults();
      this.#validate(name, d);
      await this.adapter.write(key, JSON.stringify(d, null, 2) + '\n');
      return d;
    }
    try {
      const data = JSON.parse(text);
      this.#validate(name, data);
      return data;
    } catch (e) {
      return this.#recover(name, text, e);
    }
  }

  async #recover(name, badText, cause) {
    const key = this.#key(name);
    const ts = new Date().toISOString().replace(/[-:.]/g, '');
    this.log('jsondb', `${name}: file is invalid (${cause.message}); quarantining and recovering`);
    await this.adapter.write(`${this.backupDir}/${this.#col(name).file}.corrupt.${ts}`, badText).catch(() => {});
    for (const b of await this.listBackups(name)) {
      try {
        const data = JSON.parse(await this.adapter.read(b.key));
        this.#validate(name, data);
        await this.adapter.write(key, JSON.stringify(data, null, 2) + '\n');
        this.log('jsondb', `${name}: restored from backup ${b.id}`);
        return data;
      } catch { /* try an older backup */ }
    }
    const d = this.#col(name).defaults();
    await this.adapter.write(key, JSON.stringify(d, null, 2) + '\n');
    this.log('jsondb', `${name}: no valid backup; reset to defaults`);
    return d;
  }

  /** Read a collection (a private copy; mutate freely, nothing is saved). */
  async read(name) {
    const text = await this.adapter.read(this.#key(name));
    if (text !== null) {
      try { const d = JSON.parse(text); this.#validate(name, d); return d; } catch { /* fall through to a locked recovery */ }
    }
    return this.#serial(name, () => this.adapter.lock(this.#key(name), () => this.#load(name)));
  }

  /** Serialised read-modify-write. `fn(draft)` mutates the draft and may return a value. Throwing aborts the write. */
  update(name, fn) {
    return this.#serial(name, () => this.adapter.lock(this.#key(name), async () => {
      const key = this.#key(name);
      const current = await this.#load(name);
      const draft = structuredClone(current);
      const result = await fn(draft);
      this.#validate(name, draft); // never persist invalid data
      const text = JSON.stringify(draft, null, 2) + '\n';
      JSON.parse(text);
      await this.#maybeBackup(name, JSON.stringify(current, null, 2) + '\n');
      await this.adapter.write(key, text);
      return result;
    }));
  }

  /** Replace a collection's content (validated). */
  write(name, data) {
    return this.update(name, (draft) => { for (const k of Object.keys(draft)) delete draft[k]; Object.assign(draft, structuredClone(data)); });
  }

  async #maybeBackup(name, text) {
    const last = this.lastBackup.get(name) || 0;
    if (Date.now() - last < this.minInterval) return;
    await this.#writeBackup(name, text);
  }

  async #writeBackup(name, text) {
    const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
    await this.adapter.write(`${this.backupDir}/${this.#col(name).file}.${id}.bak`, text);
    this.lastBackup.set(name, Date.now());
    const all = await this.listBackups(name);
    for (const old of all.slice(this.keep)) await this.adapter.remove(old.key).catch(() => {});
    return id;
  }

  /** Force a backup of the current (valid) data. */
  async backup(name) {
    return this.#serial(name, () => this.adapter.lock(this.#key(name), async () => {
      const data = await this.#load(name);
      return this.#writeBackup(name, JSON.stringify(data, null, 2) + '\n');
    }));
  }

  /** Newest first. */
  async listBackups(name) {
    const file = this.#col(name).file;
    const keys = await this.adapter.list(this.backupDir);
    return keys
      .filter((k) => k.split('/').pop().startsWith(file + '.') && k.endsWith('.bak'))
      .map((k) => ({ key: k, id: k.split('/').pop().slice(file.length + 1, -4) }))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  /** Restore a backup (latest by default). Validates first. */
  async restore(name, id = null) {
    const list = await this.listBackups(name);
    const b = id ? list.find((x) => x.id === id) : list[0];
    if (!b) throw new Error('No matching backup');
    const data = JSON.parse(await this.adapter.read(b.key));
    this.#validate(name, data);
    await this.write(name, data);
    return b.id;
  }

  async stats() {
    const out = {};
    for (const name of Object.keys(this.collections)) {
      const text = await this.adapter.read(this.#key(name));
      let records = null;
      try { const d = JSON.parse(text); records = Object.values(d).find(Array.isArray)?.length ?? null; } catch { /* invalid */ }
      out[name] = { bytes: text ? Buffer.byteLength(text) : 0, records, backups: (await this.listBackups(name)).length };
    }
    return out;
  }
}
