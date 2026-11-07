import http from 'node:http';
import https from 'node:https';
import { ProviderException } from './AdapterInterface.js';
import { Validator, ProviderBlocked } from '../security/Validator.js';

export class HttpClient {
  constructor(timeoutSec = 20) {
    this.timeout = Math.max(3, Number(timeoutSec) || 20) * 1000;
  }

  /** Plain API request (provider endpoints come from trusted configuration). */
  async request(method, url, headers = {}, body = null, timeoutMs = null) {
    let res;
    try {
      res = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: body ?? undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs ?? this.timeout),
      });
      const text = await res.text();
      return { status: res.status, headers: Object.fromEntries(res.headers), body: text };
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ProviderException('timeout', 'Provider request timed out.');
      throw new ProviderException('network', 'HTTP request failed: ' + (e?.cause?.code || e?.message || 'unknown'));
    }
  }

  static throwForStatus(r) {
    const s = r.status;
    if (s < 400) return;
    const snippet = String(r.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
    if (s === 429) throw new ProviderException('rate_limit', 'Provider rate limit reached.');
    if ((s === 402 || s === 403) && /quota|exceed|subscri|limit/i.test(r.body || '')) throw new ProviderException('quota_exceeded', 'Provider quota exceeded or not subscribed.');
    if (s === 401 || s === 403) throw new ProviderException('auth', `Provider rejected the API key (HTTP ${s}).`);
    if (s === 404) throw new ProviderException('not_found', 'Provider endpoint or media not found.');
    if (s >= 500) throw new ProviderException('server_error', `Provider server error (HTTP ${s}).`);
    throw new ProviderException('invalid_response', `Provider returned HTTP ${s}: ${snippet}`);
  }

  static json(r) {
    HttpClient.throwForStatus(r);
    let d;
    try { d = JSON.parse(r.body); } catch { throw new ProviderException('invalid_response', 'Provider did not return valid JSON.'); }
    if (d === null || typeof d !== 'object') throw new ProviderException('invalid_response', 'Provider did not return a JSON object.');
    return d;
  }

  /**
   * SSRF-safe streaming GET. Each hop is DNS-resolved, checked against private ranges, and the
   * validated IP is pinned for the connection. Redirects are followed manually.
   * Resolves with { status, headers, stream } — the body is NOT buffered.
   */
  async openStream(url, { maxRedirects = 4, headers = {}, idleMs = 30000 } = {}) {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let t;
      try { t = await Validator.publicTarget(url); } catch (e) {
        if (e instanceof ProviderBlocked) throw new ProviderException(e.kind, e.message);
        throw e;
      }
      const mod = t.protocol === 'https:' ? https : http;
      const res = await new Promise((resolve, reject) => {
        const req = mod.request(t.url, {
          method: 'GET',
          headers: { 'user-agent': 'M-TUBE/2.0', accept: '*/*', 'accept-encoding': 'identity', ...headers },
          lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: t.ip, family: t.family }]) : cb(null, t.ip, t.family)),
          timeout: idleMs,
        }, resolve);
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end();
      }).catch((e) => {
        throw new ProviderException(e.code === 'ETIMEDOUT' ? 'timeout' : 'network', 'Download connection failed: ' + (e.code || e.message));
      });
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        url = new URL(res.headers.location, t.url).toString();
        continue;
      }
      return { status: res.statusCode, headers: res.headers, stream: res };
    }
    throw new ProviderException('invalid_response', 'Too many redirects.');
  }
}
