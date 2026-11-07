import { ProviderException } from './AdapterInterface.js';
import { HttpClient } from './HttpClient.js';
import { MCPClient } from './MCPClient.js';
import { pick, toText, toSeconds, firstUrl, detectPlatform, parseQuality, makeFormat, extFromMime, isPlaceholder } from '../core/helpers.js';

const ALIASES = {
  url: ['url', 'link', 'videourl', 'mediaurl', 'trackurl', 'uri', 'href', 'source', 'sourceurl', 'videolink', 'songurl', 'audiourl', 'postlink'],
  query: ['query', 'q', 'search', 'term', 'keyword', 'keywords', 'text', 'searchquery', 'searchterm'],
  id: ['id', 'videoid', 'trackid', 'vid', 'v', 'songid'],
};
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'];
const KNOWN_EXT = [...AUDIO_EXT, 'mp4', 'webm', 'mkv', 'mov', '3gp'];
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

/** Shared plumbing. Each adapter keeps its own endpoint logic and response key-map. */
export class BaseAdapter {
  constructor(id, cfg, http = null) {
    this.pid = id;
    this.cfg = cfg;
    this.http = http || new HttpClient(cfg.timeout ?? 20);
    this._mcp = null;
  }

  id() { return this.pid; }
  name() { return this.cfg.name ?? this.pid; }
  priority() { return Number(this.cfg.priority ?? 100); }
  isEnabled() { return this.cfg.enabled !== false; }
  isConfigured() { return !isPlaceholder(this.key()); }
  capabilities() { return this.cfg.capabilities || {}; }
  key() { return String(this.cfg.transport === 'mcp' ? (this.cfg.mcp?.api_key ?? '') : (this.cfg.api_key ?? '')); }
  platforms() { return ['*']; }

  supports(operation, platform) {
    if (!this.isEnabled()) return false;
    const caps = this.capabilities();
    if (operation === 'search') return !!caps.search;
    if (operation === 'resolve') {
      const pl = this.platforms();
      return (!!caps.audio || !!caps.video) && (pl.includes('*') || pl.includes(platform));
    }
    return false;
  }

  async directUrl(format) {
    if (!format.url) throw new ProviderException('no_media', 'No download link available for this format.');
    return format.url;
  }

  /* ---- default search (MCP providers that enable the search capability) ---- */
  searchKeys() {
    return {
      list: ['results', 'items', 'tracks.items', 'tracks', 'videos', 'data', 'collection'],
      title: ['title', 'name'],
      artist: ['artist', 'author', 'uploader', 'channel', 'user.username', 'artists'],
      url: ['url', 'link', 'permalink_url', 'webpage_url', 'external_urls.spotify'],
      thumbnail: ['thumbnail', 'thumbnails', 'artwork_url', 'cover', 'image', 'album.images'],
      duration: ['duration', 'duration_ms', 'length'],
    };
  }

  searchHints() { return ['search', 'find', 'query']; }

  async search(query) {
    if (this.cfg.transport !== 'mcp') throw new ProviderException('unsupported', `${this.name()} does not support search.`);
    const results = await this.mcpRun({ query }, this.searchHints(), 1);
    let items = [];
    for (const r of results) items = items.concat(this.normalizeList(r.data, this.searchKeys()));
    if (!items.length) throw new ProviderException('no_media', 'No results.');
    return items;
  }

  /* ---- normalization ---- */
  normalizeList(data, k) {
    const list = pick(data, k.list);
    if (!Array.isArray(list)) return [];
    const items = [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const url = pick(it, k.url);
      const title = toText(pick(it, k.title)).trim();
      if (!isHttp(url) || !title) continue;
      items.push({
        title,
        artist: toText(pick(it, k.artist)).trim(),
        duration: toSeconds(pick(it, k.duration), !!k.duration_ms),
        thumbnail: firstUrl(pick(it, k.thumbnail)),
        platform: k.platform ?? detectPlatform(url),
        url,
      });
      if (items.length >= 20) break;
    }
    return items;
  }

