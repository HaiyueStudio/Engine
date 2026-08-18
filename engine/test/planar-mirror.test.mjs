import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PlanarMirror } from '../dist/components.js';
import { RenderView } from '../dist/core.js';
import { Material, MaterialRendererRegistry, PlanarMirrorMaterial } from '../dist/material.js';
import { Render3DSystem } from '../dist/systems.js';
import {
  Camera3D,
  CartesianTransform3D,
  Entity,
  Geometry3D,
  Mesh3D,
  World,
} from '../dist/index.js';
import { setRender3DMeshRenderer } from '../dist/experimental.js';
import { coreComponentSerializationRegistry } from '../dist/serialization.js';

class TestMaterial extends Material {
  type = 'mirror-test';
}

function ensureGpuConstants() {
  globalThis.GPUTextureUsage ??= {
    RENDER_ATTACHMENT: 1 << 0,
    TEXTURE_BINDING: 1 << 1,
    COPY_DST: 1 << 2,
  };
  globalThis.GPUBufferUsage ??= {
    UNIFORM: 1 << 0,
    COPY_DST: 1 << 1,
    STORAGE: 1 << 2,
    COPY_SRC: 1 << 3,
    INDIRECT: 1 << 4,
  };
}

function createMirrorEngine(log = []) {
  ensureGpuConstants();
  let textureId = 0;
  const outputView = { label: 'main-output' };
  const depthView = { label: 'main-depth' };
  const device = {
    features: new Set(),
    limits: { maxTextureDimension2D: 4096, minUniformBufferOffsetAlignment: 256 },
    queue: {
      writeBuffer() {},
      writeTexture() {},
      onSubmittedWorkDone() { return Promise.resolve(); },
    },
    createTexture(descriptor) {
      const id = ++textureId;
      const texture = {
        id,
        descriptor,
        destroyed: false,
        createView() { return { textureId: id }; },
        destroy() {
          this.destroyed = true;
          log.push(['destroyTexture', id]);
        },
      };
      log.push(['createTexture', id, descriptor.size]);
      return texture;
    },
    createBuffer(descriptor) {
      return { descriptor, destroy() {} };
    },
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createBindGroup(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { return { descriptor }; },
    createShaderModule(descriptor) { return { descriptor }; },
    createRenderPipeline(descriptor) { return { descriptor }; },
    createSampler(descriptor) { return { descriptor }; },
  };
  const engine = {
    key: 'mirror-engine',
    device,
    format: 'rgba8unorm',
    width: 800,
    height: 600,
    displayWidth: 800,
    displayHeight: 600,
    reverseZ: false,
    msaaSamples: 1,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    defaults: {},
    get renderTarget() { return this; },
    getDepthFormat() { return 'depth24plus'; },
    getOutputView() { return outputView; },
    getRenderPassDescriptor(options = {}) {
      return {
        colorAttachments: [{
          view: outputView,
          clearValue: options.clearColor ?? this.clearColor,
          loadOp: 'clear',
          storeOp: 'store',
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      };
    },
    getRenderPassDescriptorVersion() { return 1; },
  };
  return engine;
}

function triangle() {
  return new Geometry3D({
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
}

test('PlanarMirror shader avoids implicit derivatives in fragment-varying control flow', async () => {
  const shader = await readFile(new URL('../src/shaders/generated/specialized-planar-mirror.generated.wgsl', import.meta.url), 'utf8');
  assert.match(shader, /textureSampleLevel\s*\(/);
  assert.doesNotMatch(shader, /textureSample\s*\(/);
});

test('PlanarMirror validates options and clones its public material state', () => {
  assert.throws(() => new PlanarMirror({ localNormal: [0, 0, 0] }), /localNormal/);
  assert.throws(() => new PlanarMirror({ resolutionScale: 0 }), /resolutionScale/);
  assert.throws(() => new PlanarMirror({ reflectivity: 2 }), /reflectivity/);
  assert.throws(() => new PlanarMirror({ maxBounces: 0 }), /maxBounces/);
  assert.throws(() => new PlanarMirror({ maxBounces: 9 }), /maxBounces/);
  assert.throws(() => new PlanarMirror({ bounceResolutionScale: 1.1 }), /bounceResolutionScale/);
  assert.throws(() => new PlanarMirror({ updateInterval: 0 }), /updateInterval/);

  const mirror = new PlanarMirror({
    localNormal: [0, 2, 0],
    resolutionScale: 0.75,
    bounceResolutionScale: 0.7,
    clipBias: 0.02,
    maxBounces: 4,
    updateInterval: 3,
    staticCache: true,
    tint: [0.8, 0.9, 1],
    reflectivity: 0.85,
  });
  const clone = mirror.clone();
  assert.deepEqual(clone.localNormal, [0, 1, 0]);
  assert.equal(clone.resolutionScale, 0.75);
  assert.equal(clone.bounceResolutionScale, 0.7);
  assert.equal(clone.clipBias, 0.02);
  assert.equal(clone.maxBounces, 4);
  assert.equal(clone.updateInterval, 3);
  assert.equal(clone.staticCache, true);
  assert.deepEqual(clone.material.tint, [0.8, 0.9, 1]);
  assert.equal(clone.material.reflectivity, 0.85);
  assert.notEqual(clone.material, mirror.material);
});

test('PlanarMirror core serialization preserves reflection configuration', () => {
  const mirror = new PlanarMirror({
    localNormal: [0, 1, 0],
    resolutionScale: 0.6,
    bounceResolutionScale: 0.8,
    width: 512,
    clipBias: 0.025,
    maxBounces: 5,
    updateInterval: 4,
    staticCache: true,
    sampleCount: 4,
    clearColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
    tint: [0.7, 0.8, 0.9],
    reflectivity: 0.75,
  });
  const data = coreComponentSerializationRegistry.serialize(mirror);
  const restored = coreComponentSerializationRegistry.deserialize(data);
  assert.ok(restored instanceof PlanarMirror);
  assert.deepEqual(restored.localNormal, [0, 1, 0]);
  assert.equal(restored.resolutionScale, 0.6);
  assert.equal(restored.bounceResolutionScale, 0.8);
  assert.equal(restored.width, 512);
  assert.equal(restored.height, null);
  assert.equal(restored.clipBias, 0.025);
  assert.equal(restored.maxBounces, 5);
  assert.equal(restored.updateInterval, 4);
  assert.equal(restored.staticCache, true);
  assert.equal(restored.sampleCount, 4);
  assert.deepEqual(restored.clearColor, { r: 0.1, g: 0.2, b: 0.3, a: 1 });
  assert.deepEqual(restored.material.tint, [0.7, 0.8, 0.9]);
  assert.equal(restored.material.reflectivity, 0.75);
});

test('Render3D schedules reflection before the source view, excludes mirrors, and restores material', () => {
  const log = [];
  const engine = createMirrorEngine(log);
  const world = new World('PlanarMirrorWorld');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ near: 0.1, far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);

  const originalMaterial = new TestMaterial();
  const mirrorComponent = new PlanarMirror({ resolutionScale: 0.5 });
  const mirrorMesh = new Mesh3D(triangle(), originalMaterial);
  const mirrorEntity = new Entity('Mirror')
    .addComponent(new CartesianTransform3D())
    .addComponent(mirrorMesh)
    .addComponent(mirrorComponent);
  const sceneEntity = new Entity('SceneObject')
    .addComponent(new CartesianTransform3D({ position: [0, 0, 2] }))
    .addComponent(new Mesh3D(triangle(), new TestMaterial()));
  world.addEntity(mirrorEntity).addEntity(sceneEntity);

  const draws = [];
  const registry = new MaterialRendererRegistry()
    .register({
      materialType: TestMaterial,
      renderItem: context => draws.push([context.viewKey, context.entityId]),
    })
    .register({
      materialType: PlanarMirrorMaterial,
      renderItem: context => draws.push([context.viewKey, context.entityId]),
    });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'simple',
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {}, updateCamera() {}, releaseEntitiesNotIn() {}, releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {}, destroy() {}, reverseZ: false, msaaSamples: 1,
  });
  world.addSystem(render3D);
  const sourceView = new RenderView({ camera, target: engine, key: 'main' });
  world.frameData.begin(world, engine, 0, 16);
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    view: sourceView.snapshot(),
  });

  assert.equal(render3D.lastViewCount, 2);
  assert.equal(mirrorMesh.material, mirrorComponent.material);
  assert.deepEqual(draws, [
    [`planar-mirror:${mirrorEntity.id}:main`, sceneEntity.id],
    ['main', mirrorEntity.id],
    ['main', sceneEntity.id],
  ]);
  const reflection = mirrorComponent.material.getReflection('main');
  assert.ok(reflection);
  assert.ok(reflection.texture.descriptor.size[0] > 0 && reflection.texture.descriptor.size[0] <= 400);
  assert.ok(reflection.texture.descriptor.size[1] > 0 && reflection.texture.descriptor.size[1] <= 300);
  assert.equal(Array.from(reflection.viewProjectionMatrix).every(Number.isFinite), true);
  assert.equal(render3D.lastMirrorPlanStats.plannedViewCount, 1);
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 1);
  assert.ok(render3D.lastMirrorPlanStats.rttPixels > 0);

  render3D.planarMirrorsEnabled = false;
  world.frameData.begin(world, engine, 16, 16);
  draws.length = 0;
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    view: sourceView.snapshot(),
  });
  assert.equal(render3D.lastViewCount, 1);
  assert.equal(mirrorMesh.material, originalMaterial);
  assert.equal(mirrorComponent.material.getReflection('main'), null);

  render3D.planarMirrorsEnabled = true;
  world.frameData.begin(world, engine, 32, 16);
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    view: sourceView.snapshot(),
  });
  assert.equal(render3D.lastViewCount, 2);
  assert.equal(mirrorMesh.material, mirrorComponent.material);

  mirrorEntity.removeComponent(mirrorComponent);
  world.frameData.begin(world, engine, 48, 16);
  draws.length = 0;
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    view: sourceView.snapshot(),
  });
  assert.equal(render3D.lastViewCount, 1);
  assert.equal(mirrorMesh.material, originalMaterial);
  assert.equal(mirrorComponent.material.getReflection('main'), null);
  assert.equal(log.some(entry => entry[0] === 'destroyTexture'), true);
});

