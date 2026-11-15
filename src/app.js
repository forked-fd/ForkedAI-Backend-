// ═══════════════════════════════════════════════════════════════
// Router + shared wiring
// ═══════════════════════════════════════════════════════════════
import { HttpError, sendJson, sendError, corsHeaders, originAllowed, parseJson, parseMultipart, clientIp } from './http.js';
import { Auth } from './auth.js';
import { RateLimiter } from './ratelimit.js';
import { HistoryStore } from './history.js';
import { ModelRegistry } from './models.js';
import { handleChat } from './chat.js';
import { transcribe } from './audio.js';

export const VERSION = '3.0.0';

export function buildDeps(cfg, { fetchImpl = fetch, log } = {}) {
  const logger = log || ((...a) => { if (process.env.LOG_LEVEL !== 'silent') console.log('[forked-ai]', ...a); });
  return {
    cfg, fetchImpl, log: logger,
    registry: new ModelRegistry(cfg, { fetchImpl, log: logger }),
    auth: new Auth(cfg, { fetchImpl }),
    limiter: new RateLimiter(cfg.rate),
    history: new HistoryStore(cfg, { fetchImpl, log: logger }),
  };
}

export function createApp(deps) {
  const { cfg, registry, auth, history, limiter } = deps;

  return async function handler(req, res) {
    const headers = corsHeaders(req, cfg.cors);
    try {
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin, cfg.cors)) throw new HttpError(403, 'This website is not allowed to use the assistant.', { code: 'origin_blocked' });

      if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }

      const url = new URL(req.url, 'http://x');
      let path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/api') path = '/';
      else if (path.startsWith('/api/')) path = path.slice(4);

      if (req.method === 'GET' && path === '/') {
        return sendJson(res, 200, { name: 'Forked AI API', version: VERSION, status: 'running', streaming: true, endpoints: ['POST /api/chat', 'POST /api/chat/clear', 'GET /api/chat/history/:sessionId', 'POST /api/upload/audio', 'GET /api/health'] }, headers);
      }

      if (req.method === 'GET' && path === '/health') {
        void registry.ensureDiscovered(0);
        const detail = !!cfg.healthToken && url.searchParams.get('token') === cfg.healthToken;
        return sendJson(res, 200, {
          status: cfg.providers.length ? 'ok' : 'degraded', service: 'forked-ai-api', version: VERSION, time: new Date().toISOString(),
          streaming: true, auth: cfg.auth.mode, providers: registry.status({ detail }),
          ...(cfg.providers.length ? {} : { warning: 'No AI provider keys are configured.' }),
        }, headers);
      }

      if (req.method === 'POST' && path === '/chat') return await handleChat(req, res, deps, headers);

      if (req.method === 'POST' && path === '/chat/clear') {
        const user = await auth.authenticate(req);
        const body = await parseJson(req, 64 * 1024);
        const sid = typeof body.sessionId === 'string' ? body.sessionId : 'default';
        history.clear(user?.id || `anon:${clientIp(req, cfg.trustProxy)}`, sid);
        return sendJson(res, 200, { success: true, message: 'Conversation history cleared', sessionId: sid }, headers);
      }

      if (req.method === 'GET' && (path === '/chat/history' || path.startsWith('/chat/history/'))) {
        const user = await auth.authenticate(req);
        const sid = decodeURIComponent(path.slice('/chat/history/'.length) || url.searchParams.get('sessionId') || 'default');
        return sendJson(res, 200, { success: true, data: history.memory(user?.id || `anon:${clientIp(req, cfg.trustProxy)}`, sid), sessionId: sid }, headers);
      }

      if (req.method === 'POST' && path === '/upload/audio') {
        const user = await auth.authenticate(req);
        const release = limiter.take({ userId: user?.id, ip: clientIp(req, cfg.trustProxy) });
        try {
          const { files } = await parseMultipart(req, cfg.limits.maxAudioBytes + 1024 * 1024);
          const f = files.find((x) => x.field === 'audio') || files[0];
          if (!f) throw new HttpError(400, 'Audio recording is required.', { code: 'no_audio' });
          if (f.buffer.length > cfg.limits.maxAudioBytes) throw new HttpError(413, 'That recording is too long.', { code: 'too_large' });
          const data = await transcribe({ buffer: f.buffer, mimeType: f.mime }, cfg.deepgram, deps.fetchImpl);
          return sendJson(res, 200, { success: true, transcript: data.transcript, data }, headers);
        } finally { release(); }
      }

      throw new HttpError(404, `Cannot ${req.method} ${url.pathname}`, { code: 'not_found' });
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
      if (e instanceof HttpError) return sendError(res, e, headers);
      deps.log('unhandled', e?.stack || e);
      return sendError(res, new HttpError(500, 'Something went wrong on our side. Please try again.'), headers);
    }
  };
}

export function buildApp(cfg, opts) {
  const deps = buildDeps(cfg, opts);
  return { deps, handler: createApp(deps) };
}