  normalize(data, k, url = '', hint = '') {
    const media = {
      title: toText(pick(data, k.title ?? ['title', 'name'])).trim(),
      artist: toText(pick(data, k.artist ?? ['artist', 'author', 'uploader', 'channel'])).trim(),
      duration: toSeconds(pick(data, k.duration ?? ['duration']), !!k.duration_ms),
      thumbnail: firstUrl(pick(data, k.thumbnail ?? ['thumbnail', 'thumbnails', 'thumb', 'cover', 'image'])),
      platform: k.platform ?? detectPlatform(url),
      url,
      formats: [],
    };
    const formats = [];
    for (const key of k.formats ?? ['formats', 'medias', 'links', 'downloads']) this.#collect(pick(data, [key]), '', k, hint, formats);
    for (const [type, keys] of [['audio', k.audio ?? ['audio', 'audios']], ['video', k.video ?? ['video', 'videos']]]) {
      for (const key of keys) this.#collect(pick(data, [key]), type, k, hint, formats);
    }
    if (!formats.length) {
      // Flat responses: the link sits at the root and its quality/ext metadata are sibling fields.
      const meta = {};
      for (const [to, from] of [['bitrate', ['bitrate', 'abr', 'audioBitrate', 'audio_bitrate']], ['quality', ['quality']], ['height', ['height']], ['resolution', ['resolution']], ['ext', ['ext', 'extension']], ['mimeType', ['mimeType', 'mime_type', 'mime']], ['size', ['size', 'filesize', 'fileSize']]]) {
        const v = pick(data, from);
        if (v !== null) meta[to] = v;
      }
      for (const key of k.direct ?? ['download_url', 'downloadUrl', 'download', 'link', 'mp3', 'mp4', 'urls']) {
        const v = pick(data, [key]);
        this.#collect(typeof v === 'string' ? { ...meta, url: v } : v, '', k, hint, formats);
      }
    }
    const caps = this.capabilities();
    media.formats = formats.filter((f) => caps[f.type] ?? true);
    return media;
  }

