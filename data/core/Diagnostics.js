import { ProviderManager } from '../providers/ProviderManager.js';
import { getDb } from '../database/Db.js';
import { persistence } from './paths.js';
import { FileManager } from '../backend/FileManager.js';
import { env, isProd, detectPlatform } from './helpers.js';

/** Provider-by-provider diagnostics. Never returns keys or download URLs. */
export async function diagnose({ probe = false, testUrl = '' } = {}) {
  const pm = ProviderManager.instance();
  const out = [];
  for (const a of pm.all()) {
    const row = {
      id: a.id(), name: a.name(), transport: a.cfg.transport, priority: a.priority(), enabled: a.isEnabled(),
      configured: a.isConfigured(), capabilities: a.capabilities(), breaker: await pm.state(a.id()),
    };
    if (probe && a.isConfigured() && a.isEnabled()) {
      if (a.cfg.transport === 'mcp') {
        const t0 = Date.now();
        try {
          const tools = await a.mcp().tools();
          row.mcp = { ok: true, ms: Date.now() - t0, client: a.mcp().kind, tools: tools.map((t) => ({ name: t.name, inputs: Object.keys(t.inputSchema?.properties || {}), required: t.inputSchema?.required || [] })) };
        } catch (e) { row.mcp = { ok: false, ms: Date.now() - t0, kind: e.kind || 'error', error: String(e.message).slice(0, 200) }; }
        finally { await a.mcp().close(); }
      }
      if (testUrl && a.supports('resolve', detectPlatform(testUrl))) {
        const t0 = Date.now();
        try {
          const m = await a.resolve(testUrl);
          row.resolve = { ok: true, ms: Date.now() - t0, title: m.title, formats: m.formats.map((f) => `${f.type}:${f.quality_label}:${f.ext || '?'}`) };
        } catch (e) { row.resolve = { ok: false, ms: Date.now() - t0, kind: e.kind || 'error', error: String(e.message).slice(0, 200) }; }
      }
    }
    out.push(row);
  }
  return {
    runtime: { node: process.version, production: isProd(), mcp_client: env('MCP_CLIENT', 'sdk'), download_mode: env('DOWNLOAD_MODE', 'stream') },
    storage: await storageStatus(),
    providers: out,
  };
}

/** JSON database + local storage status (no secrets, no file contents). */
export async function storageStatus() {
  const p = persistence();
  let collections = null;
  try { collections = await (await getDb()).stats(); } catch (e) { collections = { error: String(e.message).slice(0, 120) }; }
  return {
    mode: p.mode, persistent: p.persistent,
    note: p.persistent ? undefined : 'Ephemeral storage (serverless /tmp): data is lost on cold starts and is not shared between instances. Configure Vercel Blob or run on a VPS for persistence.',
    collections, usage_bytes: await FileManager.usage(),
  };
}
