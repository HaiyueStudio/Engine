import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const compiled = mkdtempSync(join(tmpdir(), 'haiyue-ray-hybrid-'));
mkdirSync(join(compiled, 'node_modules/@haiyue'), { recursive: true });
symlinkSync(resolve(root, 'node_modules/wgpu-matrix'), join(compiled, 'node_modules/wgpu-matrix'), 'junction');
symlinkSync(resolve(root, 'engine'), join(compiled, 'node_modules/@haiyue/engine'), 'junction');
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types', '--rootDir', resolve(root, 'extensions/src'), '--outDir', compiled, resolve(root, 'extensions/src/ray-tracing/hybrid/index.ts'), resolve(root, 'extensions/src/ray-tracing/acceleration/index.ts')], { cwd: root, stdio: 'pipe' });
const hybrid = await import(pathToFileURL(join(compiled, 'ray-tracing/hybrid/index.js')));
const acceleration = await import(pathToFileURL(join(compiled, 'ray-tracing/acceleration/index.js')));

test('G07 has four Artifact V2 passes with independent deterministic RenderPlan admission', () => {
  const output = execFileSync(process.execPath, ['scripts/webgpu-gate/verify-hybrid-ray-shadow-ray-reflection-ray-ao-shaders.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /verified/); assert.match(hybrid.RAY_HYBRID_LAYOUT.artifactHash, /^[0-9a-f]{64}$/);
  const inputs = frame();
  const contract = hybrid.createRayHybridFrameContract(inputs, { shadow: { enabled: true }, ao: { enabled: true } });
  assert.equal(contract.status, 'ready'); assert.deepEqual(hybrid.createRayHybridRenderPlan(contract).map(pass => pass.label), ['ray.hybrid.upload', 'ray.hybrid.shadow', 'ray.hybrid.ao', 'ray.hybrid.composite', 'ray.hybrid.consumer']);
  assert.equal(contract.effects.reflection.enabled, false);
});

test('all effects off is a no-allocation bypass contract and each effect has an exact ray budget', () => {
  const inputs = frame({ width: 101, height: 51 }); const off = hybrid.createRayHybridFrameContract(inputs);
  assert.equal(off.status, 'bypassed'); assert.deepEqual(hybrid.createRayHybridRenderPlan(off), []);
  const shadow = hybrid.createRayHybridFrameContract(inputs, { shadow: { enabled: true, resolution: 'half', raysPerPixel: 2, maxRaysPerFrame: 2704 } });
  assert.equal(shadow.effects.shadow.width, 51); assert.equal(shadow.effects.shadow.height, 26); assert.equal(shadow.effects.shadow.rayCount, 2652); assert.equal(shadow.status, 'ready');
  const exceeded = hybrid.createRayHybridFrameContract(inputs, { shadow: { enabled: true, resolution: 'full', raysPerPixel: 4, maxRaysPerFrame: 1000 } });
  assert.equal(exceeded.status, 'failed'); assert.ok(exceeded.diagnostics.some(entry => entry.code === 'RAY_HYBRID_RAY_BUDGET_EXCEEDED' && entry.context.effect === 'shadow'));
});

test('coexistence choices are explicit and never silently replace raster effects', () => {
  assert.equal(hybrid.createRayHybridFrameContract(frame({ existingEffects: { shadowMap: true } }), { shadow: { enabled: true } }).diagnostics[0].code, 'RAY_HYBRID_SHADOW_MAP_CONFLICT');
  assert.equal(hybrid.createRayHybridFrameContract(frame({ existingEffects: { ssao: true } }), { ao: { enabled: true } }).diagnostics[0].code, 'RAY_HYBRID_SSAO_CONFLICT');
  const reflection = hybrid.createRayHybridFrameContract(frame({ existingEffects: { planarReflection: true, ssr: true } }), { reflection: { enabled: true } });
  assert.ok(reflection.diagnostics.some(entry => entry.code === 'RAY_HYBRID_REFLECTION_CONFLICT'));
  assert.equal(hybrid.createRayHybridFrameContract(frame({ existingEffects: { planarReflection: true } }), { reflection: { enabled: true }, coexistence: { reflection: 'additive-clamped' } }).status, 'ready');
  const preferred = hybrid.createRayHybridFrameContract(frame({ existingEffects: { ssr: true } }), { reflection: { enabled: true }, coexistence: { reflection: 'prefer-existing' } });
  assert.equal(preferred.status, 'bypassed'); assert.equal(preferred.effects.reflection.enabled, false); assert.ok(preferred.diagnostics.some(entry => entry.code === 'RAY_HYBRID_REFLECTION_PREFER_EXISTING'));
});

test('invalid quality, color, transparency, and effect controls fail with exact diagnostics', () => {
  const invalid = hybrid.createRayHybridFrameContract(frame(), { sceneColorSpace: 'display-p3', transparentPolicy: 'blend', debugView: 'normals', reflection: { enabled: true, resolution: 'quarter', raysPerPixel: 3, maxRoughness: 0, strength: 2 } });
  for (const code of ['RAY_HYBRID_COLOR_SPACE_UNSUPPORTED', 'RAY_HYBRID_TRANSPARENT_POLICY_UNSUPPORTED', 'RAY_HYBRID_DEBUG_VIEW_UNSUPPORTED', 'RAY_HYBRID_RESOLUTION_UNSUPPORTED', 'RAY_HYBRID_RAYS_PER_PIXEL_UNSUPPORTED', 'RAY_HYBRID_MAX_ROUGHNESS_INVALID', 'RAY_HYBRID_STRENGTH_INVALID']) assert.ok(invalid.diagnostics.some(entry => entry.code === code), code);
  assert.equal(invalid.status, 'failed');
});

test('camera and per-effect option changes reset only the affected explicit history key', () => {
  const first = hybrid.createRayHybridFrameContract(frame(), { shadow: { enabled: true }, reflection: { enabled: true } });
  const camera = hybrid.createRayHybridFrameContract(frame({ revision: { ...revision, camera: 'camera:2' } }), { shadow: { enabled: true }, reflection: { enabled: true } });
  assert.notEqual(first.effects.shadow.historyKey, camera.effects.shadow.historyKey); assert.notEqual(first.effects.reflection.historyKey, camera.effects.reflection.historyKey);
  const shadowQuality = hybrid.createRayHybridFrameContract(frame(), { shadow: { enabled: true, strength: 0.5 }, reflection: { enabled: true } });
  assert.notEqual(first.effects.shadow.historyKey, shadowQuality.effects.shadow.historyKey); assert.equal(first.effects.reflection.historyKey, shadowQuality.effects.reflection.historyKey);
  const otherView = hybrid.createRayHybridFrameContract(frame({ viewId: 'view-b' }), { shadow: { enabled: true } }); assert.notEqual(first.effects.shadow.historyKey, otherView.effects.shadow.historyKey);
});

test('unsupported GPU limits fail before allocation and hybrid owns no borrowed raster texture', async () => {
  const created = await hybrid.RayHybridRenderer.create({ limits: { maxBindingsPerBindGroup: 12, maxStorageBuffersPerShaderStage: 8, maxSampledTexturesPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 } });
  assert.equal(created.renderer, null); assert.ok(created.diagnostics.some(entry => entry.code === 'RAY_HYBRID_LIMIT_UNSUPPORTED'));
  const source = await readFile(resolve(root, 'extensions/src/ray-tracing/hybrid/runtime.ts'), 'utf8');
  assert.doesNotMatch(source, /inputs\.(depth|normal|material|sceneColor)\.destroy/); assert.doesNotMatch(source, /engine\/src|renderer\/runtime/); assert.match(source, /outputOwnership:'borrowed-raster'/);
});

test('runtime off path returns the exact borrowed texture, allocates nothing, and destroys idempotently', async () => {
  const device = { lost: new Promise(() => {}), addEventListener() {}, removeEventListener() {} };
  const renderer = new hybrid.RayHybridRenderer(device, {}, {}); const inputs = frame();
  const result = await renderer.render(inputs, {});
  assert.equal(result.status, 'bypassed'); assert.equal(result.outputTexture, inputs.sceneColor); assert.equal(result.outputOwnership, 'borrowed-raster'); assert.equal(renderer.liveResourceCount, 0);
  renderer.destroy(); renderer.destroy(); assert.equal(renderer.destroyed, true); assert.equal(renderer.liveResourceCount, 0);
});

const identity = Object.freeze([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const revision = Object.freeze({ scene: 'scene:1', camera: 'camera:1', depth: 'depth:1', normal: 'normal:1', material: 'material:1', sceneColor: 'color:1' });
let packed;
function makePacked() {
  if (packed) return packed;
  const geometry = Object.freeze({ kind: 'triangle-mesh', geometryId: 'g', revision: 1, positions: Object.freeze([-1,-1,0,1,-1,0,0,1,0]), normals: null, indices: null, primitiveCount: 1 });
  const instance = Object.freeze({ instanceId: 'i', entityId: 'e', geometryId: 'g', geometryRevision: 1, transform: identity });
  const snapshot = Object.freeze({ schemaVersion: 1, sourceRevision: Object.freeze({ worldId: 1, structureVersion: 1, componentChangeRevision: 0 }), revision: 'r', fingerprint: 'f', geometries: Object.freeze([geometry]), instances: Object.freeze([instance]), analyticPrimitives: Object.freeze([]), provenance: Object.freeze([{ instanceId: 'i', entityId: 'e', meshComponentId: 1, hierarchyVersion: 0, transformLocalVersion: 0, material: Object.freeze({ materialId: 'm', revision: 0, type: 'basic' }) }]), diagnostics: Object.freeze([]) });
  const builder = new acceleration.RayAccelerationBuilder(); const update = builder.update(snapshot); assert.ok(update.snapshot, JSON.stringify(update.diagnostics)); packed = update.snapshot.packed; builder.destroy(); return packed;
}
function frame(overrides = {}) { return { viewId: 'view-a', width: 64, height: 32, acceleration: makePacked(), depth: {}, normal: {}, material: {}, sceneColor: {}, inverseViewProjection: identity, viewProjection: identity, cameraOrigin: [0,0,2], directionalLight: [0,0,-1], revision, ...overrides }; }
