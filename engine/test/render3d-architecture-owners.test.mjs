import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Render3DSystem } from '../dist/experimental.js';
import { MaterialRendererRegistry } from '../dist/material.js';

function createSystem() {
  const engine = {
    device: { features: new Set() },
    width: 640,
    height: 360,
    displayWidth: 640,
    displayHeight: 360,
    reverseZ: false,
    msaaSamples: 1,
    renderProfile: 'batched',
  };
  return new Render3DSystem(engine, new Entity('Camera'), {
    materialRenderers: new MaterialRendererRegistry(),
    registerDefaultMaterialRenderers: false,
  });
}

test('Render3D frame-item owner reuses DTOs and releases every frame reference', () => {
  const system = createSystem();
  const items = system._viewPreparation.frameItems;
  const mesh = {};
  const geometry = {};
  const material = {};
  const matrix = new Float32Array(16);

  items.beginFrame();
  const renderItem = items.nextRenderItem(
    7,
    mesh,
    geometry,
    material,
    matrix,
    3,
    2,
    true,
    null,
    0,
    null,
  );
  const helperItem = items.nextHelperItem(7, geometry, {}, matrix);
  items.opaqueItems.push(renderItem);
  items.transparentItems.push(renderItem);
  items.helperItems.push(helperItem);

  assert.deepEqual(items.preparePostItems(), [renderItem, renderItem]);

  items.clearReferences();
  assert.equal(items.opaqueItems.length, 0);
  assert.equal(renderItem.mesh, null);
  assert.equal(renderItem.geometry, null);
  assert.equal(renderItem.material, null);
  assert.equal(renderItem.worldMatrix, null);
  assert.equal(helperItem.geometry, null);
  assert.equal(helperItem.helper, null);

  items.beginFrame();
  assert.equal(
    items.nextRenderItem(
      8,
      mesh,
      geometry,
      material,
      matrix,
      0,
      0,
      false,
      null,
      -1,
      null,
    ),
    renderItem,
  );
  system.destroy();
});

test('Render3D frame coordinator owns state and preserves the reviewed stage order', () => {
  const system = createSystem();
  const coordinator = system._frameCoordinator;
  const stages = [];
  let observedState = null;
  coordinator._actions = {
    collectView: () => {
      observedState = { ...coordinator.viewState };
      stages.push('collect');
    },
    sortRenderItems: () => stages.push('sort'),
    prepareGpuDrivenBatches: () => stages.push('batch'),
    sortTransparentOnGpu: () => stages.push('transparent-gpu'),
    preparePbrLighting: () => stages.push('pbr'),
    renderScene: () => stages.push('scene'),
    renderPostScene: () => stages.push('post'),
    renderDirectionalShadow: () => stages.push('shadow'),
  };
  const view = { key: 'architecture-view' };
  const world = {};
  const context = {};
  const camera = {};
  const cameraFrame = {};
  const worldFrameState = {};
  const environment = {};
  const matrix = new Float32Array(16);
  const position = new Float32Array(3);

  coordinator.beginFrame();
  coordinator.setSceneGlobalState(
    context,
    {},
    worldFrameState,
    environment,
  );
  coordinator.executeSceneGlobal(true);
  coordinator.executeView(
    world,
    context,
    camera,
    11,
    cameraFrame,
    [],
    {},
    view,
    worldFrameState,
    matrix,
    environment,
    position,
    2,
    640,
    360,
    5,
  );

  assert.deepEqual(stages, [
    'shadow',
    'collect',
    'sort',
    'batch',
    'transparent-gpu',
    'pbr',
    'scene',
    'post',
  ]);
  assert.equal(observedState.world, world);
  assert.equal(observedState.frameView, view);
  assert.equal(observedState.uniformSlot, 2);
  assert.throws(() => coordinator.viewState, /no active view state/);
  assert.deepEqual(
    coordinator.snapshot.map(pass => pass.name),
    [
      'collect-view:architecture-view',
      'sort-render-items',
      'prepare-gpu-driven-batches',
      'sort-transparent-on-gpu',
      'prepare-pbr-lighting',
      'render-scene-pass',
      'render-post-scene-passes',
    ],
  );
  system.destroy();
});

test('Render3D telemetry owner backs the unchanged public diagnostic fields', () => {
  const system = createSystem();
  const telemetry = system._telemetry;

  system.lastVisibleCount = 17;
  system.lastGpuDrivenGlobalCommandBuilds = 3;
  system.lastOpaqueSortMode = 'radix';
  assert.equal(telemetry.state.lastVisibleCount, 17);
  assert.equal(telemetry.state.lastGpuDrivenGlobalCommandBuilds, 3);
  assert.equal(telemetry.state.lastOpaqueSortMode, 'radix');

  telemetry.beginFrame();
  assert.equal(system.lastVisibleCount, 17);
  assert.equal(system.lastGpuDrivenGlobalCommandBuilds, 0);
  assert.equal(system.lastOpaqueSortMode, 'none');

  telemetry.resetGpuState();
  assert.equal(system.lastGpuDrivenBatchCount, 0);
  assert.equal(system.lastGpuDrivenMaterialCount, 0);
  system.destroy();
});

test('Render3D view preparation owns view-local resources across device recovery', () => {
  const system = createSystem();
  const preparation = system._viewPreparation;
  const oldBatchBuilder = preparation.gpuDrivenBatches;
  const oldTransparentOrchestrator = preparation.transparentOrchestrator;


  preparation.frameItems.opaqueItems.push({ geometry: {} });
  preparation.suspendForDeviceLoss();
  assert.equal(preparation.frameItems.opaqueItems.length, 0);
  preparation.recoverGpuResources();
  assert.notEqual(preparation.gpuDrivenBatches, oldBatchBuilder);
  assert.notEqual(preparation.transparentOrchestrator, oldTransparentOrchestrator);
  system.destroy();
});

test('Render3D record rejects nested entry before mutating shared scratch', () => {
  const system = createSystem();
  system._recording = true;
  assert.throws(
    () => system.record({}, {}),
    error => error?.code === 'E_ENGINE_INVALID_STATE'
      && error?.path === 'Render3DSystem.record',
  );
  system._recording = false;
  system.destroy();
});
