import { BaseAdapter } from './BaseAdapter.js';
import { ProviderException } from './AdapterInterface.js';
import { HttpClient } from './HttpClient.js';

/** Provider 2 — All in One Social Media Downloader (HTTP GET /autolink?url=). */
export class AllInOneUltimate extends BaseAdapter {
  keys() {
    return {
      title: ['title', 'data.title', 'result.title', 'name'],
      artist: ['author', 'uploader', 'owner', 'channel', 'data.author', 'result.author'],
      duration: ['duration', 'data.duration', 'result.duration'],
      thumbnail: ['thumbnail', 'thumb', 'cover', 'data.thumbnail', 'result.thumbnail'],
      formats: ['medias', 'formats', 'links', 'downloads', 'data.medias', 'data.formats', 'result.medias', 'result.links'],
    };
  }

  async resolve(url) {
    const r = this.cfg.resolve || {};
    const endpoint = String(r.url ?? '');
    if (!this.validEndpoint(endpoint)) throw new ProviderException('not_configured', 'Provider endpoint is not configured.');
    const u = new URL(endpoint);
    u.searchParams.set(r.query_parameter ?? 'url', url);
    const data = HttpClient.json(await this.http.request(r.method ?? 'GET', u.toString(), this.rapidHeaders()));
    this.assertNoError(data);
    return this.finish(this.normalize(data, this.keys(), url));
  }
}
