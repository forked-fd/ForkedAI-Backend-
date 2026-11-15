// ═══════════════════════════════════════════════════════════════
// Token estimation + smart truncation (no tokenizer dependency)
// ═══════════════════════════════════════════════════════════════

/** Rough token count: ~3.7 chars/token for Latin & code, ~2 chars/token for Arabic and other non-ASCII scripts. */
export function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0, other = 0;
  for (let i = 0; i < text.length; i++) (text.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 3.7 + other / 2) + 4;
}

export function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) n += p.type === 'text' ? estimateTokens(p.text) : 900; // an image costs roughly this much
    }
    n += 4;
  }
  return n;
}

/** Keeps the start (65%) and the end (35%) of a text, cutting at line boundaries, with a visible marker in the middle. */
export function truncateMiddle(text, maxChars, label = 'omitted to fit the model limit') {
  if (!text || text.length <= maxChars) return text;
  const room = Math.max(0, maxChars - 80);
  const headLen = Math.floor(room * 0.65);
  const tailLen = room - headLen;
  let head = text.slice(0, headLen);
  let tail = text.slice(text.length - tailLen);
  const cutHead = head.lastIndexOf('\n');
  if (cutHead > headLen * 0.6) head = head.slice(0, cutHead);
  const cutTail = tail.indexOf('\n');
  if (cutTail !== -1 && cutTail < tailLen * 0.4) tail = tail.slice(cutTail + 1);
  const dropped = text.length - head.length - tail.length;
  const lines = text.slice(head.length, text.length - tail.length).split('\n').length;
  return `${head}\n… [${lines} lines / ${dropped} chars ${label}] …\n${tail}`;
}

const FILE_BLOCK = /(\[File \d+: [^\n\]]*\]\n)(`{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;

/**
 * Shrinks a user message so it fits `maxTokens`. Typed text stays intact; the attached-file blocks
 * (`[File n: name — Lang, N lines]` + fenced code) are shortened evenly, keeping the start and end of each file.
 */
export function compactUserText(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return { text, trimmed: false };
  const blocks = [...text.matchAll(FILE_BLOCK)];
  if (blocks.length) {
    const fixed = text.replace(FILE_BLOCK, '').length;
    const bodyTotal = blocks.reduce((n, m) => n + m[4].length, 0);
    const charBudget = Math.max(2000, Math.floor(maxTokens * 3.2) - fixed);
    if (bodyTotal > charBudget) {
      const ratio = charBudget / bodyTotal;
      const shrunk = text.replace(FILE_BLOCK, (all, head, fence, lang, body) => {
        const cap = Math.max(400, Math.floor(body.length * ratio));
        if (body.length <= cap) return all;
        return `${head.replace(/\]\n$/, ', shortened to fit the model limit]\n')}${fence}${lang}\n${truncateMiddle(body, cap)}\n${fence}`;
      });
      if (estimateTokens(shrunk) <= maxTokens) return { text: shrunk, trimmed: true };
      return { text: truncateMiddle(shrunk, Math.floor(maxTokens * 3.2)), trimmed: true };
    }
  }
  return { text: truncateMiddle(text, Math.floor(maxTokens * 3.2)), trimmed: true };
}

/**
 * Builds the final messages array for one candidate model: system prompt + as much recent history as fits + current user turn.
 * History is filled newest → oldest; very long old messages are shortened; leading assistant turns are dropped.
 */
export function fitMessages({ system, history = [], user, budgetTokens, reserveTokens = 600, maxHistory = 40 }) {
  const room = Math.max(500, budgetTokens - reserveTokens);
  const sysT = estimateTokens(system) + 8;
  const userContent = typeof user === 'string' ? user : null;
  let trimmed = false;

  let current = user;
  let curT;
  if (userContent !== null) {
    const c = compactUserText(userContent, Math.max(400, room - sysT));
    trimmed = c.trimmed;
    current = c.text;
    curT = estimateTokens(current);
  } else {
    // multimodal parts: shrink only the text part
    const parts = user.map((p) => ({ ...p }));
    const textPart = parts.find((p) => p.type === 'text');
    const imageCost = parts.filter((p) => p.type !== 'text').length * 900;
    if (textPart) {
      const c = compactUserText(textPart.text, Math.max(400, room - sysT - imageCost));
      textPart.text = c.text;
      trimmed = c.trimmed;
    }
    current = parts;
    curT = parts.reduce((n, p) => n + (p.type === 'text' ? estimateTokens(p.text) : 900), 0);
  }

  let left = room - sysT - curT;
  const kept = [];
  const recent = history.slice(-maxHistory);
  for (let i = recent.length - 1; i >= 0 && left > 150; i--) {
    const m = recent[i];
    if (!m?.content) continue;
    const newest = recent.length - 1 - i < 2;
    let content = m.content;
    const cap = newest ? 40000 : 12000;
    if (content.length > cap) { content = truncateMiddle(content, cap, 'omitted from an earlier message'); }
    const t = estimateTokens(content) + 4;
    if (t > left) {
      if (!newest) break;
      content = truncateMiddle(content, Math.max(600, Math.floor(left * 3)), 'omitted from an earlier message');
      if (estimateTokens(content) + 4 > left) break;
    }
    left -= estimateTokens(content) + 4;
    kept.unshift({ role: m.role, content });
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();

  return {
    messages: [{ role: 'system', content: system }, ...kept, { role: 'user', content: current }],
    trimmed: trimmed || kept.length < Math.min(history.length, maxHistory),
  };
}
