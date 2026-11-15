// ═══════════════════════════════════════════════════════════════
// In-memory limiter: requests per minute (sliding window) + concurrent requests per key.
// Per server instance; on serverless use a shared store (e.g. Upstash Redis) if you need a global limit.
// ═══════════════════════════════════════════════════════════════
import { HttpError } from './http.js';

export class RateLimiter {
  constructor({ perMinuteUser, perMinuteIp, concurrentPerUser }, now = Date.now) {
    this.cfg = { perMinuteUser, perMinuteIp, concurrentPerUser };
    this.now = now;
    this.hits = new Map(); // key → timestamps[]
    this.active = new Map(); // key → count
  }

  _hit(key, limit) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < 60000);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      throw new HttpError(429, 'Too many requests. Please wait a moment and try again.', { code: 'rate_limited', retryAfter: Math.max(1, Math.ceil((60000 - (t - arr[0])) / 1000)) });
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.length || t - v[v.length - 1] > 60000) this.hits.delete(k);
  }

  /** Throws HttpError(429) when over the limit. Returns release() — call it when the request ends. */
  take({ userId, ip }) {
    this._hit(`ip:${ip}`, this.cfg.perMinuteIp);
    const key = userId ? `u:${userId}` : `ip:${ip}`;
    if (userId) this._hit(key, this.cfg.perMinuteUser);
    const n = this.active.get(key) || 0;
    if (n >= this.cfg.concurrentPerUser) throw new HttpError(429, 'Please wait for the current answers to finish before sending more.', { code: 'too_many_active', retryAfter: 3 });
    this.active.set(key, n + 1);
    let done = false;
    return () => { if (done) return; done = true; const c = (this.active.get(key) || 1) - 1; if (c <= 0) this.active.delete(key); else this.active.set(key, c); };
  }
}
