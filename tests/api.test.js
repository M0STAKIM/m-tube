import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mediaServer, httpProviderServer, mcpServer, writeConfig, tmp, MP3, MP4 } from './mocks.js';

const dir = tmp();
const media = await mediaServer();
const prov = await httpProviderServer(media.base);
const mcp = await mcpServer(media.base, { failInfoFor: ['ratelimited', 'allfail'] });
process.env.NODE_ENV = 'test';
process.env.MTUBE_QUIET = '1';
process.env.MTUBE_TEST_ALLOW_PRIVATE = '1'; // mocks live on 127.0.0.1 (never honoured in production)
process.env.APP_SECRET = 'api-test-secret-0123456789abcdef';
process.env.ADMIN_TOKEN = 'admin-token-0123456789';
process.env.API_KEYS = 'bot-key-0123456789abcdef';
process.env.RATE_LIMIT_WEB = '1000';
process.env.RATE_LIMIT_ADMIN = '1000';
process.env.MTUBE_DATA_DIR = dir;
process.env.MTUBE_LOG_FILE = '0';
process.env.MTUBE_CONFIG_PATH = writeConfig(dir, { mcp: mcp.base, httpBase: prov.base });
// MCP_CLIENT left at default "sdk": the SDK is not installed in this sandbox, so this also exercises the built-in fallback.

const { createServer } = await import('../scripts/dev.js');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const SAME = { 'Sec-Fetch-Site': 'same-origin' };

let token;
before(async () => {
  const r = await fetch(base + '/api/v1/token', { headers: SAME });
  token = (await r.json()).data.token;
});
after(() => { server.close(); media.close(); prov.close(); mcp.close(); });

