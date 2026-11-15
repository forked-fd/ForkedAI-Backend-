// ═══════════════════════════════════════════════════════════════
// Fast failover with hedging: the first model to produce a token wins.
// ═══════════════════════════════════════════════════════════════

export class RouteError extends Error {
  constructor(errors, { aborted = false, deadline = false } = {}) {
    super(aborted ? 'aborted' : 'all candidates failed');
    this.name = 'RouteError';
    this.errors = errors;
    this.aborted = aborted;
    this.deadline = deadline;
  }
  /** Dominant failure kind, to pick the right HTTP answer. */
  get kind() {
    if (!this.errors.length) return 'none';
    const kinds = this.errors.map((e) => e.err?.kind || 'transient');
    if (kinds.every((k) => k === 'context')) return 'context';
    if (kinds.every((k) => k === 'auth')) return 'auth';
    return kinds.includes('rate') ? 'rate' : 'transient';
  }
}

/**
 * @param candidates ordered list; `open(candidate, signal)` must return an async generator of text deltas
 * Starts the first candidate; if it fails → next immediately; if it is slow (hedgeMs) → starts the next one in parallel.
 * Resolves with { candidate, first, rest(), ttfbMs } once a candidate yields its first non-empty delta.
 */
export async function raceFirstToken({ candidates, open, isCooling = () => false, hedgeMs = 6000, maxParallel = 2, maxAttempts = 10, deadlineMs = 60000, signal, onResult = () => {} }) {
  const started = Date.now();
  const errors = [];
  const live = new Set();
  let next = 0, attempts = 0;
  let deadlineTimer;
  const deadline = new Promise((r) => { deadlineTimer = setTimeout(() => r('deadline'), deadlineMs); });

  const killAll = () => { for (const e of live) { e.ctrl.abort(); signal?.removeEventListener('abort', e.onParent); } live.clear(); };

  const launch = () => {
    while (next < candidates.length && attempts < maxAttempts) {
      const c = candidates[next++];
      if (isCooling(c)) continue;
      attempts++;
      const ctrl = new AbortController();
      const onParent = () => ctrl.abort();
      signal?.addEventListener('abort', onParent, { once: true });
      const gen = open(c, ctrl.signal);
      const entry = { c, ctrl, gen, onParent, t0: Date.now() };
      entry.promise = gen.next().then((r) => ({ entry, r }), (err) => ({ entry, err }));
      live.add(entry);
      return true;
    }
    return false;
  };

  try {
    launch();
    for (;;) {
      if (signal?.aborted) throw new RouteError(errors, { aborted: true });
      if (live.size === 0) throw new RouteError(errors);
      let hedgeTimer;
      const hedge = new Promise((r) => { hedgeTimer = setTimeout(() => r('hedge'), hedgeMs); });
      const outcome = await Promise.race([...[...live].map((e) => e.promise), hedge, deadline]);
      clearTimeout(hedgeTimer);

      if (outcome === 'deadline') { killAll(); throw new RouteError(errors, { deadline: true }); }
      if (outcome === 'hedge') { if (live.size < maxParallel) launch(); continue; }

      const { entry, r, err } = outcome;
      if (!err && r && !r.done && r.value) {
        live.delete(entry); // the winner keeps its link to the client's abort signal until its stream ends
        killAll(); // abort the losers
        const ttfbMs = Date.now() - entry.t0;
        onResult(entry.c, null, ttfbMs);
        async function* rest() {
          try {
            yield r.value;
            for (;;) { const n = await entry.gen.next(); if (n.done) return; yield n.value; }
          } finally { signal?.removeEventListener('abort', entry.onParent); entry.ctrl.abort(); await entry.gen.return?.(); }
        }
        return { candidate: entry.c, first: r.value, ttfbMs, stream: rest() };
      }

      live.delete(entry);
      signal?.removeEventListener('abort', entry.onParent);
      entry.ctrl.abort();
      if (err?.name === 'AbortError' && signal?.aborted) throw new RouteError(errors, { aborted: true });
      const failure = err || Object.assign(new Error('empty answer'), { kind: 'empty', cooldownMs: 20000 });
      errors.push({ candidate: entry.c, err: failure });
      onResult(entry.c, failure, 0);
      if (live.size === 0) launch(); // fast failover: no waiting
    }
  } finally {
    clearTimeout(deadlineTimer);
    void started;
  }
}
