// ═══════════════════════════════════════════════════════════════
// POST /chat — the main endpoint (SSE streaming or JSON, same contract the web app expects)
// ═══════════════════════════════════════════════════════════════
import { HttpError, SseWriter, sendJson, parseJson, parseMultipart, isMultipart, clientIp } from './http.js';
import { bearerOf } from './auth.js';
import { readUpload, buildFileBlocks } from './files.js';
import { StreamSanitizer } from './sanitize.js';
import { buildSystemPrompt } from './prompts.js';
import { estimateTokens, fitMessages } from './tokens.js';
import { raceFirstToken, RouteError } from './router.js';
import { streamCompletion } from './upstream.js';

const BUSY = 'The assistant is busy at the moment. Please wait a little and try again.';
const NO_REPLY = 'The assistant didn’t reply this time. Please try again.';
const CJK_ANY = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;
const DEFAULT_REVIEW = 'Please review the attached file(s) and tell me what they do and anything that looks wrong or can be improved.';

const cleanSession = (s) => (typeof s === 'string' && /^[\w.:-]{1,100}$/.test(s) ? s : 'default');

async function readRequest(req, cfg) {
  let message = '', sessionId = 'default', uploads = [];
  if (isMultipart(req)) {
    const { fields, files } = await parseMultipart(req, cfg.limits.maxBodyBytes);
    message = fields.message ?? ''; sessionId = fields.sessionId; uploads = files;
  } else {
    const body = await parseJson(req, cfg.limits.maxJsonBytes);
    message = body.message ?? ''; sessionId = body.sessionId;
  }
  if (typeof message !== 'string') throw new HttpError(400, 'Please type a message or attach a file.', { code: 'bad_message' });
  if (message.length > cfg.limits.maxMessageChars) throw new HttpError(413, 'That message is too long. Try fewer or smaller files.', { code: 'too_large' });
  if (uploads.length > cfg.limits.maxFiles) throw new HttpError(400, `You can attach up to ${cfg.limits.maxFiles} files.`, { code: 'too_many_files' });
  return { message: message.trim(), sessionId: cleanSession(sessionId), uploads };
}

export function prepareTurn({ message, uploads }, cfg) {
  const read = uploads.map((u) => readUpload(u, cfg.limits));
  const images = read.filter((f) => f.kind === 'image');
  const code = read.filter((f) => f.kind === 'code');
  if (!message && !read.length) throw new HttpError(400, 'Please type a message or attach a file.', { code: 'empty' });

  let text = message || (code.length ? DEFAULT_REVIEW : images.length ? 'Describe this image.' : '');
  if (code.length) text += `\n\nAttached files (${code.length}):\n\n${buildFileBlocks(code, cfg.limits).join('\n\n')}`;
  return { text, images: images.map((i) => i.dataUrl), imageNames: images.map((i) => i.name) };
}

