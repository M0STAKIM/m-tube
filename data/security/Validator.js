import dns from 'node:dns/promises';
import net from 'node:net';
import { ApiError } from '../core/helpers.js';

const blocked = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(a, bits, 'ipv4');
}
for (const [a, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]]) {
  blocked.addSubnet(a, bits, 'ipv6');
}

export function isPublicIp(ip) {
  const v = net.isIP(ip);
  if (!v) return false;
  if (v === 6) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (m) return isPublicIp(m[1]);
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

const testBypass = () => process.env.NODE_ENV === 'test' && process.env.MTUBE_TEST_ALLOW_PRIVATE === '1';
const bad = (msg) => new ApiError(422, 'invalid_input', msg);

export const Validator = {
  /** User supplied media URL (providers fetch it, not this server). */
  mediaUrl(input) {
    const url = String(input ?? '').trim();
    if (!url || url.length > 2048) throw bad('Please provide a valid media link.');
    let u;
    try { u = new URL(url); } catch { throw bad('That does not look like a valid link.'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw bad('Only plain http(s) links are supported.');
    if (u.port && !['80', '443'].includes(u.port)) throw bad('Links with custom ports are not supported.');
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
      if (!isPublicIp(host)) throw bad('That address is not allowed.');
    } else if (!host.includes('.') || /(^|\.)(local|localhost|internal|lan|intranet)$/.test(host)) {
      throw bad('That address is not allowed.');
    }
    return u.toString();
  },

  query(input) {
    const q = String(input ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
    const len = Array.from(q).length;
    if (len < 2) throw bad('Please enter at least 2 characters.');
    if (len > 200) throw bad('Search text is too long.');
    return q;
  },

  ref(input) {
    const r = String(input ?? '');
    if (!/^[A-Za-z0-9_-]{20,40000}$/.test(r)) throw bad('Invalid media reference.');
    return r;
  },

  formatId(input) {
    const f = String(input ?? '');
    if (!/^[av]\d{1,2}$/.test(f)) throw bad('Invalid format.');
    return f;
  },

  /** Resolve + validate a remote URL for server side fetching (SSRF protection). Pins the IP. */
  async publicTarget(url) {
    let u;
    try { u = new URL(url); } catch { throw new ProviderBlocked('Blocked: invalid download URL.'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new ProviderBlocked('Blocked: unsupported download URL.');
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if (!testBypass() && ![80, 443].includes(port)) throw new ProviderBlocked('Blocked: unsupported download port.');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    let addrs;
    if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
    else {
      try { addrs = await dns.lookup(host, { all: true }); } catch { throw new ProviderBlocked('Could not resolve download host.', 'network'); }
    }
    if (!addrs.length) throw new ProviderBlocked('Could not resolve download host.', 'network');
    if (!testBypass()) {
      for (const a of addrs) if (!isPublicIp(a.address)) throw new ProviderBlocked('Blocked: download host is not public.');
    }
    const pref = addrs.find((a) => a.family === 4) || addrs[0];
    return { url: u.toString(), host, port, ip: pref.address, family: pref.family, protocol: u.protocol };
  },
};

/** Thrown for blocked/failed remote targets; converted to ProviderException by callers. */
export class ProviderBlocked extends Error {
  constructor(message, kind = 'invalid_response') {
    super(message);
    this.kind = kind;
  }
}
