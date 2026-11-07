import crypto from 'node:crypto';
import { getDb, loggingEnabled } from '../Db.js';
import { appSecret, log } from '../../core/helpers.js';

const MAX = 2000;

export const SearchHistory = {
  async record({ query, provider, results, ip }) {
    if (!loggingEnabled()) return;
    try {
      const db = await getDb();
      const rec = {
        id: crypto.randomBytes(8).toString('hex'), query: String(query).slice(0, 200), provider: provider ? String(provider).slice(0, 80) : null,
        results: Number(results) || 0, ip_hash: crypto.createHash('sha256').update(String(ip ?? '') + '|' + appSecret()).digest('hex'), created_at: new Date().toISOString(),
      };
      await db.update('search-history', (x) => { x.records.push(rec); if (x.records.length > MAX) x.records.splice(0, x.records.length - MAX); });
    } catch (e) { log('jsondb', 'SearchHistory.record failed: ' + e.message); }
  },
};
