import { getDb } from '../Db.js';

export const Settings = {
  async get() { return (await (await getDb()).read('settings')).settings; },
  async set(patch) {
    const db = await getDb();
    return db.update('settings', (d) => {
      for (const [k, v] of Object.entries(patch || {})) if (k in d.settings && typeof v === typeof d.settings[k]) d.settings[k] = v;
      return { ...d.settings };
    });
  },
  async isMaintenance() { try { return !!(await this.get()).maintenance; } catch { return false; } },
};
