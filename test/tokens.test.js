import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, truncateMiddle, compactUserText, fitMessages } from '../src/tokens.js';

const fileBlock = (n, name, body) => `[File ${n}: ${name} — Python, ${body.split('\n').length} lines]\n\`\`\`python\n${body}\n\`\`\``;

test('estimateTokens: Arabic costs more per char than English', () => {
  assert.ok(estimateTokens('ا'.repeat(1000)) > estimateTokens('a'.repeat(1000)) * 1.5);
  assert.equal(estimateTokens(''), 0);
});

test('truncateMiddle keeps head and tail and a marker', () => {
  const t = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const out = truncateMiddle(t, 2000);
  assert.ok(out.length <= 2200);
  assert.ok(out.startsWith('line 0'));
  assert.ok(out.endsWith('line 499'));
  assert.match(out, /\[\d+ lines \/ \d+ chars omitted/);
});

test('compactUserText shrinks file blocks but keeps the typed question', () => {
  const big = Array.from({ length: 4000 }, (_, i) => `x${i} = ${i}`).join('\n');
  const msg = `Why is this slow?\n\nAttached files (2):\n\n${fileBlock(1, 'a.py', big)}\n\n${fileBlock(2, 'b.py', 'print(1)')}`;
  const { text, trimmed } = compactUserText(msg, 3000);
  assert.equal(trimmed, true);
  assert.ok(estimateTokens(text) <= 3200, `got ${estimateTokens(text)}`);
  assert.ok(text.startsWith('Why is this slow?'));
  assert.ok(text.includes('print(1)'), 'small file untouched');
  assert.match(text, /shortened to fit the model limit/);
});

test('fitMessages respects the budget, keeps the newest history, starts with a user turn', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ` + 'w'.repeat(800) }));
  const { messages, trimmed } = fitMessages({ system: 'sys', history, user: 'now?', budgetTokens: 2500, reserveTokens: 300 });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).content, 'now?');
  assert.equal(messages[1].role, 'user');
  assert.ok(messages.length < 32 && messages.length > 3);
  assert.equal(trimmed, true);
  assert.ok(messages.at(-2).content.startsWith('message 29'));
  const total = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  assert.ok(total <= 2500, `total ${total}`);
});

test('fitMessages handles multimodal user turns', () => {
  const user = [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
  const { messages } = fitMessages({ system: 's', history: [], user, budgetTokens: 4000 });
  assert.ok(Array.isArray(messages.at(-1).content));
  assert.equal(messages.at(-1).content.length, 2);
});
