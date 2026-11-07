// Dependency-free test/dev server (plain http, no Express): serves public/ and routes /api/v1/<name>
// through the same createHandler() the Express app uses. `node index.js` is the real entry point.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../data/core/router.js';
import { routes } from '../data/api/routes.js';

try { process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env')); } catch { /* no .env or old Node */ }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const handlers = Object.fromEntries(Object.keys(routes).map((n) => [n, createHandler(n)]));

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/api\/v1\/([a-z]+)\/?$/.exec(url.pathname);
    if (m) {
      if (!handlers[m[1]]) { res.statusCode = 404; return res.end('{"ok":false,"error":{"code":"not_found","message":"Unknown API endpoint."}}'); }
      return handlers[m[1]](req, res);
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, 'public', rel);
    if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    return fs.createReadStream(file).pipe(res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`M-TUBE (plain http) : http://localhost:${port}`));
}
