import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const isServerless = () => !!process.env.VERCEL;

// Evaluated lazily so tests/ops can point the app at another directory via env.
const custom = () => (process.env.MTUBE_DATA_DIR ? path.resolve(process.env.MTUBE_DATA_DIR) : null);

/** Folder holding the JSON database files (users.json, downloads.json, ...). Never served publicly. */
export function dbDir() {
  if (process.env.DB_DIR) return path.resolve(process.env.DB_DIR);
  if (custom()) return path.join(custom(), 'database');
  return isServerless() ? path.join(os.tmpdir(), 'mtube', 'database') : path.join(ROOT, 'data', 'database');
}

/** Folder holding temp/, cache/, downloads/, logs/, backups/. Never served publicly. */
export function storageDir(sub = '') {
  let base;
  if (process.env.STORAGE_DIR) base = path.resolve(process.env.STORAGE_DIR);
  else if (custom()) base = path.join(custom(), 'storage');
  else base = isServerless() ? path.join(os.tmpdir(), 'mtube', 'storage') : path.join(ROOT, 'data', 'storage');
  return sub ? path.join(base, sub) : base;
}

/**
 * Where JSON data lives and whether it survives restarts:
 *  local     — real files on a persistent disk (local machine / VPS)                    persistent
 *  blob      — Vercel Blob object storage (encrypted JSON objects)                      persistent*
 *  ephemeral — Vercel without Blob: files in /tmp, lost on cold start, not shared       NOT persistent
 */
export function persistence() {
  const forced = process.env.JSON_DB_ADAPTER;
  if (forced === 'blob' || (isServerless() && process.env.BLOB_READ_WRITE_TOKEN && forced !== 'local')) return { adapter: 'blob', mode: 'blob', persistent: true };
  if (isServerless()) return { adapter: 'local', mode: 'ephemeral', persistent: false };
  return { adapter: 'local', mode: 'local', persistent: true };
}
