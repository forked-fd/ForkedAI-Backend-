// ═══════════════════════════════════════════════════════════════
// Streaming-safe answer cleaner.
//
// Removes things that must never reach the chat bubble — outside of code only:
//   • <think>…</think> reasoning blocks some models put in `content`
//   • stray presentational HTML tags (<p>, <br>, <div class="…">, …)   (the frontend renders Markdown, not HTML)
//   • stray CJK characters (Chinese/Japanese/Korean models sometimes leak them)  — optional
// Fenced code blocks and `inline code` are NEVER touched, whitespace/indentation is NEVER touched
// (nested lists and tables depend on it), and Arabic (including presentation forms such as ﷺ) is always kept.
//
// It works chunk by chunk with a tiny lookahead buffer, so the output is identical however the text is split.
// ═══════════════════════════════════════════════════════════════

const BLOCK_CLOSE = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'section', 'article', 'header', 'footer']);
const STRIP = new Set([...BLOCK_CLOSE, 'br', 'span', 'b', 'i', 'u', 'strong', 'em', 'thead', 'tbody', 'td', 'th', 'hr', 'center', 'font', 'nav', 'main', 'code', 'pre', 'small', 'sup', 'sub', 'mark']);
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^<>]*)?(\/?)>$/;
const MAX_TAG = 120;
const THINK_CLOSE = '</think>';

/** CJK + Hangul + kana + fullwidth forms. Deliberately does NOT include Arabic ranges (U+FB50–U+FEFF). */
const CJK_BMP = /[\u2E80-\u2FDF\u3000-\u303F\u3040-\u30FF\u3100-\u318F\u31C0-\u31FF\u3200-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
const isCjkCodePoint = (cp) => (cp >= 0x20000 && cp <= 0x2FA1F) || (cp >= 0x30000 && cp <= 0x3134F);

export class StreamSanitizer {
  constructor({ stripCjk = true, stripHtml = true } = {}) {
    this.stripCjk = stripCjk;
    this.stripHtml = stripHtml;
    this.mode = 'text'; // text | inline | fence | think
    this.carry = '';
    this.indent = 0; // leading-whitespace count on the current line; -1 once real text was seen
    this.prev = '\n';
    this.runLen = 0; // length of the opening backtick run (inline / fence)
    this.trimNext = false; // swallow whitespace right after </think>
    this.out = '';
  }

  _emit(str) {
    this.out += str;
    for (const ch of str) {
      if (ch === '\n') this.indent = 0;
      else if (this.indent >= 0 && ch === ' ') this.indent += 1;
      else if (this.indent >= 0 && ch === '\t') this.indent = 99;
      else this.indent = -1;
      this.prev = ch;
    }
  }

  push(chunk) { return this._run(chunk, false); }
  end() { return this._run('', true); }

  _run(chunk, final) {
    const s = this.carry + chunk;
    this.carry = '';
    this.out = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];

      if (this.mode === 'think') {
        const j = s.indexOf(THINK_CLOSE, i);
        if (j === -1) {
          // keep a possible partial "</think>" at the end for the next chunk
          let keep = 0;
          for (let k = Math.min(THINK_CLOSE.length - 1, s.length - i); k > 0; k--) {
            if (s.endsWith(THINK_CLOSE.slice(0, k))) { keep = k; break; }
          }
          if (!final && keep) this.carry = s.slice(s.length - keep);
          i = s.length;
          break;
        }
        i = j + THINK_CLOSE.length;
        this.mode = 'text';
        this.trimNext = true;
        continue;
      }

      if (ch === '`') {
        let j = i;
        while (j < s.length && s[j] === '`') j++;
        if (j === s.length && !final) { this.carry = s.slice(i); break; } // the run may continue in the next chunk
        const run = j - i;
        const text = s.slice(i, j);
        if (this.mode === 'text') {
          this.trimNext = false;
          const atLineStart = this.indent >= 0 && this.indent <= 3;
          this.mode = run >= 3 && atLineStart ? 'fence' : 'inline';
          this.runLen = run;
          this._emit(text);
        } else if (this.mode === 'inline') {
          if (run === this.runLen) this.mode = 'text';
          this._emit(text);
        } else { // fence: closes on a line-start run at least as long as the opener with nothing but whitespace after it
          const atLineStart = this.indent >= 0 && this.indent <= 3;
          const next = j < s.length ? s[j] : '\n';
          if (atLineStart && run >= this.runLen && /[\r\n \t]/.test(next)) this.mode = 'text';
          this._emit(text);
        }
        i = j;
        continue;
      }

      if (this.mode !== 'text') {
        if (this.mode === 'inline' && ch === '\n' && this.prev === '\n') this.mode = 'text'; // a blank line ends unclosed inline code
        this._emit(ch);
        i += 1;
        continue;
      }

      // ── text mode ──
      if (this.trimNext) {
        if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
        this.trimNext = false;
      }

      if (ch === '<' && this.stripHtml) {
        const rest = s.slice(i, i + MAX_TAG + 1);
        const nl = rest.indexOf('\n');
        const gt = rest.indexOf('>');
        if (gt !== -1 && (nl === -1 || gt < nl)) {
          const m = TAG_RE.exec(rest.slice(0, gt + 1));
          if (m) {
            const closing = m[1] === '/';
            const name = m[2].toLowerCase();
            if (name === 'think') { if (!closing) this.mode = 'think'; else this.trimNext = true; i += gt + 1; continue; }
            if (STRIP.has(name)) {
              if (name === 'br' || (closing && BLOCK_CLOSE.has(name))) this._emit('\n');
              i += gt + 1;
              continue;
            }
          }
          this._emit('<');
          i += 1;
          continue;
        }
        if (nl !== -1 || rest.length > MAX_TAG || final) { this._emit('<'); i += 1; continue; } // can't be a tag
        this.carry = s.slice(i); // might still become a tag: wait for more text
        break;
      }

      // surrogate pair (astral CJK) — never split it
      const code = s.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        if (i + 1 >= s.length && !final) { this.carry = s.slice(i); break; }
        const cp = s.codePointAt(i);
        const len = cp > 0xFFFF ? 2 : 1;
        if (!(this.stripCjk && isCjkCodePoint(cp))) this._emit(s.slice(i, i + len));
        i += len;
        continue;
      }
      if (this.stripCjk && CJK_BMP.test(ch)) { i += 1; continue; }
      this._emit(ch);
      i += 1;
    }
    return this.out;
  }
}

/** One-shot helper (non-streaming answers and tests). */
export function cleanText(text, opts) {
  const s = new StreamSanitizer(opts);
  return (s.push(text ?? '') + s.end()).trim();
}
