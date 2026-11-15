// ═══════════════════════════════════════════════════════════════
// Small HTTP helpers on plain node:http objects (no framework)
// ═══════════════════════════════════════════════════════════════
export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.name = 'HttpError'; this.status = status; this.extra = extra; }
}

export function clientIp(req, trustProxy = true) {
  if (trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ─── CORS ───────────────────────────────────────────────────
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
export function originAllowed(origin, cors) {
  if (!origin) return true;
  if (!cors.origins.length) return true; // Bearer-token API (no cookies): open CORS is safe, auth is what protects it
  for (const o of cors.origins) {
    if (o === '*' || o === origin) return true;
    if (o.includes('*') && new RegExp(`^${o.split('*').map(escapeRe).join('[^.]+(?:\\.[^.]+)*')}$`).test(origin)) return true;
  }
  return cors.allowLocalhost && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function corsHeaders(req, cors) {
  const origin = req.headers.origin;
  const h = { Vary: 'Origin' };
  if (origin && originAllowed(origin, cors)) {
    h['Access-Control-Allow-Origin'] = cors.origins.length ? origin : '*';
    h['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Accept, X-Requested-With';
    h['Access-Control-Expose-Headers'] = 'Retry-After';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

// ─── responses ──────────────────────────────────────────────
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

export function sendError(res, err, headers = {}) {
  const status = err.status || 500;
  const extra = { ...(err.extra || {}) };
  const hdr = { ...headers };
  if (extra.retryAfter) { hdr['Retry-After'] = String(extra.retryAfter); delete extra.retryAfter; }
  sendJson(res, status, { success: false, error: err.code || (status >= 500 ? 'server_error' : 'bad_request'), message: err.message, ...extra }, hdr);
}

export class SseWriter {
  constructor(res, headers = {}) {
    this.res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.flushHeaders?.();
    this.open = true;
  }
  write(str) { if (this.open && !this.res.writableEnded && !this.res.destroyed) this.res.write(str); }
  delta(text) { if (text) this.write(`data: ${JSON.stringify({ delta: text })}\n\n`); }
  error(message) { this.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`); }
  done() { this.write('data: [DONE]\n\n'); this.close(); }
  close() { if (this.open) { this.open = false; if (!this.res.writableEnded) this.res.end(); } }
}

// ─── bodies ─────────────────────────────────────────────────
export async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'That upload is too large. Try fewer or smaller files.', { code: 'too_large' });
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) { req.destroy?.(); throw new HttpError(413, 'That upload is too large. Try fewer or smaller files.', { code: 'too_large' }); }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Parses multipart/form-data with the platform's own parser (undici). Returns { fields, files:[{field,name,mime,buffer}] }. */
export async function parseMultipart(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  let form;
  try {
    form = await new Response(buf, { headers: { 'content-type': req.headers['content-type'] } }).formData();
  } catch {
    throw new HttpError(400, 'The upload could not be read. Please try again.', { code: 'bad_multipart' });
  }
  const fields = {};
  const files = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
    else files.push({ field: key, name: value.name || 'file', mime: value.type || '', buffer: Buffer.from(await value.arrayBuffer()) });
  }
  return { fields, files };
}

export async function parseJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'The request was not valid. Please try again.', { code: 'bad_json' });
  }
}

export const isMultipart = (req) => /^multipart\/form-data/i.test(String(req.headers['content-type'] || ''));
