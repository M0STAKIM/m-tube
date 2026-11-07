import crypto from 'node:crypto';
import { getDb, loggingEnabled } from '../Db.js';
import { appSecret, log } from '../../core/helpers.js';

const MAX = 5000;

export const Downloads = {
  async record(d) {
    if (!loggingEnabled()) return;
    try {
      const db = await getDb();
      const rec = {
        id: crypto.randomBytes(8).toString('hex'),
        provider: String(d.provider ?? '').slice(0, 80), media_type: String(d.type ?? '').slice(0, 10),
        title: String(d.title ?? '').slice(0, 255), platform: String(d.platform ?? '').slice(0, 40),
        status: String(d.status ?? 'ok').slice(0, 20), bytes: d.bytes != null ? Number(d.bytes) : null,
        ip_hash: crypto.createHash('sha256').update(String(d.ip ?? '') + '|' + appSecret()).digest('hex'),
        created_at: new Date().toISOString(),
      };
      await db.update('downloads', (x) => { x.records.push(rec); if (x.records.length > MAX) x.records.splice(0, x.records.length - MAX); });
    } catch (e) { log('jsondb', 'Downloads.record failed: ' + e.message); }
  },
  async recent(n = 50) { return (await (await getDb()).read('downloads')).records.slice(-n).reverse(); },
};
