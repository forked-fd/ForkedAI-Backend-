// ═══════════════════════════════════════════════════════════════
// Speech-to-text (Deepgram). Kept from the old backend; now memory-only (Vercel's disk is read-only).
// ═══════════════════════════════════════════════════════════════
import { HttpError } from './http.js';

export async function transcribe({ buffer, mimeType }, cfg, fetchImpl = fetch) {
  if (!buffer?.length) throw new HttpError(400, 'Audio recording is required.', { code: 'no_audio' });
  if (!cfg.apiKey) throw new HttpError(503, 'Voice input is not available right now.', { code: 'audio_unconfigured' });
  const type = String(mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  const url = `${cfg.baseUrl}/listen?model=${encodeURIComponent(cfg.model)}&language=${encodeURIComponent(cfg.language)}&smart_format=true&punctuate=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Token ${cfg.apiKey}`, 'Content-Type': type }, body: buffer, signal: ctrl.signal });
  } catch {
    throw new HttpError(503, 'Voice input is not available right now.', { code: 'audio_unreachable' });
  } finally { clearTimeout(t); }
  if (!res.ok) { console.warn('[audio] deepgram status', res.status); throw new HttpError(502, 'We could not process that recording. Please try again.', { code: 'audio_failed' }); }
  const data = await res.json().catch(() => null);
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  const transcript = String(alt?.transcript || '').trim();
  const duration = data?.metadata?.duration ?? null;
  if (!transcript) {
    throw new HttpError(422, duration !== null && duration < 0.5 ? 'The recording was too short. Please speak for at least a second.' : 'We could not understand any speech. Please speak clearly and try again.', { code: 'no_speech' });
  }
  return { transcript, confidence: alt?.confidence ?? null, duration };
}
