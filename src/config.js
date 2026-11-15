// ═══════════════════════════════════════════════════════════════
// Forked AI — configuration (environment → one plain object)
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Tiny .env loader (no dependency). Real environment variables always win. */
export function loadDotEnv(file = path.join(ROOT, '.env'), env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
}

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d, min = -Infinity, max = Infinity) => {
  if (v == null || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const bool = (v, d) => (v == null || String(v).trim() === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

/**
 * Provider descriptors. Model names change often (Groq retired llama-3.3-70b-versatile, DeepSeek retired deepseek-chat…),
 * so `preferred` is only a *preference*: at runtime it is intersected with the provider's real /models list
 * (see models.js). Override anything with <ID>_MODELS=a,b,c.
 */
const PROVIDER_DEFS = [
  {
    id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', baseVar: 'GROQ_BASE_URL',
    keyVars: ['GROQ_API_KEYS', 'GROQ_API_KEY'], modelsVar: 'GROQ_MODELS',
    preferred: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
    fast: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
    // Free tiers allow only a few thousand tokens per minute; the router learns exact limits from 413 answers.
    promptTokens: 6500,
    extraBody: (model) => (/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
  },
  {
    id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', baseVar: 'DEEPSEEK_BASE_URL',
    keyVars: ['DEEPSEEK_API_KEYS', 'DEEPSEEK_API_KEY'], modelsVar: 'DEEPSEEK_MODELS',
    preferred: ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro'],
    fast: ['deepseek-v4-flash', 'deepseek-flash'],
    promptTokens: 100000,
    extraBody: () => ({}),
  },
  {
    id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', baseVar: 'OPENROUTER_BASE_URL',
    keyVars: ['OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY'], modelsVar: 'OPENROUTER_MODELS',
    preferred: [], fast: [], discover: 'free',
    promptTokens: 30000,
    extraBody: () => ({}),
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', baseVar: 'NVIDIA_BASE_URL',
    keyVars: ['NVIDIA_API_KEYS', 'NVIDIA_API_KEY'], modelsVar: 'NVIDIA_MODELS',
    preferred: ['meta/llama-3.3-70b-instruct', 'openai/gpt-oss-120b', 'nvidia/llama-3.3-nemotron-super-49b-v1', 'meta/llama-3.1-405b-instruct'],
    fast: ['openai/gpt-oss-20b', 'meta/llama-3.1-8b-instruct'],
    promptTokens: 30000,
    extraBody: () => ({}),
  },
  {
    id: 'huggingface', name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', baseVar: 'HUGGINGFACE_BASE_URL',
    keyVars: ['HUGGINGFACE_API_KEYS', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'], modelsVar: 'HUGGINGFACE_MODELS',
    preferred: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'openai/gpt-oss-20b'],
    fast: ['openai/gpt-oss-20b'],
    promptTokens: 30000,
    extraBody: () => ({}),
  },
];

export function loadConfig(env = process.env) {
  const isVercel = !!env.VERCEL;
  const isProd = env.NODE_ENV === 'production' || isVercel;

  const providers = [];
  for (const def of PROVIDER_DEFS) {
    const keys = [...new Set(def.keyVars.flatMap((k) => list(env[k])))];
    if (!keys.length) continue;
    const ID = def.id.toUpperCase();
    providers.push({
      id: def.id, name: def.name, keys, rr: 0,
      baseUrl: String(env[def.baseVar] || def.baseUrl).replace(/\/+$/, ''),
      explicitModels: list(env[def.modelsVar]),
      preferred: def.preferred, fast: def.fast, discover: def.discover || null,
      promptTokens: num(env[`${ID}_MAX_PROMPT_TOKENS`], def.promptTokens, 500),
      extraBody: def.extraBody,
    });
  }
  const order = list(env.PROVIDER_ORDER || 'groq,deepseek,openrouter,nvidia,huggingface');
  providers.sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const supabaseUrl = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const supabaseKey = String(env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
  const supabaseOk = !!(supabaseUrl && supabaseKey);
  let authMode = String(env.AUTH_MODE || '').trim().toLowerCase();
  if (!['required', 'optional', 'off'].includes(authMode)) authMode = supabaseOk ? 'required' : 'off';
  if (authMode !== 'off' && !supabaseOk) authMode = 'off'; // cannot verify tokens without Supabase settings

  return {
    isProd, isVercel,
    port: num(env.PORT, 5000, 1, 65535),
    providers,
    temperature: num(env.TEMPERATURE, 0.7, 0, 2),
    maxTokens: num(env.MAX_TOKENS, 4096, 16, 32000),
    stripCjk: bool(env.STRIP_CJK, true),
    timing: {
      firstTokenMs: num(env.FIRST_TOKEN_TIMEOUT_MS, 20000, 1000),
      idleMs: num(env.STREAM_IDLE_TIMEOUT_MS, 25000, 1000),
      hedgeMs: num(env.HEDGE_AFTER_MS, 6000, 200),
      deadlineMs: num(env.REQUEST_DEADLINE_MS, 60000, 2000),
      maxParallel: num(env.MAX_PARALLEL_ATTEMPTS, 2, 1, 4),
      maxAttempts: num(env.MAX_ATTEMPTS, 10, 1, 40),
      discoveryTtlMs: num(env.MODEL_DISCOVERY_TTL_MS, 3600000, 60000),
    },
    limits: {
      maxFiles: num(env.MAX_FILES, 8, 1, 20),
      maxFileChars: num(env.MAX_FILE_CHARS, 80000, 1000),
      maxTotalChars: num(env.MAX_TOTAL_CHARS, 200000, 1000),
      maxImageBytes: num(env.MAX_IMAGE_BYTES, 12 * 1024 * 1024, 1024),
      maxTextBytes: num(env.MAX_TEXT_FILE_BYTES, 2 * 1024 * 1024, 1024),
      maxBodyBytes: num(env.MAX_BODY_BYTES, 30 * 1024 * 1024, 1024),
      maxJsonBytes: num(env.MAX_JSON_BYTES, 4 * 1024 * 1024, 1024),
      maxMessageChars: num(env.MAX_MESSAGE_CHARS, 500000, 100),
      maxAudioBytes: num(env.MAX_AUDIO_BYTES, 25 * 1024 * 1024, 1024),
    },
    cors: { origins: list(env.CORS_ORIGINS || env.CLIENT_URL), allowLocalhost: !isProd || bool(env.CORS_ALLOW_LOCALHOST, false) },
    auth: { mode: authMode, supabaseUrl, supabaseKey, supabaseOk, failOpen: bool(env.AUTH_FAIL_OPEN, false) },
    rate: {
      perMinuteUser: num(env.RATE_LIMIT_PER_MIN, 30, 1),
      perMinuteIp: num(env.RATE_LIMIT_PER_MIN_IP, 60, 1),
      concurrentPerUser: num(env.MAX_CONCURRENT_PER_USER, 3, 1),
    },
    history: {
      ttlMs: num(env.HISTORY_TTL_MS, 6 * 3600000, 1000),
      maxSessions: num(env.HISTORY_MAX_SESSIONS, 500, 10),
      maxMessages: num(env.HISTORY_MAX_MESSAGES, 40, 2),
      supabase: bool(env.HISTORY_FROM_SUPABASE, true) && supabaseOk,
    },
    systemPrompt: String(env.SYSTEM_PROMPT || ''),
    systemPromptAppend: String(env.SYSTEM_PROMPT_APPEND || ''),
    deepgram: {
      apiKey: String(env.DEEPGRAM_API_KEY || ''),
      baseUrl: String(env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com/v1').replace(/\/+$/, ''),
      model: String(env.DEEPGRAM_MODEL || 'nova-2'),
      language: String(env.DEEPGRAM_LANGUAGE || 'multi'),
    },
    healthToken: String(env.HEALTH_TOKEN || ''),
    trustProxy: bool(env.TRUST_PROXY, true),
  };
}

loadDotEnv();
export const config = loadConfig();
export default config;
