// ═══════════════════════════════════════════════════════════════
// Model registry: discovery, candidate ordering, cooldowns, learned limits
// ═══════════════════════════════════════════════════════════════

const BAD = /(embed|rerank|guard|safety|moderat|tts|whisper|speech|audio|image-gen|diffusion|flux|sdxl|ocr|translat|parse|retriev|classif|reward|clip|bge-|e5-|nemoretriever|prompt-guard|orpheus)/i;
const GOOD = [/gpt-oss/i, /deepseek/i, /qwen/i, /llama.*(3\.3|4)/i, /nemotron/i, /glm|kimi/i, /mistral|mixtral/i, /gemma/i, /instruct|chat|-it$/i];
const VISION_RE = /(vision|-vl\b|vl-|llava|pixtral|llama-4|gemma-3|gpt-4o|gemini|molmo|maverick|scout)/i;

const goodRank = (id) => { const i = GOOD.findIndex((r) => r.test(id)); return i === -1 ? 99 : i; };

/** Picks sensible chat models from a provider's /models list when none of our preferred names exist. */
export function pickGeneric(models, n = 4) {
  return models
    .filter((m) => !BAD.test(m.id))
    .sort((a, b) => goodRank(a.id) - goodRank(b.id) || (b.context || 0) - (a.context || 0))
    .slice(0, n)
    .map((m) => m.id);
}

export class ModelRegistry {
  constructor(config, { fetchImpl = fetch, now = Date.now, log = () => {} } = {}) {
    this.cfg = config;
    this.providers = config.providers;
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.disabled = new Map(); // "pid|keyIdx|model" (either part may be *) → expiry
    this.limits = new Map(); // "pid|model" → learned prompt-token limit
    this.disc = new Map(); // pid → { at, models:[{id,context,vision}] | null, promise }
    this.stats = new Map(); // "pid|model" → { ok, fail, ttfbMs }
  }

