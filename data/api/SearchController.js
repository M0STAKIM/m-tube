import { Search } from '../backend/Search.js';
import { sendJson, clientIp } from '../core/helpers.js';

export const SearchController = {
  async handle({ req, res, input }) {
    sendJson(res, 200, { ok: true, data: await new Search().run(input.query ?? input.q ?? '', clientIp(req)) });
  },
};
