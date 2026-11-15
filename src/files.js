// ═══════════════════════════════════════════════════════════════
// Reading uploaded files: code / text / notebooks / images
// ═══════════════════════════════════════════════════════════════
import { HttpError } from './http.js';

/** extension → fenced-block language. Covers the common languages of every field (web, mobile, systems, data/ML, DevOps, games, embedded, blockchain, docs). */
export const CODE = {
  // web
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less', vue: 'vue', svelte: 'svelte', astro: 'astro',
  php: 'php', phtml: 'php', ejs: 'ejs', hbs: 'handlebars', pug: 'pug', twig: 'twig', graphql: 'graphql', gql: 'graphql', wasm: null,
  // scripting / backend
  py: 'python', pyw: 'python', pyi: 'python', ipynb: 'python', rb: 'ruby', erb: 'erb', pl: 'perl', pm: 'perl', lua: 'lua', tcl: 'tcl',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'groovy', cs: 'csharp', vb: 'vbnet', fs: 'fsharp', razor: 'razor', cshtml: 'razor',
  go: 'go', rs: 'rust', dart: 'dart', swift: 'swift', m: 'objectivec', mm: 'objectivec', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell',
  clj: 'clojure', cljs: 'clojure', ml: 'ocaml', nim: 'nim', cr: 'crystal', zig: 'zig', d: 'd', jl: 'julia', r: 'r', rmd: 'markdown', lisp: 'lisp', scm: 'scheme', rkt: 'racket',
  // systems / embedded / hardware
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', ino: 'cpp', asm: 'asm', s: 'asm', v: 'verilog', sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  f: 'fortran', f90: 'fortran', pas: 'pascal', ada: 'ada', adb: 'ada', cob: 'cobol', cbl: 'cobol',
  // data / ML / science
  sql: 'sql', csv: 'csv', tsv: 'tsv', json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json', xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', env: 'dotenv', sas: 'sas', m4: 'm4', mat: null, prisma: 'prisma',
  // devops / build / infra
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', bat: 'batch', cmd: 'batch', ps1: 'powershell', psm1: 'powershell', tf: 'hcl', hcl: 'hcl', tfvars: 'hcl', bicep: 'bicep',
  mk: 'makefile', cmake: 'cmake', bzl: 'python', nix: 'nix', dockerfile: 'dockerfile', gitignore: 'text', gitattributes: 'text', editorconfig: 'ini',
  prettierrc: 'json', eslintrc: 'json', npmrc: 'ini', lock: 'text', log: 'text', toml5: 'toml', nginx: 'nginx', service: 'ini',
  // games / graphics / blockchain / protocols
  glsl: 'glsl', frag: 'glsl', vert: 'glsl', wgsl: 'wgsl', hlsl: 'hlsl', shader: 'glsl', gd: 'gdscript', unity: 'yaml', sol: 'solidity', vy: 'python', move: 'move', proto: 'protobuf', thrift: 'thrift',
  // docs
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', txt: 'text', text: 'text', rst: 'rst', adoc: 'asciidoc', tex: 'latex', bib: 'bibtex', org: 'org',
};
for (const k of Object.keys(CODE)) if (CODE[k] === null) delete CODE[k]; // known-binary extensions: not readable

export const NAMED = {
  dockerfile: 'dockerfile', makefile: 'makefile', procfile: 'text', gemfile: 'ruby', rakefile: 'ruby', 'cmakelists.txt': 'cmake', 'requirements.txt': 'text',
  '.gitignore': 'text', '.gitattributes': 'text', '.env': 'dotenv', '.editorconfig': 'ini', '.prettierrc': 'json', '.eslintrc': 'json', '.npmrc': 'ini',
  license: 'text', readme: 'markdown', 'build.gradle': 'groovy', 'pom.xml': 'xml', 'package.json': 'json', 'tsconfig.json': 'json', 'pyproject.toml': 'toml', 'cargo.toml': 'toml', 'go.mod': 'text',
};

const LABEL = {
  python: 'Python', javascript: 'JavaScript', jsx: 'JSX', typescript: 'TypeScript', tsx: 'TSX', json: 'JSON', html: 'HTML', css: 'CSS', scss: 'SCSS',
  markdown: 'Markdown', text: 'Text', bash: 'Shell', sql: 'SQL', java: 'Java', kotlin: 'Kotlin', c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust',
  ruby: 'Ruby', php: 'PHP', swift: 'Swift', dart: 'Dart', yaml: 'YAML', xml: 'XML', csv: 'CSV', dockerfile: 'Dockerfile', vue: 'Vue', svelte: 'Svelte',
};
export const languageLabel = (lang) => LABEL[lang] ?? lang.charAt(0).toUpperCase() + lang.slice(1);

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'ico', 'apng'];

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 || (i === 0 && name.length > 1) ? name.slice(i + 1).toLowerCase() : ''; };
const baseOf = (name) => String(name || 'file').split(/[\\/]/).pop() || 'file';

