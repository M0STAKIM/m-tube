import { ProviderException, isAdapter } from './AdapterInterface.js';
import { config } from '../core/config.js';
import { kv } from '../core/kv.js';
import { log } from '../core/helpers.js';
import { CloudApiHub } from './CloudApiHub.js';
import { AllInOneUltimate } from './AllInOneUltimate.js';
import { AutoDownloadAllInOne } from './AutoDownloadAllInOne.js';
import { AllMediaDownloader } from './AllMediaDownloader.js';
import { SoundCloudScraper } from './SoundCloudScraper.js';
import { YouTubeDownloader } from './YouTubeDownloader.js';
import { SpotifyDownloader } from './SpotifyDownloader.js';

/** Config id -> adapter class. Add a provider: register it here (or pass `registry` to the constructor). */
export const REGISTRY = {
  cloud_api_hub_youtube_downloader: CloudApiHub,
  all_in_one_ultimate: AllInOneUltimate,
  auto_download_all_in_one: AutoDownloadAllInOne,
  all_media_downloader: AllMediaDownloader,
  soundcloud_scraper: SoundCloudScraper,
  youtube_mp4_mp3_downloader: YouTubeDownloader,
  spotify_music_mp3_downloader: SpotifyDownloader,
};

let instance = null;

export class ProviderManager {
  static instance() { return (instance ||= new ProviderManager()); }
  static reset() { instance = null; }

  constructor({ providers = config('providers', {}), fallback = config('provider_fallback', {}), registry = REGISTRY, httpFactory = null } = {}) {
    this.fb = fallback;
    this.adapters = new Map();
    const list = [];
    for (const [id, cfg] of Object.entries(providers)) {
      const Cls = registry[id];
      if (!Cls) { log('providers', `Provider ${id} has no adapter registered; skipped.`); continue; }
      const a = new Cls(id, { ...cfg, timeout: cfg.timeout ?? fallback.timeout_seconds ?? 20 }, httpFactory ? httpFactory(id) : null);
      if (!isAdapter(a)) { log('providers', `Adapter for ${id} does not implement the contract; skipped.`); continue; }
      list.push(a);
    }
    list.sort((a, b) => a.priority() - b.priority());
    for (const a of list) this.adapters.set(a.id(), a);
  }

  adapter(id) { return this.adapters.get(id) || null; }
  all() { return [...this.adapters.values()]; }

  /* ---- circuit breaker (in-memory, per process) ---- */
  #breakerOn() { return !!this.fb.circuit_breaker?.enabled; }

  async state(id) { return (await kv.get('cb:' + id)) || {}; }

  async #isOpen(id) {
    if (!this.#breakerOn()) return false;
    const s = await this.state(id);
    return (s.open_until || 0) > Date.now() / 1000;
  }

  async #success(id) { await kv.del('cb:' + id); }

  async #failure(id, kind) {
    const counted = [...(this.fb.on_errors || []), 'network'];
    if (!this.#breakerOn() || !counted.includes(kind)) return;
    const threshold = Math.max(1, Number(this.fb.circuit_breaker.failure_threshold ?? 3));
    const cooldown = Math.max(10, Number(this.fb.circuit_breaker.cooldown_seconds ?? 300));
    const s = await this.state(id);
    s.failures = (s.failures || 0) + 1;
    s.last_error = kind;
    s.last_failure = Math.floor(Date.now() / 1000);
    if (s.failures >= threshold) {
      s.open_until = Math.floor(Date.now() / 1000) + cooldown;
      s.failures = threshold - 1; // half-open: next failure re-opens immediately
    }
    await kv.set('cb:' + id, s, cooldown + 3600);
  }

  async #eligible(op, platform) {
    const list = [];
    const skipped = [];
    for (const a of this.adapters.values()) {
      if (!a.supports(op, platform)) continue;
      if (!a.isConfigured()) skipped.push({ provider: a.name(), status: 'skipped', reason: 'not_configured' });
      else if (await this.#isOpen(a.id())) skipped.push({ provider: a.name(), status: 'skipped', reason: 'cooldown' });
      else list.push(a);
    }
    return [list, skipped];
  }

  /**
   * Pick eligible providers by operation/platform/priority, call them, validate, retry, fall back.
   * @returns {{result:any, provider:object, attempts:object[]}}
   */
  async execute(op, platform, call) {
    const [list, attempts] = await this.#eligible(op, platform);
    if (!list.length) {
      if (!attempts.length) {
        throw new ProviderException('unsupported', op === 'search'
          ? 'No search provider is enabled. Enable one in mostakim.json.'
          : 'No enabled provider supports this link.');
      }
      const allUnconf = attempts.every((x) => x.reason === 'not_configured');
      const e = new ProviderException(allUnconf ? 'not_configured' : 'all_failed',
        allUnconf ? 'No provider has an API key configured yet.' : 'Matching providers are temporarily cooling down. Try again shortly.');
      e.attempts = attempts;
      throw e;
    }
    const tries = 1 + Math.max(0, Number(this.fb.max_retries_per_provider ?? 1));
    const fallback = this.fb.enabled !== false;
    const kinds = [];
    for (const ad of list) {
      for (let i = 0; i < tries; i++) {
        try {
          const result = await call(ad);
          await this.#success(ad.id());
          attempts.push({ provider: ad.name(), status: 'ok' });
          return { result, provider: ad, attempts };
        } catch (e) {
          if (e instanceof ProviderException) {
            log('provider_' + ad.id(), `${op} failed: [${e.kind}] ${e.message}`);
            if (e.retryable() && i < tries - 1) continue;
            await this.#failure(ad.id(), e.kind);
            attempts.push({ provider: ad.name(), status: 'failed', reason: e.kind });
            kinds.push(e.kind);
          } else {
            log('provider_' + ad.id(), `Adapter error: ${e?.name} ${e?.message}`);
            attempts.push({ provider: ad.name(), status: 'failed', reason: 'invalid_response' });
            kinds.push('invalid_response');
          }
          break;
        }
      }
      if (!fallback) break;
    }
    const allNoMedia = kinds.length > 0 && kinds.every((k) => k === 'no_media');
    const e = new ProviderException(allNoMedia ? 'no_media' : 'all_failed',
      allNoMedia ? 'No downloadable media was found for this request.' : 'All matching providers failed. Please try again later.');
    e.attempts = attempts;
    throw e;
  }
}
