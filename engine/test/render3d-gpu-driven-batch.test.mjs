import test from 'node:test';
import assert from 'node:assert/strict';
import { BvhLod3D } from '../dist/components.js';
import { RenderView, RenderViewFamily } from '../dist/core.js';
import {
  BlinnPhongMaterial,
  DepthMaterial,
  Material,
  MaterialRendererRegistry,
  NormalMaterial,
  VolumeMaterial,
} from '../dist/material.js';
import { BlinnPhongRenderSystem, Render3DSystem } from '../dist/systems.js';
import {
  BasicMaterial,
  Camera3D,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  Geometry3D,
  Mesh3D,
  PbrMaterial,
  World,
} from '../dist/index.js';
import {
  getRender3DFramePlanSnapshot,
  getRender3DGpuDrivenBatchBuffer,
  getRender3DGpuDrivenBatchIndexForEntity,
  getRender3DGpuDrivenMaterialSlot,
  setRender3DMeshRenderer,
} from '../dist/experimental.js';

class TestMaterial extends Material {
  type = 'render3d-test';
}

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    STORAGE: 1 << 0,
    COPY_DST: 1 << 1,
    COPY_SRC: 1 << 2,
    INDIRECT: 1 << 3,
    MAP_READ: 1 << 4,
    UNIFORM: 1 << 5,
  };
  globalThis.GPUShaderStage ??= {
    COMPUTE: 1 << 0,
  };
}

