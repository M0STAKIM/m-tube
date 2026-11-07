import { getDb, loggingEnabled } from '../Db.js';
import { log } from '../../core/helpers.js';

const KEEP_DAYS = 90;

export const Analytics = {
  /** Increment one or more named counters (total + today) in a single write. */
  async bump(names) {
    if (!loggingEnabled()) return;
    try {
      const db = await getDb();
      const day = new Date().toISOString().slice(0, 10);
      await db.update('analytics', (d) => {
        d.daily[day] ||= {};
        for (const n of [].concat(names)) {
          const k = String(n).slice(0, 120);
          d.totals[k] = (d.totals[k] || 0) + 1;
          d.daily[day][k] = (d.daily[day][k] || 0) + 1;
        }
        const days = Object.keys(d.daily).sort();
        for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete d.daily[old];
      });
    } catch (e) { log('jsondb', 'Analytics.bump failed: ' + e.message); }
  },
  async totals() { return (await (await getDb()).read('analytics')).totals; },
};