function toUserContent(text, images, { visionOk }) {
  if (!images.length) return text;
  if (!visionOk) return `${text}\n\n(The user attached ${images.length} image(s), but image reading is temporarily unavailable. If the image is essential, say so briefly and ask them to describe it.)`;
  return [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

export async function handleChat(req, res, deps, headers) {
  const { cfg, registry, auth, limiter, history, log } = deps;
  const user = await auth.authenticate(req);
  const release = limiter.take({ userId: user?.id, ip: clientIp(req, cfg.trustProxy) });
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  try {
    const parsed = await readRequest(req, cfg);
    const turn = prepareTurn(parsed, cfg);
    const url = new URL(req.url, 'http://x');
    const wantsSse = /text\/event-stream/i.test(String(req.headers.accept || '')) && url.searchParams.get('stream') !== '0';
    const fast = parsed.sessionId.startsWith('enhance-');
    const owner = user?.id || `anon:${clientIp(req, cfg.trustProxy)}`;

    const prior = fast ? [] : await history.load({ owner, sessionId: parsed.sessionId, token: bearerOf(req), currentText: parsed.message });
    await registry.ensureDiscovered(1500);

    const system = buildSystemPrompt({ override: cfg.systemPrompt, append: cfg.systemPromptAppend, profile: fast ? 'fast' : 'chat' });
    const needTokens = estimateTokens(turn.text) + estimateTokens(system) + 300;
    const hasImages = turn.images.length > 0;

    const open = (visionOk) => async function* openCandidate(c, signal) {
      const maxTokens = fast ? 400 : Math.min(cfg.maxTokens, Math.max(512, Math.floor(c.budget * 0.35)));
      const { messages } = fitMessages({ system, history: prior, user: toUserContent(turn.text, turn.images, { visionOk }), budgetTokens: c.budget, reserveTokens: maxTokens, maxHistory: cfg.history.maxMessages });
      const base = {
        baseUrl: c.provider.baseUrl, apiKey: c.key, model: c.model, messages, signal,
        temperature: fast ? 0.7 : cfg.temperature, maxTokens,
        headers: c.provider.id === 'openrouter' ? { 'HTTP-Referer': cfg.cors.origins[0] || 'https://forked.app', 'X-Title': 'Forked AI' } : {},
        firstTokenMs: cfg.timing.firstTokenMs, idleMs: cfg.timing.idleMs, fetchImpl: deps.fetchImpl,
      };
      const extra = c.provider.extraBody(c.model);
      let yielded = false;
      try {
        for await (const d of streamCompletion({ ...base, extraBody: extra })) { yielded = true; yield d; }
      } catch (e) {
        if (e.kind === 'bad_request' && !yielded && Object.keys(extra).length) { yield* streamCompletion({ ...base, extraBody: {} }); } else throw e;
      }
    };

    const route = (vision) => {
      const cands = registry.candidates({ vision, fast });
      const fits = cands.filter((c) => c.budget >= needTokens);
      return raceFirstToken({
        candidates: fits.length ? [...fits, ...cands.filter((c) => c.budget < needTokens)] : cands,
        open: open(vision || !hasImages), isCooling: (c) => registry.isCooling(c),
        hedgeMs: cfg.timing.hedgeMs, maxParallel: cfg.timing.maxParallel, maxAttempts: cfg.timing.maxAttempts, deadlineMs: cfg.timing.deadlineMs,
        signal: abort.signal,
        onResult: (c, err, ms) => { if (err) { registry.onFailure(c, err); log('fail', c.provider.id, c.model, err.kind, err.message); } else { registry.onSuccess(c, ms); log('ok', c.provider.id, c.model, `${ms}ms`); } },
      });
    };

    let winner;
    try {
      try { winner = await route(hasImages); } catch (e) {
        if (!(e instanceof RouteError) || e.aborted || !hasImages) throw e;
        winner = await route(false); // no vision model answered: still answer the text part
      }
    } catch (e) {
      if (!(e instanceof RouteError)) throw e;
      if (e.aborted) return;
      log('route failed', e.kind, e.errors.map((x) => `${x.candidate.provider.id}/${x.candidate.model}:${x.err.kind}`).join(' '));
      if (e.kind === 'context') throw new HttpError(413, 'Your message or files are too large for the assistant right now. Try fewer or smaller files.', { code: 'too_large' });
      throw new HttpError(503, BUSY, { code: 'busy', retryAfter: 10 });
    }

    const sanitizer = new StreamSanitizer({ stripCjk: cfg.stripCjk && !CJK_ANY.test(turn.text) });
    let answer = '';
    const userStored = turn.text + (hasImages ? `\n\n[${turn.images.length} image(s) attached: ${turn.imageNames.join(', ')}]` : '');
    const finish = () => { if (!fast && answer.trim()) history.append(owner, parsed.sessionId, [{ role: 'user', content: userStored }, { role: 'assistant', content: answer }]); };

    if (wantsSse) {
      const sse = new SseWriter(res, headers);
      try {
        for await (const d of winner.stream) { const out = sanitizer.push(d); answer += out; sse.delta(out); }
        const tail = sanitizer.end(); answer += tail; sse.delta(tail);
        if (!answer.trim()) { sse.error(NO_REPLY); sse.close(); return; }
        sse.done();
      } catch (e) {
        if (e?.name !== 'AbortError') { log('stream error', e.kind || '', e.message); sse.error(answer.trim() ? 'The answer was cut short. Please try again.' : NO_REPLY); }
        sse.close();
      }
      finish();
      return;
    }

    try {
      for await (const d of winner.stream) answer += sanitizer.push(d);
      answer += sanitizer.end();
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (!answer.trim()) throw new HttpError(503, BUSY, { code: 'busy', retryAfter: 10 });
    }
    answer = answer.trim();
    if (!answer) throw new HttpError(502, NO_REPLY, { code: 'empty' });
    finish();
    sendJson(res, 200, { success: true, data: { response: answer }, sessionId: parsed.sessionId }, headers);
  } finally {
    release();
  }
}