function createGpuBatchMockEngine(log = []) {
  ensureGpuConstants();
  const queue = {
    writeBuffer(buffer, offset, data, dataOffset, size) {
      log.push(['writeBuffer', buffer.label, offset, dataOffset ?? 0, size ?? data.length]);
    },
  };
  const device = {
    queue,
    features: new Set(['indirect-first-instance']),
    createBuffer(descriptor) {
      const buffer = {
        label: descriptor.label,
        descriptor,
        destroy() {
          log.push(['destroyBuffer', descriptor.label]);
        },
      };
      log.push(['createBuffer', descriptor.label, descriptor.usage]);
      return buffer;
    },
    createBindGroupLayout(descriptor) {
      log.push(['createBindGroupLayout', descriptor.label]);
      return { label: descriptor.label, descriptor };
    },
    createShaderModule(descriptor) {
      log.push(['createShaderModule', descriptor.label]);
      return { label: descriptor.label, descriptor };
    },
    createPipelineLayout(descriptor) {
      log.push(['createPipelineLayout', descriptor.label]);
      return { label: descriptor.label, descriptor };
    },
    createComputePipeline(descriptor) {
      log.push(['createComputePipeline', descriptor.label]);
      return { label: descriptor.label, descriptor };
    },
    createBindGroup(descriptor) {
      log.push(['createBindGroup', descriptor.label]);
      return { label: descriptor.label, descriptor };
    },
  };
  return {
    device,
    width: 640,
    height: 360,
    displayWidth: 640,
    displayHeight: 360,
    reverseZ: false,
    msaaSamples: 1,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    depthTextureView: { label: 'depth' },
    msaaTextureView: null,
    getDepthFormat() {
      return 'depth24plus';
    },
    getOutputView() {
      return { label: 'output' };
    },
    getRenderPassDescriptor() {
      return {
        colorAttachments: [{
          view: this.getOutputView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: this.clearColor,
        }],
        depthStencilAttachment: {
          view: this.depthTextureView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      };
    },
    getRenderPassDescriptorVersion() {
      return 1;
    },
  };
}

function createGpuBatchMockEngineWithoutIndirectFirstInstance(log = []) {
  const engine = createGpuBatchMockEngine(log);
  engine.device.features = new Set();
  return engine;
}

test('Render3DSystem uploads visible meshes into GpuDrivenBatchBuffer on the main path', () => {
  const log = [];
  const engine = createGpuBatchMockEngine(log);
  const world = new World('Render3DGpuBatch');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new TestMaterial();
  const entity = new Entity('Mesh');
  entity.addComponent(new CartesianTransform3D());
  entity.addComponent(new Mesh3D(geometry, material));
  world.addEntity(entity);

  const draws = [];
  const batchContexts = [];
  const lifecycle = [];
  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: TestMaterial,
    beginView: context => lifecycle.push(['beginView', context.viewSlot]),
    prepareObjects: (_context, items, first, count) => lifecycle.push([
      'prepareObjects',
      count,
      items[first].entityId,
    ]),
    flushUploads: context => lifecycle.push(['flushUploads', context.viewSlot]),
    renderItem: context => {
      lifecycle.push(['renderItem', context.entityId]);
      draws.push(context.entityId);
      batchContexts.push({
        batchIndex: context.gpuDrivenBatch?.batchIndex,
        objectSlot: context.gpuDrivenBatch?.objectSlot,
        materialSlot: context.gpuDrivenBatch?.materialSlot,
        rendererSlot: context.gpuDrivenBatch?.rendererSlot,
        indexedIndirectOffset: context.gpuDrivenBatch?.indexedIndirectOffset,
        drawIndirectOffset: context.gpuDrivenBatch?.drawIndirectOffset,
        hasInstanceTable: !!context.gpuDrivenBatch?.instanceTableBuffer,
        hasMaterialTable: !!context.gpuDrivenBatch?.materialTableBuffer,
        hasMegaBatchRun: !!context.gpuDrivenBatch?.megaBatchRunBuffer,
      });
    },
    endView: context => lifecycle.push(['endView', context.viewSlot]),
  });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'gpu-driven',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  const passEncoder = {};
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder,
  });

  assert.deepEqual(draws, [entity.id]);
  assert.deepEqual(lifecycle, [
    ['beginView', 0],
    ['prepareObjects', 1, entity.id],
    ['flushUploads', 0],
    ['renderItem', entity.id],
    ['endView', 0],
  ]);
  assert.deepEqual(batchContexts, [{
    batchIndex: 0,
    objectSlot: 0,
    materialSlot: 0,
    rendererSlot: 1,
    indexedIndirectOffset: 0,
    drawIndirectOffset: 0,
    hasInstanceTable: true,
    hasMaterialTable: true,
    hasMegaBatchRun: true,
  }]);
  assert.equal(render3D.lastGpuDrivenBatchCount, 1);
  assert.equal(render3D.lastGpuDrivenMaterialCount, 1);
  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.count, 1);
  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.instanceTableCount, 1);
  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.materialTableCount, 1);
  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.megaBatchRunCount, 1);
  assert.equal(getRender3DGpuDrivenBatchIndexForEntity(render3D, entity.id), 0);
  assert.equal(getRender3DGpuDrivenMaterialSlot(render3D, material.id), 0);
  const framePlanNames = getRender3DFramePlanSnapshot(render3D).map(pass => pass.name);
  assert.equal(framePlanNames[0].startsWith('collect-view:render3d:'), true);
  assert.deepEqual(framePlanNames.slice(1), [
    'sort-render-items',
    'prepare-gpu-driven-batches',
    'sort-transparent-on-gpu',
    'prepare-pbr-lighting',
    'render-scene-pass',
    'render-post-scene-passes',
  ]);
  assert.equal(log.some(entry => entry[0] === 'createBuffer' && entry[1] === 'Render3DSystem.batches.commands'), true);
  assert.equal(log.some(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.commands'), true);
  assert.equal(log.some(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.indexedIndirect'), true);
  assert.equal(log.some(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.drawIndirect'), true);
  assert.equal(log.some(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.bounds'), true);
  assert.equal(log.some(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.instanceTable'), true);
  assert.equal(log.some(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.materialTable'), true);
  assert.equal(log.some(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.view.0.megaBatchRuns'), true);
});

test('one Render3DSystem extracts once and selects LOD independently for each RenderView', () => {
  const engine = createGpuBatchMockEngine();
  engine.key = 'multiview-target';
  engine.format = 'bgra8unorm';
  engine.renderTarget = engine;
  const world = new World('Render3DMultiView');
  const nearCamera = new Entity('NearCamera')
    .addComponent(new Camera3D({ far: 500 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  const farCamera = new Entity('FarCamera')
    .addComponent(new Camera3D({ far: 500 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 80] }));
  world.addEntity(nearCamera).addEntity(farCamera);
  world.addEntity(new Entity('ShadowSun').addComponent(new DirectionalLight({ castShadow: true })));

  const baseGeometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  const lowGeometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]) });
  const fixedGeometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 1.5, 0, 0, 0, 1.5, 0]) });
  const highGeometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]) });
  const material = new TestMaterial();
  const mesh = new Mesh3D(baseGeometry, material);
  const entity = new Entity('LOD')
    .addComponent(new CartesianTransform3D())
    .addComponent(mesh)
    .addComponent(new BvhLod3D({
      bounds: { center: [0, 0, 0], radius: 1 },
      levels: [
        { geometry: highGeometry, maxDistance: 10 },
        { geometry: lowGeometry, maxDistance: Infinity },
      ],
    }));
  world.addEntity(entity);
  const fixedTransform = new CartesianTransform3D({ position: [2, 0, 0] });
  const fixedEntity = new Entity('Fixed')
    .addComponent(fixedTransform)
    .addComponent(new Mesh3D(fixedGeometry, material));
  world.addEntity(fixedEntity);
  world.addEntity(new Entity('ShadowReceiver')
    .addComponent(new CartesianTransform3D({ position: [-2, 0, 0] }))
    .addComponent(new Mesh3D(fixedGeometry, new PbrMaterial())));

  const draws = [];
  const viewBatchBuffers = [];
  const sharedInstanceTables = [];
  const objectSlots = [];
  const cameraSlots = [];
  const registry = new MaterialRendererRegistry().register({
    materialType: TestMaterial,
    beginView: context => cameraSlots.push(context.viewSlot),
    renderItem: context => {
      draws.push([context.viewSlot, context.geometry.id]);
      const batchBuffer = context.gpuDrivenBatch?.batchBuffer;
      if (viewBatchBuffers.at(-1) !== batchBuffer) {
        viewBatchBuffers.push(batchBuffer);
        sharedInstanceTables.push(context.gpuDrivenBatch?.instanceTableBuffer);
      }
      objectSlots.push([context.viewSlot, context.entityId, context.gpuDrivenBatch?.objectSlot]);
    },
  }).register({ materialType: PbrMaterial, receivesDirectionalShadow: true, renderItem: () => {} });
  const render3D = new Render3DSystem(engine, nearCamera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'gpu-driven',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  let shadowRenderCount = 0;
  let shadowGeometryIds = [];
  render3D._requireShadowRenderer = () => ({
    render(_encoder, items) {
      shadowRenderCount++;
      shadowGeometryIds = items.map(item => item.geometry?.id);
      return {
        enabled: true, view: {}, sampler: {}, lightViewProjection: new Float32Array(16),
        mapSize: 64, bias: 0, normalBias: 0,
      };
    },
    destroy() {},
  });
  render3D._requirePbrRenderer = () => ({ beginScene() {} });
  world.addSystem(render3D);
  world.frameData.begin(world, null, 0, 16);
  const family = new RenderViewFamily({ views: [
    new RenderView({ key: 'near', camera: nearCamera, target: engine }),
    new RenderView({ key: 'far', camera: farCamera, target: engine, loadOp: 'load' }),
  ] });
  const extractionsBefore = render3D.sceneExtractionCount;
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    viewFamily: family.snapshot(),
  });

  assert.equal(render3D.sceneExtractionCount, extractionsBefore + 1);
  assert.equal(render3D.lastViewCount, 2);
  assert.equal(shadowRenderCount, 1, 'scene-global directional shadow renders once for the complete view family');
  assert.ok(shadowGeometryIds.includes(highGeometry.id), 'shadow LOD remains highest detail regardless of camera LOD');
  assert.equal(shadowGeometryIds.includes(lowGeometry.id), false);
  assert.equal(render3D.lastDirectionalShadowPassCount, 1);
  assert.equal(render3D.lastOpaqueSortMode, 'comparison');
  assert.equal(render3D.lastOpaqueSortCount, 3);
  assert.deepEqual(cameraSlots, [0, 1]);
  assert.deepEqual(draws, [
    [0, highGeometry.id],
    [0, fixedGeometry.id],
    [1, lowGeometry.id],
    [1, fixedGeometry.id],
  ], 'view-local LOD resources use their scene-global geometry slots');
  assert.deepEqual(objectSlots, [
    [0, entity.id, 1],
    [0, fixedEntity.id, 0],
    [1, entity.id, 1],
    [1, fixedEntity.id, 0],
  ], 'view-local command order must preserve scene-global object slots');
  assert.notEqual(viewBatchBuffers[0], viewBatchBuffers[1], 'each view must own isolated indirect output');
  assert.equal(sharedInstanceTables[0], sharedInstanceTables[1], 'views must share the scene-global instance table');
  assert.equal(mesh.geometry, baseGeometry, 'view-local LOD must not mutate shared Mesh3D geometry');
  assert.equal(mesh.material, material);

  for (let frame = 1; frame < 4; frame++) {
    world.frameData.begin(world, null, frame, 16);
    render3D.record(world, {
      device: engine.device,
      encoder: {},
      passEncoder: {},
      frameData: world.frameData,
      viewFamily: family.snapshot(),
    });
  }
  assert.equal(shadowRenderCount, 1, 'unchanged scene-global shadow is cached across frames');
  assert.equal(render3D.lastDirectionalShadowCacheHit, true);
  assert.equal(new Set(viewBatchBuffers.slice(0, 6)).size, 6, 'three in-flight frames own distinct view outputs');
  assert.equal(viewBatchBuffers[6], viewBatchBuffers[0], 'the fourth frame reuses ring frame zero');
  assert.equal(viewBatchBuffers[7], viewBatchBuffers[1], 'each view reuses only its own ring slot');
  assert.equal(render3D.lastGpuDrivenGlobalCommandBuilds, 1, 'all views share one scene-global command build');
  assert.equal(render3D.lastGpuDrivenGlobalCommandUpdates, 0, 'an unchanged scene keeps persistent global slots clean');
  assert.equal(render3D.lastGpuDrivenCommandObjectsCreated, 0, 'steady-state view preparation reuses command DTOs');
  assert.equal(render3D.lastGpuDrivenMaterialRendererResolutions, 0, 'views do not resolve renderer/material pairs again');

  fixedTransform.setPosition(2.25, 0, 0);
  world.frameData.begin(world, null, 4, 16);
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    viewFamily: family.snapshot(),
  });
  assert.equal(render3D.lastGpuDrivenGlobalCommandBuilds, 1);
  assert.equal(render3D.lastGpuDrivenGlobalCommandUpdates, 1, 'TransformStore journal dirties only the changed object slot');
  assert.equal(render3D.lastGpuDrivenCommandObjectsCreated, 0);
});

