import assert from 'node:assert/strict';
import { cp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../../../scripts/webgpu-gate/chrome-runner.mjs';

const output = resolve(process.argv[2]);
const name = process.argv[3] ?? 'consumer';
assert(['consumer', 'blank', 'edited'].includes(name), 'Unknown G06 consumer directory.');
const root = join(output, name, 'dist');
await cp(fileURLToPath(new URL('./native-flow.mjs', import.meta.url)), join(root, 'proof.mjs'));
await writeFile(join(root, 'proof.html'), `<!doctype html><meta charset="utf-8"><title>G06 production slice</title>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}pre{display:none}</style>
<iframe title="The Last Lantern"></iframe><pre id="progress"></pre><pre id="result"></pre>
<script type="module" src="./proof.mjs"></script>`);
try {
  const data = await runChromeWebGpuFixture({ root, fixture: 'proof.html', query: { edited: name === 'edited' }, timeoutMs: 95_000,
    visualCapture: { viewportWidth: 1280, viewportHeight: 860, sampleWidth: 32, sampleHeight: 20 } });
  const { pngBase64, ...metrics } = data.visualCapture;
  assert(pngBase64 && metrics.darkRatio < .95, 'The production slice did not render a readable page.');
  await writeFile(join(output, name + '-screenshot.png'), Buffer.from(pngBase64, 'base64'));
  await writeFile(join(output, name + '-native.json'), JSON.stringify({ status: 'passed', ...data, visualCapture: metrics }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', layers: data.layers, endings: data.editedEnding ?? [data.lantern, data.tide], gpu: data.gpu }));
} catch (error) {
  await writeFile(join(output, name + '-native-failure-' + Date.now() + '.txt'), String(error.stack ?? error));
  throw error;
}
