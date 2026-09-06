import assert from 'node:assert/strict';
import test from 'node:test';
import { BasicMaterial, BlinnPhongMaterial, Entity, Geometry3D, NormalMaterial, NormalRenderer, Render3DSystem } from '../dist/experimental.js';
import { PbrMaterial } from '../dist/index.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const scene = id => { const data = new Float32Array(68); data.set(identity()); data.set(identity(), 16); return { data, frameId: id, phaseRevision: id, cameraEntityId: 1 }; };
function fixture(t, loadTexture = async () => { throw Error('unexpected texture load'); }) {
  const draws = [];
  const device = createAuditGpuDevice({ behaviors: {
    'renderPass.setBindGroup': ({ args }) => draws.push(['group', ...args]),
    'renderPass.setPipeline': ({ args }) => draws.push(['pipeline', ...args]),
  } });
  const engine = { device, defaults: {}, assetManager: { loadTexture }, format: 'rgba8unorm', width: 64, height: 64, msaaSamples: 1, getDepthFormat: () => 'depth24plus' };
  const system = new Render3DSystem(engine, new Entity('camera'), { registerDefaultMaterialRenderers: false });
  const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [] });
  t.after(() => { pass.end(); system.destroy(); });
  return { device, engine, system, pass, draws, audit: getAuditGpuDeviceState(device) };
}
function geometry() {
  return new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    morphTargets: [{ positions: new Float32Array(9).fill(0.1), normals: new Float32Array(9).fill(0.2) }],
    morphWeights: [0.25],
    skinning: { joints: new Float32Array(12), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), jointMatrices: identity() },
  });
}

test('normal rendering follows pose/morph updates, reuses unchanged uploads across views and releases deformation resources', t => {
  const f = fixture(t);
  const renderer = new NormalRenderer();
  renderer.prepare(f.engine);
  t.after(() => renderer.destroy());
  const geo = geometry();
  const material = new NormalMaterial();
  const world = identity();
  renderer.beginView(scene(1));
  renderer.render(f.pass, 1, geo, material, world);
  const table = renderer.objectTable;
  assert.deepEqual([...table.data.slice(32, 38)], [0.25, 0, 0, 0, 1, 1]);
  const deformation = renderer.deformationCache.ensure(geo);
  assert.equal(deformation.morphNormalSources[0], geo.morphTargets[0].normals);
  const objectUploads = () => [...f.audit.uploadsByLabel].filter(([label]) => !label.includes('SceneFrame')).reduce((sum, [, value]) => sum + value.calls, 0);
  const writes = objectUploads();
  renderer.beginView(scene(1));
  renderer.render(f.pass, 1, geo, material, world);
  assert.equal(objectUploads(), writes, 'unchanged second view does not upload object, morph or skin state');
  geo.setMorphWeights([0.75]);
  renderer.render(f.pass, 1, geo, material, world);
  assert.equal(table.data[32], 0.75);
  renderer.render(f.pass, 1, geo, material, world, { sourceMaterial: new BlinnPhongMaterial() });
  assert.deepEqual([...table.data.slice(32, 38)], [0, 0, 0, 0, 0, 0], 'legacy forward geometry remains undeformed in auxiliary normals');
  renderer.releaseGeometriesNotIn(new Set());
  for (const buffer of [...deformation.morphBuffers, deformation.skinMatrixBuffer]) assert.equal(buffer.destroyed, true);
});

test('all auxiliary pipelines preserve Basic winding and cull overrides and PBR double-sided state', t => {
  const f = fixture(t);
  const post = f.system._postScenePasses;
  const geo = geometry();
  const basic = new BasicMaterial({ cullMode: 'front', frontFace: 'cw' });
  const doubleSided = new PbrMaterial({ doubleSided: true });
  for (const renderer of [post._requireDepthRenderer(), post._requireNormalRenderer(), post._requireMotionVectorRenderer()]) {
    assert.deepEqual(renderer._getPipeline(geo, basic).descriptor.primitive, { topology: 'triangle-list', cullMode: 'front', frontFace: 'cw' });
    assert.equal(renderer._getPipeline(geo, doubleSided).descriptor.primitive.cullMode, 'none');
  }
  assert.equal(post._requireOutlineMaskRenderer()._getPipeline(geo, false, basic).descriptor.primitive.frontFace, 'cw');
});

test('PBR alpha-test preparation writes the same batch object table used by opaque submission', t => {
  const f = fixture(t);
  const renderer = f.system._renderers.requirePbr();
  const world = identity();
  world[12] = 0.5;
  renderer.prepareObjects([{ entityId: 7, geometry: geometry(), material: new PbrMaterial({ alphaMode: 'mask' }), worldMatrix: world, clippingPlanes: null }], 0, 1, 0, { getObjectSlot: () => 3 });
  assert.equal(renderer._batchObjectTable.data[3 * 40 + 12], 0.5);
  assert.equal(renderer._batchObjectTable.data[3 * 40 + 32], 0.25);
});

test('alpha coverage borrows forward uniform/texture/sampler state and updates after asynchronous readiness', async t => {
  let finish;
  let released = 0;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const material = new PbrMaterial({ alphaMode: 'mask', baseColorTexture: 'mask.png', alphaCutoff: 0.3, textureMappings: { baseColor: { texCoord: 1, offset: [0.2, 0.4], scale: [-1, 2], rotation: 0.5 } } });
  const resources = f.system._renderers.resolveMaterialCoverage(material);
  const depth = f.system._postScenePasses._requireDepthRenderer();
  const before = depth.coverageBindings.get(resources);
  const texture = f.device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  finish({ value: texture, release() { released++; } });
  await Promise.resolve();
  assert.equal(f.system._renderers.resolveMaterialCoverage(material), resources);
  const after = depth.coverageBindings.get(resources);
  assert.notEqual(before, after);
  assert.equal(after.descriptor.entries[0].resource.buffer, resources.buffer);
  assert.equal(after.descriptor.entries[1].resource.texture, texture);
  assert.equal(after.descriptor.entries[2].resource, resources.samplers.baseColor);
  const forwardData = f.system._renderers.pbr._materials.get(material.id);
  assert.equal(forwardData.u32[12], 1);
  assert.equal(forwardData.u32[15], 1);
  assert.equal(forwardData.f32[43], 1, 'coverage uses the forward UV channel mapping');
  depth.destroy();
  assert.equal(resources.buffer.destroyed, false, 'auxiliary destruction must not destroy borrowed forward resources');
  assert.equal(released, 0);
});

test('shadow cache readiness revision changes when a mask finishes loading, without material mutation', async t => {
  let finish;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const shadow = f.system._renderers.requireShadow();
  const material = new PbrMaterial({ alphaMode: 'mask', baseColorTexture: 'mask.png' });
  const items = [{ material, entityId: 1, geometry: geometry(), worldMatrix: identity() }];
  const pendingRevision = shadow.prepareMaterialCoverage(items);
  const revision = material.revision;
  finish({ value: f.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING }), release() {} });
  await Promise.resolve();
  const readyRevision = shadow.prepareMaterialCoverage(items);
  assert.notEqual(pendingRevision, readyRevision);
  assert.equal(material.revision, revision);
  assert.equal(shadow.prepareMaterialCoverage(items), readyRevision);
});
