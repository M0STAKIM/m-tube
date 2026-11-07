import { Downloader } from '../backend/Downloader.js';
import { Validator } from '../security/Validator.js';
import { RateLimiter } from '../security/RateLimiter.js';
import { ApiError, clientIp, sendJson, open } from '../core/helpers.js';

export const DownloadController = {
  async handle({ req, res, client, input, query }) {
    const dl = new Downloader();
    if (req.method === 'GET' && query.t) {
      const r = await RateLimiter.hit('dl', clientIp(req), 20);
      if (!r.allowed) throw new ApiError(429, 'rate_limited', 'Too many downloads. Please wait a moment.');
      const payload = open(query.t);
      if (!payload || !payload.u) throw new ApiError(403, 'invalid_token', 'This download link is invalid or has expired.');
      await dl.deliver(req, res, payload);
      return;
    }
    if (!client) throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    const ref = Validator.ref(input.ref);
    const fid = Validator.formatId(input.format);
    const prep = await dl.prepare(req, ref, fid);
    if (String(input.stream) === '1' && client.type === 'key') {
      const url = new URL(prep.download_url);
      await dl.deliver(req, res, open(url.searchParams.get('t')));
      return;
    }
    sendJson(res, 200, { ok: true, data: prep });
  },
};
