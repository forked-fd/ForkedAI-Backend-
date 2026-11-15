import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeProvider, collect, provider, baseConfig } from './helpers.js';
import { ModelRegistry, pickGeneric } from '../src/models.js';
import { raceFirstToken, RouteError } from '../src/router.js';
import { streamCompletion } from '../src/upstream.js';

function setup(registry, timing = {}) {
  const t = { ...registry.cfg.timing, ...timing };
  const open = (c, signal) => streamCompletion({ baseUrl: c.provider.baseUrl, apiKey: c.key, model: c.model, messages: [{ role: 'user', content: 'hi' }], temperature: 0.5, maxTokens: 50, extraBody: c.provider.extraBody(c.model), signal, firstTokenMs: t.firstTokenMs, idleMs: t.idleMs });
  const run = (opts = {}) => raceFirstToken({ candidates: registry.candidates(opts.cand), open, isCooling: (c) => registry.isCooling(c), hedgeMs: t.hedgeMs, deadlineMs: t.deadlineMs, onResult: (c, err, ms) => (err ? registry.onFailure(c, err) : registry.onSuccess(c, ms)), ...opts.race });
  return run;
}

test('streams content deltas and ignores reasoning deltas', async () => {
  const p = await fakeProvider(() => ({ reasoning: ['thinking…'], tokens: ['A', 'B', 'C'] }));
  const reg = new ModelRegistry(baseConfig([provider('a', p.url)]));
  const w = await setup(reg)();
  assert.equal(w.first, 'A');
  assert.equal(await collect(w.stream), 'ABC'); // stream() re-yields the first delta, then the rest
  await p.close();
});

test('fails over instantly on 404 model, disables it, and learns nothing wrong about the key', async () => {
  const dead = await fakeProvider(() => ({ status: 404, message: 'The model `m1` has been decommissioned' }));
  const ok = await fakeProvider(() => ({ tokens: ['fine'] }));
  const reg = new ModelRegistry(baseConfig([provider('dead', dead.url), provider('ok', ok.url)]));
  const t0 = Date.now();
  const w = await setup(reg)();
  assert.ok(Date.now() - t0 < 500);
  assert.equal(w.candidate.provider.id, 'ok');
  assert.equal(await collect(w.stream), 'fine');
  // second request skips the dead model entirely (no call made)
  const before = dead.calls.length;
  await setup(reg)();
  assert.equal(dead.calls.length, before);
  await dead.close(); await ok.close();
});

test('rate limit (429 with retry hint) cools down only that key; next key is used', async () => {
  let n = 0;
  const p = await fakeProvider((body, req) => (req.headers.authorization === 'Bearer k1' ? { status: 429, message: 'Rate limit reached. Please try again in 2s', headers: { 'retry-after': '2' } } : { tokens: ['second key'] }));
  const reg = new ModelRegistry(baseConfig([provider('a', p.url, { keys: ['k1', 'k2'] })]));
  const w = await setup(reg)();
  assert.equal(w.first, 'second key');
  assert.equal(reg.candidates().some((c) => c.keyIndex === 0), false);
  assert.equal(reg.candidates().some((c) => c.keyIndex === 1), true);
  void n;
  await p.close();
});

test('hedging: a slow first model does not block a fast second one', async () => {
  const slow = await fakeProvider(() => ({ delayMs: 1500, tokens: ['slow'] }));
  const fast = await fakeProvider(() => ({ tokens: ['fast'] }));
  const reg = new ModelRegistry(baseConfig([provider('slow', slow.url), provider('fast', fast.url)]));
  const t0 = Date.now();
  const w = await setup(reg)();
  const dt = Date.now() - t0;
  assert.equal(w.first, 'fast');
  assert.ok(dt >= 250 && dt < 900, `took ${dt}`);
  await slow.close(); await fast.close();
});

test('hung provider hits the first-token timeout and the next one answers', async () => {
  const hung = await fakeProvider(() => ({ hang: true }));
  const ok = await fakeProvider(() => ({ tokens: ['ok'] }));
  const reg = new ModelRegistry(baseConfig([provider('hung', hung.url), provider('ok', ok.url)]));
  const w = await setup(reg, { firstTokenMs: 400, hedgeMs: 5000 })();
  assert.equal(w.first, 'ok');
  await hung.close(); await ok.close();
});

test('context errors learn the model limit and are reported as such when everything fails', async () => {
  const p = await fakeProvider(() => ({ status: 413, message: 'Request too large for model on tokens per minute (TPM): Limit 8000, Requested 12000' }));
  const reg = new ModelRegistry(baseConfig([provider('a', p.url)]));
  await assert.rejects(setup(reg)(), (e) => e instanceof RouteError && e.kind === 'context');
  assert.equal(reg.budgetFor(reg.providers[0], 'm1'), 6800);
  await p.close();
});

test('all rate-limited → RouteError kind=rate; client abort → aborted', async () => {
  const p = await fakeProvider(() => ({ status: 429, message: 'rate limit' }));
  const reg = new ModelRegistry(baseConfig([provider('a', p.url)]));
  await assert.rejects(setup(reg)(), (e) => e.kind === 'rate');
  await p.close();
  const slow = await fakeProvider(() => ({ hang: true }));
  const reg2 = new ModelRegistry(baseConfig([provider('s', slow.url)]));
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  await assert.rejects(setup(reg2, { firstTokenMs: 3000 })({ race: { signal: ctrl.signal } }), (e) => e.aborted === true);
  await slow.close();
});

test('discovery: preferred names are intersected with the real /models list; generic fallback picks chat models', async () => {
  const p = await fakeProvider(() => ({}), { models: ['openai/gpt-oss-120b', 'whisper-large-v3', 'llama-guard', 'qwen/qwen3.6-27b'] });
  const reg = new ModelRegistry(baseConfig([provider('g', p.url, { preferred: ['gone-model', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b'] })]));
  await reg.ensureDiscovered(2000);
  assert.deepEqual(reg.modelsFor(reg.providers[0]), ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b']);
  const reg2 = new ModelRegistry(baseConfig([provider('g', p.url, { preferred: ['renamed-model'] })]));
  await reg2.ensureDiscovered(2000);
  assert.deepEqual(reg2.modelsFor(reg2.providers[0]), ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b']);
  assert.deepEqual(pickGeneric([{ id: 'x-embed-1' }, { id: 'foo-instruct' }]), ['foo-instruct']);
  await p.close();
});

test('OpenRouter-style free discovery uses pricing and image modality', async () => {
  const p = await fakeProvider(() => ({}), { models: [
    { id: 'a/free-llm:free', context_length: 65000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'b/paid', context_length: 65000, pricing: { prompt: '0.1', completion: '0.1' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'c/vision:free', context_length: 32000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
  ] });
  const reg = new ModelRegistry(baseConfig([provider('or', p.url, { preferred: [], discover: 'free' })]));
  await reg.ensureDiscovered(2000);
  const list = reg.modelsFor(reg.providers[0]);
  assert.deepEqual([...list].sort(), ['a/free-llm:free', 'c/vision:free']);
  assert.equal(reg.isVision(reg.providers[0], 'c/vision:free'), true);
  assert.equal(reg.isVision(reg.providers[0], 'a/free-llm:free'), false);
  assert.deepEqual(reg.candidates({ vision: true }).map((c) => c.model), ['c/vision:free']);
  await p.close();
});
