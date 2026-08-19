import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Camera3D, Mesh3D, Transform3D } from '@haiyue/engine/components';
import { Entity, World } from '@haiyue/engine/ecs';
import { Geometry3D } from '@haiyue/engine/geometry';
import { DirectionalLight, EnvironmentLight } from '@haiyue/engine/lighting';
import { PbrMaterial } from '@haiyue/engine/material';

const root = resolve(import.meta.dirname, '../..');
const compiled = mkdtempSync(join(tmpdir(), 'haiyue-ray-path-'));
mkdirSync(join(compiled, 'node_modules/@haiyue'), { recursive: true });
symlinkSync(resolve(root, 'node_modules/wgpu-matrix'), join(compiled, 'node_modules/wgpu-matrix'), 'junction');
symlinkSync(resolve(root, 'engine'), join(compiled, 'node_modules/@haiyue/engine'), 'junction');
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));
execFileSync(process.execPath, [
  resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types',
  '--rootDir', resolve(root, 'extensions/src'), '--outDir', compiled,
  resolve(root, 'extensions/src/ray-tracing/renderer/index.ts'),
  resolve(root, 'extensions/src/ray-tracing/material/index.ts'),
  resolve(root, 'extensions/src/ray-tracing/scene/index.ts'),
  resolve(root, 'extensions/src/ray-tracing/acceleration/index.ts'),
], { cwd: root, stdio: 'pipe' });

const renderer = await import(pathToFileURL(join(compiled, 'ray-tracing/renderer/index.js')));
const material = await import(pathToFileURL(join(compiled, 'ray-tracing/material/index.js')));
const scene = await import(pathToFileURL(join(compiled, 'ray-tracing/scene/index.js')));
const acceleration = await import(pathToFileURL(join(compiled, 'ray-tracing/acceleration/index.js')));

