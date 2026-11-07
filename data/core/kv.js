/**
 * In-memory key/value helper (per process). Used for the circuit-breaker state and rate-limit counters.
 * It is intentionally not persisted; durable data goes through the JSON database / file cache.
 */
const mem = new Map();
const now = () => Date.now();

function prune() {
  if (mem.size < 2000) return;
  for (const [k, v] of mem) if (v.exp <= now()) mem.delete(k);
}

export const kv = {
  async get(key) { const h = mem.get(key); return h && h.exp > now() ? h.v : null; },
  async set(key, value, ttlSec) { prune(); mem.set(key, { v: value, exp: now() + ttlSec * 1000 }); },
  async del(key) { mem.delete(key); },
  /** Fixed-window counter. Returns { count, reset(unix seconds) } */
  async hit(key, windowSec) {
    prune();
    let h = mem.get(key);
    if (!h || h.exp <= now()) h = { v: 0, exp: now() + windowSec * 1000 };
    h.v += 1;
    mem.set(key, h);
    return { count: h.v, reset: Math.ceil(h.exp / 1000) };
  },
  _clearMemory() { mem.clear(); },
};