test('Render3D prepares two-mirror bounce chains deepest-first and retires reduced depth', () => {
  const log = [];
  const engine = createMirrorEngine(log);
  const world = new World('RecursiveMirrorWorld');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ near: 0.1, far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);

  const mirrorA = new PlanarMirror({ maxBounces: 2, resolutionScale: 0.5 });
  const mirrorB = new PlanarMirror({ localNormal: [0, 0, -1], maxBounces: 2, resolutionScale: 0.5 });
  const entityA = new Entity('Mirror A')
    .addComponent(new CartesianTransform3D({ position: [-1.5, 0, 0] }))
    .addComponent(new Mesh3D(triangle(), new TestMaterial()))
    .addComponent(mirrorA);
  const entityB = new Entity('Mirror B')
    .addComponent(new CartesianTransform3D({ position: [1.5, 0, 0] }))
    .addComponent(new Mesh3D(triangle(), new TestMaterial()))
    .addComponent(mirrorB);
  const sceneEntity = new Entity('SceneObject')
    .addComponent(new CartesianTransform3D({ position: [0, 0, 2] }))
    .addComponent(new Mesh3D(triangle(), new TestMaterial()));
  world.addEntity(entityA).addEntity(entityB).addEntity(sceneEntity);

  const viewOrder = [];
  const registry = new MaterialRendererRegistry()
    .register({
      materialType: TestMaterial,
      beginView: context => viewOrder.push(context.viewKey),
      renderItem() {},
    })
    .register({ materialType: PlanarMirrorMaterial, renderItem() {} });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'simple',
    planarMirrorPlanner: { visibilityCulling: false },
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {}, updateCamera() {}, releaseEntitiesNotIn() {}, releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {}, destroy() {}, reverseZ: false, msaaSamples: 1,
  });
  world.addSystem(render3D);
  const sourceView = new RenderView({ camera, target: engine, key: 'main' });
  const record = () => render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    view: sourceView.snapshot(),
  });

  world.frameData.begin(world, engine, 0, 16);
  record();
  const aView = `planar-mirror:${entityA.id}:main`;
  const bView = `planar-mirror:${entityB.id}:main`;
  assert.equal(render3D.lastViewCount, 5);
  assert.ok(mirrorA.material.getReflection('main'));
  assert.ok(mirrorB.material.getReflection(aView));
  assert.ok(mirrorB.material.getReflection('main'));
  assert.ok(mirrorA.material.getReflection(bView));
  assert.ok(viewOrder.indexOf(`planar-mirror:${entityB.id}:${aView}`) < viewOrder.indexOf(aView));
  assert.ok(viewOrder.indexOf(`planar-mirror:${entityA.id}:${bView}`) < viewOrder.indexOf(bView));
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 4);
  assert.equal(render3D.lastRenderGraphStats.sceneGlobalPassCount, 1);
  assert.equal(render3D.lastRenderGraphStats.viewLocalPassCount, 1);
  assert.equal(render3D.lastRenderGraphStats.reflectionLocalPassCount, 4);
  assert.ok(render3D.lastRenderGraphStats.dependencyCount >= 5);
  assert.equal(render3D.lastMirrorTargetPoolStats.logicalTargetCount, 4);
  assert.ok(render3D.lastMirrorTargetPoolStats.aliasCount >= 1);
  assert.ok(
    render3D.lastMirrorTargetPoolStats.physicalTargetCount
      < render3D.lastMirrorTargetPoolStats.logicalTargetCount,
  );
  assert.ok(render3D.lastMirrorTargetPoolStats.savedBytes > 0);
  assert.equal(render3D.lastMirrorTargetPoolStats.scopes.length, 4);
  assert.equal(render3D.lastMirrorTargetPoolStats.scopes.every(scope => scope.scope.includes(':depth:')), true);
  assert.equal(render3D.lastMirrorGpuResourceStats.logicalTargetCount, 4);
  assert.equal(render3D.lastMirrorGpuResourceStats.persistentTargetCount, 0);
  assert.equal(
    render3D.lastMirrorGpuResourceStats.estimatedResidentBytes
      < render3D.lastMirrorGpuResourceStats.estimatedLogicalBytes,
    true,
  );
  const rootTexture = mirrorA.material.getReflection('main').texture;
  const childTexture = mirrorB.material.getReflection(aView).texture;
  assert.ok(childTexture.descriptor.size[0] < rootTexture.descriptor.size[0]);
  assert.ok(childTexture.descriptor.size[1] < rootTexture.descriptor.size[1]);

  mirrorA.maxBounces = 1;
  mirrorB.maxBounces = 1;
  viewOrder.length = 0;
  world.frameData.begin(world, engine, 16, 16);
  record();
  assert.equal(render3D.lastViewCount, 3);
  assert.equal(mirrorB.material.getReflection(aView), null);
  assert.equal(mirrorA.material.getReflection(bView), null);
  assert.equal(log.some(entry => entry[0] === 'destroyTexture'), true);
});

