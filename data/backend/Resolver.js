import { ProviderManager } from '../providers/ProviderManager.js';
import { Validator } from '../security/Validator.js';
import { detectPlatform } from '../core/helpers.js';
import { FileManager } from './FileManager.js';
import { Analytics } from '../database/models/Analytics.js';

export class Resolver {
  constructor(pm = null) { this.pm = pm || ProviderManager.instance(); }

  async resolve(rawUrl) {
    const url = Validator.mediaUrl(rawUrl);
    const platform = detectPlatform(url);
    let out;
    try { out = await this.pm.execute('resolve', platform, (ad) => ad.resolve(url)); } catch (e) { Analytics.bump(['resolve_failed', `platform:${platform}:resolve_failed`]); throw e; }
    Analytics.bump(['resolve_ok', `platform:${platform}:resolve_ok`, `provider:${out.provider.id()}:resolve_ok`]);
    const media = out.result;
    const ad = out.provider;
    const byQ = (x, y) => (y.quality ?? 0) - (x.quality ?? 0);
    const audio = media.formats.filter((f) => f.type === 'audio').sort(byQ).map((f, i) => ({ id: 'a' + i, ...f }));
    const video = media.formats.filter((f) => f.type !== 'audio').sort(byQ).map((f, i) => ({ id: 'v' + i, ...f }));
    const formats = [...audio, ...video];
    const title = media.title || 'M-TUBE Download';

    // Sealed reference: provider links stay inside an opaque token the browser cannot read.
    const ref = FileManager.sealRef({
      m: { title, artist: media.artist, duration: media.duration, thumbnail: media.thumbnail, platform: media.platform },
      p: ad.id(),
      f: formats.map((f) => ({ id: f.id, type: f.type, ext: f.ext, size: f.size, u: f.url })),
    });
    return {
      ref, title, artist: media.artist, duration: media.duration, thumbnail: media.thumbnail,
      platform: media.platform, provider: ad.name(),
      fallback_used: out.attempts.some((a) => a.status === 'failed'),
      formats: formats.map(({ url: _u, ...pub }) => pub),
      expires_in: 1800,
    };
  }
}
