import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ConfigError extends Error {}

const placeholder = (v) => v == null || String(v).trim() === '' || /^YOUR_/i.test(String(v));
const envv = (k) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : undefined);
let cache = null;

export function resetConfigCache() { cache = null; }

export function loadConfig() {
  if (cache) return cache;
  const candidates = [
    process.env.MTUBE_CONFIG_PATH,
    path.join(process.cwd(), 'mostakim.json'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../mostakim.json'),
  ].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new ConfigError('mostakim.json was not found in the project root.');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError('mostakim.json is not valid JSON: ' + e.message); }
  for (const s of ['database', 'providers', 'provider_fallback', 'storage']) {
    if (!cfg[s] || typeof cfg[s] !== 'object') throw new ConfigError(`mostakim.json is missing the "${s}" section.`);
  }

  if ((cfg.database.driver || 'json') !== 'json') throw new ConfigError('Only the JSON file database is supported (database.driver must be "json").');

  for (const [id, p] of Object.entries(cfg.providers)) {
    if (!p || typeof p !== 'object') throw new ConfigError(`Provider "${id}" must be an object.`);
    if (!['http', 'mcp'].includes(p.transport)) throw new ConfigError(`Provider "${id}" has an invalid transport (use http or mcp).`);
    const up = id.replace(/[^a-z0-9]/gi, '_').toUpperCase();
    if (envv(`PROVIDER_${up}_ENABLED`) !== undefined) p.enabled = ['1', 'true', 'yes', 'on'].includes(envv(`PROVIDER_${up}_ENABLED`).toLowerCase());
    if (envv(`PROVIDER_${up}_PRIORITY`) !== undefined) p.priority = Number(envv(`PROVIDER_${up}_PRIORITY`));
    let current = p.transport === 'mcp' ? (p.mcp?.api_key ?? '') : (p.api_key ?? '');
    let override = envv(`PROVIDER_${up}_API_KEY`);
    if (override === undefined && placeholder(current)) override = envv('RAPIDAPI_KEY');
    if (override !== undefined) current = override;
    if (p.transport === 'mcp') { p.mcp ||= {}; p.mcp.api_key = current; } else p.api_key = current;
    p.configured = !placeholder(current);
  }
  cache = cfg;
  return cfg;
}

export function config(key, def = undefined) {
  let v = loadConfig();
  for (const part of key.split('.')) {
    if (v && typeof v === 'object' && part in v) v = v[part];
    else return def;
  }
  return v;
}
