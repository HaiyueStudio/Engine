import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = resolve(root, 'artifacts/webgpu/transparent-batching.json');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/transparent-batching-fixture.html',
  timeoutMs: 300_000,
});

const cases = new Map(result.cases.map(item => [item.id, item]));
const additive = requiredCase(cases, 'additive-1000');
const alpha = requiredCase(cases, 'alpha-64');
const volume = requiredCase(cases, 'volume-16');
if (additive.after.draws >= additive.before.draws) {
  throw new Error(`Additive draw count did not decrease: ${additive.before.draws} -> ${additive.after.draws}`);
}
for (const item of [additive, alpha, volume]) {
  if (item.pixelComparison.mismatchedPixels !== 0 || item.pixelComparison.maxChannelDelta !== 0) {
    throw new Error(`${item.id} pixel comparison failed`);
  }
}
for (const item of [alpha, volume]) {
  if (item.before.draws !== item.after.draws || item.drawReduction !== 0) {
    throw new Error(`${item.id} illegally changed draw count: ${item.before.draws} -> ${item.after.draws}`);
  }
}

mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`[transparent-batching] additive draws ${additive.before.draws} -> ${additive.after.draws}; passes ${additive.before.passes} -> ${additive.after.passes}; pixel mismatches ${additive.pixelComparison.mismatchedPixels}.`);
console.log(`[transparent-batching] alpha draws ${alpha.before.draws} -> ${alpha.after.draws}; Volume draws ${volume.before.draws} -> ${volume.after.draws}; both exact pixel matches.`);
console.log(`[transparent-batching] Wrote ${relative(root, artifactPath)}.`);

function requiredCase(cases, id) {
  const result = cases.get(id);
  if (!result) throw new Error(`Missing transparent batching result ${id}`);
  return result;
}