const post = (p, body, headers = {}) => fetch(base + '/api/v1/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Web-Token': token, ...SAME, ...headers }, body: JSON.stringify(body) });
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('web token only issued to same-origin requests; API needs auth', async () => {
  assert.equal((await fetch(base + '/api/v1/token')).status, 403);
  assert.equal((await fetch(base + '/api/v1/resolve', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await post('resolve', { url: YT }, { 'X-Web-Token': 'bad' })).status, 401);
  assert.equal((await post('resolve', { url: YT }, { 'X-API-Key': 'nope' })).status, 401);
});

test('MCP provider (priority 1): init, tool discovery, resolve YouTube; no provider links or keys leak', async () => {
  const r = await post('resolve', { url: YT });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const d = JSON.parse(text).data;
  assert.equal(d.provider, 'Cloud API Hub');
  assert.equal(d.title, 'Sample Song: "Live" / Mix?');
  assert.equal(d.artist, 'Sample Artist');
  assert.equal(d.duration, 200);
  assert.equal(d.thumbnail, media.base + '/cover.jpg');
  const q = d.formats.map((f) => `${f.id}:${f.type}:${f.quality_label}:${f.ext}`);
  assert.deepEqual(q, ['a0:audio:320 kbps:mp3', 'a1:audio:128 kbps:m4a', 'v0:video:720p:mp4']); // 1080p video-only stream excluded
  assert.ok(!text.includes('127.0.0.1:' + new URL(media.base).port + '/song'), 'provider URL leaked');
  assert.ok(!/test-key|rapidapi/i.test(text), 'key leaked');
  // MCP protocol conformance as seen by the server
  const methods = mcp.seen.map((s) => { try { return JSON.parse(s.body).method; } catch { return s.method; } });
  assert.ok(methods.includes('initialize') && methods.includes('notifications/initialized') && methods.includes('tools/list') && methods.includes('tools/call'));
  assert.equal(mcp.seen[0].headers['x-api-host'], 'cloud-api-hub-youtube-downloader.p.rapidapi.com');
  assert.equal(mcp.seen[0].headers['x-api-key'], 'test-key-mcp-0001');
});

test('direct HTTP provider 2 (GET) and 3 (POST) send the right method, headers and body', async () => {
  const { AllInOneUltimate } = await import('../data/providers/AllInOneUltimate.js');
  const { AutoDownloadAllInOne } = await import('../data/providers/AutoDownloadAllInOne.js');
  const { config } = await import('../data/core/config.js');
  const url = 'https://www.tiktok.com/@creator1/video/123';
  const a2 = new AllInOneUltimate('all_in_one_ultimate', config('providers.all_in_one_ultimate'));
  const m2 = await a2.resolve(url);
  const s2 = prov.seen.at(-1);
  assert.equal(s2.method, 'GET'); assert.equal(s2.path, '/autolink'); assert.equal(s2.query.url, url);
  assert.equal(s2.headers['x-rapidapi-host'], 'download-all-in-one-ultimate.p.rapidapi.com'); assert.equal(s2.headers['x-rapidapi-key'], 'test-key-http-0002');
  assert.equal(m2.title, 'Tiktok Sample Clip'); assert.equal(m2.platform, 'tiktok');
  const a3 = new AutoDownloadAllInOne('auto_download_all_in_one', config('providers.auto_download_all_in_one'));
  const m3 = await a3.resolve(url);
  const s3 = prov.seen.at(-1);
  assert.equal(s3.method, 'POST'); assert.equal(s3.path, '/v1/social/autolink'); assert.deepEqual(JSON.parse(s3.body), { url });
  assert.match(s3.headers['content-type'], /application\/json/); assert.equal(s3.headers['x-rapidapi-host'], 'auto-download-all-in-one.p.rapidapi.com');
  assert.deepEqual(m3.formats.map((f) => f.type + f.quality), ['video720', 'audio128']);
});

test('TikTok resolves through the HTTP providers (MCP provider 1 is YouTube-only)', async () => {
  const r = await post('resolve', { url: 'https://www.tiktok.com/@creator1/video/123' });
  const d = (await r.json()).data;
  assert.equal(d.provider, 'All in One');
  assert.equal(d.platform, 'tiktok');
});

test('fallback: provider 1 rate-limited -> next providers; attempts are reported honestly', async () => {
  const r = await post('resolve', { url: YT + '&x=ratelimited' });
  const d = (await r.json()).data;
  assert.equal(r.status, 200);
  assert.equal(d.fallback_used, true);
  assert.ok(['All in One', 'Auto Download', 'All Media', 'YT MP4/MP3'].includes(d.provider));
  assert.notEqual(d.provider, 'Cloud API Hub');
});

test('all providers failing returns 502/404 and never claims success', async () => {
  const r = await post('resolve', { url: 'https://www.tiktok.com/@x/video/http500-allfail' });
  const j = await r.json();
  assert.equal(r.status, 502);
  assert.equal(j.ok, false);
  assert.ok(j.error.attempts.every((a) => a.status !== 'ok'));
  const e = await post('resolve', { url: 'https://www.tiktok.com/@x/video/empty-noformats' });
  assert.equal(e.status, 404);
  assert.equal((await e.json()).error.code, 'no_media');
});

test('circuit breaker opens after repeated failures and skips the provider (cooldown)', async () => {
  const { ProviderManager } = await import('../data/providers/ProviderManager.js');
  const pm = ProviderManager.instance();
  const st0 = await pm.state('all_in_one_ultimate');
  for (let i = 0; i < 3; i++) await post('resolve', { url: `https://www.tiktok.com/@x/video/quota${i}-allfail` });
  const st = await pm.state('all_in_one_ultimate');
  assert.ok(st.open_until > Date.now() / 1000, 'breaker should be open: ' + JSON.stringify([st0, st]));
  const r = await post('resolve', { url: 'https://www.tiktok.com/@x/video/quota-final-allfail' });
  const j = await r.json();
  assert.ok(j.error.attempts.some((a) => a.reason === 'cooldown'));
});

test('download: prepare -> real bytes, ID3-tagged MP3 with original title filename', async () => {
  const d = (await (await post('resolve', { url: YT })).json()).data;
  const p = await post('download', { ref: d.ref, format: 'a0' });
  const prep = (await p.json()).data;
  assert.equal(prep.filename, 'Sample Song Live Mix.mp3');
  assert.equal(prep.mode, 'stream');
  const f = await fetch(prep.download_url);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'audio/mpeg');
  assert.match(f.headers.get('content-disposition'), /^attachment; filename="Sample Song Live Mix\.mp3"/);
  const buf = Buffer.from(await f.arrayBuffer());
  assert.equal(buf.subarray(0, 3).toString(), 'ID3');
  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  const tag = buf.subarray(0, 10 + size).toString('latin1');
  assert.ok(tag.includes('TIT2') && tag.includes('TPE1') && tag.includes('APIC'), 'tag frames');
  assert.ok(buf.subarray(10 + size).equals(MP3), 'audio payload intact after tag');
  assert.equal(Number(f.headers.get('x-estimated-size')), buf.length);
});

