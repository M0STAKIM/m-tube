import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.MTUBE_QUIET = '1';
process.env.APP_SECRET = 'unit-test-secret-0123456789abcdef';
// NOTE: MTUBE_TEST_ALLOW_PRIVATE is intentionally NOT set, so SSRF protection is fully active here.

const h = await import('../data/core/helpers.js');
const { Validator, isPublicIp } = await import('../data/security/Validator.js');
const { Metadata } = await import('../data/backend/Metadata.js');
const { HttpClient } = await import('../data/providers/HttpClient.js');

test('sanitizeFilename keeps the title, removes invalid characters, adds extension', () => {
  assert.equal(h.sanitizeFilename('Sample Song: "Live" / Mix?', 'mp3'), 'Sample Song Live Mix.mp3');
  assert.equal(h.sanitizeFilename('  ..  ', 'mp4'), 'M-TUBE Download.mp4');
  assert.equal(h.sanitizeFilename('CON', 'mp3'), 'CON_.mp3');
  assert.equal(h.sanitizeFilename('গান বাংলা', 'mp3'), 'গান বাংলা.mp3');
  assert.ok(h.sanitizeFilename('a'.repeat(400), 'mp3').length <= 154);
});

test('contentDisposition is attachment with ASCII fallback and UTF-8 name', () => {
  const d = h.contentDisposition('গান.mp3');
  assert.match(d, /^attachment; filename="___\.mp3"; filename\*=UTF-8''/);
});

test('parseQuality / makeFormat only report real values', () => {
  assert.equal(h.parseQuality('1080p', 'video'), 1080);
  assert.equal(h.parseQuality('1920x1080', 'video'), 1080);
  assert.equal(h.parseQuality(128000, 'audio'), 128);
  assert.equal(h.parseQuality('hd', 'video'), null);
  assert.equal(h.parseQuality(5, 'audio'), null);
  assert.equal(h.makeFormat('audio', 'https://x', 'mp3', null).quality_label, 'Best available');
});

test('seal/open: round trip, tamper and expiry', () => {
  const t = h.seal({ a: 1, u: 'https://cdn.example/x.mp3' }, 60);
  assert.equal(h.open(t).a, 1);
  assert.equal(h.open(t.slice(0, -2) + 'AA'), null);
  assert.equal(h.open(h.seal({ a: 1 }, -5)), null);
  assert.equal(h.open('garbage'), null);
});

test('ID3v2.3 tag has valid header, title, artist and cover', () => {
  const tag = Metadata.id3('Titel', 'Artist', Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]), 'image/jpeg');
  assert.equal(tag.subarray(0, 3).toString(), 'ID3');
  const size = (tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9];
  assert.equal(size, tag.length - 10);
  const s = tag.toString('latin1');
  assert.ok(s.includes('TIT2') && s.includes('TPE1') && s.includes('APIC'));
  assert.equal(Metadata.id3('', '', null).length, 0);
});

test('isPublicIp blocks private, loopback, link-local, CGNAT and mapped addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
});

test('mediaUrl rejects unsafe or malformed links', () => {
  for (const bad of ['', 'ftp://x.com/a', 'http://localhost/a', 'http://127.0.0.1/a', 'http://192.168.1.1/x', 'http://user:pw@example.com/', 'http://example.com:8080/', 'not a url', 'http://intranet/x', 'https://a.local/x', 'http://[::1]/x']) {
    assert.throws(() => Validator.mediaUrl(bad), { code: 'invalid_input' }, bad);
  }
  assert.equal(Validator.mediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('publicTarget (server-side fetch guard) blocks private targets and bad schemes', async () => {
  for (const u of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'file:///etc/passwd', 'http://localhost/x', 'http://example.com:22/x']) {
    await assert.rejects(() => Validator.publicTarget(u), /Blocked|resolve/, u);
  }
  await assert.rejects(() => new HttpClient().openStream('http://127.0.0.1:9/x'), { kind: 'invalid_response' });
});

test('query/ref/format validators', () => {
  assert.throws(() => Validator.query('a'));
  assert.equal(Validator.query('  hello\u0000 world '), 'hello  world');
  assert.throws(() => Validator.formatId('x1'));
  assert.equal(Validator.formatId('a0'), 'a0');
  assert.throws(() => Validator.ref('../../etc'));
});

test('detectPlatform', () => {
  assert.equal(h.detectPlatform('https://www.tiktok.com/@a/video/1'), 'tiktok');
  assert.equal(h.detectPlatform('https://youtu.be/abc'), 'youtube');
  assert.equal(h.detectPlatform('https://on.soundcloud.com/x'), 'soundcloud');
  assert.equal(h.detectPlatform('https://open.spotify.com/track/1'), 'spotify');
  assert.equal(h.detectPlatform('https://example.org/'), 'other');
});