test('Render3DSystem collects off-camera opaque casters independently from camera visibility', () => {
  const engine = createGpuBatchMockEngineWithoutIndirectFirstInstance();
  const world = new World('Render3DOffCameraShadowCaster');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const sun = new Entity('Sun');
  const shadowLight = new DirectionalLight({ castShadow: true, shadow: { extent: 150, far: 300 } });
  sun.addComponent(shadowLight);
  world.addEntity(sun);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const receiver = new Entity('VisiblePbrReceiver');
  receiver.addComponent(new CartesianTransform3D());
  receiver.addComponent(new Mesh3D(geometry, new PbrMaterial()));
  world.addEntity(receiver);

  const caster = new Entity('OffCameraBasicCaster');
  caster.addComponent(new CartesianTransform3D({ position: [100, 0, 0] }));
  caster.addComponent(new Mesh3D(geometry, new BasicMaterial()));
  world.addEntity(caster);

  const registry = new MaterialRendererRegistry();
  registry.register({ materialType: PbrMaterial, receivesDirectionalShadow: true, renderItem: () => {} });
  registry.register({ materialType: BasicMaterial, renderItem: () => {} });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'batched',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  const submittedCasters = [];
  const submittedCasterSpheres = new Map();
  let shadowRenderCount = 0;
  render3D._requireShadowRenderer = () => ({
    render(_encoder, items) {
      shadowRenderCount++;
      submittedCasters.push(...items.map(item => item.entityId));
      for (const item of items) submittedCasterSpheres.set(item.entityId, item.worldSphere);
      return {
        enabled: true,
        view: {},
        sampler: {},
        lightViewProjection: new Float32Array(16),
        mapSize: 64,
        bias: 0,
        normalBias: 0,
      };
    },
    destroy() {},
  });
  render3D._requirePbrRenderer = () => ({
    beginScene() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);
  world.frameData.begin(world, engine, 0, 0);

  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
  });

  assert.equal(render3D.renderSettings.frustumCulling, true);
  assert.equal(render3D.frustum.containsSphere({ center: [100, 0, 0], radius: 1 }), false);
  assert.ok(submittedCasterSpheres.get(caster.id).center[0] > 99);
  assert.equal(render3D.lastTotalCount, 2);
  assert.equal(render3D.lastVisibleCount, 1, 'the main camera rejects the remote caster');
  assert.deepEqual(new Set(submittedCasters), new Set([receiver.id, caster.id]));
  assert.equal(shadowRenderCount, 1);
  assert.equal(render3D.lastDirectionalShadowPassCount, 1);

  world.frameData.begin(world, engine, 1, 16);
  render3D.record(world, { device: engine.device, encoder: {}, passEncoder: {} });
  assert.equal(shadowRenderCount, 1);
  assert.equal(render3D.lastDirectionalShadowCacheHit, true);

  caster.getComponent(CartesianTransform3D).setPosition(99, 0, 0);
  world.frameData.begin(world, engine, 2, 16);
  render3D.record(world, { device: engine.device, encoder: {}, passEncoder: {} });
  assert.equal(shadowRenderCount, 2, 'caster transform revision invalidates the shadow cache');

  geometry.markDirty();
  world.frameData.begin(world, engine, 3, 16);
  render3D.record(world, { device: engine.device, encoder: {}, passEncoder: {} });
  assert.equal(shadowRenderCount, 3, 'caster geometry/bounds revision invalidates the shadow cache');

  geometry.setMorphWeights([]);
  world.frameData.begin(world, engine, 4, 16);
  render3D.record(world, { device: engine.device, encoder: {}, passEncoder: {} });
  assert.equal(shadowRenderCount, 4, 'caster deformation revision invalidates the shadow cache');

  shadowLight.shadow.bias += 0.0001;
  world.frameData.begin(world, engine, 5, 16);
  render3D.record(world, { device: engine.device, encoder: {}, passEncoder: {} });
  assert.equal(shadowRenderCount, 5, 'direct shadow setting mutation invalidates the shadow cache');

  shadowLight.markDirty();
  world.frameData.begin(world, engine, 6, 16);
  render3D.record(world, { device: engine.device, encoder: {}, passEncoder: {} });
  assert.equal(shadowRenderCount, 6, 'light revision invalidates the shadow cache');
});