  // ─── discovery ────────────────────────────────────────────
  async _discover(p) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await this.fetch(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${p.keys[0]}` }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const arr = Array.isArray(json) ? json : json.data || [];
      return arr.filter((m) => m?.id).map((m) => ({
        id: String(m.id),
        context: Number(m.context_length || m.context_window || m.max_model_len || 0),
        free: m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : null,
        textOut: m.architecture?.output_modalities ? m.architecture.output_modalities.includes('text') : true,
        vision: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities.includes('image') : null,
      }));
    } finally { clearTimeout(t); }
  }

  /** Starts (or reuses) discovery for every provider. Never throws; resolves when all are done or `timeoutMs` passed. */
  async ensureDiscovered(timeoutMs = 1500) {
    const jobs = this.providers.map((p) => {
      if (p.explicitModels.length) return null;
      const d = this.disc.get(p.id);
      const ttl = d?.models ? this.cfg.timing.discoveryTtlMs : 300000;
      if (d && (d.promise || this.now() - d.at < ttl)) return d.promise || null;
      const entry = { at: this.now(), models: d?.models ?? null, promise: null };
      entry.promise = this._discover(p)
        .then((models) => { entry.models = models; this.log('discovery', p.id, `${models.length} models`); })
        .catch((e) => this.log('discovery failed', p.id, e.message))
        .finally(() => { entry.promise = null; entry.at = this.now(); });
      this.disc.set(p.id, entry);
      return entry.promise;
    }).filter(Boolean);
    if (!jobs.length) return;
    await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  // ─── model lists ──────────────────────────────────────────
  _known(p) { const m = this.disc.get(p.id)?.models; return m && m.length ? m : null; }

  modelsFor(p, { fast = false } = {}) {
    if (p.explicitModels.length) return p.explicitModels;
    const known = this._known(p);
    const have = known ? new Set(known.map((m) => m.id)) : null;
    const keepIfKnown = (id) => !have || have.has(id);
    let list = (fast ? [...p.fast, ...p.preferred] : p.preferred).filter(keepIfKnown);
    if (p.discover === 'free' && known) {
      const free = known.filter((m) => m.free && m.textOut && (m.context || 32000) >= 16000 && !BAD.test(m.id));
      list = [...list, ...pickGeneric(free, 6)];
    } else if (known && list.length === 0) {
      list = pickGeneric(known, 4);
    }
    if (!list.length) list = fast ? [...p.fast, ...p.preferred] : [...p.preferred]; // discovery unusable: stay optimistic
    return [...new Set(list)];
  }

  isVision(p, model) {
    const m = this._known(p)?.find((x) => x.id === model);
    if (m && m.vision !== null) return m.vision;
    return VISION_RE.test(model);
  }

  budgetFor(p, model) { return Math.min(p.promptTokens, this.limits.get(`${p.id}|${model}`) || Infinity); }

  // ─── cooldowns / learning ─────────────────────────────────
  _isOff(pid, ki, model) {
    const t = this.now();
    for (const k of [`${pid}|${ki}|${model}`, `${pid}|*|${model}`, `${pid}|${ki}|*`]) {
      const exp = this.disabled.get(k);
      if (exp) { if (exp > t) return true; this.disabled.delete(k); }
    }
    return false;
  }
  _off(key, ms) { if (ms > 0) this.disabled.set(key, this.now() + ms); }

  isCooling(c) { return this._isOff(c.provider.id, c.keyIndex, c.model); }

  candidates({ vision = false, fast = false, limit = 40 } = {}) {
    const out = [];
    for (const p of this.providers) {
      for (const model of this.modelsFor(p, { fast })) {
        const vis = this.isVision(p, model);
        if (vision && !vis) continue;
        for (let k = 0; k < p.keys.length; k++) {
          const ki = (p.rr + k) % p.keys.length;
          if (this._isOff(p.id, ki, model)) continue;
          out.push({ provider: p, model, keyIndex: ki, key: p.keys[ki], vision: vis, budget: this.budgetFor(p, model) });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  onSuccess(c, ttfbMs) {
    c.provider.rr = (c.keyIndex + 1) % c.provider.keys.length;
    const s = this.stats.get(`${c.provider.id}|${c.model}`) || { ok: 0, fail: 0, ttfbMs: 0 };
    s.ok++; s.ttfbMs = s.ttfbMs ? Math.round(s.ttfbMs * 0.7 + ttfbMs * 0.3) : ttfbMs;
    this.stats.set(`${c.provider.id}|${c.model}`, s);
  }

  onFailure(c, err) {
    const pid = c.provider.id;
    const s = this.stats.get(`${pid}|${c.model}`) || { ok: 0, fail: 0, ttfbMs: 0 };
    s.fail++; this.stats.set(`${pid}|${c.model}`, s);
    switch (err.kind) {
      case 'auth': this._off(`${pid}|${c.keyIndex}|*`, err.cooldownMs); break;
      case 'model': this._off(`${pid}|*|${c.model}`, err.cooldownMs); break;
      case 'rate': this._off(`${pid}|${c.keyIndex}|${c.model}`, err.cooldownMs || 8000); break;
      case 'context':
        if (err.limit) this.limits.set(`${pid}|${c.model}`, Math.floor(err.limit * 0.85));
        break;
      case 'bad_request': this._off(`${pid}|${c.keyIndex}|${c.model}`, 60000); break;
      case 'empty': this._off(`${pid}|${c.keyIndex}|${c.model}`, 20000); break;
      default: this._off(`${pid}|${c.keyIndex}|${c.model}`, err.cooldownMs || 10000);
    }
  }

  status({ detail = false } = {}) {
    return this.providers.map((p) => {
      const models = this.modelsFor(p);
      const base = { id: p.id, keys: p.keys.length, models: models.length, discovered: !!this._known(p) };
      return detail ? { ...base, modelList: models, stats: Object.fromEntries([...this.stats].filter(([k]) => k.startsWith(`${p.id}|`))) } : base;
    });
  }
}
