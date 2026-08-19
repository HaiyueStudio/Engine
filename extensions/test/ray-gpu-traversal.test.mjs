import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const compiled = mkdtempSync(join(tmpdir(), 'haiyue-ray-gpu-'));
mkdirSync(join(compiled, 'node_modules/@haiyue'), { recursive: true });
symlinkSync(resolve(root, 'node_modules/wgpu-matrix'), join(compiled, 'node_modules/wgpu-matrix'), 'junction');
symlinkSync(resolve(root, 'engine'), join(compiled, 'node_modules/@haiyue/engine'), 'junction');
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));
execFileSync(process.execPath, [
  resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types',
  '--rootDir', resolve(root, 'extensions/src'), '--outDir', compiled,
  resolve(root, 'extensions/src/ray-tracing/traversal/index.ts'),
], { cwd: root, stdio: 'pipe' });

const traversal = await import(pathToFileURL(join(compiled, 'ray-tracing/traversal/index.js')));
const acceleration = await import(pathToFileURL(join(compiled, 'ray-tracing/acceleration/index.js')));

test('Artifact V2 source, reflection, frozen acceleration ABI, and generated browser module do not drift', () => {
  const output = execFileSync(process.execPath, ['scripts/verify-ray-traversal-shader.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /verified Artifact V2/);
  assert.equal(traversal.RAY_TRAVERSAL_LAYOUT.artifactVersion, 2);
  assert.equal(traversal.RAY_TRAVERSAL_LAYOUT.stackCapacity, 64);
  assert.equal(traversal.RAY_TRAVERSAL_LAYOUT.requiredStorageBuffersPerShaderStage, 8);
  assert.equal(acceleration.RAY_ACCELERATION_ABI_FINGERPRINT, 'fnv1a64:9fd4d41c38d10fa2');
});

test('RenderPlan deterministically orders upload, every traversal dispatch, and consumer', () => {
  const plan = traversal.createRayTraversalDispatchPlan(130, 64);
  assert.equal(plan.dispatchCount, 3);
  assert.deepEqual(plan.passes.map(pass => pass.label), [
    'ray.upload', 'ray.traversal.0', 'ray.traversal.1', 'ray.traversal.2', 'ray.consumer',
  ]);
  assert.throws(() => traversal.createRayTraversalDispatchPlan(-1, 64), /rayCount/);
  assert.throws(() => traversal.createRayTraversalDispatchPlan(1, 0), /maxRaysPerDispatch/);
});

test('unsupported WebGPU limits fail structurally before allocation and never choose a CPU fallback', async () => {
  const packed = buildPacked();
  const fakeDevice = {
    limits: {
      maxStorageBuffersPerShaderStage: 7,
      maxBindingsPerBindGroup: 9,
      maxBufferSize: 1_000_000,
      maxStorageBufferBindingSize: 1_000_000,
    },
  };
  const result = await traversal.RayTraversalRuntime.create(fakeDevice, packed);
  assert.equal(result.runtime, null);
  assert.ok(result.diagnostics.some(entry => entry.code === 'RAY_GPU_LIMIT_UNSUPPORTED'));
  assert.ok(result.diagnostics.every(entry => !/fallback/iu.test(entry.message) || /did not fall back|without.*fallback/iu.test(entry.message)));
});

test('RT math uses wgpu-matrix while AABB/f32 serialization stays RT-specific, and BVH owners remain separate', () => {
  const reference = read('extensions/src/ray-tracing/reference/index.ts');
  const scene = read('extensions/src/ray-tracing/scene/index.ts');
  const math = read('extensions/src/ray-tracing/acceleration/math.ts');
  assert.match(reference, /import \{ mat4n, vec3n \} from 'wgpu-matrix'/);
  assert.match(scene, /mat4n\.multiply/);
  assert.match(math, /mat4n\.inverse/);
  assert.doesNotMatch(`${reference}\n${math}`, /pivotRow|augmented|Array\.from\(\{ length: 4 \}.*length: 8/su);
  assert.match(math, /outwardF32Bounds/);

  const picking = read('engine/src/math/Ray.ts');
  const spatial = read('engine/src/spatial/SpatialIndex.ts');
  const rt = read('extensions/src/ray-tracing/acceleration/runtime.ts');
  assert.match(picking, /WeakMap<Geometry3D, GeometryBVH>/);
  assert.match(spatial, /beginIncrementalUpdate/);
  assert.match(rt, /membership-rebuild|transform-refit/);
  assert.match(read('../milestones/milestones/m04-webgpu-ray-tracing/contracts.md'), /保持不同 owner、更新策略和 public surface/);
});

function buildPacked() {
  const identity = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const geometry = Object.freeze({ kind: 'triangle-mesh', geometryId: 'gpu:test', revision: 1,
    positions: Object.freeze([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, indices: null, primitiveCount: 1 });
  const instance = Object.freeze({ instanceId: 'instance:test', entityId: 'entity:test', geometryId: geometry.geometryId, geometryRevision: 1, transform: identity });
  const snapshot = Object.freeze({
    schemaVersion: 1, sourceRevision: Object.freeze({ worldId: 1, structureVersion: 1, componentChangeRevision: 1 }),
    revision: 'gpu:test', fingerprint: 'gpu:test', geometries: Object.freeze([geometry]), instances: Object.freeze([instance]), analyticPrimitives: Object.freeze([]),
    provenance: Object.freeze([Object.freeze({ instanceId: instance.instanceId, entityId: instance.entityId, meshComponentId: 1, hierarchyVersion: 0, transformLocalVersion: 0,
      material: Object.freeze({ materialId: 'material:test', revision: 1, type: 'basic' }) })]), diagnostics: Object.freeze([]),
  });
  const builder = new acceleration.RayAccelerationBuilder();
  const update = builder.update(snapshot);
  assert.ok(update.snapshot);
  builder.destroy();
  return update.snapshot.packed;
}
function read(path) { return readFileSync(resolve(root, path), 'utf8'); }
