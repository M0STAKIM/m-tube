import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

export const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(4096, 7)]);
export const MP3_TAGGED = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), MP3]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8192, 3)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);

/** Mock media CDN. */
export async function mediaServer() {
  const srv = http.createServer((req, res) => {
    const send = (ct, buf, extra = {}) => { res.writeHead(200, { 'Content-Type': ct, 'Content-Length': buf.length, ...extra }); res.end(buf); };
    if (req.url === '/song.mp3') return send('audio/mpeg', MP3);
    if (req.url === '/tagged.mp3') return send('audio/mpeg', MP3_TAGGED);
    if (req.url === '/video.mp4') return send('video/mp4', MP4);
    if (req.url === '/cover.jpg') return send('image/jpeg', JPEG);
    if (req.url === '/expired') return send('text/html', Buffer.from('<html>expired</html>'));
    if (req.url === '/gone') { res.writeHead(403); return res.end('no'); }
    if (req.url === '/redir') { res.writeHead(302, { Location: '/song.mp3' }); return res.end(); }
    if (req.url === '/huge') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(900 * 1048576) }); res.flushHeaders(); return setTimeout(() => res.destroy(), 300); }
    res.writeHead(404); return res.end();
  });
  const port = await listen(srv);
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

/** Mock RapidAPI HTTP providers (records requests). */
export async function httpProviderServer(media) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
    const target = u.searchParams.get('url') || (body && JSON.parse(body).url) || '';
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (target.includes('http500')) return json(500, { error: 'boom' });
    if (target.includes('quota')) return json(429, { message: 'You have exceeded the MONTHLY quota' });
    if (target.includes('empty')) return json(200, { title: 'x', medias: [] });
    if (target.includes('apierror')) return json(200, { error: true, message: 'Unsupported URL' });
    return json(200, {
      title: 'Tiktok Sample Clip', author: 'creator1', duration: 15, thumbnail: `${media}/cover.jpg`,
      medias: [
        { url: `${media}/video.mp4`, quality: '720p', extension: 'mp4', type: 'video' },
        { url: `${media}/song.mp3`, quality: '128kbps', extension: 'mp3', type: 'audio' },
      ],
    });
  });
  const port = await listen(srv);
  return { base: `http://127.0.0.1:${port}`, seen, close: () => srv.close() };
}

/** Mock MCP server (Streamable HTTP; JSON or SSE with ?sse=1). */
export async function mcpServer(media, { failInfoFor = [] } = {}) {
  const seen = [];
  const tools = [
    { name: 'get_video_info', description: 'Get video information and formats', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'convert_audio', description: 'Convert to audio', inputSchema: { type: 'object', properties: { url: { type: 'string' }, format: { type: 'string', enum: ['mp3', 'm4a'] } }, required: ['url', 'format'] } },
    { name: 'search_tracks', description: 'Search tracks by query', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'needs_secret', description: 'Download video with token', inputSchema: { type: 'object', properties: { url: { type: 'string' }, token: { type: 'string' } }, required: ['url', 'token'] } },
  ];
  const srv = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, headers: req.headers, body: raw });
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    const msg = JSON.parse(raw);
    if (req.headers['x-api-key'] !== 'test-key-mcp-0001') { res.writeHead(401); return res.end('unauthorized'); }
    const reply = (result) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (u.searchParams.get('sse') === '1') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-1' }); res.end(`event: message\ndata: ${payload}\n\n`); } else { res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' }); res.end(payload); }
    };
    const text = (o, isError = false) => reply({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }], isError });
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } });
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (msg.method === 'tools/list') return reply({ tools });
    if (msg.method === 'tools/call') {
      const { name, arguments: a } = msg.params;
      if (name === 'get_video_info') {
        if (failInfoFor.some((f) => a.url.includes(f))) return text('Rate limit exceeded: too many requests', true);
        if (a.url.includes('noformats')) return text({ title: 'x', formats: [] });
        return text({
          title: 'Sample Song: "Live" / Mix?', author: 'Sample Artist', lengthSeconds: '200',
          thumbnails: [{ url: `${media}/cover.jpg`, width: 120 }],
          formats: [
            { url: `${media}/video.mp4`, mimeType: 'video/mp4; codecs="avc1"', qualityLabel: '720p', hasAudio: true },
            { url: `${media}/video.mp4`, mimeType: 'video/mp4; codecs="avc1"', qualityLabel: '1080p', hasAudio: false },
          ],
        });
      }
      if (name === 'convert_audio') return a.url.includes('noformats') ? text({}) : text({ download_url: `${media}/song.mp3`, abr: a.format === 'mp3' ? 320 : 128, ext: a.format });
      if (name === 'search_tracks') return text({ collection: [{ title: 'Found Track', permalink_url: 'https://soundcloud.com/a/found', duration: 215000, user: { username: 'Dj Test' }, artwork_url: 'https://i1.sndcdn.com/a-large.jpg' }] });
    }
    return reply({ content: [{ type: 'text', text: 'unknown' }], isError: true });
  });
  const port = await listen(srv);
  return { base: `http://127.0.0.1:${port}/mcp`, seen, close: () => srv.close() };
}

