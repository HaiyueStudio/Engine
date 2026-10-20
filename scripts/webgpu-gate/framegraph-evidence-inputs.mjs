import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deferredRuntimeFingerprint, sha256 } from './deferred-fixture-policy.mjs';

const self = 'scripts/webgpu-gate/framegraph-evidence-inputs.mjs';
const records = (root, paths) => Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));

export async function productionEvidenceInputs(root) {
  const paths = ['config/framegraph-production-021.json', 'scripts/verify-framegraph-production.mjs',
    ...['framegraph-production-scene.mjs', 'framegraph-production-fixture.mjs', 'framegraph-production-fixture.html',
      'framegraph-production-policy.mjs', 'framegraph-production-artifact.mjs', 'deferred-room-fixture.mjs',
      'chrome-runner.mjs', 'chrome-profile-cleanup.ps1', 'framegraph-presentation.mjs'].map(file => `scripts/webgpu-gate/${file}`),
    'scripts/visual-regression/png.mjs', self];
  return sha256(JSON.stringify({ runtime: await deferredRuntimeFingerprint(root), harness: await records(root, paths) }));
}

export async function studyEvidenceInputs(root, mode) {
  if (!['resources', 'ablation'].includes(mode)) throw Error('Unknown study input mode');
  const fixture = mode === 'resources' ? 'framegraph-resource-study-fixture.mjs' : 'framegraph-ablation-study-fixture.mjs';
  const paths = ['run-framegraph-study.mjs', 'framegraph-study-policy.mjs', 'framegraph-study-artifact.mjs',
    'framegraph-study-fixture.html', fixture, 'framegraph-production-scene.mjs', 'framegraph-production-policy.mjs',
    'deferred-room-fixture.mjs', 'chrome-runner.mjs', 'chrome-profile-cleanup.ps1', 'framegraph-presentation.mjs'].map(file => `scripts/webgpu-gate/${file}`);
  paths.push('config/framegraph-production-021.json', 'scripts/visual-regression/png.mjs', self);
  return { runtime: await deferredRuntimeFingerprint(root), harness: await records(root, paths) };
}

export async function lightingContinuousEvidenceInputs(root, config) {
  const paths = (await readdir(resolve(root, 'scripts/webgpu-gate')))
    .filter(file => /^(deferred-g05-|deferred-room-|run-g05-continuous|build-g05-forward|framegraph-(pixel-oracle|batch-completion)|float-texture|lighting-scaling-|chrome-)/.test(file)
      && /\.(mjs|html)$/.test(file) && !file.includes('.test.'))
    .sort().map(file => `scripts/webgpu-gate/${file}`);
  paths.push('config/lighting-continuous-021.json', config.frozenBudget.path, 'scripts/webgpu-gate/chrome-profile-cleanup.ps1', self);
  const files = await records(root, paths);
  return { runtime: await deferredRuntimeFingerprint(root), files, harness: sha256(JSON.stringify(files)) };
}
