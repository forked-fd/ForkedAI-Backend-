import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamSanitizer, cleanText } from '../src/sanitize.js';

function viaChunks(text, sizes, opts) {
  const s = new StreamSanitizer(opts);
  let out = '', i = 0, k = 0;
  while (i < text.length) { const n = sizes[k++ % sizes.length]; out += s.push(text.slice(i, i + n)); i += n; }
  return out + s.end();
}

test('removes <think> blocks (also when split across chunks)', () => {
  assert.equal(cleanText('<think>secret plan</think>\n\nHello'), 'Hello');
  assert.equal(viaChunks('<think>abc</think>Hi there', [3, 2, 5]), 'Hi there');
  assert.equal(cleanText('Answer <think>x</think> done'), 'Answer done');
});

test('strips presentational HTML in prose but keeps generics and code', () => {
  assert.equal(cleanText('<p class="x">Hello</p><p>World</p>'), 'Hello\nWorld');
  assert.equal(cleanText('line one<br>line two<br/>three'), 'line one\nline two\nthree');
  assert.equal(cleanText('Use List<T> or Map<string, int> here'), 'Use List<T> or Map<string, int> here');
  assert.equal(cleanText('a < b and c > d'), 'a < b and c > d');
  assert.equal(cleanText('The `<div>` tag is a block'), 'The `<div>` tag is a block');
  assert.equal(cleanText('The ``<p>`` tag'), 'The ``<p>`` tag');
});

test('never touches fenced code (including nested longer fences and unclosed fences)', () => {
  const code = 'Look:\n```html\n<div class="a"><p>Hi</p></div>\n<think>keep</think>\n```\nafter <b>bold</b>';
  assert.equal(cleanText(code), 'Look:\n```html\n<div class="a"><p>Hi</p></div>\n<think>keep</think>\n```\nafter bold');
  const nested = '````md\n```js\n<br>\n```\n````\n<br>x';
  assert.equal(cleanText(nested), '````md\n```js\n<br>\n```\n````\n\nx');
  const open = 'x\n```js\nconst a = "<div>你好</div>";\n';
  assert.equal(cleanText(open), 'x\n```js\nconst a = "<div>你好</div>";');
});

test('CJK is removed from prose only; Arabic (incl. presentation forms) is always kept', () => {
  assert.equal(cleanText('hello 你好 world'), 'hello  world');
  assert.equal(cleanText('`你好` stays', {}), '`你好` stays');
  assert.equal(cleanText('محمد ﷺ وﷲ أعلم'), 'محمد ﷺ وﷲ أعلم');
  assert.equal(cleanText('ok 𠀀 astral'), 'ok  astral');
  assert.equal(cleanText('hello 你好', { stripCjk: false }), 'hello 你好');
});

test('keeps indentation, nested lists and blank lines exactly', () => {
  const md = '- a\n  - b\n    - c\n\n\n| x | y |\n|---|---|\n';
  assert.equal(cleanText(md + 'end'), md + 'end');
});

test('chunking never changes the result (fuzz)', () => {
  const corpus = [
    'Intro <p>para</p> and `<b>` code ``a ` b`` more\n```python\nprint("<br>")\n```\n<think>x</think>\n\n你好 end <br> done',
    '<think>one</think><think>two</think>X List<int> `a`b``c`` <div><span>z</span></div>\n\n- a\n  - <i>b</i>',
    '```\nunclosed <p> 你好\n',
    'text with ` single tick and <incomplete tag',
    'مرحبا <p>بك</p> ﷲ `<code>` 你',
  ];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const text of corpus) {
    const whole = viaChunks(text, [text.length + 5]);
    for (let t = 0; t < 400; t++) {
      const sizes = Array.from({ length: 6 }, () => 1 + Math.floor(rnd() * 7));
      assert.equal(viaChunks(text, sizes), whole, `chunking ${sizes} changed output for: ${JSON.stringify(text)}`);
    }
    assert.equal(viaChunks(text, [1]), whole);
  }
});
