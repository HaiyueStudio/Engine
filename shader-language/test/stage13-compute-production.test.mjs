import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { PRODUCTION_COMPUTE_OPERATIONS, ShaderComposerError, compileProductionComputeFamilyV1 } from '../dist/index.js';

const path = 'shader-language/builtin-compute-family.json';
const source = await readFile(new URL('../builtin-compute-family.json', import.meta.url), 'utf8');
const compiled = compile(source);

test('stage 13 compiles all production compute passes as one typed side-effect family', () => {
  assert.equal(compiled.family.abiVersion, 1);
  assert.equal(compiled.artifact.version, 2);
  assert.equal(compiled.artifact.compilerVersion, 'shader-language-stage13');
  assert.deepEqual(compiled.family.passes.map(pass => pass.operation), [...PRODUCTION_COMPUTE_OPERATIONS]);
  assert.equal(new Set(compiled.family.passes.map(pass => pass.canonicalHash)).size, 5);
  for (const pass of compiled.family.passes) {
    assert.deepEqual(pass.workgroupSize, [64, 1, 1]);
    assert.ok(pass.effects.length > 0);
    assert.ok(pass.resources.every(resource => resource.access === 'read' || pass.effects.some(effect => effect.resource === resource.id)));
    assert.match(compiled.passes[pass.id].code, new RegExp(`haiyue:compute-ir ${pass.canonicalHash}`));
    assert.match(compiled.passes[pass.id].code, new RegExp(`haiyue:compute-module ${compiled.computeModuleHash}`));
  }
  assert.equal(compile(source).artifact.artifactHash, compiled.artifact.artifactHash);
});

test('stage 13 freezes resource access, effects, workgroups and multi-dispatch scheduling in reflection', () => {
  const cull = compiled.family.passes.find(pass => pass.id === 'instanced-cull');
  assert.deepEqual(cull.effects, [
    { kind: 'store', resource: 'pass.visibleIndices' },
    { kind: 'atomic-add', resource: 'pass.visibleCounter' },
  ]);
  assert.equal(cull.resources.find(resource => resource.id === 'pass.visibleCounter').access, 'atomic-read-write');
  assert.equal(compiled.family.passes.find(pass => pass.id === 'gpu-sort-bitonic').dispatch.schedule, 'bitonic-network');
  assert.equal(compiled.artifact.passes['gpu-draw-command'].bindGroups[0].bindings[3].layout.minBindingSize, 16);
  assert.equal(compiled.artifact.passes['instanced-depth-sort-key'].uniformBlocks[0].byteSize, 80);
  assert.ok(compiled.artifact.passes['mesh3d-cull'].passRequirements.includes('effect-store:pass.drawIndirect'));
});

test('stage 13 rejects undeclared atomic effects, invalid workgroups and wrong schedules', () => {
  const atomicMismatch = source.replace('{ "kind": "atomic-add", "resource": "pass.visibleCounter" }', '{ "kind": "store", "resource": "pass.visibleCounter" }');
  assert.throws(() => compile(atomicMismatch), ShaderComposerError);
  const invalidWorkgroup = source.replace('"workgroupSize": [64, 1, 1]', '"workgroupSize": [512, 1, 1]');
  assert.throws(() => compile(invalidWorkgroup), ShaderComposerError);
  const invalidSchedule = source.replace('"schedule": "bitonic-network"', '"schedule": "single"');
  assert.throws(() => compile(invalidSchedule), ShaderComposerError);
});

test('stage 13 removes handwritten production compute WGSL and keeps raw ComputeKernel explicit', async () => {
  const consumers = await Promise.all([
    '../../engine/src/compute/GpuDrawCommandComputePass.ts',
    '../../engine/src/compute/GpuSortComputePass.ts',
    '../../engine/src/compute/Mesh3DGpuCullComputePass.ts',
    '../../engine/src/renderer/InstancedMesh3DRenderer.ts',
  ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.ok(consumers.every(value => /getBuiltinComputeShader/.test(value)));
  assert.match(await readFile(new URL('../../engine/src/compute/ComputeKernel.ts', import.meta.url), 'utf8'), /code:\s*string/);
  for (const file of ['gpu-draw-command.comp.wgsl', 'gpu-sort-bitonic.comp.wgsl', 'instanced-cull.comp.wgsl', 'instanced-depth-sort-key.comp.wgsl', 'mesh3d-cull.comp.wgsl']) {
    await assert.rejects(access(new URL(`../../engine/src/shaders/${file}`, import.meta.url)));
  }
});

function compile(value) { return compileProductionComputeFamilyV1(value, { sourcePath: path, sourceSha256: sha256(value) }); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