/** Detects the real image type from the first bytes (the browser-declared type can be wrong or empty). */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const MAGIC = [
  ['%PDF', 'a PDF'], ['PK\x03\x04', 'an archive or Office file'], ['\x1f\x8b', 'a compressed file'], ['\x7fELF', 'a program'], ['MZ', 'a program'],
  ['SQLite format', 'a database'], ['Rar!', 'an archive'], ['7z\xbc\xaf', 'an archive'], ['\xd0\xcf\x11\xe0', 'an Office file'],
];
const detectBinaryKind = (buf) => { const head = buf.toString('latin1', 0, 16); return MAGIC.find(([m]) => head.startsWith(m))?.[1] ?? null; };

export function looksBinary(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false; // UTF-16 text
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return true;
  let ctl = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32 && b !== 27)) ctl++;
  return head.length > 0 && ctl / head.length > 0.1;
}

/** UTF-8 (with BOM handling) → UTF-16 by BOM → Windows-1256 (Arabic legacy files) when UTF-8 is clearly wrong. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf).replace(/^\uFEFF/, '');
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf).replace(/^\uFEFF/, '');
  const utf8 = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > 0 && bad / Math.max(1, utf8.length) > 0.005) {
    try { return new TextDecoder('windows-1256').decode(buf); } catch { /* ICU without that table */ }
  }
  return utf8;
}

export function notebookToText(raw) {
  const nb = JSON.parse(raw);
  const join = (s) => (Array.isArray(s) ? s.join('') : s ?? '');
  const out = [];
  for (const c of nb.cells ?? []) {
    const src = join(c.source).trimEnd();
    if (c.cell_type === 'markdown') out.push('# %% [markdown]\n' + src.split('\n').map((l) => `# ${l}`).join('\n'));
    else if (c.cell_type === 'code') {
      out.push('# %%\n' + src);
      for (const o of c.outputs ?? []) {
        const t = join(o.text ?? o.data?.['text/plain']).trim();
        if (t) out.push('# Output:\n' + t.slice(0, 600).split('\n').map((l) => `# ${l}`).join('\n'));
      }
    }
  }
  return out.join('\n\n');
}

const fenceFor = (s) => '`'.repeat(Math.max(3, (s.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0) + 1));

/**
 * Classifies and reads one uploaded file.
 * @returns {{kind:'image', name, mime, dataUrl, size} | {kind:'code', name, language, text, lines, truncated}}
 */
export function readUpload(file, limits) {
  const name = baseOf(file.name);
  const lower = name.toLowerCase();
  const ext = extOf(name);
  const { buffer } = file;

  const sniffed = sniffImage(buffer);
  const declaredImage = String(file.mime).startsWith('image/') || IMAGE_EXT.includes(ext);
  if (sniffed || (declaredImage && ext !== 'svg')) {
    if (!sniffed) throw new HttpError(415, `${name} is an image format the assistant can't read. Please use PNG, JPG or WebP.`, { code: 'unsupported_image' });
    if (buffer.length > limits.maxImageBytes) throw new HttpError(413, `${name} is over ${Math.round(limits.maxImageBytes / 1048576)} MB.`, { code: 'too_large' });
    return { kind: 'image', name, mime: sniffed, size: buffer.length, dataUrl: `data:${sniffed};base64,${buffer.toString('base64')}` };
  }

  const language = NAMED[lower] ?? CODE[ext];
  if (buffer.length > limits.maxTextBytes) throw new HttpError(413, `${name} is too large to read (${Math.round(limits.maxTextBytes / 1048576)} MB max).`, { code: 'too_large' });
  const binaryKind = detectBinaryKind(buffer);
  if (binaryKind || looksBinary(buffer)) {
    throw new HttpError(415, `${name} is ${binaryKind ? `${binaryKind}, ` : 'a binary file, '}not source code or text. Attach source code, text, or an image.`, { code: 'binary_file' });
  }

  let text = decodeText(buffer);
  if (ext === 'ipynb') {
    try { text = notebookToText(text); } catch { throw new HttpError(415, `${name} is not a valid Jupyter notebook.`, { code: 'bad_notebook' }); }
  }
  const lines = text.length ? text.split('\n').length : 0;
  let truncated = false;
  if (text.length > limits.maxFileChars) { text = text.slice(0, limits.maxFileChars); truncated = true; }
  return { kind: 'code', name, language: language ?? 'text', text, lines, truncated };
}

/** Same block format the web app builds in the browser, so the model sees one consistent shape. */
export function buildFileBlocks(codeFiles, limits, startIndex = 1) {
  let budget = limits.maxTotalChars;
  return codeFiles.map((f, i) => {
    let body = f.text;
    let cut = f.truncated;
    if (body.length > budget) { body = body.slice(0, Math.max(0, budget)); cut = true; }
    budget -= body.length;
    const fence = fenceFor(body);
    return `[File ${startIndex + i}: ${f.name} — ${languageLabel(f.language)}, ${f.lines} lines${cut ? ', truncated for length' : ''}]\n${fence}${f.language}\n${body}\n${fence}`;
  });
}