test('Render3DSystem builds GPU-resident material table and larger opaque mega-batch runs', () => {
  const engine = createGpuBatchMockEngine();
  const world = new World('Render3DGpuMegaBatch');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const materialA = new TestMaterial();
  const materialB = new TestMaterial();
  const entities = [materialB, materialA, materialA].map((material, index) => {
    const entity = new Entity(`Mesh${index}`);
    entity.addComponent(new CartesianTransform3D({ position: [index * 2, 0, 0] }));
    entity.addComponent(new Mesh3D(geometry, material));
    world.addEntity(entity);
    return entity;
  });

  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: TestMaterial,
    renderItem: () => {},
  });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'gpu-driven',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
  });

  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.count, 3);
  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.instanceTableCount, 3);
  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.materialTableCount, 2);
  assert.equal(getRender3DGpuDrivenBatchBuffer(render3D)?.megaBatchRunCount, 2);
  assert.equal(getRender3DGpuDrivenMaterialSlot(render3D, materialA.id), 0);
  assert.equal(getRender3DGpuDrivenMaterialSlot(render3D, materialB.id), 1);
  assert.equal(getRender3DGpuDrivenBatchIndexForEntity(render3D, entities[1].id), 0);
  assert.equal(getRender3DGpuDrivenBatchIndexForEntity(render3D, entities[2].id), 1);
  assert.equal(getRender3DGpuDrivenBatchIndexForEntity(render3D, entities[0].id), 2);
});

test('Render3DSystem dispatches opaque mega-batch runs through material renderBatch', () => {
  const engine = createGpuBatchMockEngine();
  const world = new World('Render3DGpuRenderBatch');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new TestMaterial();
  const entities = [0, 1, 2].map(index => {
    const entity = new Entity(`Mesh${index}`);
    entity.addComponent(new CartesianTransform3D({ position: [index * 2, 0, 0] }));
    entity.addComponent(new Mesh3D(geometry, material));
    world.addEntity(entity);
    return entity;
  });

  const calls = [];
  let receivedBatchItems = null;
  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: TestMaterial,
    renderItem: context => calls.push(['render', context.entityId]),
    renderBatch: (context, items, first, count, batchBuffer) => {
      receivedBatchItems = items;
      calls.push([
        'batch',
        first,
        count,
        batchBuffer.count,
        !!batchBuffer.instanceTableBuffer,
        items.slice(first, first + count).map((item, offset) => [item.entityId, first + offset]),
      ]);
    },
  });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'gpu-driven',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
  });

  assert.deepEqual(calls, [[
    'batch',
    0,
    3,
    3,
    true,
    entities.map((entity, index) => [entity.id, index]),
  ]]);
  assert.equal(receivedBatchItems, render3D._viewPreparation.frameItems.opaqueItems);
  assert.equal(receivedBatchItems.every(item => 'mesh' in item), true);
});