  #collect(items, forced, k, hint, out) {
    if (typeof items === 'string') items = [items];
    if (!Array.isArray(items)) {
      if (items && typeof items === 'object' && (items.url || items.link || items.download_url)) items = [items];
      else return;
    }
    for (const it of items) {
      const f = this.#toFormat(it, k, forced, hint);
      if (f) out.push(f);
    }
  }

  #toFormat(it, k, forced, hint) {
    if (typeof it === 'string') it = { url: it };
    if (!it || typeof it !== 'object') return null;
    const u = pick(it, k.f_url ?? ['url', 'link', 'download_url', 'downloadUrl', 'src', 'href', 'directUrl']);
    if (!isHttp(u)) return null;
    const mime = String(pick(it, ['mimeType', 'mime_type', 'mime', 'content_type'], '')).toLowerCase();
    let extRaw = String(pick(it, ['extension', 'ext', 'container', 'format'], '')).toLowerCase();
    if (extRaw.includes('/')) extRaw = extFromMime(extRaw);
    let ext = extRaw.replace(/[^a-z0-9]/g, '');
    if (!KNOWN_EXT.includes(ext)) ext = extFromMime(mime);
    if (!ext) {
      let pe = '';
      try { pe = new URL(u).pathname.split('.').pop().toLowerCase(); } catch { /* ignore */ }
      if (KNOWN_EXT.includes(pe)) ext = pe;
    }
    let type = forced;
    if (!type) {
      const t = String(pick(it, ['type', 'kind', 'mediaType', 'media_type'], '')).toLowerCase();
      type = t.includes('audio') ? 'audio' : t.includes('video') ? 'video' : '';
    }
    if (!type && mime) type = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : '';
    if (!type && ext) type = AUDIO_EXT.includes(ext) ? 'audio' : 'video';
    if (!type && pick(it, ['height', 'resolution', 'qualityLabel']) !== null) type = 'video';
    if (!type) type = /mp3|audio/.test(hint) ? 'audio' : /mp4|video/.test(hint) ? 'video' : '';
    if (!type) return null;
    if (type === 'video') {
      const ha = pick(it, ['has_audio', 'hasAudio', 'audio_available']);
      if (ha === false || ha === 0 || ha === '0') return null; // video-only stream
    }
    const qRaw = type === 'video'
      ? pick(it, ['height', 'resolution', 'qualityLabel', 'quality', 'label', 'res'])
      : pick(it, ['bitrate', 'abr', 'audioBitrate', 'audio_bitrate', 'quality', 'label']);
    const size = pick(it, ['size', 'filesize', 'fileSize', 'contentLength', 'content_length', 'file_size']);
    return makeFormat(type, u, ext, parseQuality(qRaw, type), size !== null && Number.isFinite(Number(size)) ? Math.trunc(Number(size)) : null);
  }

  /** De-duplicate and validate the final media. */
  finish(media) {
    const seen = new Set();
    const final = [];
    for (const f of media.formats) {
      const key = `${f.type}|${f.quality ?? 'x'}|${f.ext}`;
      if (!seen.has(key)) { seen.add(key); final.push(f); }
    }
    if (!final.length) throw new ProviderException('no_media', `${this.name()} returned no downloadable media for this link.`);
    return { ...media, formats: final };
  }

  assertNoError(d) {
    const err = d.error;
    const failed = (err !== undefined && err !== null && err !== false && err !== '' && !(Array.isArray(err) && !err.length)) || d.success === false || d.status === 'error';
    if (failed) {
      const msg = typeof err === 'string' ? err : String(pick(d, ['message', 'error.message', 'msg'], 'Provider reported an error.'));
      const kind = /rate|too many/i.test(msg) ? 'rate_limit' : /quota|exceed|subscri/i.test(msg) ? 'quota_exceeded' : 'invalid_response';
      throw new ProviderException(kind, msg.slice(0, 200));
    }
  }

  validEndpoint(u) {
    u = String(u ?? '');
    return /^https:\/\//.test(u) || (process.env.NODE_ENV === 'test' && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u));
  }

  rapidHeaders() {
    return { 'x-rapidapi-key': this.key(), 'x-rapidapi-host': String(this.cfg.api_host ?? ''), Accept: 'application/json' };
  }

  /* ---- MCP discovery ---- */
  mcp() {
    if (!this._mcp) {
      const m = this.cfg.mcp || {};
      this._mcp = new MCPClient({
        server: m.server_url ?? 'https://mcp.rapidapi.com', host: m.api_host ?? '', key: this.key(), label: this.pid,
        timeout: (this.cfg.timeout ?? 20) * 1000,
      });
    }
    return this._mcp;
  }

  /** Discover tools, rank by name hints, fill input schemas from `values`, call them. */
  async mcpRun(values, hints, maxCalls = 3) {
    const out = [];
    let last = null;
    try {
      const tools = await this.mcp().tools();
      const scored = [];
      for (const t of tools) {
        const name = String(t.name || '').toLowerCase();
        const desc = String(t.description || '').toLowerCase();
        let s = 0;
        hints.forEach((h, i) => { if (name.includes(h)) s += 10 - i; else if (desc.includes(h)) s += 1; });
        if (s > 0) scored.push([s, t]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      let calls = 0;
      outer: for (const [, tool] of scored) {
        for (const [args, variant] of this.#argSets(tool, values)) {
          if (calls >= maxCalls) break outer;
          calls++;
          try {
            const data = await this.mcp().call(tool.name, args);
            out.push({ data: data && typeof data === 'object' ? data : { text: String(data) }, hint: `${tool.name} ${variant}`.toLowerCase() });
          } catch (e) {
            if (e instanceof ProviderException && ['rate_limit', 'quota_exceeded', 'auth', 'timeout', 'network'].includes(e.kind)) throw e;
            last = e;
          }
        }
      }
    } finally {
      await this.mcp().close();
    }
    if (!out.length) throw last || new ProviderException('unsupported', `No compatible tool was found on ${this.name()}.`);
    return out;
  }

  #argSets(tool, values) {
    const schema = tool.inputSchema || {};
    const props = schema.properties || {};
    const req = schema.required || [];
    const args = {};
    let used = false;
    let enumProp = null;
    for (const [name, def0] of Object.entries(props)) {
      const norm = name.toLowerCase().replace(/[_-]/g, '');
      let matched = false;
      for (const [vk, vv] of Object.entries(values)) {
        if ((ALIASES[vk] || [vk]).includes(norm)) { args[name] = vv; matched = used = true; break; }
      }
      if (matched || !req.includes(name)) continue;
      const def = def0 || {};
      if ('default' in def) args[name] = def.default;
      else if (Array.isArray(def.enum) && def.enum.length && def.enum.length <= 6 && !enumProp && /format|quality|type|resolution|output|ext/i.test(name)) enumProp = [name, def.enum];
      else return []; // required input we cannot satisfy
    }
    if (!used) return [];
    if (enumProp) return enumProp[1].map((v) => [{ ...args, [enumProp[0]]: v }, String(v)]);
    return [[args, '']];
  }

  static youtubeId(url) { const m = /(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/.exec(url); return m ? m[1] : null; }
  static spotifyId(url) { const m = /track\/([A-Za-z0-9]{22})/.exec(url); return m ? m[1] : null; }

  /** Merge several tool results into one media object. */
  mergeResults(results, keys, url) {
    let media = null;
    for (const r of results) {
      const m = this.normalize(r.data, keys, url, r.hint);
      if (!media) { media = m; continue; }
      for (const f of ['title', 'artist', 'thumbnail']) if (!media[f] && m[f]) media[f] = m[f];
      media.duration ??= m.duration;
      media.formats = media.formats.concat(m.formats);
    }
    return this.finish(media || { title: '', artist: '', duration: null, thumbnail: '', platform: detectPlatform(url), url, formats: [] });
  }
}
