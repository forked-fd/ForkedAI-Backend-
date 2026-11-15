// ═══════════════════════════════════════════════════════════════
// Supabase access-token verification (the web app already sends `Authorization: Bearer <token>`)
// ═══════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function jwtExp(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp * 1000; } catch { return 0; }
}

export const bearerOf = (req) => { const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')); return m ? m[1].trim() : ''; };

export class Auth {
  constructor(cfg, { fetchImpl = fetch, now = Date.now } = {}) {
    this.cfg = cfg.auth; this.fetch = fetchImpl; this.now = now;
    this.cache = new Map(); // sha(token) → { user, until }
  }

  /** @returns {Promise<{id:string,email?:string}|null>} null only when auth is off/optional and no token was sent */
  async authenticate(req) {
    const mode = this.cfg.mode;
    if (mode === 'off') return null;
    const token = bearerOf(req);
    if (!token) {
      if (mode === 'optional') return null;
      throw new HttpError(401, 'Please sign in again to use the assistant.', { code: 'auth_required' });
    }
    const exp = jwtExp(token);
    if (exp && exp < this.now()) throw new HttpError(401, 'Your session expired. Please sign in again.', { code: 'token_expired' });

    const key = sha(token);
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) { if (!hit.user) throw new HttpError(401, 'Please sign in again to use the assistant.', { code: 'bad_token' }); return hit.user; }

    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        res = await this.fetch(`${this.cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: this.cfg.supabaseKey, Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      } finally { clearTimeout(t); }
    } catch {
      if (this.cfg.failOpen) return null;
      throw new HttpError(503, 'The assistant is busy at the moment. Please wait a little and try again.', { code: 'auth_unreachable', retryAfter: 5 });
    }
    if (res.status === 401 || res.status === 403) {
      this._remember(key, null, 30000, exp);
      throw new HttpError(401, 'Please sign in again to use the assistant.', { code: 'bad_token' });
    }
    if (!res.ok) {
      if (this.cfg.failOpen) return null;
      throw new HttpError(503, 'The assistant is busy at the moment. Please wait a little and try again.', { code: 'auth_unreachable', retryAfter: 5 });
    }
    const j = await res.json().catch(() => null);
    if (!j?.id) throw new HttpError(401, 'Please sign in again to use the assistant.', { code: 'bad_token' });
    const user = { id: String(j.id), email: j.email };
    this._remember(key, user, 300000, exp);
    return user;
  }

  _remember(key, user, ttl, exp) {
    if (this.cache.size > 2000) this.cache.clear();
    const until = Math.min(this.now() + ttl, exp || Infinity);
    this.cache.set(key, { user, until });
  }
}
