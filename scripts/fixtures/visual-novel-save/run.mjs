import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runChromeWebGpuFixture } from '../../webgpu-gate/chrome-runner.mjs';
import { buildSaveFixture, engineRoot, evidenceRoot } from './build.mjs';

const id = process.argv[2] ?? `native-${Date.now()}`;
assert(/^[a-z0-9][a-z0-9-]+$/u.test(id), 'Use a fresh run ID.');
const root = join(evidenceRoot, id);
await mkdir(evidenceRoot, { recursive: true });
await mkdir(root);
const entry = await buildSaveFixture(root, true);
const script = '<script type="module" src="./fixture.mjs"></script>';
await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><title>G05 save restart</title><iframe title="Story" width="360" height="230"></iframe><pre id="result"></pre>' + script);
await writeFile(join(root, 'child.html'), '<!doctype html><meta charset="utf-8"><title>G05 story</title><canvas id="stage" tabindex="0"></canvas>' + script);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const dirs = ['extensions/src/visual-novel/save', 'extensions/src/visual-novel/stage', 'extensions/src/visual-novel/ui',
  'scripts/fixtures/visual-novel-save'];
const inputs = (await Promise.all(dirs.map(async path => (await readdir(join(engineRoot, path))).sort().map(name => path + '/' + name)))).flat();
inputs.push('scripts/fixtures/visual-novel-stage/assets.mjs', 'config/visual-novel-024-contract.json', 'engine/dist/save.js',
  'engine/dist/gui.js', 'engine/dist/audio.js', 'extensions/dist/hya-player.js');
const inputSha256 = Object.fromEntries(await Promise.all(inputs.map(async path => [path, digest(await readFile(join(engineRoot, path)))])));
let result;
try {
  result = await runChromeWebGpuFixture({ root, fixture: 'index.html', timeoutMs: 100_000,
    acceptedStatuses: ['passed','failed'], disableDx12InfoCollection: true, navigateAwayAfterResult: true });
} catch (error) { result = { status: 'failed-launch', error: error.stack }; }
const { images, ...receipt } = result;
const imageHashes = {};
for (const [name, encoded] of Object.entries(images ?? {})) {
  assert(/^[a-z-]+$/u.test(name));
  const bytes = Buffer.from(encoded, 'base64');
  await writeFile(join(root, name + '.png'), bytes);
  imageHashes[name] = { bytes: bytes.length, sha256: digest(bytes) };
}
await writeFile(join(root, 'result.json'), JSON.stringify({ id, node: process.version, platform: process.platform, inputSha256,
  bundleSha256: digest(await readFile(entry)), imageHashes, ...receipt }, null, 2) + '\n');
console.log(JSON.stringify({ id, status: result.status, cases: result.cases?.map(row => row.id), error: result.error }));
if (result.status !== 'passed') process.exitCode = 1;
