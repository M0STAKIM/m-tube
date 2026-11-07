import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ProviderException } from '../providers/AdapterInterface.js';
import { ProviderManager } from '../providers/ProviderManager.js';
import { HttpClient } from '../providers/HttpClient.js';
import { Validator, ProviderBlocked } from '../security/Validator.js';
import { Metadata, TagPrefixer } from './Metadata.js';
import { FileManager } from './FileManager.js';
import { Downloads } from '../database/models/Downloads.js';
import { Analytics } from '../database/models/Analytics.js';
import { seal, open, env, log, clientIp, sanitizeFilename, contentDisposition, mimeFromExt, extFromMime } from '../core/helpers.js';

const TOKEN_TTL = 300;

function publicOrigin(req) {
  const h = req.headers || {};
  const host = /^[a-z0-9.\-:\[\]]+$/i.test(h.host || '') ? h.host : 'localhost';
  const proto = (h['x-forwarded-proto'] || '').split(',')[0] === 'https' || process.env.VERCEL ? 'https' : 'http';
  return `${proto}://${host}`;
}

export const downloadMode = () => { const m = env('DOWNLOAD_MODE', 'stream'); return ['stream', 'file', 'redirect'].includes(m) ? m : 'stream'; };

export class Downloader {
  constructor(pm = null) { this.pm = pm || ProviderManager.instance(); }

  /** Validate a sealed reference + format and return a short-lived download URL. */
  async prepare(req, ref, formatId) {
    const r = FileManager.openRef(ref);
    if (!r) throw new ProviderException('expired', 'This download expired. Please resolve the link again.');
    const fmt = (r.f || []).find((f) => f.id === formatId);
    if (!fmt) throw new ProviderException('bad_format', 'That format is not available for this media.');
    const ad = this.pm.adapter(r.p);
    if (!ad) throw new ProviderException('not_configured', 'The provider for this download is no longer available.');
    const url = await ad.directUrl({ ...fmt, url: fmt.u }, r.m);
    const ext = fmt.ext || (fmt.type === 'audio' ? 'mp3' : 'mp4');
    const token = seal({ u: url, ty: fmt.type, x: fmt.ext || '', ti: r.m.title, ar: r.m.artist, th: r.m.thumbnail, pl: r.m.platform, p: r.p, s: fmt.size }, TOKEN_TTL);
    const mode = downloadMode();
    return {
      download_url: `${publicOrigin(req)}/api/v1/download?t=${token}`,
      filename: sanitizeFilename(r.m.title, ext), type: fmt.type, size: fmt.size ?? null, mode, expires_in: TOKEN_TTL,
    };
  }

  async fetchCover(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    try {
      const work = (async () => {
        const { status, headers, stream } = await new HttpClient(8).openStream(url, { maxRedirects: 2 });
        const mime = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (status !== 200 || !['image/jpeg', 'image/png'].includes(mime)) { stream.destroy(); return null; }
        const chunks = [];
        let n = 0;
        for await (const c of stream) {
          n += c.length;
          if (n > 2 * 1048576) { stream.destroy(); return null; }
          chunks.push(c);
        }
        return n ? [Buffer.concat(chunks), mime] : null;
      })();
      return await Promise.race([work, new Promise((r) => setTimeout(() => r(null), 8000))]);
    } catch { return null; }
  }

  /**
   * Serve the file.
   *  stream   (default) provider -> browser with back-pressure, nothing stored
   *  file     stage in data/storage/temp -> downloads, then serve with an exact Content-Length; deleted afterwards
   *  redirect validated 302 to the provider URL (no filename/ID3 control)
   */
  async deliver(req, res, payload) {
    const url = payload.u;
    const title = String(payload.ti || '');
    const mode = downloadMode();
    if (mode === 'redirect') {
      try { await Validator.publicTarget(url); } catch (e) {
        if (e instanceof ProviderBlocked) throw new ProviderException(e.kind, e.message);
        throw e;
      }
      res.statusCode = 302;
      res.setHeader('Location', url);
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }

    const max = FileManager.maxBytes();
    const { status, headers, stream } = await new HttpClient(20).openStream(url);
    const fail = (kind, msg) => { stream.destroy(); throw new ProviderException(kind, msg); };
    if (status !== 200) fail('invalid_response', `The source returned HTTP ${status}.`);
    const ct = String(headers['content-type'] || '').toLowerCase();
    if (ct.startsWith('text/') || ct.includes('json')) fail('no_media', 'The provider link did not return a media file (it may have expired).');
    const len = Number(headers['content-length'] || 0);
    if (len > max) fail('too_large', 'This file exceeds the maximum allowed size.');

    const ext = extFromMime(ct) || payload.x || (payload.ty === 'audio' ? 'mp3' : 'mp4');
    const tagging = payload.ty === 'audio' && ext === 'mp3';
    let tag = Buffer.alloc(0);
    if (tagging) {
      const cover = await this.fetchCover(payload.th);
      tag = Metadata.id3(title, String(payload.ar || ''), cover?.[0] ?? null, cover?.[1] ?? 'image/jpeg');
    }
    const baseHeaders = () => {
      res.statusCode = 200;
      res.setHeader('Content-Type', mimeFromExt(ext));
      res.setHeader('Content-Disposition', contentDisposition(sanitizeFilename(title, ext)));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
    };

    const prefixer = new TagPrefixer(tagging ? tag : Buffer.alloc(0), max);
    let bytes = 0;
    let outcome = 'ok';
    try {
      if (mode === 'file') {
        try { await FileManager.ensureCapacity(len + tag.length); } catch (e) { stream.destroy(); throw e; }
        const ac = new AbortController();
        const onClose = () => { if (!res.writableFinished) ac.abort(); };
        res.on('close', onClose);
        let staged;
        try {
          staged = await FileManager.stage({ stream, transform: prefixer, ext, signal: ac.signal });
          bytes = staged.size;
        } catch (e) {
          stream.destroy();
          if (ac.signal.aborted) { outcome = 'aborted'; return; }
          throw e;
        } finally { res.off('close', onClose); }
        baseHeaders();
        res.setHeader('Content-Length', String(staged.size));
        try { await pipeline(createReadStream(staged.path), res); } finally { await FileManager.remove(staged.path); }
      } else {
        baseHeaders();
        if (len > 0) {
          if (tagging) res.setHeader('X-Estimated-Size', String(len + tag.length));
          else res.setHeader('Content-Length', String(len));
        }
        await pipeline(stream, prefixer, res);
        bytes = prefixer.bytes;
      }
    } catch (e) {
      bytes = bytes || prefixer.bytes;
      if (!res.headersSent && !(e?.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
        outcome = 'failed';
        await Downloads.record({ provider: payload.p, type: payload.ty, title, platform: payload.pl, status: outcome, bytes, ip: clientIp(req) });
        Analytics.bump(['download_failed']);
        throw e;
      }
      outcome = e?.code === 'ERR_STREAM_PREMATURE_CLOSE' ? 'aborted' : 'failed';
      log('download', `Stream ${outcome}: ${e?.message}`, { provider: payload.p });
      stream.destroy();
      if (!res.writableEnded) res.destroy();
    }
    await Downloads.record({ provider: payload.p, type: payload.ty, title, platform: payload.pl, status: outcome, bytes, ip: clientIp(req) });
    Analytics.bump([`download_${outcome}`, `download_type:${payload.ty}`, `provider:${payload.p}:download_${outcome}`]);
  }

  static open(token) { return open(token); }
}
