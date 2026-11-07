import { Resolver } from '../backend/Resolver.js';
import { sendJson } from '../core/helpers.js';

export const ResolveController = {
  async handle({ res, input }) {
    sendJson(res, 200, { ok: true, data: await new Resolver().resolve(input.url ?? '') });
  },
};