test('MirrorViewPlanner compounds fixed target resolution at every recursive bounce', () => {
  const engine = createMirrorEngine();
  const world = new World('FixedMirrorResolutionWorld');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ near: 0.1, far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);

  const mirrorA = addMirror(world, 'A', [-1.5, 0, 0], [0, 0, 1], {
    maxBounces: 3,
    width: 100,
    height: 80,
    bounceResolutionScale: 0.5,
  });
  const mirrorB = addMirror(world, 'B', [1.5, 0, 0], [0, 0, -1], {
    maxBounces: 3,
    width: 100,
    height: 80,
    bounceResolutionScale: 0.5,
  });
  const render3D = createMirrorRenderSystem(engine, camera, { visibilityCulling: false });
  world.addSystem(render3D);
  const sourceView = new RenderView({ camera, target: engine, key: 'main' });

  world.frameData.begin(world, engine, 0, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);

  const rootAView = `planar-mirror:${mirrorA.entity.id}:main`;
  const childBView = `planar-mirror:${mirrorB.entity.id}:${rootAView}`;
  const root = mirrorA.component.material.getReflection('main');
  const child = mirrorB.component.material.getReflection(rootAView);
  const grandchild = mirrorA.component.material.getReflection(childBView);
  assert.deepEqual(root.texture.descriptor.size.slice(0, 2), [100, 80]);
  assert.deepEqual(child.texture.descriptor.size.slice(0, 2), [50, 40]);
  assert.deepEqual(grandchild.texture.descriptor.size.slice(0, 2), [25, 20]);
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 6);
  assert.equal(render3D.lastMirrorPlanStats.maxDepth, 3);
});

