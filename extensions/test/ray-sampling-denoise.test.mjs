import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const compiled = mkdtempSync(join(tmpdir(), 'haiyue-ray-g06-'));
mkdirSync(join(compiled, 'node_modules/@haiyue'), { recursive: true });
symlinkSync(resolve(root, 'node_modules/wgpu-matrix'), join(compiled, 'node_modules/wgpu-matrix'), 'junction');
symlinkSync(resolve(root, 'engine'), join(compiled, 'node_modules/@haiyue/engine'), 'junction');
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));
execFileSync(process.execPath, [
  resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types',
  '--rootDir', resolve(root, 'extensions/src'), '--outDir', compiled,
  resolve(root, 'extensions/src/ray-tracing/sampling/index.ts'), resolve(root, 'extensions/src/ray-tracing/denoise/index.ts'),
], { cwd: root, stdio: 'pipe' });

const sampling = await import(pathToFileURL(join(compiled, 'ray-tracing/sampling/index.js')));
const denoise = await import(pathToFileURL(join(compiled, 'ray-tracing/denoise/index.js')));

test('G06 Artifact V2 modules, accumulation format, and optional RenderPlan ordering remain frozen', () => {
  const output = execFileSync(process.execPath, ['scripts/webgpu-gate/verify-progressive-path-tracing-shaders.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /RAY_PROGRESSIVE_SHADER_ARTIFACT/); assert.match(output, /RAY_DENOISE_SHADER_ARTIFACT/);
  assert.equal(sampling.RAY_ACCUMULATION_FORMAT, 'rgba16float');
  assert.equal(sampling.RAY_PROGRESSIVE_LAYOUT.requiredStorageTextures, 4);
  assert.deepEqual(sampling.createRayProgressiveRenderPlan(false).map(pass => pass.label), [
    'ray.progressive.sample', 'ray.progressive.accumulate', 'ray.progressive.present',
  ]);
  assert.deepEqual(sampling.createRayProgressiveRenderPlan(true).map(pass => pass.label), [
    'ray.progressive.sample', 'ray.progressive.accumulate', 'ray.progressive.denoise.temporal', 'ray.progressive.denoise.spatial', 'ray.progressive.present',
  ]);
});

test('Halton/Cranley/PCG sequence is byte-stable, replayable, bounded, and non-repeating', () => {
  const expected = [
    [1360305691, 0.021293980535119772, 0.23038120389295114],
    [1976942106, 0.7712939805351198, 0.5637145372262844],
    [38559445, 0.27129398053511977, 0.008158981670729037],
    [4128767964, 0.6462939805351198, 0.3414923150040623],
  ];
  const actual = expected.map((_, index) => sampling.createRayProgressiveSequenceSample(index, 7));
  assert.deepEqual(actual.map(value => [value.pathSeed, ...value.jitter]), expected);
  assert.deepEqual(sampling.createRayProgressiveSequenceSample(3, 7), actual[3]);
  assert.equal(new Set(actual.map(value => value.pathSeed)).size, actual.length);
  assert.ok(actual.every(value => value.jitter.every(item => item >= 0 && item < 1)));
  assert.throws(() => sampling.createRayProgressiveSequenceSample(-1, 0), /sampleIndex/);
});

test('accumulation reset matrix classifies every frozen revision exactly once', () => {
  const revision = Object.freeze({ sceneOwner: 'scene', acceleration: 'acceleration', geometry: 'geometry', membership: 'membership', transform: 'transform', material: 'material', camera: 'camera', light: 'light' });
  const base = sampling.createRayProgressiveAccumulationKey(revision, { width: 32, height: 18 }, { revision: 'quality', maxBounces: 3 }, { baseSeed: 1 }, 'denoise:a');
  assert.deepEqual(sampling.classifyRayProgressiveReset(null, base), ['initial']);
  const cases = [
    ['sceneOwner', 'scene-owner'], ['geometry', 'geometry'], ['membership', 'membership'], ['transform', 'transform'],
    ['material', 'material'], ['camera', 'camera'], ['light', 'light'], ['viewport', 'viewport'],
    ['quality', 'quality'], ['sampling', 'sampling'], ['denoise', 'denoise'],
  ];
  for (const [field, reason] of cases) assert.deepEqual(sampling.classifyRayProgressiveReset(base, Object.freeze({ ...base, [field]: `${base[field]}:changed` })), [reason], field);
  assert.deepEqual(sampling.classifyRayProgressiveReset(base, base, new Set(['explicit', 'renderer', 'explicit'])), ['explicit', 'renderer']);
  assert.deepEqual(sampling.classifyRayProgressiveReset(base, base), []);
});

test('canonical acceleration/material/camera/light facts derive a value-owned revision key', () => {
  const acceleration = {
    blases: new Map([['b', { key: 'b', fingerprint: 'blas:b' }], ['a', { key: 'a', fingerprint: 'blas:a' }]]),
    source: { sourceRevision: { worldId: 42 } }, packed: { fingerprint: 'packed:1' },
    tlas: { membershipFingerprint: 'membership:1', transformFingerprint: 'transform:1' },
  };
  const facts = { camera: { revision: 'camera:1' }, environment: { revision: 'environment:1' }, lights: [{ revision: 'light:1' }] };
  const revision = sampling.createRayProgressiveFrameRevision(acceleration, { fingerprint: 'material:1' }, facts);
  assert.equal(revision.sceneOwner, 'world:42'); assert.equal(revision.acceleration, 'packed:1');
  assert.equal(revision.membership, 'membership:1'); assert.equal(revision.transform, 'transform:1');
  assert.equal(revision.material, 'material:1'); assert.equal(revision.camera, 'camera:1');
  assert.match(revision.geometry, /^fnv1a64:/); assert.match(revision.light, /^fnv1a64:/);
  assert.ok(Object.isFrozen(revision));
});

test('invalid denoise controls and unsupported progressive limits fail before GPU allocation', async () => {
  const limits = { maxBindingsPerBindGroup: 9, maxSampledTexturesPerShaderStage: 4, maxStorageTexturesPerShaderStage: 4, maxStorageBuffersPerShaderStage: 1 };
  const invalidDenoise = await denoise.RaySpatialTemporalDenoiser.create({ limits }, { temporalFeedback: 1 });
  assert.equal(invalidDenoise.denoiser, null); assert.ok(invalidDenoise.diagnostics.some(entry => entry.code === 'RAY_DENOISE_FEEDBACK_INVALID'));
  const progressive = await sampling.RayProgressiveRenderer.create({ limits: { ...limits, maxStorageTexturesPerShaderStage: 3 } }, { destroyed: false }, null);
  assert.equal(progressive.renderer, null); assert.ok(progressive.diagnostics.some(entry => entry.code === 'RAY_PROGRESSIVE_LIMIT_UNSUPPORTED'));
});

test('G06 stays independently removable and does not modify the G05 renderer/material owners', async () => {
  const { readFile } = await import('node:fs/promises');
  const runtime = await readFile(resolve(root, 'extensions/src/ray-tracing/sampling/runtime.ts'), 'utf8');
  assert.match(runtime, /from '\.\.\/renderer\/index\.js'/);
  assert.doesNotMatch(runtime, /renderer\/runtime|engine\/src|\.\.\/\.\.\/\.\.\/engine/);
  assert.equal('destroy' in sampling.RayProgressiveRenderer.prototype, true);
  assert.equal('destroy' in denoise.RaySpatialTemporalDenoiser.prototype, true);
});