export function writeConfig(dir, { mcp, httpBase, overrides = {} }) {
  const caps = (a, v, s = false) => ({ audio: a, video: v, search: s });
  const mcpCfg = (host) => ({ server_url: mcp, api_host: host, api_key: 'test-key-mcp-0001' });
  const cfg = {
    database: { driver: 'json', directory: 'data/database' },
    providers: {
      cloud_api_hub_youtube_downloader: { name: 'Cloud API Hub', enabled: true, priority: 1, transport: 'mcp', capabilities: caps(true, true), mcp: mcpCfg('cloud-api-hub-youtube-downloader.p.rapidapi.com') },
      all_in_one_ultimate: { name: 'All in One', enabled: true, priority: 2, transport: 'http', api_host: 'download-all-in-one-ultimate.p.rapidapi.com', api_key: 'test-key-http-0002', capabilities: caps(true, true), resolve: { method: 'GET', url: `${httpBase}/autolink`, query_parameter: 'url' } },
      auto_download_all_in_one: { name: 'Auto Download', enabled: true, priority: 3, transport: 'http', api_host: 'auto-download-all-in-one.p.rapidapi.com', api_key: 'test-key-http-0003', capabilities: caps(true, true), resolve: { method: 'POST', url: `${httpBase}/v1/social/autolink`, body: { url: '{media_url}' } } },
      all_media_downloader: { name: 'All Media', enabled: true, priority: 4, transport: 'mcp', capabilities: caps(true, true), mcp: mcpCfg('all-media-downloader4.p.rapidapi.com') },
      soundcloud_scraper: { name: 'SoundCloud', enabled: true, priority: 5, transport: 'mcp', capabilities: caps(true, false, true), mcp: mcpCfg('soundcloud-scraper.p.rapidapi.com') },
      youtube_mp4_mp3_downloader: { name: 'YT MP4/MP3', enabled: true, priority: 6, transport: 'mcp', capabilities: caps(true, true), mcp: mcpCfg('youtube-mp4-mp3-downloader.p.rapidapi.com') },
      spotify_music_mp3_downloader: { name: 'Spotify', enabled: true, priority: 7, transport: 'mcp', capabilities: caps(true, false, false), mcp: mcpCfg('spotify-music-mp3-downloader-api.p.rapidapi.com') },
    },
    provider_fallback: { enabled: true, on_errors: ['timeout', 'rate_limit', 'quota_exceeded', 'server_error', 'invalid_response'], max_retries_per_provider: 1, circuit_breaker: { enabled: true, failure_threshold: 3, cooldown_seconds: 300 }, timeout_seconds: 5 },
    storage: { driver: 'local', temporary_directory: 'storage/app/temp', max_file_size_mb: 500, cleanup_enabled: true },
    ...overrides,
  };
  const file = path.join(dir, 'mostakim.test.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mtube-test-'));