test('MirrorViewPlanner rejects back-facing and off-frustum mirrors before allocating targets', () => {
  const engine = createMirrorEngine();
  const world = new World('MirrorVisibilityWorld');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ near: 0.1, far: 100 }))
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);
  const visible = addMirror(world, 'Visible', [0, 0, 0], [0, 0, 1]);
  addMirror(world, 'Back facing', [0, 0, 0], [0, 0, -1]);
  addMirror(world, 'Outside', [100, 0, 0], [0, 0, 1]);
  const render3D = createMirrorRenderSystem(engine, camera);
  world.addSystem(render3D);
  const sourceView = new RenderView({ camera, target: engine, key: 'main' });
  world.frameData.begin(world, engine, 0, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);

  const stats = render3D.lastMirrorPlanStats;
  assert.equal(stats.plannedViewCount, 3);
  assert.equal(stats.executedViewCount, 1);
  assert.equal(stats.droppedViewCount, 2);
  assert.equal(stats.dropReasons['back-facing'], 1);
  assert.equal(stats.dropReasons['outside-frustum'], 1);
  assert.ok(visible.component.material.getReflection('main'));
});

test('MirrorViewPlanner enforces the global pixel budget and rotates equal-priority roots', () => {
  const engine = createMirrorEngine();
  const world = new World('MirrorBudgetWorld');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D())
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);
  const mirrors = [
    addMirror(world, 'A', [-2, 0, 0], [0, 0, 1], { width: 100, height: 100 }),
    addMirror(world, 'B', [0, 0, 0], [0, 0, 1], { width: 100, height: 100 }),
    addMirror(world, 'C', [2, 0, 0], [0, 0, 1], { width: 100, height: 100 }),
  ];
  const render3D = createMirrorRenderSystem(engine, camera, {
    visibilityCulling: false,
    maxRttPixels: 10_000,
  });
  world.addSystem(render3D);
  const sourceView = new RenderView({ camera, target: engine, key: 'main' });
  const selected = [];
  for (let frame = 0; frame < 2; frame++) {
    world.frameData.begin(world, engine, frame * 16, 16);
    recordMirrorFrame(render3D, world, engine, sourceView);
    assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 1);
    assert.equal(render3D.lastMirrorPlanStats.rttPixels, 10_000);
    assert.equal(render3D.lastMirrorPlanStats.dropReasons['pixel-budget'], 2);
    selected.push(mirrors.findIndex(mirror => mirror.component.material.getReflection('main')));
  }
  assert.notEqual(selected[0], selected[1]);
});