test('Render3DSystem keeps CPU mega-batching without indirect-first-instance', () => {
  const engine = createGpuBatchMockEngineWithoutIndirectFirstInstance();
  const world = new World('Render3DGpuBatchNoIndirectFirstInstance');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new TestMaterial();
  const entities = [0, 1, 2].map(index => {
    const entity = new Entity(`Mesh${index}`);
    entity.addComponent(new CartesianTransform3D({ position: [index * 2, 0, 0] }));
    entity.addComponent(new Mesh3D(geometry, material));
    world.addEntity(entity);
    return entity;
  });

  const calls = [];
  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: TestMaterial,
    renderItem: context => calls.push(['render', context.entityId, context.gpuDrivenBatch?.batchIndex]),
    renderBatch: (_context, items, first, count) => {
      calls.push([
        'batch',
        items.slice(first, first + count).map((item, offset) => [item.entityId, first + offset]),
      ]);
    },
  });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'batched',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
  });

  assert.deepEqual(calls, [[
    'batch',
    entities.map((entity, index) => [entity.id, index]),
  ]]);
  const batchBuffer = getRender3DGpuDrivenBatchBuffer(render3D);
  assert.equal(batchBuffer?.count, 3);
  assert.equal(batchBuffer?.gpuUploadEnabled, false);
});

test('Render3DSystem batches only explicitly order-independent transparent ranges', () => {
  const engine = createGpuBatchMockEngineWithoutIndirectFirstInstance();
  const world = new World('Render3DSafeTransparentBatch');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const alpha = new TestMaterial();
  alpha.transparentKind = 'alpha';
  const additive = new TestMaterial();
  additive.transparentKind = 'additive';
  const volume = new VolumeMaterial();

  const alphaFar = new Entity('alpha-far')
    .addComponent(new CartesianTransform3D({ position: [0, 0, -2] }))
    .addComponent(new Mesh3D(geometry, alpha));
  const alphaNear = new Entity('alpha-near')
    .addComponent(new CartesianTransform3D({ position: [0, 0, 2] }))
    .addComponent(new Mesh3D(geometry, alpha));
  const volumeEntity = new Entity('volume')
    .addComponent(new CartesianTransform3D())
    .addComponent(new Mesh3D(geometry, volume));
  const additiveEntities = [0, 1, 2].map(index => new Entity(`additive-${index}`)
    .addComponent(new CartesianTransform3D({ position: [index - 1, 0, 0] }))
    .addComponent(new Mesh3D(geometry, additive)));
  world
    .addEntity(alphaNear)
    .addEntity(alphaFar)
    .addEntity(volumeEntity);
  for (const entity of additiveEntities) world.addEntity(entity);

  const calls = [];
  const registry = new MaterialRendererRegistry()
    .register({
      materialType: TestMaterial,
      isTransparent: () => true,
      transparentOrder: material => material.transparentKind === 'additive' ? 10 : 0,
      transparentDepthSort: material => material.transparentKind !== 'additive',
      supportsSortedInstanceBatching: material => material.transparentKind === 'additive',
      renderItem: context => calls.push(['item', context.entityId]),
      renderSortedInstanceBatch: (context, items, first, count, batchBuffer, firstBatchIndex) => {
        calls.push([
          'batch',
          context.viewSlot,
          firstBatchIndex,
          batchBuffer.gpuUploadEnabled,
          items.slice(first, first + count).map(item => item.entityId),
        ]);
      },
    })
    .register({
      materialType: VolumeMaterial,
      isTransparent: () => true,
      transparentOrder: () => 5,
      transparentDepthSort: () => true,
      renderItem: context => calls.push(['volume', context.entityId]),
    });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'batched',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
  });

  assert.deepEqual(calls, [
    ['item', alphaFar.id],
    ['item', alphaNear.id],
    ['volume', volumeEntity.id],
    ['batch', 0, 3, false, additiveEntities.map(entity => entity.id)],
  ]);
});

test('default material registry opts in only depth-read-only Basic additive transparency', () => {
  const engine = createGpuBatchMockEngineWithoutIndirectFirstInstance();
  const render3D = new Render3DSystem(engine, new Entity('Camera'), {
    renderProfile: 'batched',
  });
  const alpha = new BasicMaterial({ blending: 'normal', depthWrite: false });
  const additive = new BasicMaterial({ blending: 'additive', depthWrite: false });
  const additiveDepthWrite = new BasicMaterial({ blending: 'additive', depthWrite: true });
  const volume = new VolumeMaterial();
  const basicRegistration = render3D.materialRenderers.resolve(additive);
  const volumeRegistration = render3D.materialRenderers.resolve(volume);

  assert.equal(basicRegistration.transparentDepthSort(alpha), true);
  assert.equal(basicRegistration.supportsSortedInstanceBatching(alpha), false);
  assert.equal(basicRegistration.transparentDepthSort(additive), false);
  assert.equal(basicRegistration.supportsSortedInstanceBatching(additive), true);
  assert.equal(basicRegistration.supportsSortedInstanceBatching(additiveDepthWrite), false);
  assert.equal(typeof basicRegistration.renderSortedInstanceBatch, 'function');
  assert.equal(volumeRegistration.transparentDepthSort(volume), true);
  assert.equal(volumeRegistration.supportsSortedInstanceBatching, undefined);
  assert.equal(volumeRegistration.renderSortedInstanceBatch, undefined);

  render3D.destroy();
});

