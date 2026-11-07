import { BaseAdapter } from './BaseAdapter.js';
import { ProviderException } from './AdapterInterface.js';
import { HttpClient } from './HttpClient.js';

/** Provider 3 — Auto Download All In One (HTTP POST /v1/social/autolink, JSON body). */
export class AutoDownloadAllInOne extends BaseAdapter {
  keys() {
    return {
      title: ['title', 'data.title', 'result.title', 'name'],
      artist: ['author', 'uploader', 'owner', 'username', 'data.author', 'result.author'],
      duration: ['duration', 'data.duration', 'result.duration'],
      thumbnail: ['thumbnail', 'thumb', 'cover', 'data.thumbnail', 'result.thumbnail'],
      formats: ['medias', 'formats', 'links', 'downloads', 'data.medias', 'data.formats', 'result.medias', 'result.links'],
    };
  }

  async resolve(url) {
    const r = this.cfg.resolve || {};
    const endpoint = String(r.url ?? '');
    if (!this.validEndpoint(endpoint)) throw new ProviderException('not_configured', 'Provider endpoint is not configured.');
    const body = JSON.parse(JSON.stringify(r.body ?? { url: '{media_url}' }), (k, v) => (typeof v === 'string' ? v.split('{media_url}').join(url) : v));
    const headers = { ...this.rapidHeaders(), 'Content-Type': 'application/json' };
    const data = HttpClient.json(await this.http.request(r.method ?? 'POST', endpoint, headers, JSON.stringify(body)));
    this.assertNoError(data);
    return this.finish(this.normalize(data, this.keys(), url));
  }
}
