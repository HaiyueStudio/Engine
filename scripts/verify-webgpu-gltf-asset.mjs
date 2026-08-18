import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChromePath, defaultWebGpuAngleBackend, runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { validateGltfCorpusResult } from './webgpu-gate/gltf-corpus-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.GLTF_ASSET_BASELINE_OUTPUT ?? 'artifacts/webgpu/gltf-asset-first-frame.json');
const manifestPath = resolve(root, 'scripts/webgpu-gate/assets/gltf-corpus/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const required of [
  'engine/dist/index.js',
  'extensions/dist/gltf.js',
  'extensions/dist/gltf-animation3d.js',
]) {
  if (!existsSync(resolve(root, required))) throw new Error(`glTF asset gate requires ${required}; build the workspace first.`);
}
const reference = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/gltf-corpus-fixture.html',
  query: { mode: 'reference' },
  timeoutMs: 180_000,
});
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/gltf-corpus-fixture.html',
  query: { mode: 'optimized' },
  timeoutMs: 180_000,
});
const validationErrors = validateGltfCorpusResult(result, manifest);
const artifact = {
  ...result,
  comparison: {
    policy: 'same pinned corpus, upload budget, render path, and pixel gate; reference disables glTF and KTX2 workers',
    before: selectEvidence(reference),
    after: selectEvidence(result),
  },
  gate: {
    status: validationErrors.length === 0 ? 'passed' : 'failed',
    checkedAt: new Date().toISOString(),
    chromePath: process.env.CHROME_PATH ?? defaultChromePath(),
    angleBackend: process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend(),
    validationErrors,
    manifest: relative(root, manifestPath),
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
if (validationErrors.length > 0) throw new Error(`Chrome/WebGPU glTF asset gate failed:\n- ${validationErrors.join('\n- ')}\nArtifact: ${relative(root, output)}`);
console.log(
  `[gltf-asset-gate] passed: 3 production tiers in ${result.timings.firstVisibleFrameMs.toFixed(1)}ms, `
  + `GPU peak ${Math.round(result.resources.peakGpuEstimatedBytes / 1024)}KiB, `
  + `CPU staging peak ${Math.round(result.resources.peakCpuStagingBytes / 1024)}KiB, residual=0.`,
);
const referenceLarge = reference.tiers.find(tier => tier.id === 'large');
const optimizedLarge = result.tiers.find(tier => tier.id === 'large');
console.log(
  `[gltf-asset-gate] large reference ${referenceLarge.timings.firstVisibleFrameMs.toFixed(1)}ms -> `
  + `optimized ${optimizedLarge.timings.firstVisibleFrameMs.toFixed(1)}ms.`,
);
console.log(`[gltf-asset-gate] Wrote ${relative(root, output)}.`);

function selectEvidence(run) {
  return {
    configuration: run.configuration,
    animation3D: run.animation3D,
    tiers: run.tiers,
    timings: run.timings,
    resources: run.resources,
    lifecycle: run.lifecycle,
    validation: run.validation,
  };
}
