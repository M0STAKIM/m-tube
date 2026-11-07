import { loadConfig } from './config.js';
import { FileManager } from '../backend/FileManager.js';
import { getDb } from '../database/Db.js';
import { log } from './helpers.js';

let ready = null;

async function init() {
  try {
    await FileManager.init();
    await getDb(); // creates/validates/recovers the JSON database files
    await FileManager.cleanup({ force: true });
  } catch (e) {
    log('storage', 'Storage initialisation problem: ' + e.message); // the site keeps working, data features degrade
  }
}

/** Validates mostakim.json (throws ConfigError) and prepares storage + JSON database once per process. */
export function ensureReady() {
  loadConfig();
  ready ||= init();
  return ready;
}
export function _resetReady() { ready = null; }
