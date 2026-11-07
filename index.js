// M-TUBE main entry point.
//   Local / VPS :  npm install && node index.js        (http://localhost:3000, honours PORT)
//   Vercel      :  api/v1/[name].js re-exports the Express app below as a serverless function
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createHandler } from './data/core/router.js';
import { routes } from './data/api/routes.js';
import { ensureReady } from './data/core/bootstrap.js';
import { FileManager } from './data/backend/FileManager.js';
import { isServerless } from './data/core/paths.js';
import { env, log, sendJson } from './data/core/helpers.js';
import { buildSite } from './scripts/build.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public'); // the ONLY directory served as static files

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', isServerless() || env('TRUST_PROXY') === '1' ? 1 : false);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"],
        connectSrc: ["'self'"], fontSrc: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], objectSrc: ["'none'"],
        upgradeInsecureRequests: isServerless() ? [] : null, // plain-http localhost/VPS must keep working
      },
    },
  }));
  app.use(compression({ filter: (req, res) => (req.path.startsWith('/api/v1/download') ? false : compression.filter(req, res)) }));
  morgan.token('safe-url', (req) => String(req.originalUrl || req.url).replace(/([?&]t=)[^&]+/, '$1[token]'));
  if (process.env.NODE_ENV !== 'test') app.use(morgan(':remote-addr :method :safe-url :status :res[content-length] - :response-time ms'));

  const allowed = String(env('CORS_ORIGINS', '')).split(',').map((s) => s.trim()).filter(Boolean);
  app.use('/api', cors({
    origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Admin-Token', 'X-Web-Token'],
  }));
  app.use('/api', rateLimit({
    windowMs: 60_000, limit: Number(env('RATE_LIMIT_GLOBAL', '120')), standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => sendJson(res, 429, { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' } }),
  }));

  const handlers = Object.fromEntries(Object.keys(routes).map((n) => [n, createHandler(n)]));
  app.all('/api/v1/:name', (req, res, next) => {
    const h = handlers[req.params.name];
    if (!h) return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown API endpoint.' } });
    return h(req, res).catch(next);
  });
  app.use('/api', (req, res) => sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown API endpoint.' } }));

  app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore', index: 'index.html', maxAge: '1h' }));
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log('app', `Express error: ${err?.message}`);
    sendJson(res, 500, { ok: false, error: { code: 'server_error', message: 'An unexpected error occurred. Please try again later.' } });
  });
  return app;
}

const app = createApp();
export default app; // Vercel: api/v1/[name].js re-exports this

async function start() {
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) buildSite(); // first run: assemble src/ui -> public/
  await ensureReady(); // validates mostakim.json, creates/recovers JSON database + storage folders
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`M-TUBE running at http://localhost:${port}`));
  setInterval(() => FileManager.cleanup().catch(() => {}), 10 * 60 * 1000).unref();
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

process.on('unhandledRejection', (e) => log('app', 'unhandledRejection: ' + (e?.message || e)));
const isMain = process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
if (isMain && !isServerless()) {
  start().catch((e) => { console.error('Failed to start M-TUBE:', e.message); process.exit(1); });
}
