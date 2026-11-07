import { kv } from '../core/kv.js';

export const RateLimiter = {
  /** @returns {{allowed:boolean, remaining:number, reset:number}} */
  async hit(bucket, id, limit, windowSec = 60) {
    const { count, reset } = await kv.hit(`rl:${bucket}:${id}`, windowSec);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), reset };
  },
};
