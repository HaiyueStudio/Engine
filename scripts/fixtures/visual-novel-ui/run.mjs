import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { runChromeWebGpuFixture } from '../../webgpu-gate/chrome-runner.mjs';
import { compileReadingFixture, engineRoot, evidenceRoot } from './compile.mjs';

const id = process.argv[2] ?? `native-${Date.now()}`;
assert(/^[a-z0-9][a-z0-9-]+$/u.test(id), 'Use a fresh, simple run ID.');
const file = 'index.html', root = join(evidenceRoot, id);
await mkdir(evidenceRoot, { recursive: true });
await mkdir(root);
const compiled = await compileReadingFixture(join(root, 'compiled'));
const privateEntries = {
  'g04:read': 'visual-novel/ui/ReadingPlayback.js',
  'g04:gui': 'visual-novel/ui/GuiReading.js',
  'g04:voice': 'visual-novel/audio/ReadingAudio.js',
  'g04:game-audio': 'audio/GameAudio.js',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [
  'engine/src/audio/OwnerSafeAudioMixer.ts', 'extensions/src/audio/GameAudio.ts',
  ...await Promise.all(['extensions/src/visual-novel/ui', 'extensions/src/visual-novel/audio', 'scripts/fixtures/visual-novel-ui']
    .map(async base => (await readdir(join(engineRoot, base))).sort().map(name => `${base}/${name}`))).then(list => list.flat()),
  'engine/dist/audio.js', 'engine/dist/gui.js',
];
const inputSha256 = Object.fromEntries(await Promise.all(files.map(async path => [path, digest(await readFile(join(engineRoot, path)))])));
const bundle = await rollup({
  input: join(import.meta.dirname, 'fixture.mjs'),
  plugins: [{
    name: 'g04-private-entry',
    resolveId(id) { return Object.hasOwn(privateEntries, id) ? join(compiled, privateEntries[id]) : null; },
  }, nodeResolve({ browser: true, preferBuiltins: false, rootDir: engineRoot }), commonjs()],
});
try { await bundle.write({ dir: root, format: 'es', entryFileNames: 'fixture.js', chunkFileNames: 'chunks/[name]-[hash].js' }); }
finally { await bundle.close(); }
await writeFile(join(root, file), '<!doctype html><meta charset="utf-8"><title>G04 reading fixture</title><canvas id="stage" tabindex="0"></canvas><pre id="result"></pre><script type="module" src="./fixture.js"></script>');
let result;
try {
  result = await runChromeWebGpuFixture({
    root, fixture: file, timeoutMs: 90_000, acceptedStatuses: ['passed','failed'],
    disableDx12InfoCollection: true, navigateAwayAfterResult: true,
  });
} catch (error) { result = { status: 'failed-launch', error: error.stack }; }
const { images, ...receipt } = result;
const imageHashes = {};
for (const [name, data] of Object.entries(images ?? {})) {
  assert(/^[a-z-]+$/u.test(name));
  const bytes = Buffer.from(data, 'base64');
  await writeFile(join(root, name + '.png'), bytes);
  imageHashes[name] = { bytes: bytes.length, sha256: digest(bytes) };
}
await writeFile(join(root, 'result.json'), JSON.stringify({
  runId: id, node: process.version, platform: process.platform, inputSha256,
  bundleSha256: digest(await readFile(join(root, 'fixture.js'))), imageHashes, ...receipt,
}, null, 2) + '\n');
console.log(JSON.stringify({ id, status: result.status, cases: result.cases?.map(item => item.id), error: result.error }));
if (result.status !== 'passed') process.exitCode = 1;
