import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readUpload, buildFileBlocks, decodeText, sniffImage } from '../src/files.js';
import { parseMultipart } from '../src/http.js';

const limits = { maxImageBytes: 1e6, maxTextBytes: 1e6, maxFileChars: 80000, maxTotalChars: 200000 };
const f = (name, content, mime = '') => ({ name, mime, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);

test('code files of many fields are read with the right language, whatever the browser MIME says', () => {
  const cases = { 'a.py': 'python', 'x.tsx': 'tsx', 'main.rs': 'rust', 'App.kt': 'kotlin', 'q.sql': 'sql', 'Dockerfile': 'dockerfile', 'main.tf': 'hcl', 'C.sol': 'solidity', 'shader.wgsl': 'wgsl', 'notes.unknownext': 'text', 'sketch.ino': 'cpp' };
  for (const [name, lang] of Object.entries(cases)) {
    const r = readUpload(f(name, 'x = 1\n', 'application/octet-stream'), limits);
    assert.equal(r.kind, 'code'); assert.equal(r.language, lang, name);
  }
});

test('images are detected by bytes; unsupported image formats get a clear error', () => {
  const r = readUpload(f('shot.bin', PNG, ''), limits);
  assert.equal(r.kind, 'image'); assert.equal(r.mime, 'image/png'); assert.match(r.dataUrl, /^data:image\/png;base64,/);
  assert.throws(() => readUpload(f('a.heic', Buffer.from('ftypheic....'), 'image/heic'), limits), (e) => e.status === 415 && /PNG, JPG or WebP/.test(e.message));
  assert.equal(sniffImage(Buffer.from('hello world')), null);
});

test('binary files are rejected, PDFs are named', () => {
  assert.throws(() => readUpload(f('a.pdf', '%PDF-1.7 ....'), limits), (e) => e.status === 415 && /PDF/.test(e.message));
  assert.throws(() => readUpload(f('blob', Buffer.from([1, 2, 0, 4, 5])), limits), (e) => e.status === 415);
});

test('notebooks are flattened, big files truncated, UTF-16 and Windows-1256 decoded', () => {
  const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Hi'] }, { cell_type: 'code', source: ['print(1)'], outputs: [{ text: ['1\n'] }] }] });
  const r = readUpload(f('n.ipynb', nb), limits);
  assert.match(r.text, /# %% \[markdown\]\n# # Hi/); assert.match(r.text, /print\(1\)/); assert.match(r.text, /# Output:/);
  const big = readUpload(f('big.js', 'a\n'.repeat(60000)), { ...limits, maxFileChars: 1000 });
  assert.equal(big.truncated, true); assert.equal(big.text.length, 1000);
  assert.equal(decodeText(Buffer.from('\ufeffhi', 'utf16le')), 'hi');
  assert.equal(decodeText(new TextEncoder().encode('مرحبا')), 'مرحبا');
  const win1256 = Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7, 0x20, 0xe3, 0xd1, 0xcd, 0xc8, 0xc7, 0x20, 0xe3, 0xd1, 0xcd, 0xc8, 0xc7]);
  assert.match(decodeText(win1256), /مرحبا/);
});

test('file blocks use the same shape as the web app and respect the total budget', () => {
  const a = readUpload(f('a.py', 'print(1)\n```\nx'), limits);
  const blocks = buildFileBlocks([a, readUpload(f('b.js', 'x'.repeat(50)), limits)], { maxTotalChars: 20 });
  assert.match(blocks[0], /^\[File 1: a\.py — Python, 3 lines/);
  assert.ok(blocks[0].includes('````python'), 'fence longer than the backticks inside the file');
  assert.match(blocks[1], /truncated for length/);
});

test('multipart parsing keeps Arabic file names and fields', async () => {
  const server = http.createServer(async (req, res) => { const r = await parseMultipart(req, 1e6); res.end(JSON.stringify({ fields: r.fields, files: r.files.map((x) => [x.field, x.name, x.buffer.toString()]) })); });
  await new Promise((r) => server.listen(0, r));
  const fd = new FormData(); fd.append('message', 'مرحبا'); fd.append('sessionId', 's1'); fd.append('files', new File(['print(1)'], 'برنامج.py', { type: 'text/x-python' }));
  const out = await (await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: fd })).json();
  server.close();
  assert.deepEqual(out.fields, { message: 'مرحبا', sessionId: 's1' });
  assert.deepEqual(out.files, [['files', 'برنامج.py', 'print(1)']]);
});