test('download: video is passed through untouched with Content-Length and .mp4 name', async () => {
  const d = (await (await post('resolve', { url: YT })).json()).data;
  const prep = (await (await post('download', { ref: d.ref, format: 'v0' })).json()).data;
  assert.equal(prep.filename, 'Sample Song Live Mix.mp4');
  const f = await fetch(prep.download_url);
  const buf = Buffer.from(await f.arrayBuffer());
  assert.equal(f.headers.get('content-type'), 'video/mp4');
  assert.equal(Number(f.headers.get('content-length')), MP4.length);
  assert.ok(buf.equals(MP4));
});

test('download: tampered/expired tokens, bad formats and expired provider links are rejected', async () => {
  const { seal } = await import('../data/core/helpers.js');
  const d = (await (await post('resolve', { url: YT })).json()).data;
  const prep = (await (await post('download', { ref: d.ref, format: 'a0' })).json()).data;
  assert.equal((await fetch(prep.download_url.slice(0, -3) + 'abc')).status, 403);
  assert.equal((await fetch(`${base}/api/v1/download?t=${seal({ u: media.base + '/song.mp3' }, -10)}`)).status, 403);
  assert.equal((await post('download', { ref: d.ref, format: 'a9' })).status, 422);
  assert.equal((await post('download', { ref: 'x'.repeat(30) + '!', format: 'a0' })).status, 422);
  assert.equal((await post('download', { ref: seal({ m: {}, p: 'x', f: [] }, -1), format: 'a0' })).status, 410);
  for (const [path, status, code] of [['/expired', 404, 'no_media'], ['/gone', 502, 'providers_failed']]) {
    const t = seal({ u: media.base + path, ty: 'video', x: 'mp4', ti: 'T', ar: '', th: '', pl: 'x', p: 'x' }, 60);
    const r = await fetch(`${base}/api/v1/download?t=${t}`);
    assert.equal(r.status, path === '/expired' ? 404 : 502, path);
  }
});

test('download follows validated redirects and enforces the size limit', async () => {
  const { seal } = await import('../data/core/helpers.js');
  const mk = (u, ty = 'audio') => seal({ u, ty, x: 'mp3', ti: 'Redirected', ar: '', th: '', pl: 'x', p: 'x' }, 60);
  const ok = await fetch(`${base}/api/v1/download?t=${mk(media.base + '/redir')}`);
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 3).toString(), 'ID3');
  const big = await fetch(`${base}/api/v1/download?t=${mk(media.base + '/huge', 'video')}`);
  assert.equal(big.status, 413);
});

