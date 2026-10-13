import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { Font, Glyph, Path } from 'opentype.js';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'artifacts/animation-font-loading', new Date().toISOString().replace(/[:.]/gu, '-'));
mkdirSync(directory, { recursive: true });
const input = resolve(import.meta.dirname, 'animation-font-loading-fixture.mjs');
const parserDirectory = resolve(root, 'extensions/dist/chunks');
const parserChunk = readdirSync(parserDirectory).filter(name => /^opentype\.module-.*\.js$/u.test(name));
assert.equal(parserChunk.length, 1, 'expected one published OpenType parser chunk');
const bundle = await rollup({ input, plugins: [{
  name: 'reference-published-font-parser',
  // Reuse the published parser for synchronous reference preparation; do not
  // accidentally bundle a second copy from node_modules into this test.
  resolveId(id) { return id === 'opentype.js' ? resolve(parserDirectory, parserChunk[0]) : null; },
}, nodeResolve({ browser: true }), commonjs()] });
let output;
try {
  ({ output } = await bundle.write({ dir: directory, format: 'es', entryFileNames: 'fixture.js', chunkFileNames: '[name]-[hash].js' }));
} finally { await bundle.close(); }
// A small original outline avoids host fonts, network assets and third-party font licenses.
const path = new Path();
path.moveTo(80, 0); path.lineTo(300, 700); path.lineTo(520, 0); path.close();
const font = new Font({ familyName: 'Lazy Test Font', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200,
  glyphs: [new Glyph({ name: '.notdef', advanceWidth: 600, path: new Path() }),
    new Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path })] });
const bytes = Buffer.from(font.toArrayBuffer());
writeFileSync(resolve(directory, 'font.otf'), bytes);
writeFileSync(resolve(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><pre id="result"></pre><script type="module" src="./fixture.js"></script>');
const result = await runChromeWebGpuFixture({ root, fixture: `${relative(root, directory).split('\\').join('/')}/index.html`, timeoutMs: 60000 });
writeFileSync(resolve(directory, 'browser-result.json'), JSON.stringify(result, null, 2) + '\n');
assert.equal(result.fontByteLength, bytes.length);
assert.equal(result.fontSha256, createHash('sha256').update(bytes).digest('hex'));
assert.equal(result.browserDiagnostics.unclassifiedFailureCount, 0);
const parserFiles = result.httpProvenance.files.filter(file => /opentype\.module-/u.test(file.sourcePath));
assert.equal(parserFiles.length, 1);
const sha256 = content => createHash('sha256').update(content).digest('hex');
result.inputs = [input, resolve(root, 'extensions/src/animation/AnimationOpenType.ts'),
  resolve(root, 'extensions/src/animation/AnimationTextRasterizer.ts'), resolve(root, 'extensions/src/animation/Animation2DRuntime.ts')]
  .map(file => ({ path: relative(root, file).split('\\').join('/'), sha256: sha256(readFileSync(file)) }));
result.emittedFiles = output.filter(file => file.type === 'chunk').map(file => ({ fileName: file.fileName, sha256: sha256(file.code) }));
result.generatedAt = new Date().toISOString();
writeFileSync(resolve(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, directory, cases: result.cases, parserRequests: result.parserRequests }, null, 2));
