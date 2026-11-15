import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import module from 'node:module';
import { fakeProvider, provider } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// ─── the REAL frontend stream parser, loaded from the web app's own source ───
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-'));
const strip = (f) => module.stripTypeScriptTypes(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
fs.writeFileSync(path.join(dir, 'friendly.mjs'), strip('friendly.ts.txt'));
fs.writeFileSync(path.join(dir, 'stream.mjs'), `import { FRIENDLY, friendlyError } from './friendly.mjs';
class BotError extends Error { constructor(code, message) { super(message); this.code = code; } }
${strip('botApi-stream.ts.txt')}
export { consumeStream, BotError };`);
const { consumeStream, BotError } = await import(path.join(dir, 'stream.mjs'));
const { looksTechnical } = await import(path.join(dir, 'friendly.mjs'));

// ─── harness ───
async function fakeSupabase({ users = { good: { id: 'u1', email: 'a@b.c' } }, rows = [] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    const tok = String(req.headers.authorization || '').replace('Bearer ', '');
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/auth/v1/user')) { if (users[tok]) return res.end(JSON.stringify(users[tok])); res.statusCode = 401; return res.end('{"msg":"bad"}'); }
    if (req.url.startsWith('/rest/v1/chat_messages')) { if (!users[tok]) { res.statusCode = 401; return res.end('[]'); } return res.end(JSON.stringify([...rows].reverse())); } // PostgREST: newest first (order=created_at.desc)
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

async function boot({ providers, env = {}, supabase } = {}) {
  const cfg = loadConfig({ GROQ_API_KEYS: 'x', ...env, ...(supabase ? { SUPABASE_URL: supabase.url, SUPABASE_ANON_KEY: 'anon' } : {}) });
  cfg.providers = providers;
  cfg.timing = { ...cfg.timing, hedgeMs: 400, firstTokenMs: 2000, deadlineMs: 5000 };
  const { handler, deps } = buildApp(cfg, { log: () => {} });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/api`, deps, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}
const post = (b, body, headers = {}) => fetch(`${b.url}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const SSE = { Accept: 'text/event-stream, application/x-ndjson;q=0.9, application/json;q=0.8' };

test('SSE stream is understood by the web app\'s own parser; deltas arrive incrementally', async () => {
  const p = await fakeProvider(() => ({ tokens: ['Hel', 'lo ', 'wor', 'ld'], tokenDelayMs: 40 }));
  const b = await boot({ providers: [provider('a', p.url)] });
  const res = await post(b, { message: 'hi', sessionId: 's1' }, SSE);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  const deltas = []; const times = [];
  const text = await consumeStream(res, 'sse', (c) => { deltas.push(c); times.push(Date.now()); }, () => {});
  assert.equal(text, 'Hello world');
  assert.ok(deltas.length >= 3, `streamed in ${deltas.length} pieces`);
  assert.ok(times.at(-1) - times[0] >= 80, 'pieces arrive over time, not at the end');
  await b.close(); await p.close();
});

test('JSON mode keeps the old contract { success, data: { response } } and sanitizes', async () => {
  const p = await fakeProvider(() => ({ tokens: ['<think>plan</think>', 'Use <b>this</b>', '<br>', 'and `<div>`'] }));
  const b = await boot({ providers: [provider('a', p.url)] });
  const body = await (await post(b, { message: 'hi', sessionId: 's2' })).json();
  assert.equal(body.success, true);
  assert.equal(body.data.response, 'Use this\nand `<div>`');
  assert.equal(JSON.stringify(body).includes('provider'), false);
  await b.close(); await p.close();
});

test('conversation memory: follow-up questions carry the previous turns', async () => {
  const p = await fakeProvider((body) => ({ tokens: [`turn${body.messages.length}`] }));
  const b = await boot({ providers: [provider('a', p.url)] });
  await (await post(b, { message: 'my name is Sam', sessionId: 'mem1' })).json();
  await (await post(b, { message: 'what is my name?', sessionId: 'mem1' })).json();
  const second = p.calls.at(-1).body.messages;
  assert.deepEqual(second.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(second[1].content, 'my name is Sam');
  const hist = await (await fetch(`${b.url}/chat/history/mem1`)).json();
  assert.equal(hist.data.length, 4);
  await fetch(`${b.url}/chat/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'mem1' }) });
  assert.equal((await (await fetch(`${b.url}/chat/history/mem1`)).json()).data.length, 0);
  await b.close(); await p.close();
});

test('auth: missing/invalid token → 401, valid Supabase token → answer; context is rebuilt from Supabase on a cold instance', async () => {
  const conv = '11111111-2222-4333-8444-555555555555';
  const sb = await fakeSupabase({ rows: [
    { role: 'user', body: 'earlier question', info: false, error: false, files: null },
    { role: 'ai', body: 'earlier answer', info: false, error: false, files: null },
    { role: 'user', body: 'second one', info: false, error: false, files: [{ name: 'app.py' }] },
    { role: 'ai', body: 'oops', info: false, error: true, files: null },
    { role: 'user', body: 'now this', info: false, error: false, files: null }, // current message, already saved by the web app
  ] });
  const p = await fakeProvider(() => ({ tokens: ['ok'] }));
  const b = await boot({ providers: [provider('a', p.url)], supabase: sb });
  assert.equal((await post(b, { message: 'hi', sessionId: conv })).status, 401);
  assert.equal((await post(b, { message: 'hi', sessionId: conv }, { Authorization: 'Bearer nope' })).status, 401);
  const ok = await post(b, { message: 'now this', sessionId: conv }, { Authorization: 'Bearer good' });
  assert.equal(ok.status, 200);
  const msgs = p.calls.at(-1).body.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'user']);
  assert.equal(msgs.at(-1).content, 'now this');
  assert.match(msgs[3].content, /Attached earlier: app\.py/);
  await post(b, { message: 'again', sessionId: conv }, { Authorization: 'Bearer good' });
  assert.equal(sb.calls.filter((u) => u.startsWith('/auth/v1/user')).length, 2, 'token verified once per distinct token (cached)');
  await b.close(); await p.close(); await sb.close();
});

test('uploads: code files are read into the prompt; images go to vision models; text-only fallback when none', async () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30)]);
  const vis = await fakeProvider(() => ({ tokens: ['saw it'] }));
  const txt = await fakeProvider(() => ({ tokens: ['text only'] }));
  const b = await boot({ providers: [provider('txt', txt.url, { preferred: ['plain-model'] }), provider('vis', vis.url, { preferred: ['llama-4-vision'] })] });
  const fd = new FormData();
  fd.append('message', 'explain'); fd.append('sessionId', 'up1');
  fd.append('files', new File([PNG], 'shot.png', { type: 'image/png' }));
  fd.append('files', new File(['fn main() {}'], 'main.rs', { type: 'application/octet-stream' }));
  const r = await (await fetch(`${b.url}/chat`, { method: 'POST', body: fd })).json();
  assert.equal(r.data.response, 'saw it');
  assert.equal(txt.calls.length, 0, 'text-only model skipped for an image request');
  const user = vis.calls[0].body.messages.at(-1).content;
  assert.equal(user[0].type, 'text'); assert.match(user[0].text, /\[File 1: main\.rs — Rust, 1 lines\]/); assert.equal(user[1].type, 'image_url');
  await b.close(); await vis.close();

  const b2 = await boot({ providers: [provider('txt', txt.url, { preferred: ['plain-model'] })] });
  const fd2 = new FormData(); fd2.append('message', 'what is this'); fd2.append('files', new File([PNG], 'shot.png', { type: 'image/png' }));
  const r2 = await (await fetch(`${b2.url}/chat`, { method: 'POST', body: fd2 })).json();
  assert.equal(r2.data.response, 'text only');
  assert.match(txt.calls.at(-1).body.messages.at(-1).content, /image reading is temporarily unavailable/);
  await b2.close(); await txt.close();
});

test('bad uploads get friendly 4xx errors (binary, unsupported image, too many files)', async () => {
  const p = await fakeProvider(() => ({}));
  const b = await boot({ providers: [provider('a', p.url)] });
  const send = async (files) => { const fd = new FormData(); fd.append('message', 'x'); for (const f of files) fd.append('files', f); const r = await fetch(`${b.url}/chat`, { method: 'POST', body: fd }); return [r.status, (await r.json()).message]; };
  const [s1, m1] = await send([new File(['%PDF-1.4 ...'], 'a.pdf', { type: 'application/pdf' })]);
  assert.equal(s1, 415); assert.match(m1, /PDF/); assert.equal(looksTechnical(m1), false);
  const [s2] = await send([new File(['ftypavif'], 'a.avif', { type: 'image/avif' })]);
  assert.equal(s2, 415);
  const [s3] = await send(Array.from({ length: 9 }, (_, i) => new File(['x'], `f${i}.js`)));
  assert.equal(s3, 400);
  assert.equal(p.calls.length, 0);
  await b.close(); await p.close();
});

test('enhance-* sessions: no history, short answers, small max_tokens', async () => {
  const p = await fakeProvider(() => ({ tokens: ['a better prompt'] }));
  const b = await boot({ providers: [provider('a', p.url)] });
  await post(b, { message: 'first', sessionId: 'enhance-1' });
  await post(b, { message: 'second', sessionId: 'enhance-1' });
  const body = p.calls.at(-1).body;
  assert.equal(body.messages.length, 2);
  assert.equal(body.max_tokens, 400);
  await b.close(); await p.close();
});

test('errors are friendly: all providers down → 503 without provider names; rate limiter → 429 + Retry-After', async () => {
  const p = await fakeProvider(() => ({ status: 500, message: 'groq internal explosion' }));
  const b = await boot({ providers: [provider('groq', p.url)], env: { RATE_LIMIT_PER_MIN_IP: '3' } });
  const r = await post(b, { message: 'hi', sessionId: 'e1' });
  const body = await r.json();
  assert.equal(r.status, 503); assert.equal(body.success, false);
  assert.equal(looksTechnical(body.message), false); assert.doesNotMatch(JSON.stringify(body), /groq|explosion/i);
  await post(b, { message: 'hi' }); await post(b, { message: 'hi' });
  const limited = await post(b, { message: 'hi' });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  await b.close(); await p.close();
});

test('validation: bad JSON, empty message, unknown route, CORS preflight and blocked origins', async () => {
  const p = await fakeProvider(() => ({}));
  const b = await boot({ providers: [provider('a', p.url)], env: { CORS_ORIGINS: 'https://app.example.com,https://*.vercel.app' } });
  assert.equal((await fetch(`${b.url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await post(b, { message: '   ' })).status, 400);
  assert.equal((await fetch(`${b.url}/nothing`)).status, 404);
  const pre = await fetch(`${b.url}/chat`, { method: 'OPTIONS', headers: { Origin: 'https://forked-learn-git-x.vercel.app', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://forked-learn-git-x.vercel.app');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/i);
  const bad = await fetch(`${b.url}/chat`, { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"message":"x"}' });
  assert.equal(bad.status, 403);
  await b.close(); await p.close();
});

test('closing the browser tab cancels the upstream request', async () => {
  const p = await fakeProvider(() => ({ tokens: Array.from({ length: 200 }, (_, i) => `t${i} `), tokenDelayMs: 20 }));
  const b = await boot({ providers: [provider('a', p.url)] });
  const ctrl = new AbortController();
  const res = await post(b, { message: 'long answer', sessionId: 'c1' }, { ...SSE });
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(p.closed >= 1, 'provider saw the connection close');
  void ctrl;
  await b.close(); await p.close();
});

test('health is public but does not leak model lists or keys', async () => {
  const p = await fakeProvider(() => ({}));
  const b = await boot({ providers: [provider('a', p.url)] });
  const h = await (await fetch(`${b.url}/health`)).json();
  assert.equal(h.status, 'ok'); assert.equal(h.streaming, true);
  assert.equal(JSON.stringify(h).includes('m1'), false);
  await b.close(); await p.close();
});