test('G05 Artifact V2 retains portable resource limits and deterministic render ordering', () => {
  const output = execFileSync(process.execPath, ['scripts/visual-regression/verify-ray-path-tracing-shader.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /verified Artifact V2/);
  assert.equal(renderer.RAY_PATH_LAYOUT.artifactVersion, 2);
  assert.equal(renderer.RAY_PATH_LAYOUT.requiredStorageBuffersPerShaderStage, 8);
  assert.equal(renderer.RAY_PATH_LAYOUT.requiredBindingsPerBindGroup, 15);
  assert.deepEqual(renderer.createRayPathRenderPlan(32, 18).passes.map(pass => pass.label), [
    'ray.path.upload', 'ray.path.trace', 'ray.path.tone-map', 'ray.path.consumer',
  ]);
  assert.throws(() => renderer.createRayPathRenderPlan(0, 1), /positive integers/);
});

test('packs PBR factors, sRGB/linear texture indirection, normals and UVs without becoming a material store', () => {
  const fixture = createFixture();
  const packed = material.packRayPbrMaterialScene(fixture.world, fixture.acceleration, {
    textureResolver: source => texturePixels(String(source)),
  });
  assert.ok(packed.packed, JSON.stringify(packed.diagnostics));
  assert.equal(packed.packed.materials.count, 1);
  assert.equal(packed.packed.materials.stride, 128);
  assert.equal(packed.packed.surfaces.count, 2);
  assert.equal(packed.packed.textures.layerCount, 3);
  assert.equal(packed.packed.accelerationFingerprint, fixture.acceleration.fingerprint);
  assert.equal(packed.packed.materialIdentities[0], fixture.acceleration.materialIdentities[0]);
  const materials = new DataView(packed.packed.materials.data);
  assert.ok(materials.getFloat32(0, true) < fixture.material.baseColor.writeSRGB(new Float32Array(4))[0]);
  assert.equal(materials.getUint32(64, true), 0);
  assert.equal(materials.getUint32(68, true), 1);
  assert.equal(materials.getUint32(72, true), 2);
  const surfaces = new DataView(packed.packed.surfaces.data);
  assert.equal(surfaces.getUint32(12, true), 1);
  assert.equal(surfaces.getUint32(96, true) & 1, 1);
  assert.match(packed.packed.fingerprint, /^fnv1a64:[0-9a-f]{16}$/);
  fixture.builder.destroy(); fixture.world.destroy();
});

test('material revision invalidation and unsupported features fail explicitly without approximation', () => {
  const stale = createFixture();
  stale.material.metallic = 0.9;
  const staleResult = material.packRayPbrMaterialScene(stale.world, stale.acceleration);
  assert.equal(staleResult.packed, null);
  assert.ok(staleResult.diagnostics.some(entry => entry.code === 'RAY_MATERIAL_ACCELERATION_STALE'));
  stale.builder.destroy(); stale.world.destroy();

  const cases = [
    [{ alphaMode: 'mask' }, 'alpha-mode:mask'],
    [{ clearcoatFactor: 1 }, 'clearcoat'],
    [{ sheenColorFactor: [0.5, 0, 0] }, 'sheen'],
    [{ transmissionFactor: 0.5 }, 'transmission'],
    [{ thicknessFactor: 0.5 }, 'volume'],
    [{ specularTexture: 'specular' }, 'specular-texture'],
    [{ specularColorTexture: 'specular-color' }, 'specular-color-texture'],
    [{ textureMappings: { baseColor: { offset: [0.1, 0] } } }, 'texture-transform:baseColor'],
    [{ samplers: { baseColor: { minFilter: 'nearest' } } }, 'texture-sampler:baseColor'],
  ];
  for (const [options, feature] of cases) {
    const unsupported = createFixture(options);
    const unsupportedResult = material.packRayPbrMaterialScene(unsupported.world, unsupported.acceleration, {
      textureResolver: source => texturePixels(String(source)),
    });
    assert.equal(unsupportedResult.packed, null, feature);
    assert.ok(unsupportedResult.diagnostics.some(entry => entry.code === 'RAY_MATERIAL_FEATURE_UNSUPPORTED' && entry.context.feature === feature), feature);
    unsupported.builder.destroy(); unsupported.world.destroy();
  }
});

test('camera/light extraction, CPU BSDF and tone mapping freeze G06/G07 input/output semantics', () => {
  const fixture = createFixture();
  const facts = renderer.extractRayPathSceneFacts(fixture.world);
  assert.ok(facts.facts, JSON.stringify(facts.diagnostics));
  assert.equal(facts.facts.lights.length, 1);
  assert.equal(facts.facts.environment.intensity, 0.25);
  const ray = renderer.createRayPathPrimaryRay(facts.facts.camera, 3, 3, 1, 1);
  closeVec(ray.direction, [0, 0, -1], 1e-7);
  const direct = renderer.evaluateRayPbrDirectReference({
    baseColor: [0.8, 0.2, 0.1], metallic: 0, roughness: 0.6, ior: 1.5,
    specularFactor: 1, specularColor: [1, 1, 1], normal: [0, 0, 1],
  }, [0, 0, 1], [0, 0, 1], [2, 2, 2]);
  assert.ok(direct[0] > direct[1] && direct[1] > direct[2]);
  const mapped = renderer.toneMapRayColor([4, 1, 0.25], 1, 'aces');
  assert.ok(mapped[0] > mapped[1] && mapped[1] > mapped[2] && mapped[0] <= 1);
  fixture.builder.destroy(); fixture.world.destroy();
});

test('unsupported device limits fail before allocation and never choose CPU fallback', async () => {
  const fixture = createFixture();
  const packed = material.packRayPbrMaterialScene(fixture.world, fixture.acceleration, { textureResolver: source => texturePixels(String(source)) });
  assert.ok(packed.packed);
  const limits = {
    maxStorageBuffersPerShaderStage: 7, maxBindingsPerBindGroup: 15, maxStorageTexturesPerShaderStage: 1,
    maxSampledTexturesPerShaderStage: 2, maxSamplersPerShaderStage: 2, maxComputeInvocationsPerWorkgroup: 64,
    maxComputeWorkgroupSizeX: 8, maxComputeWorkgroupSizeY: 8, maxUniformBufferBindingSize: 512,
    maxTextureDimension2D: 4096, maxTextureArrayLayers: 256, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000,
  };
  const created = await renderer.RayPathTracingRenderer.create({ limits }, fixture.acceleration, packed.packed);
  assert.equal(created.renderer, null);
  assert.ok(created.diagnostics.some(entry => entry.code === 'RAY_PATH_LIMIT_UNSUPPORTED'));
  fixture.builder.destroy(); fixture.world.destroy();
});

function createFixture(materialOptions = {}) {
  const world = new World('ray-path-test');
  const geometry = new Geometry3D({
    positions: new Float32Array([-2, -2, 0, 2, -2, 0, -2, 2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]),
    normals: new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1]).flat()),
    textureCoordinates: [{ set: 0, data: new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]) }],
  });
  const pbr = new PbrMaterial({ baseColor: [0.8, 0.4, 0.2, 1], metallic: 0.2, roughness: 0.65,
    baseColorTexture: 'base', metallicRoughnessTexture: 'mr', normalTexture: 'normal', ...materialOptions });
  const meshEntity = new Entity('surface'); meshEntity.add(new Transform3D()); meshEntity.add(new Mesh3D(geometry, pbr)); world.addEntity(meshEntity);
  const cameraEntity = new Entity('camera'); cameraEntity.add(new Transform3D().setTranslation(0, 0, 3)); cameraEntity.add(new Camera3D({ fov: Math.PI / 3, near: 0.01, far: 50 })); world.addEntity(cameraEntity);
  const lightEntity = new Entity('light'); lightEntity.add(new DirectionalLight({ direction: [0, 0, -1], intensity: 2 })); world.addEntity(lightEntity);
  const environmentEntity = new Entity('environment'); environmentEntity.add(new EnvironmentLight({ intensity: 0.25, specularColor: [0.2, 0.3, 0.5] })); world.addEntity(environmentEntity);
  const extracted = scene.extractRayTracingScene(world); assert.equal(extracted.valid, true);
  const builder = new acceleration.RayAccelerationBuilder(); const update = builder.update(extracted.snapshot); assert.ok(update.snapshot);
  return { world, material: pbr, acceleration: update.snapshot.packed, builder };
}
function texturePixels(identity) {
  const colors = identity === 'base' ? [200, 100, 50, 255] : identity === 'mr' ? [255, 160, 64, 255] : [128, 128, 255, 255];
  return { identity, revision: 1, width: 1, height: 1, data: Uint8Array.from(colors) };
}
function closeVec(actual, expected, tolerance) { for (let index = 0; index < 3; index++) assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance, `${index}: ${actual[index]} != ${expected[index]}`); }
