# M-TUBE — Download What You Love
Developer: **MOSTAKIM LAB'S** · Node.js 20+ · Express · custom **JSON file database** · local filesystem storage · Vercel-compatible.
UI: Home | Search | About (unchanged Blue + White + Cyan Liquid Glass design).

> **Honesty note.** Automated tests (`npm test`, 57 tests) cover the JSON database, storage, security, provider adapters (against **mock** providers) and the download pipeline through a plain-`http` harness that uses the same request handlers as the Express app.
> **Not verified here** (no network / npm registry in the build sandbox): `npm install` + `node index.js` with real Express, the real RapidAPI providers, the official MCP SDK, Vercel Blob, and a live Vercel deployment. Run `npm run diagnose` and the checklist at the end.

## Run locally / on a VPS
```bash
npm install
node index.js          # http://localhost:3000   (PORT env supported)
```
`.env` (see `.env.example`) is loaded with dotenv. On first start the site is built from `src/ui` into `public/`, storage folders and JSON files are created automatically and `APP_SECRET` is generated into `data/storage/.secret` if you did not set one. Put your RapidAPI key in `.env` (`RAPIDAPI_KEY=...`).

## Architecture
```
index.js            Express app (helmet, cors, compression, morgan, express-rate-limit) — `node index.js` starts it, default export is the app
api/index.js        Vercel Function entry (re-exports the Express app) · vercel.json rewrites /api/* to it
src/ui/ -> public/  UI templates/CSS/JS, assembled by scripts/build.js (only public/ is served)
mostakim.json       providers, fallback, storage limits (root config)
data/core/          JsonDatabase.js · StorageAdapters.js (Local file + Vercel Blob) · paths.js · config.js · helpers.js · router.js · Diagnostics.js
data/database/      Db.js (schemas/singleton) · models: Users, Downloads, SearchHistory, Analytics, Settings
                    runtime files: users.json downloads.json search-history.json analytics.json settings.json   (git-ignored)
data/storage/       temp/ cache/ downloads/ logs/ backups/   (git-ignored, never served)
data/backend/       Resolver · Search · Downloader · Metadata (ID3) · FileManager
data/providers/     ProviderManager · MCPClient · HttpClient · BaseAdapter · 7 adapters
data/security/      Validator (URL + SSRF) · RateLimiter · ApiAuth
```
## JSON database
No SQL/NoSQL service is used. `data/core/JsonDatabase.js` provides:
- automatic creation + default initialisation of missing files; schema validation **before** every save;
- atomic writes (temp file → fsync → rename), in-process write queue **and** cross-process lock file (tested with 4 processes × 40 writes);
- timestamped backups in `data/storage/backups/` (keep N, min interval configurable in `mostakim.json → storage.backups`), manual backup/restore;
- recovery: a corrupt or schema-invalid file is quarantined (`*.corrupt.*`) and restored from the newest valid backup, else reset to defaults;
- a storage-adapter interface (`read/write/list/remove/lock`) so the backend can change without touching application code.
Records are capped (downloads 5000, search history 2000, analytics 90 days). IPs are stored only as salted hashes. Set `JSON_DB_LOGGING=off` to stop writing history/analytics.

## Local storage
`temp/` (partial downloads), `downloads/` (staged files awaiting delivery), `cache/` (search + MCP tool cache), `logs/app.log` (rotated at 5 MB), `backups/`. Limits in `mostakim.json → storage`: `max_file_size_mb`, `max_temp_size_mb`, `max_cache_size_mb`, `temp_ttl_seconds`. Expired files are removed at startup, every 10 minutes and when space is needed. None of these folders is under `public/`.
`DOWNLOAD_MODE`: `stream` (default, nothing stored) · `file` (stage in temp → exact Content-Length → delete after delivery) · `redirect` (validated 302 to the provider).

## Vercel — read this
Vercel Functions have an **ephemeral** filesystem, so local JSON files do **not** persist there.
| Setup | JSON data |
|---|---|
| Local / VPS | real files on disk, persistent |
| Vercel **without** `BLOB_READ_WRITE_TOKEN` | `/tmp` files — **lost on cold start, not shared between instances** (reported as `ephemeral` by `/api/v1/storage`) |
| Vercel **with** Vercel Blob | same JsonDatabase interface, stored as **AES-encrypted objects** in Blob (object storage, not a database). No cross-instance locking (concurrent writers: last write wins), CDN reads can lag a few seconds → low-traffic use only |
Other Vercel limits: `/tmp` is small; a function runs at most `maxDuration` (60 s in `vercel.json`) so long downloads can be cut; rate limits and the circuit breaker are per instance (in memory); `DOWNLOAD_MODE=file` is possible but uses scarce `/tmp`. `APP_SECRET` is **required** on Vercel. For serious persistent data run on a VPS.

Deploy: push to GitHub → import in Vercel (Framework: Other) → set env vars (`APP_SECRET`, `RAPIDAPI_KEY`, optionally `ADMIN_TOKEN`, `BLOB_READ_WRITE_TOKEN`) → deploy. Build: `node scripts/build.js`; function: `api/index.js`.

## Providers (unchanged)
7 RapidAPI providers (5 MCP, 2 HTTP) with per-provider adapters, priority order from `mostakim.json`, capability checks, retry, circuit breaker and fallback. MCP uses the official `@modelcontextprotocol/sdk` with an automatic fallback to a built-in JSON-RPC client. `mostakim.json` ships placeholders (`YOUR_RAPIDAPI_KEY`) — keys go in env vars; providers with placeholder keys are skipped.

## API
`X-API-Key: <key>` or `Authorization: Bearer <key>`; responses `{ok:true,data}` / `{ok:false,error}`.
`POST /api/v1/search {query}` · `POST /api/v1/resolve {url}` · `POST /api/v1/download {ref, format}` → short-lived `download_url` (`stream:"1"` + API key streams directly).
Admin (`X-Admin-Token`, needs `ADMIN_TOKEN`): `GET|POST|DELETE /api/v1/keys` (users.json) · `GET /api/v1/diagnostics?probe=1&url=...` · `GET|POST /api/v1/storage` (status; `{action:"backup"|"restore"|"cleanup", name}`).

## Security
Provider keys and media links never reach the browser; SSRF guard (DNS-resolved, private ranges blocked, IP pinned, redirects re-validated); sealed expiring tokens; same-origin web tokens; filename sanitisation; path-traversal-safe storage keys; helmet CSP; global (express-rate-limit) + per-key/per-IP limits; secrets redacted in logs; admin endpoints disabled without `ADMIN_TOKEN`; JSON files live outside `public/`.

## Development
`npm test` · `npm run dev:plain` (dependency-free server for quick checks) · `npm run diagnose -- <url>`.

## Checklist before going live
1. `npm install && node index.js`, open the site, resolve a link you may download.
2. `RAPIDAPI_KEY=... npm run diagnose -- <video-url>`; adjust an adapter's `keys()` if a field is missed.
3. Vercel: confirm `/api/v1/token` works and check `/api/v1/storage` shows the expected mode.
Use only for content you own or may legally download. M-TUBE does not bypass DRM or access controls.
