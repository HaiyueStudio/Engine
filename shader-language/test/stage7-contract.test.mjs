import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stage7Contract = JSON.parse(await readFile(new URL('../stage7-contract.json', import.meta.url), 'utf8'));
const migrationManifest = JSON.parse(await readFile(new URL('../migration-manifest.json', import.meta.url), 'utf8'));
const artifactSchema = JSON.parse(await readFile(new URL('../precompiled-artifact-v2.schema.json', import.meta.url), 'utf8'));

test('stage 7 freezes artifact v2 multi-group ownership without a production migration', () => {
  assert.equal(stage7Contract.phase, 7);
  assert.equal(stage7Contract.status, 'implemented');
  assert.deepEqual(stage7Contract.artifact.compatibleVersions, [1, 2]);
  assert.deepEqual(stage7Contract.artifact.layoutOwners, ['artifact', 'renderer']);
  assert.equal(stage7Contract.artifact.multiBindGroup, true);
  assert.equal(stage7Contract.runtime.externalLayoutIdentityInCacheKey, true);
  assert.equal(stage7Contract.runtime.missingRendererLayoutFailsBeforeGpuAllocation, true);
  assert.equal(stage7Contract.productionMigrations.length, 0);
  assert.deepEqual(stage7Contract.publicApiChanges, []);
  assert.equal(stage7Contract.apiBaselineUpdated, false);
});

test('stage 7 compatibility record is historical while current runtime is v2-only', async () => {
  const runtimeSource = await readFile(new URL('../../engine/src/shader/PrecompiledShaderRuntime.ts', import.meta.url), 'utf8');
  const motionArtifact = await readFile(new URL('../../engine/src/shaders/generated/motion-blur-artifact.generated.ts', import.meta.url), 'utf8');
  assert.match(runtimeSource, /artifact\.version !== 2/);
  assert.doesNotMatch(runtimeSource, /PrecompiledShaderArtifactV1|artifact\.version === 1/);
  assert.match(motionArtifact, /"version": 2/);
  assert.doesNotMatch(motionArtifact, /PrecompiledShaderArtifactV1/);
});

test('artifact v2 JSON schema requires complete ownership and binding reflection', () => {
  assert.equal(artifactSchema.properties.version.const, 2);
  assert.deepEqual(artifactSchema.$defs.bindGroup.required, [
    'logicalSpace', 'logicalGroup', 'physicalGroup', 'owner', 'bindings',
  ]);
  assert.deepEqual(artifactSchema.$defs.bindGroup.properties.owner.enum, ['artifact', 'renderer']);
  assert.equal(artifactSchema.$defs.bindingLayout.oneOf.length, 5);
  assert.ok(artifactSchema.required.includes('artifactHash'));
});

test('current migration manifest preserves the stage 7 inventory and explicit raw escape hatches', () => {
  const sources = migrationManifest.sourceFamilies.flatMap(family => family.sources);
  const generated = migrationManifest.sourceFamilies
    .filter(family => family.status === 'generated')
    .flatMap(family => family.sources);
  assert.ok(migrationManifest.stage >= 7);
  assert.ok(sources.length >= stage7Contract.inventory.wgslSourceCount);
  assert.equal(new Set(sources).size, sources.length);
  assert.ok(generated.length >= stage7Contract.inventory.generatedSourceCount);
  assert.equal(migrationManifest.escapeHatches.length, stage7Contract.inventory.escapeHatchCount);
  assert.equal(migrationManifest.escapeHatches.find(entry => entry.id === 'custom-pass').disposition, 'retain-raw-wgsl');
  assert.equal(migrationManifest.escapeHatches.find(entry => entry.id === 'compute-kernel').disposition, 'retain-raw-wgsl');
});

test('stage 7 repository wiring keeps the runtime private and retains its original production generator', async () => {
  const [rootManifest, engineManifest, engineRollup, runtimeSource, registrySource, cacheGate] = await Promise.all([
    readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../engine/package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../engine/rollup.config.js', import.meta.url), 'utf8'),
    readFile(new URL('../../engine/src/shader/PrecompiledShaderRuntime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/generate-production-shaders.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/verify-production-cache.mjs', import.meta.url), 'utf8'),
  ]);
  const dependencies = { ...engineManifest.dependencies, ...engineManifest.devDependencies };
  assert.equal(dependencies['@haiyue/shader-language'], undefined);
  assert.equal(engineManifest.exports['./internal/precompiled-shader-runtime'], undefined);
  assert.match(engineRollup, /internal\/precompiled-shader-runtime/);
  assert.match(runtimeSource, /rendererOwnedLayouts/);
  assert.match(runtimeSource, /rendererLayoutId/);
  assert.match(runtimeSource, /storage-texture/);
  assert.match(registrySource, /PRODUCTION_SHADER_GENERATORS/);
  assert.match(registrySource, /id: 'motion-blur'/);
  assert.match(rootManifest.scripts['shader-language:check'], /verify-production-cache\.mjs/);
  assert.match(cacheGate, /generate-production-shaders\.mjs/);
  assert.match(rootManifest.scripts['verify:shader-language-stage7'], /verify-webgpu-shader-language-stage7\.mjs/);
});
