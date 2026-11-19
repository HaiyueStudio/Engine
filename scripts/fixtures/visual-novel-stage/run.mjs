import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { runChromeWebGpuFixture } from '../../webgpu-gate/chrome-runner.mjs';
import { owns, stageSource, resolveStageImport, transpile } from './source-loader.mjs';

const engine = resolve(import.meta.dirname, '../../..');
const evidence = resolve(engine, 'artifacts/engine-0.2.4/g03');
const isolated = resolve(engine, 'artifacts/engine-0.2.4/g01/consumer');
const runId = process.argv[2] ?? `native-${Date.now()}`;
const size = process.argv[3] ?? '320x200';
const rounds = Number(process.argv[4] ?? 1);
assert(/^[a-z0-9][a-z0-9-]+$/u.test(runId) && ['320x200', '1280x720'].includes(size) && [1, 3].includes(rounds), 'Usage: run.mjs run-id [320x200|1280x720] [1|3]');
const root = join(evidence, runId);
await mkdir(evidence, { recursive: true });
await mkdir(root);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const provenance = await json(join(isolated, 'package-provenance.json'));
const lockPath = join(isolated, 'package-lock.json');
const lock = await json(lockPath);
const exportsByPackage = new Map();
for (const pack of provenance.packages) {
  const file = await readFile(join(isolated, pack.path));
  assert.equal(sha(file), pack.sha256);
  assert.equal(file.length, pack.bytes);
  assert.equal(lock.packages[`node_modules/${pack.package}`].integrity, pack.integrity);
  const directory = await realpath(join(isolated, 'node_modules', pack.package));
  assert(directory.startsWith(join(isolated, 'node_modules') + sep));
  const installed = await json(join(directory, 'package.json'));
  assert.equal(installed.version, pack.version);
  exportsByPackage.set(pack.package, { directory, exports: installed.exports });
}
const image = await json(join(isolated, 'probe-image.json'));
const imageBytes = await readFile(join(isolated, 'probe-image.png'));
assert.equal(sha(imageBytes), image.sha256);
await copyFile(join(isolated, 'probe-image.png'), join(root, 'image.png'));
await writeFile(join(root, 'image.json'), JSON.stringify(image) + '\n');
await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><title>G03 stage WebGPU</title><canvas id="stage"></canvas><pre id="result"></pre><script type="module" src="./fixture.js"></script>');

const files = (await readdir(stageSource)).map(name => new URL(name, stageSource));
files.push(...(await readdir(import.meta.dirname)).filter(name => /\.mjs$/u.test(name)).map(name => new URL(name, import.meta.url)));
const sources = Object.fromEntries(await Promise.all(files.map(async url => [
  fileURLToPath(url).slice(engine.length + 1).split(sep).join('/'), sha(await readFile(url)),
])));
const bundle = await rollup({
  input: join(import.meta.dirname, 'fixture.mjs'),
  plugins: [{
    name: 'g03-stage-with-real-published-foundations',
    resolveId(specifier, importer) {
      const parent = importer && pathToFileURL(importer).href;
      if (specifier === 'g03:stage') return fileURLToPath(new URL('hya-stage.ts', stageSource));
      if (specifier === 'g03:stage-action') return fileURLToPath(new URL('narrative-stage.ts', stageSource));
      const mapped = owns(parent) && specifier === '../../hya-player.js' ? '@haiyue/extensions/hya-player' : specifier;
      if (mapped.startsWith('@haiyue/')) {
        const [scope, name, ...subpath] = mapped.split('/');
        const pack = exportsByPackage.get(`${scope}/${name}`);
        const entry = pack?.exports[subpath.length ? './' + subpath.join('/') : '.'];
        const file = typeof entry === 'string' ? entry : entry?.import;
        assert(file && !file.includes('..'), 'Unknown published import ' + mapped);
        return resolve(pack.directory, file);
      }
      const local = resolveStageImport(specifier, parent);
      if (local) return fileURLToPath(local);
    },
    transform(code, id) {
      if (owns(pathToFileURL(id).href) && id.endsWith('.ts')) return transpile(code, id);
    },
  }, nodeResolve({ browser: true, preferBuiltins: false, rootDir: isolated }), commonjs()],
});
try { await bundle.write({ dir: root, format: 'es', entryFileNames: 'fixture.js', chunkFileNames: 'chunks/[name]-[hash].js' }); }
finally { await bundle.close(); }
const meta = { runId, size, platform: process.platform, node: process.version, sources, provenance, lockSha256: sha(await readFile(lockPath)),
  bundleSha256: sha(await readFile(join(root, 'fixture.js'))), imageSha256: image.sha256 };
let failed = false;
for (let round = 1; round <= rounds; round++) {
  let result;
  try {
    result = await runChromeWebGpuFixture({
      root, fixture: 'index.html', query: { size }, timeoutMs: 110_000, acceptedStatuses: ['passed', 'failed'],
      disableDx12InfoCollection: true, navigateAwayAfterResult: true,
    });
  } catch (error) { result = { status: 'failed-launch', error: error.stack }; }
  await writeFile(join(root, `round-${round}.json`), JSON.stringify({ ...meta, round, ...result }, null, 2) + '\n');
  console.log(JSON.stringify({ round, size, status: result.status, cases: result.cases?.map(({ id }) => id), error: result.error }));
  failed ||= result.status !== 'passed';
}
if (failed) process.exitCode = 1;
