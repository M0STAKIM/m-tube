import { Users } from '../database/models/Users.js';
import { ApiError, sendJson } from '../core/helpers.js';

/** GET list API clients, POST {name} create a key, DELETE ?id= revoke (admin only; stored in users.json). */
export const KeysController = {
  async handle({ req, res, input }) {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, data: { keys: await Users.all() } });
    if (req.method === 'POST') {
      const k = await Users.create(input.name);
      return sendJson(res, 201, { ok: true, data: { ...k, note: 'Store this key now; it cannot be shown again.' } });
    }
    const id = String(input.id ?? '');
    if (!/^[a-f0-9]{16}$/.test(id)) throw new ApiError(422, 'invalid_input', 'A valid key id is required.');
    return sendJson(res, 200, { ok: await Users.revoke(id), data: { revoked: id } });
  },
};
