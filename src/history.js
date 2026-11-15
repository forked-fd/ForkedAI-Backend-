// ═══════════════════════════════════════════════════════════════
// Conversation memory.
//  • In memory per server instance (fast, keeps attached-file text for follow-up questions).
//  • When Supabase is configured the saved conversation (chat_messages) is the source of truth, so context survives
//    cold starts, several serverless instances and page reloads: the backend reads it with the user's own token (RLS applies).
// ═══════════════════════════════════════════════════════════════

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID.test(s);
const MAX_STORED_CHARS = 120000;

export class HistoryStore {
  constructor(cfg, { fetchImpl = fetch, now = Date.now, log = () => {} } = {}) {
    this.cfg = cfg.history; this.auth = cfg.auth;
    this.fetch = fetchImpl; this.now = now; this.log = log;
    this.map = new Map(); // key → { messages:[{role,content}], at }
  }

  _key(owner, sessionId) { return `${owner}:${sessionId}`; }

  _prune() {
    const t = this.now();
    for (const [k, v] of this.map) if (t - v.at > this.cfg.ttlMs) this.map.delete(k);
    while (this.map.size > this.cfg.maxSessions) this.map.delete(this.map.keys().next().value);
  }

  memory(owner, sessionId) {
    const e = this.map.get(this._key(owner, sessionId));
    if (!e) return [];
    e.at = this.now();
    return e.messages;
  }

  append(owner, sessionId, turns) {
    this._prune();
    const k = this._key(owner, sessionId);
    const e = this.map.get(k) || { messages: [], at: 0 };
    for (const t of turns) if (t.content) e.messages.push({ role: t.role, content: t.content.slice(0, MAX_STORED_CHARS) });
    if (e.messages.length > this.cfg.maxMessages * 2) e.messages = e.messages.slice(-this.cfg.maxMessages * 2);
    e.at = this.now();
    this.map.delete(k); this.map.set(k, e); // keeps Map order = recency
  }

  clear(owner, sessionId) { this.map.delete(this._key(owner, sessionId)); }

  /** Messages saved by the web app for this conversation, oldest first. null when unavailable. */
  async _fromSupabase(sessionId, token) {
    if (!this.cfg.supabase || !token || !isUuid(sessionId)) return null;
    const url = `${this.auth.supabaseUrl}/rest/v1/chat_messages?conversation_id=eq.${sessionId}&select=role,body,info,error,files&order=created_at.desc,seq.desc&limit=${this.cfg.maxMessages + 2}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await this.fetch(url, { headers: { apikey: this.auth.supabaseKey, Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      if (!res.ok) { this.log('history: supabase', res.status); return null; }
      const rows = await res.json();
      if (!Array.isArray(rows)) return null;
      return rows.reverse();
    } catch (e) { this.log('history: supabase failed', e.message); return null; } finally { clearTimeout(t); }
  }

  /**
   * History to give the model for the *next* turn.
   * `currentTypedText` lets us drop the current user message if the web app already saved it before calling us.
   */
  async load({ owner, sessionId, token, currentText = '' }) {
    const mem = this.memory(owner, sessionId);
    const rows = await this._fromSupabase(sessionId, token);
    if (!rows) return mem.slice(-this.cfg.maxMessages);

    const out = [];
    for (const r of rows) {
      if (r.info || r.error) continue;
      const role = r.role === 'ai' ? 'assistant' : 'user';
      let body = String(r.body ?? '').trim();
      if (!body && role === 'user' && !(Array.isArray(r.files) && r.files.length)) continue;
      if (!body && role === 'assistant') continue;
      if (role === 'user') {
        // prefer the richer in-memory version (it still has the attached file text)
        const rich = body ? mem.find((m) => m.role === 'user' && m.content.startsWith(body) && m.content.length > body.length) : null;
        if (rich) body = rich.content;
        else if (Array.isArray(r.files) && r.files.length) {
          const names = r.files.map((f) => f?.name).filter(Boolean).join(', ');
          if (names) body += `${body ? '\n\n' : ''}[Attached earlier: ${names} — file contents are no longer available]`;
        }
      }
      out.push({ role, content: body });
    }
    // the web app may have saved the message we are answering right now
    const typed = String(currentText).trim();
    const last = out.at(-1);
    if (last?.role === 'user' && typed && (typed.startsWith(last.content.slice(0, 200)) || last.content.startsWith(typed.slice(0, 200)))) out.pop();
    return out.slice(-this.cfg.maxMessages);
  }
}
