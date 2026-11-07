import { SearchController } from './SearchController.js';
import { ResolveController } from './ResolveController.js';
import { DownloadController } from './DownloadController.js';
import { KeysController } from './KeysController.js';
import { issueWebToken } from '../security/ApiAuth.js';
import { diagnose, storageStatus } from '../core/Diagnostics.js';
import { getDb } from '../database/Db.js';
import { FileManager } from '../backend/FileManager.js';
import { sendJson, ApiError } from '../core/helpers.js';

// name -> { methods, auth: 'client'|'admin'|'none', anonymous?(req,url) => bool, handle(ctx) }
export const routes = {
  search: { methods: ['GET', 'POST'], auth: 'client', handle: SearchController.handle },
  resolve: { methods: ['GET', 'POST'], auth: 'client', handle: ResolveController.handle },
  download: {
    methods: ['GET', 'POST'], auth: 'client',
    anonymous: (req, url) => req.method === 'GET' && url.searchParams.has('t'), // signed one-time-ish token
    handle: DownloadController.handle,
  },
  keys: { methods: ['GET', 'POST', 'DELETE'], auth: 'admin', handle: KeysController.handle },
  token: {
    methods: ['GET'], auth: 'none',
    async handle({ req, res }) { sendJson(res, 200, { ok: true, data: issueWebToken(req) }); },
  },
  diagnostics: {
    methods: ['GET'], auth: 'admin',
    async handle({ res, query }) {
      if (query.url) {
        try { new URL(query.url); } catch { throw new ApiError(422, 'invalid_input', 'Invalid url.'); }
      }
      sendJson(res, 200, { ok: true, data: await diagnose({ probe: query.probe === '1', testUrl: query.url || '' }) });
    },
  },
  storage: {
    methods: ['GET', 'POST'], auth: 'admin',
    async handle({ req, res, input }) {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, data: await storageStatus() });
      const db = await getDb();
      const name = String(input.name || '');
      try {
        if (input.action === 'backup') return sendJson(res, 200, { ok: true, data: { backup: await db.backup(name) } });
        if (input.action === 'restore') return sendJson(res, 200, { ok: true, data: { restored: await db.restore(name, input.id || null) } });
        if (input.action === 'cleanup') return sendJson(res, 200, { ok: true, data: { removed: await FileManager.cleanup({ force: true }) } });
      } catch (e) { throw new ApiError(422, 'invalid_input', String(e.message).slice(0, 160)); }
      throw new ApiError(422, 'invalid_input', 'action must be backup, restore or cleanup.');
    },
  },
};