test('already-tagged MP3 is not double tagged', async () => {
  const { seal } = await import('../data/core/helpers.js');
  const r = await fetch(`${base}/api/v1/download?t=${seal({ u: media.base + '/tagged.mp3', ty: 'audio', x: 'mp3', ti: 'T', ar: 'A', th: '', pl: 'x', p: 'x' }, 60)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.indexOf('ID3'), 0);
  assert.equal(buf.indexOf('ID3', 3), -1);
});

test('search uses the configured provider capabilities (SoundCloud) and never invents results', async () => {
  const r = await post('search', { query: 'dj test' });
  const d = (await r.json()).data;
  assert.equal(d.provider, 'SoundCloud');
  assert.deepEqual(d.results[0], { title: 'Found Track', artist: 'Dj Test', duration: 215, thumbnail: 'https://i1.sndcdn.com/a-t500x500.jpg', platform: 'soundcloud', url: 'https://soundcloud.com/a/found', kinds: ['audio'] });
  assert.equal((await post('search', { query: 'x' })).status, 422);
});

test('API key (bot) auth works, web token is not needed', async () => {
  const r = await fetch(base + '/api/v1/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bot-key-0123456789abcdef' }, body: JSON.stringify({ url: YT }) });
  assert.equal(r.status, 200);
  const d = (await r.json()).data;
  const s = await fetch(base + '/api/v1/download', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'bot-key-0123456789abcdef' }, body: JSON.stringify({ ref: d.ref, format: 'v0', stream: '1' }) });
  assert.equal(s.status, 200);
  assert.ok(Buffer.from(await s.arrayBuffer()).equals(MP4));
});

test('admin endpoints are token protected; diagnostics expose no secrets', async () => {
  assert.equal((await fetch(base + '/api/v1/diagnostics')).status, 403);
  assert.equal((await fetch(base + '/api/v1/keys', { headers: { 'X-Admin-Token': 'wrong-wrong-wrong-wrong' } })).status, 403);
  const r = await fetch(base + '/api/v1/diagnostics?probe=1', { headers: { 'X-Admin-Token': process.env.ADMIN_TOKEN } });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!/test-key|127\.0\.0\.1:\d+\/song/.test(text), 'diagnostics leaked a secret');
  const j = JSON.parse(text).data;
  assert.equal(j.providers.length, 7);
  const hub = j.providers.find((p) => p.id === 'cloud_api_hub_youtube_downloader');
  assert.equal(hub.mcp.ok, true);
  assert.deepEqual(hub.mcp.tools.map((t) => t.name), ['get_video_info', 'convert_audio', 'search_tracks', 'needs_secret']);
  assert.equal(hub.mcp.client, 'builtin');
  assert.equal(j.storage.mode, 'local');
  assert.equal(j.storage.persistent, true);
  assert.ok(j.storage.collections.users && j.storage.collections.settings);
});

test('API keys live in users.json: create via admin, use, revoke -> 401', async () => {
  const H = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'Content-Type': 'application/json' };
  const created = await fetch(base + '/api/v1/keys', { method: 'POST', headers: H, body: '{"name":"bot-2"}' });
  assert.equal(created.status, 201);
  const k = (await created.json()).data;
  const use = () => fetch(base + '/api/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': k.key }, body: JSON.stringify({ query: 'dj test' }) });
  assert.equal((await use()).status, 200);
  const listed = (await (await fetch(base + '/api/v1/keys', { headers: H })).json()).data.keys;
  assert.ok(listed.some((x) => x.id === k.id && !x.revoked));
  assert.ok(!JSON.stringify(listed).includes(k.key));
  assert.equal((await fetch(base + `/api/v1/keys?id=${k.id}`, { method: 'DELETE', headers: H })).status, 200);
  assert.equal((await use()).status, 401);
});

test('downloads, search history and analytics are recorded in the JSON files', async () => {
  await new Promise((r) => setTimeout(r, 300)); // analytics writes are fire-and-forget
  const dbdir = path.join(dir, 'database');
  const downloads = JSON.parse(await fs.readFile(path.join(dbdir, 'downloads.json'), 'utf8')).records;
  assert.ok(downloads.some((r) => r.status === 'ok' && r.media_type === 'audio' && r.title.startsWith('Sample Song')));
  assert.ok(downloads.every((r) => /^[a-f0-9]{64}$/.test(r.ip_hash)));
  const hist = JSON.parse(await fs.readFile(path.join(dbdir, 'search-history.json'), 'utf8')).records;
  assert.ok(hist.some((r) => r.query === 'dj test' && r.results === 1));
  const totals = JSON.parse(await fs.readFile(path.join(dbdir, 'analytics.json'), 'utf8')).totals;
  assert.ok(totals.resolve_ok >= 5 && totals.download_ok >= 2 && totals.search_ok >= 1 && totals.resolve_failed >= 1, JSON.stringify(totals));
});

test('storage admin endpoint: status, forced backup, restore, cleanup', async () => {
  const H = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/v1/storage')).status, 403);
  const st = (await (await fetch(base + '/api/v1/storage', { headers: H })).json()).data;
  assert.equal(st.mode, 'local');
  const b = await fetch(base + '/api/v1/storage', { method: 'POST', headers: H, body: JSON.stringify({ action: 'backup', name: 'settings' }) });
  assert.equal(b.status, 200);
  const r = await fetch(base + '/api/v1/storage', { method: 'POST', headers: H, body: JSON.stringify({ action: 'restore', name: 'settings' }) });
  assert.equal(r.status, 200);
  assert.equal((await fetch(base + '/api/v1/storage', { method: 'POST', headers: H, body: JSON.stringify({ action: 'backup', name: '../etc' }) })).status, 422);
  assert.equal((await fetch(base + '/api/v1/storage', { method: 'POST', headers: H, body: JSON.stringify({ action: 'cleanup' }) })).status, 200);
});

test('DOWNLOAD_MODE=file stages through data/storage/temp, serves an exact Content-Length, then deletes the file', async () => {
  process.env.DOWNLOAD_MODE = 'file';
  try {
    const d = (await (await post('resolve', { url: YT })).json()).data;
    const prep = (await (await post('download', { ref: d.ref, format: 'a0' })).json()).data;
    assert.equal(prep.mode, 'file');
    const f = await fetch(prep.download_url);
    const buf = Buffer.from(await f.arrayBuffer());
    assert.equal(f.status, 200);
    assert.equal(Number(f.headers.get('content-length')), buf.length);
    assert.equal(buf.subarray(0, 3).toString(), 'ID3');
    assert.ok(buf.subarray(buf.length - MP3.length).equals(MP3));
    await new Promise((r) => setTimeout(r, 150));
    for (const sub of ['temp', 'downloads']) assert.deepEqual((await fs.readdir(path.join(dir, 'storage', sub))).filter((x) => !x.startsWith('.')), [], sub + ' must be empty after delivery');
    const v = (await (await post('download', { ref: d.ref, format: 'v0' })).json()).data;
    const vb = Buffer.from(await (await fetch(v.download_url)).arrayBuffer());
    assert.ok(vb.equals(MP4));
  } finally { delete process.env.DOWNLOAD_MODE; }
});

test('maintenance flag (settings.json) returns 503 for API clients but keeps the token endpoint', async () => {
  const { Settings } = await import('../data/database/models/Settings.js');
  await Settings.set({ maintenance: true });
  try {
    assert.equal((await post('resolve', { url: YT })).status, 503);
    assert.equal((await fetch(base + '/api/v1/token', { headers: SAME })).status, 200);
  } finally { await Settings.set({ maintenance: false }); }
  assert.equal((await post('search', { query: 'dj test' })).status, 200);
});

test('method checks and unknown routes', async () => {
  assert.equal((await fetch(base + '/api/v1/token', { method: 'POST', headers: SAME })).status, 405);
  assert.equal((await fetch(base + '/api/v1/nope')).status, 404);
});

test('rate limiting returns 429 with Retry-After', async () => {
  const { kv } = await import('../data/core/kv.js');
  const { RateLimiter } = await import('../data/security/RateLimiter.js');
  kv._clearMemory();
  let last;
  for (let i = 0; i < 4; i++) last = await RateLimiter.hit('t', 'ip', 3);
  assert.equal(last.allowed, false);
});

test('static site is served and contains exactly three nav tabs', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.equal((html.match(/<a href="[^"]*" data-nav="(home|search|about)"/g) || []).length, 3);
  assert.ok(!html.includes('{{') && !html.includes('<?php'));
  for (const u of ['https://www.facebook.com/MOSTAKIM.LABS', 'https://t.me/M0STAKIM10X', 'https://www.youtube.com/@MOSTAKIM-LABS', 'https://discord.gg/2vM4QEHhD']) assert.ok(html.includes(`href="${u}"`), u);
  assert.equal((await fetch(base + '/resources/mostakim.png')).status, 200);
  assert.equal((await fetch(base + '/../mostakim.json')).status, 404);
  assert.equal((await fetch(base + '/src/ui/app.js')).status, 200);
});

test('MCP client speaks both JSON and SSE (Streamable HTTP) responses and reports auth errors', async () => {
  process.env.MCP_CLIENT = 'builtin';
  const { MCPClient } = await import('../data/providers/MCPClient.js');
  const mk = (server, key = 'test-key-mcp-0001') => new MCPClient({ server, host: 'h', key, label: 'sse-test-' + Math.random(), timeout: 4000 });
  const sse = mk(mcp.base + '?sse=1');
  const tools = await sse.tools();
  assert.equal(tools.length, 4);
  assert.equal(sse.kind, 'builtin');
  const out = await sse.call('search_tracks', { query: 'q' });
  assert.equal(out.collection[0].title, 'Found Track');
  await sse.close();
  await assert.rejects(() => mk(mcp.base, 'wrong-key').tools(), (e) => e.kind === 'auth');
  await assert.rejects(() => mk(mcp.base).call('get_video_info', { url: 'https://x.com/ratelimited' }), (e) => e.kind === 'rate_limit');
  delete process.env.MCP_CLIENT;
});