test('PlanarMirror static and interval caches skip view execution until refresh is due', () => {
  const engine = createMirrorEngine();
  const world = new World('MirrorCacheWorld');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D())
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);
  const mirror = addMirror(world, 'Cached', [0, 0, 0], [0, 0, 1], { staticCache: true });
  const render3D = createMirrorRenderSystem(engine, camera, { visibilityCulling: false });
  world.addSystem(render3D);
  const sourceView = new RenderView({ camera, target: engine, key: 'main' });

  world.frameData.begin(world, engine, 0, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 1);
  assert.equal(render3D.lastMirrorGpuResourceStats.persistentTargetCount, 1);
  assert.equal(render3D.lastMirrorGpuResourceStats.scopes[0].lifetime, 'persistent');
  assert.ok(render3D.lastMirrorGpuResourceStats.estimatedResidentBytes > 0);
  world.frameData.begin(world, engine, 16, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 0);
  assert.equal(render3D.lastMirrorPlanStats.cachedViewCount, 1);
  assert.equal(render3D.lastViewCount, 1);
  assert.equal(render3D.lastRenderGraphStats.resourceCount, 1);
  assert.equal(render3D.lastMirrorGpuResourceStats.persistentTargetCount, 1);
  mirror.component.invalidateReflection();
  world.frameData.begin(world, engine, 32, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 1);

  mirror.component.staticCache = false;
  mirror.component.updateInterval = 2;
  world.frameData.begin(world, engine, 48, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 1);
  world.frameData.begin(world, engine, 64, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);
  assert.equal(render3D.lastMirrorPlanStats.cachedViewCount, 1);
  world.frameData.begin(world, engine, 80, 16);
  recordMirrorFrame(render3D, world, engine, sourceView);
  assert.equal(render3D.lastMirrorPlanStats.executedViewCount, 1);
});

function addMirror(world, name, position, localNormal, options = {}) {
  const component = new PlanarMirror({ localNormal, ...options });
  const entity = new Entity(name)
    .addComponent(new CartesianTransform3D({ position }))
    .addComponent(new Mesh3D(triangle(), new TestMaterial()))
    .addComponent(component);
  world.addEntity(entity);
  return { entity, component };
}

function createMirrorRenderSystem(engine, camera, planarMirrorPlanner = {}) {
  const registry = new MaterialRendererRegistry()
    .register({ materialType: TestMaterial, renderItem() {} })
    .register({ materialType: PlanarMirrorMaterial, renderItem() {} });
  const render3D = new Render3DSystem(engine, camera, {
    materialRenderers: registry,
    registerDefaultMaterialRenderers: false,
    renderProfile: 'simple',
    planarMirrorPlanner,
  });
  setRender3DMeshRenderer(render3D, {
    prepare() {}, updateCamera() {}, releaseEntitiesNotIn() {}, releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {}, destroy() {}, reverseZ: false, msaaSamples: 1,
  });
  return render3D;
}

function recordMirrorFrame(render3D, world, engine, sourceView) {
  render3D.record(world, {
    device: engine.device,
    encoder: {},
    passEncoder: {},
    frameData: world.frameData,
    view: sourceView.snapshot(),
  });
}