test('Render3DSystem keeps sorted transparent instance batches view-local', () => {
  const engine = createGpuBatchMockEngineWithoutIndirectFirstInstance();
  engine.key = 'transparent-batch-multiview-target';
  engine.format = 'bgra8unorm';
  engine.renderTarget = engine;
  const world = new World('Render3DSafeTransparentBatchMultiView');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const additive = new TestMaterial();
  additive.transparentKind = 'additive';
  const entities = [0, 1, 2, 3].map(index => new Entity(`additive-${index}`)
    .addComponent(new CartesianTransform3D({ position: [index - 1.5, 0, 0] }))
    .addComponent(new Mesh3D(geometry, additive)));
  for (const entity of entities) world.addEntity(entity);

  const batches = [];
  const registry = new MaterialRendererRegistry().register({
    materialType: TestMaterial,
    isTransparent: () => true,
    transparentOrder: () => 10,
    transparentDepthSort: () => false,
    supportsSortedInstanceBatching: () => true,
    renderItem: () => assert.fail('safe additive objects should use the explicit batch path'),
    renderSortedInstanceBatch: (context, items, first, count, batchBuffer, firstBatchIndex) => {
      batches.push([
        context.viewSlot,
        batchBuffer,
        firstBatchIndex,
        items.slice(first, first + count).map(item => item.entityId),
      ]);
    },
  });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'batched',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);
  world.frameData.begin(world, engine, 0, 0);
  const family = new RenderViewFamily({ views: [
    new RenderView({ key: 'left', camera, target: engine }),
    new RenderView({ key: 'right', camera, target: engine, loadOp: 'load' }),
  ] });

  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    viewFamily: family.snapshot(),
  });

  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map(([viewSlot, _buffer, firstBatchIndex, entityIds]) => [
    viewSlot,
    firstBatchIndex,
    entityIds,
  ]), [
    [0, 0, entities.map(entity => entity.id)],
    [1, 0, entities.map(entity => entity.id)],
  ]);
  assert.notEqual(batches[0][1], batches[1][1], 'each view keeps its own visibility and batch command buffer');
});

test('Render3DSystem keeps one-item portable runs on the prepared batch-table path', () => {
  const engine = createGpuBatchMockEngineWithoutIndirectFirstInstance();
  const world = new World('Render3DSingleItemPortableRuns');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const materials = [new TestMaterial(), new TestMaterial()];
  const entities = materials.map((material, index) => {
    const entity = new Entity(`Mesh${index}`);
    entity.addComponent(new CartesianTransform3D({ position: [index * 2, 0, 0] }));
    entity.addComponent(new Mesh3D(geometry, material));
    world.addEntity(entity);
    return entity;
  });

  const calls = [];
  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: TestMaterial,
    renderItem: context => calls.push(['render', context.entityId]),
    renderBatch: (_context, items, first, count, batchBuffer) => calls.push([
      'batch',
      count,
      batchBuffer.gpuUploadEnabled,
      items[first].entityId,
    ]),
  });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'batched',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
  });

  assert.deepEqual(calls, entities.map(entity => ['batch', 1, false, entity.id]));
});

test('Render3DSystem dispatches GPU culling before opening the render pass', () => {
  const log = [];
  const engine = createGpuBatchMockEngine(log);
  const world = new World('Render3DGpuCull');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new TestMaterial();
  const entity = new Entity('Mesh');
  entity.addComponent(new CartesianTransform3D());
  entity.addComponent(new Mesh3D(geometry, material));
  world.addEntity(entity);

  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: TestMaterial,
    renderItem: () => {},
  });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'gpu-driven',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  const encoder = {
    beginComputePass({ label }) {
      log.push(['beginComputePass', label]);
      return {
        setPipeline(pipeline) { log.push(['setComputePipeline', pipeline.label]); },
        setBindGroup(index, bindGroup) { log.push(['setComputeBindGroup', index, bindGroup.label]); },
        dispatchWorkgroups(count) { log.push(['dispatchWorkgroups', count]); },
        end() { log.push(['endComputePass', label]); },
      };
    },
    beginRenderPass() {
      log.push(['beginRenderPass']);
      return {
        end() { log.push(['endRenderPass']); },
      };
    },
  };

  render3D.record(world, {
    device: engine.device,
    encoder,
    descriptor: engine.getRenderPassDescriptor(),
  });

  const drawIndex = log.findIndex(entry => entry[0] === 'beginComputePass' && entry[1] === 'Render3DSystem.drawCommands.view.0');
  const cullIndex = log.findIndex(entry => entry[0] === 'beginComputePass' && entry[1] === 'Render3DSystem.gpuCull.view.0');
  const renderIndex = log.findIndex(entry => entry[0] === 'beginRenderPass');
  assert.ok(drawIndex >= 0);
  assert.ok(cullIndex > drawIndex);
  assert.ok(renderIndex > cullIndex);
  assert.equal(log.some(entry => entry[0] === 'createBindGroup' && entry[1] === 'Render3DSystem.gpuCull.view.0.bindGroup'), true);
});

