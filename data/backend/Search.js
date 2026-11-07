import { ProviderManager } from '../providers/ProviderManager.js';
import { ProviderException } from '../providers/AdapterInterface.js';
import { Validator } from '../security/Validator.js';
import { Resolver } from './Resolver.js';
import { FileManager } from './FileManager.js';
import crypto from 'node:crypto';
import { SearchHistory } from '../database/models/SearchHistory.js';
import { Analytics } from '../database/models/Analytics.js';

export class Search {
  constructor(pm = null) { this.pm = pm || ProviderManager.instance(); }

  async run(query, ip = '') {
    const q = Validator.query(query);
    if (/^https?:\/\//i.test(q)) {
      const m = await new Resolver(this.pm).resolve(q);
      const kinds = [...new Set(m.formats.map((f) => f.type))];
      return {
        mode: 'url', provider: m.provider,
        results: [{ title: m.title, artist: m.artist, duration: m.duration, thumbnail: m.thumbnail, platform: m.platform, url: q, kinds }],
      };
    }
    const key = 'search:' + crypto.createHash('sha1').update(q.toLowerCase()).digest('hex');
    const hit = await FileManager.cacheGet(key);
    if (hit) { Analytics.bump(['search_cached']); return hit; }
    let out;
    try {
      out = await this.pm.execute('search', 'any', async (ad) => {
        const items = await ad.search(q);
        if (!items.length) throw new ProviderException('no_media', 'No results.');
        return items;
      });
    } catch (e) {
      if (e instanceof ProviderException && e.kind === 'no_media') { SearchHistory.record({ query: q, provider: null, results: 0, ip }); Analytics.bump(['search_empty']); return { mode: 'text', provider: null, results: [] }; }
      Analytics.bump(['search_failed']);
      throw e;
    }
    const caps = out.provider.capabilities();
    const kinds = ['audio', 'video'].filter((k) => caps[k]);
    const data = { mode: 'text', provider: out.provider.name(), results: out.result.map((it) => ({ ...it, kinds })) };
    await FileManager.cachePut(key, data, 300);
    SearchHistory.record({ query: q, provider: out.provider.name(), results: data.results.length, ip });
    Analytics.bump(['search_ok', `provider:${out.provider.id()}:search_ok`]);
    return data;
  }
}
