import http from 'node:http';

/** Fake OpenAI-compatible provider. behaviors: fn(body, req) => { status?, json?, tokens?, delayMs?, hang?, reasoning? } */
export async function fakeProvider(behavior, { models = [] } = {}) {
  const calls = [];
  let closed = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: models.map((m) => (typeof m === 'string' ? { id: m } : m)) }));
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      calls.push({ body, headers: req.headers, url: req.url });
      const b = (await behavior(body, req)) || {};
      if (b.status && b.status !== 200) {
        res.writeHead(b.status, { 'content-type': 'application/json', ...(b.headers || {}) });
        return res.end(JSON.stringify(b.json ?? { error: { message: b.message || 'error' } }));
      }
      if (b.hang) return; // never answers
      res.on('close', () => { if (!res.writableFinished) closed++; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
      for (const r of b.reasoning || []) send({ choices: [{ delta: { reasoning: r } }] });
      for (const t of b.tokens ?? ['Hello', ' world']) { if (b.tokenDelayMs) await new Promise((r) => setTimeout(r, b.tokenDelayMs)); if (res.destroyed) return; send({ choices: [{ delta: { content: t } }] }); }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, get closed() { return closed; }, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

export async function collect(stream) { let s = ''; for await (const d of stream) s += d; return s; }

export function provider(id, url, extra = {}) {
  return { id, name: id, keys: ['k1'], rr: 0, baseUrl: url, explicitModels: [], preferred: ['m1'], fast: [], discover: null, promptTokens: 10000, extraBody: () => ({}), ...extra };
}

export const baseConfig = (providers) => ({
  providers,
  timing: { firstTokenMs: 2000, idleMs: 2000, hedgeMs: 300, deadlineMs: 5000, maxParallel: 2, maxAttempts: 10, discoveryTtlMs: 60000 },
});