test('Render3DSystem keeps multi-view draw, cull, transparent sort, and readback outputs view-local', () => {
  const log = [];
  const engine = createGpuBatchMockEngine(log);
  engine.key = 'gpu-multiview-target';
  engine.format = 'bgra8unorm';
  engine.renderTarget = engine;
  const world = new World('Render3DGpuMultiView');
  const cameraA = new Entity('CameraA')
    .addComponent(new Camera3D({ far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  const cameraB = new Entity('CameraB')
    .addComponent(new Camera3D({ far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [4, 0, 6] }));
  world.addEntity(cameraA).addEntity(cameraB);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const opaqueMaterial = new TestMaterial();
  const transparentMaterial = new TestMaterial();
  transparentMaterial.transparent = true;
  for (let index = 0; index < 4; index++) {
    const entity = new Entity(`Mesh${index}`)
      .addComponent(new CartesianTransform3D({ position: [index === 0 ? 100 : index - 1.5, 0, 0] }))
      .addComponent(new Mesh3D(geometry, index < 2 ? opaqueMaterial : transparentMaterial));
    world.addEntity(entity);
  }

  const viewBuffers = new Map();
  const registry = new MaterialRendererRegistry().register({
    materialType: TestMaterial,
    isTransparent: material => material.transparent === true,
    transparentDepthSort: material => material.transparent === true,
    renderItem: context => {
      const buffer = context.gpuDrivenBatch?.batchBuffer;
      if (buffer) viewBuffers.set(context.viewSlot, buffer);
    },
  });
  const render3D = new Render3DSystem(engine, cameraA, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'diagnostic',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  const encoder = {
    beginComputePass({ label }) {
      log.push(['beginComputePass', label]);
      return {
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups() {},
        end() {},
      };
    },
    beginRenderPass() {
      return { end() {} };
    },
    copyBufferToBuffer(source, _sourceOffset, destination, _destinationOffset, size) {
      log.push(['copyBufferToBuffer', source.label, destination.label, size]);
    },
  };
  const afterSubmitCallbacks = [];
  const family = new RenderViewFamily({ views: [
    new RenderView({ key: 'a', camera: cameraA, target: engine }),
    new RenderView({ key: 'b', camera: cameraB, target: engine, loadOp: 'load' }),
  ] });
  world.frameData.begin(world, engine, 0, 0);

  render3D.record(world, {
    device: engine.device,
    encoder,
    descriptor: engine.getRenderPassDescriptor(),
    viewFamily: family.snapshot(),
    afterSubmit: callback => afterSubmitCallbacks.push(callback),
  });

  const computeLabels = log
    .filter(entry => entry[0] === 'beginComputePass')
    .map(entry => entry[1]);
  for (const viewSlot of [0, 1]) {
    assert.ok(computeLabels.includes(`Render3DSystem.drawCommands.view.${viewSlot}`));
    assert.ok(computeLabels.includes(`Render3DSystem.gpuCull.view.${viewSlot}`));
    assert.ok(computeLabels.includes(`Render3DSystem.transparentSort.view.${viewSlot}`));
  }
  assert.notEqual(viewBuffers.get(0), viewBuffers.get(1));
  assert.equal(viewBuffers.get(0).instanceTableBuffer, viewBuffers.get(1).instanceTableBuffer);
  assert.equal(render3D.lastVisibleCount, 6, 'CPU visibility stats exclude the off-camera object');
  assert.equal(render3D.lastGpuDrivenBatchCount, 4, 'GPU culling still receives the complete candidate set');
  assert.equal(
    log.filter(entry => entry[0] === 'writeBuffer' && entry[1] === 'Render3DSystem.batches.instanceTable').length,
    1,
    'the scene-global instance table is uploaded once per frame',
  );
  const readbackDestinations = log
    .filter(entry => entry[0] === 'copyBufferToBuffer')
    .map(entry => entry[2]);
  for (const viewSlot of [0, 1]) {
    assert.ok(readbackDestinations.some(label => label.startsWith(
      `Render3DSystem.batches.view.${viewSlot}.indexedInstanceCounts.readback.`,
    )));
    assert.ok(readbackDestinations.includes(
      `Render3DSystem.transparentMegaBatch.view.${viewSlot}.sortIndices.readback`,
    ));
  }
  assert.equal(afterSubmitCallbacks.length, 4);
});

test('Render3DSystem forwards GPU-driven batch context to compatible non-Basic material renderers', () => {
  const log = [];
  const engine = createGpuBatchMockEngine(log);
  const world = new World('Render3DNonBasicGpuBatch');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 6] }));
  world.addEntity(camera);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const materials = [
    new DepthMaterial(),
    new NormalMaterial(),
    new VolumeMaterial(),
    new BlinnPhongMaterial(),
  ];
  const entities = materials.map((material, index) => {
    const entity = new Entity(`Mesh${index}`);
    entity.addComponent(new CartesianTransform3D({ position: [index * 2, 0, 0] }));
    entity.addComponent(new Mesh3D(geometry, material));
    world.addEntity(entity);
    return entity;
  });

  const render3D = new Render3DSystem(engine, camera, {
    renderProfile: 'gpu-driven',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  const received = [];
  render3D._requireDepthRenderer = () => ({
    beginView() {},
    prepareObjects() {},
    flushUploads() {},
    endView() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    render(_pass, entityId, _geometry, _material, _worldMatrix, options) {
      received.push(['depth', entityId, options?.gpuDrivenBatch?.batchIndex]);
    },
    renderBatch(_pass, items, first, count) {
      for (let index = first; index < first + count; index++) {
        received.push(['depth', items[index].entityId, index]);
      }
    },
    reverseZ: false,
    msaaSamples: 1,
  });
  render3D._requireNormalRenderer = () => ({
    beginView() {},
    prepareObjects() {},
    flushUploads() {},
    endView() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    render(_pass, entityId, _geometry, _material, _worldMatrix, options) {
      received.push(['normal', entityId, options?.gpuDrivenBatch?.batchIndex]);
    },
    renderBatch(_pass, items, first, count) {
      for (let index = first; index < first + count; index++) {
        received.push(['normal', items[index].entityId, index]);
      }
    },
    reverseZ: false,
    msaaSamples: 1,
  });
  render3D._requireVolumeRenderer = () => ({
    beginView() {},
    prepareObjects() {},
    flushUploads() {},
    endView() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    render(_pass, entityId, _geometry, _material, _worldMatrix, _eyePosition, options) {
      received.push(['volume', entityId, options?.gpuDrivenBatch?.batchIndex]);
    },
    reverseZ: false,
    msaaSamples: 1,
  });
  const blinnPhong = new BlinnPhongRenderSystem(engine, null, { render3DSystem: render3D });
  blinnPhong._requireRenderer = () => ({
    updateCamera() {},
    updateLights() {},
    prepareObjects() {},
    flushUploads() {},
    endView() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    render(_pass, entityId, _geometry, _material, _worldMatrix, options) {
      received.push(['blinn', entityId, options?.gpuDrivenBatch?.batchIndex]);
    },
    renderBatch(_pass, items, first, count) {
      for (let index = first; index < first + count; index++) {
        received.push(['blinn', items[index].entityId, index]);
      }
    },
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  const encoder = {
    beginComputePass({ label }) {
      return {
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups() { log.push(['dispatch', label]); },
        end() {},
      };
    },
  };

  render3D.record(world, {
    device: engine.device,
    encoder,
    passEncoder: {},
  });

  assert.equal(received.length, 4);
  const receivedByKind = new Map(received.map(([kind, entityId, batchIndex]) => [kind, { entityId, batchIndex }]));
  assert.deepEqual(Array.from(receivedByKind.entries()), [
    ['normal', { entityId: entities[1].id, batchIndex: 0 }],
    ['depth', { entityId: entities[0].id, batchIndex: 1 }],
    ['blinn', { entityId: entities[3].id, batchIndex: 2 }],
    ['volume', { entityId: entities[2].id, batchIndex: 3 }],
  ]);
});

test('Render3DSystem sweeps preview view, LOD selection, and collect-pass caches', () => {
  const engine = createGpuBatchMockEngine();
  engine.key = 'view-cache-churn-target';
  engine.format = 'bgra8unorm';
  engine.renderTarget = engine;
  const world = new World('Render3DViewCacheChurn');
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  });
  const lowGeometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]),
  });
  const material = new TestMaterial();
  const registry = new MaterialRendererRegistry().register({
    materialType: TestMaterial,
    renderItem() {},
  });
  let previewCamera = null;
  let previewEntity = null;
  const render3D = new Render3DSystem(engine, new Entity('Initial camera'), {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'simple',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() {},
    reverseZ: false,
    msaaSamples: 1,
  });
  world.addSystem(render3D);

  for (let frame = 1; frame <= 140; frame++) {
    if (previewCamera) world.removeEntity(previewCamera);
    if (previewEntity) world.removeEntity(previewEntity);
    previewCamera = new Entity(`Preview camera:${frame}`)
      .addComponent(new Camera3D({ far: 100 }))
      .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
    previewEntity = new Entity(`Preview LOD:${frame}`)
      .addComponent(new CartesianTransform3D())
      .addComponent(new Mesh3D(geometry, material))
      .addComponent(new BvhLod3D({
        levels: [
          { geometry, maxDistance: 10 },
          { geometry: lowGeometry, maxDistance: Infinity },
        ],
      }));
    world.addEntity(previewCamera).addEntity(previewEntity);
    render3D.setCameraEntity(previewCamera);
    world.update(frame, 16);
    const family = new RenderViewFamily({ views: [
      new RenderView({ key: 'stable-preview', camera: previewCamera, target: engine }),
      new RenderView({ key: `transient-preview:${frame}`, camera: previewCamera, target: engine, loadOp: 'load' }),
    ] });
    render3D.record(world, {
      device: engine.device,
      encoder: {},
      passEncoder: {},
      frameData: world.frameData,
      viewFamily: family.snapshot(),
    });
  }

  const collector = render3D._sceneCollector;
  assert.equal(collector.lodViewCacheCount, 2, 'inactive preview view keys are swept every frame');
  assert.ok(collector.lodSelectionCacheCount <= 65, 'stable-view entity churn remains capacity bounded');
  assert.equal(render3D._frameCoordinator.collectPassNames.size, 2, 'collect pass names retain only current views');

  render3D.destroy();
  assert.equal(collector.lodViewCacheCount, 0);
  assert.equal(collector.lodSelectionCacheCount, 0);
  assert.equal(render3D._frameCoordinator.collectPassNames.size, 0);
});
