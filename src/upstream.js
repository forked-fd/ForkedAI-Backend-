// ═══════════════════════════════════════════════════════════════
// OpenAI-compatible streaming client + error classification
// ═══════════════════════════════════════════════════════════════

export class UpstreamError extends Error {
  /** kind: rate | auth | model | context | transient | bad_request | empty | timeout */
  constructor(message, { kind = 'transient', status = 0, cooldownMs = 0, limit = 0, daily = false } = {}) {
    super(message);
    this.name = 'UpstreamError';
    Object.assign(this, { kind, status, cooldownMs, limit, daily });
  }
}

const MODEL_GONE = /(not found|does not exist|decommission|deprecat|no longer|retired|not supported|unavailable|invalid model|unknown model|model_not_found)/;

function messageOf(text) {
  try {
    const j = JSON.parse(text);
    return String(j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? text).slice(0, 400);
  } catch { return String(text).slice(0, 400); }
}

function retryAfterMs(headers, msg) {
  const h = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(h) && h > 0) return Math.min(h * 1000, 300000);
  const m = /try again in\s+(?:(\d+(?:\.\d+)?)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*(ms|s))?/i.exec(msg);
  if (m && (m[1] || m[2])) {
    const mins = m[1] ? Number(m[1]) * 60000 : 0;
    const rest = m[2] ? Number(m[2]) * (m[3] === 'ms' ? 1 : 1000) : 0;
    return Math.min(mins + rest, 300000);
  }
  return 0;
}

export function classifyHttp(status, text, headers) {
  const msg = messageOf(text);
  const low = msg.toLowerCase();
  const limit = Number((/limit\s+(\d{3,})/i.exec(msg) || [])[1]) || 0;
  const opts = { status, limit };
  if (status === 401 || status === 403) return new UpstreamError(msg, { ...opts, kind: 'auth', cooldownMs: 600000 });
  if (status === 402) return new UpstreamError(msg, { ...opts, kind: 'auth', cooldownMs: 1800000 });
  if (status === 404 || (status === 400 && /model/.test(low) && MODEL_GONE.test(low))) return new UpstreamError(msg, { ...opts, kind: 'model', cooldownMs: 6 * 3600000 });
  if (status === 413 || ((status === 400) && /(context|too large|too long|maximum (?:context|prompt)|reduce the length|tokens)/.test(low))) {
    return new UpstreamError(msg, { ...opts, kind: 'context' });
  }
  if (status === 429 || /(rate.?limit|quota|resource_exhausted|overloaded|capacity|too many requests)/.test(low)) {
    const daily = /(per day|daily|\btpd\b|\brpd\b)/.test(low);
    return new UpstreamError(msg, { ...opts, kind: 'rate', daily, cooldownMs: daily ? 1800000 : retryAfterMs(headers, msg) || 8000 });
  }
  if (status >= 500) return new UpstreamError(msg, { ...opts, kind: 'transient', cooldownMs: 10000 });
  return new UpstreamError(msg, { ...opts, kind: 'bad_request', cooldownMs: 0 });
}

function contentOf(delta) {
  const c = delta?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/**
 * Streams one completion. Yields content deltas only (reasoning fields are ignored).
 * Aborts the HTTP request when the consumer stops iterating or `signal` fires.
 */
export async function* streamCompletion({
  baseUrl, apiKey, model, messages, temperature, maxTokens, extraBody = {}, headers = {},
  signal, firstTokenMs = 20000, idleMs = 25000, fetchImpl = fetch,
}) {
  const ctrl = new AbortController();
  let reason = '';
  let timer;
  const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => { reason = why; ctrl.abort(); }, ms); };
  const onAbort = () => { reason ||= 'client'; ctrl.abort(); };
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  arm(firstTokenMs, 'first-token');

  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${apiKey}`, ...headers },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true, ...extraBody }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw classifyHttp(res.status, await res.text().catch(() => ''), res.headers);

    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('event-stream')) { // some gateways ignore stream:true
      const json = await res.json().catch(() => null);
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text) yield text;
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let gotToken = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json?.error) throw classifyHttp(Number(json.error.code) || 500, JSON.stringify(json), res.headers);
        const text = contentOf(json?.choices?.[0]?.delta);
        if (text) { gotToken = true; arm(idleMs, 'idle'); yield text; }
        else if (gotToken) arm(idleMs, 'idle'); // keep-alive / reasoning frames count as life only after the first token
        if (json?.choices?.[0]?.finish_reason && gotToken && !contentOf(json?.choices?.[0]?.delta)) { /* let [DONE] or EOF end it */ }
      }
    }
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (reason === 'client') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (reason) throw new UpstreamError(`no response (${reason})`, { kind: 'timeout', cooldownMs: 10000 });
    throw new UpstreamError(`network: ${e?.cause?.code || e?.message || 'failed'}`, { kind: 'transient', cooldownMs: 10000 });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    ctrl.abort();
  }
}
