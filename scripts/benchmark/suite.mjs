import {
  Component,
  AssetManager,
  AssetUploadScheduler,
  BasicMaterial,
  Camera2D,
  Camera3D,
  Entity,
  FrameData,
  Fog,
  Frustum,
  Geometry3D,
  Geometry2D,
  GpuDrivenBatchBuffer,
  Mesh3D,
  Mesh2D,
  Mesh2DRenderSystem,
  Material2D,
  PointLight,
  DirectionalLight,
  Render3DSystem,
  RenderView,
  RendererResourceCache,
  System,
  Transform3D,
  Transform2D,
  TransparentMegaBatch,
  UniqueCheckType,
  World,
  createRenderCapabilities,
  createRenderFrameContext,
  disposeSceneFrameGpuArena,
  getSceneFrameGpuArena,
  getSpatialIndexService,
  inspectKtx2Texture,
  setRender3DMeshRenderer,
  uploadPreparedKtx2Texture,
} from '../../engine/dist/experimental.js';
import { MaterialRendererRegistry } from '../../engine/dist/material.js';
import { RendererObjectTable } from '../../engine/dist/renderer.js';
import { PbrMaterial } from '../../engine/dist/index.js';
import { applyGltfAnimationClip } from '../../extensions/dist/gltf.js';
import { loadParsedGltfAsset } from '../../extensions/dist/experimental-gltf-worker.js';
import {
  benchmarkSpineAnimationSample,
  benchmarkSpineParse,
  benchmarkSpineVertexBuild,
  createSpineAnimationBenchmarkState,
} from '../../extensions/dist/benchmark.js';
import {
  createRealRendererBenchmarkScenario,
  destroyRealRendererBenchmarkScenario,
  getRealRendererAllocationEvidence,
  getRealRendererBenchmarkMetrics,
  resetRealRendererBenchmarkMetrics,
  runRealRendererBenchmarkFrame,
} from './real-renderer-scenario.mjs';
import {
  GPU_MOCK_CAPABILITIES,
  composeGpuMockCapabilities,
  createAuditGpuDevice,
  createRealRendererAuditDevice,
  getAuditGpuDeviceState,
} from './real-renderer-audit-device.mjs';
import {
  resolvePlanarReflectionStructuralBudgets,
  resolveRealRendererStructuralBudgets,
} from './real-renderer-budgets.mjs';

// glTF's URL adapter uses the browser location only to resolve relative URLs.
globalThis.window ??= { location: { href: 'http://benchmark.haiyue.local/' } };

// Keep sub-millisecond cases above the timer/async scheduling noise floor.
// Results remain normalized to milliseconds per operation by the harness.
const SYNC_MICRO_WINDOW_ITERATIONS = 10_000;
const ASYNC_CONTROL_WINDOW_ITERATIONS = 10_000;
const HEADER_PARSE_WINDOW_ITERATIONS = 100_000;
const IMAGE_MIPMAP_WINDOW_ITERATIONS = 1_000;
const EXPORT_WRITER_WINDOW_ITERATIONS = 5;
const REAL_FRAME_WINDOW_ITERATIONS = 5;
const SPINE_SAMPLE_WINDOW_ITERATIONS = 1_000;

class BenchA extends Component { static UniqueCheckType = UniqueCheckType.SAME | UniqueCheckType.REPLACE; }
class BenchB extends Component { static UniqueCheckType = UniqueCheckType.SAME | UniqueCheckType.REPLACE; }

export function createBenchmarkCases(profile = 'ci') {
  const scale = profile === 'full' ? 4 : 1;
  const realRendererEntities = profile === 'full' ? 1_000 : 256;
  return [
    ecsQueryCase(1_000 * scale),
    transformCase(500 * scale),
    frameDataTransformChurnCase(2_000 * scale, 64 * scale),
    renderCollectionCase(2_000 * scale),
    render3dFullPrepareCase(1_000, 1),
    render3dFullPrepareCase(1_000, 4),
    render3dFullPrepareCase(10_000, 1),
    render3dFullPrepareCase(10_000, 4),
    ...[0, 0.01, 0.1, 1].flatMap(dynamicRatio => [
      render3dRealFrameCase(realRendererEntities, dynamicRatio, 1),
      render3dRealFrameCase(realRendererEntities, dynamicRatio, 4),
    ]),
    ...render3dPlanarReflectionCases(profile),
    render3dGpuMultiViewPrepareCase(1_000, 4),
    render3dGpuMultiViewPrepareCase(10_000, 4),
    render3dSpatialIncrementalCase(10_000, 0, 4),
    render3dSpatialIncrementalCase(10_000, 0.01, 4),
    render3dSpatialIncrementalCase(10_000, 0.1, 4),
    render3dSpatialIncrementalCase(10_000, 1, 4),
    render3dShadowSpatialCase(10_000, 1),
    render3dShadowSpatialCase(10_000, 4),
    gpuBatchCase(2_000 * scale),
    gltfParseCase(500 * scale),
    dracoDecodeCase(1_000 * scale),
    ktx2ParseCase(),
    spineParseCase(200 * scale),
    spineAnimationSampleCase(200, 120),
    mesh2dCollectCase(1_000 * scale),
    spineVertexBuildCase(200, 100, 120),
    assetUploadSchedulingCase(4 * 1024 * 1024 * scale),
    imageMipmapUploadCase(1_024),
    animationSamplingCase(500 * scale),
    sceneLifecycleCase(500 * scale),
    pbrMaterialFrameCase(1_000 * scale),
    capabilityNegotiationCase(1_000 * scale),
    gpuReadbackRingCase(120 * scale),
    gpuStagingRetirementCase(120 * scale),
    rendererCacheChurnCase(10_000 * scale),
    rendererObjectTableDirtyRangeCase(10_000, 0.01),
    rendererObjectTableDirtyRangeCase(10_000, 0.1),
    rendererObjectTableDirtyRangeCase(10_000, 1),
    renderObjectChurnCase(10_000 * scale),
    editorPlayRestartImportChurnCase(500 * scale),
    editorExportBinaryWriterCase(4 * 1024 * 1024 * scale),
  ];
}

function editorExportBinaryWriterCase(byteCount) {
  return {
    id: `editor.export-binary-writer.${byteCount}`,
    group: 'editor',
    stage: 'export-precompile',
    iterations: EXPORT_WRITER_WINDOW_ITERATIONS,
    metricBudgets: {
      payloadBytes: { min: byteCount, max: byteCount },
      copiedBytes: { min: byteCount * 2, max: byteCount * 4 },
      reallocations: { max: 16 },
      peakWorkingBytes: { max: byteCount * 5 },
    },
    async setup() {
      const { BinaryWriter } = await import('../../editor/dist-test/testing.js');
      return { BinaryWriter, source: new Float32Array(1024), metrics: null };
    },
    run(state) {
      const writer = new state.BinaryWriter(1024);
      const appendCount = byteCount / state.source.byteLength;
      for (let index = 0; index < appendCount; index++) writer.appendTypedArray(state.source, 'float32');
      const bytes = writer.finish();
      state.metrics = writer.metrics;
      return bytes.byteLength;
    },
    metrics(state) {
      return state.metrics;
    },
    allocationEvidence(state) {
      return { kind: 'deterministic-export-writer', ...state.metrics };
    },
  };
}

function render3dPlanarReflectionCases(profile) {
  const mirrorCounts = [1, 2, 4];
  const bounceCounts = [1, 3, 5, 8];
  if (profile !== 'full') {
    return [
      render3dPlanarReflectionCase(1_000, 1, 1, 1),
      render3dPlanarReflectionCase(1_000, 2, 3, 4),
      render3dPlanarReflectionCase(10_000, 4, 5, 1),
      render3dPlanarReflectionCase(10_000, 4, 8, 4),
    ];
  }
  return [1_000, 10_000].flatMap(entityCount => [1, 4].flatMap(viewCount => (
    mirrorCounts.flatMap(mirrorCount => bounceCounts.map(maxBounces => (
      render3dPlanarReflectionCase(entityCount, mirrorCount, maxBounces, viewCount)
    )))
  )));
}

function render3dPlanarReflectionCase(entityCount, mirrorCount, maxBounces, viewCount) {
  const budgets = resolvePlanarReflectionStructuralBudgets(
    entityCount,
    mirrorCount,
    maxBounces,
    viewCount,
  );
  return {
    id: `render3d.planar-reflection.${entityCount}e.${mirrorCount}m.${maxBounces}b.${viewCount}v`,
    group: 'render3d',
    stage: 'planar-reflection',
    // The 1K matrix is a control-path workload; use complete reflected frames
    // to move each sample above host scheduling jitter. 10K pressure cases
    // remain single-frame measurements.
    iterations: entityCount <= 1_000 ? 5 : 1,
    metricBudgets: {
      setupRenderPipelinesCreated: { min: 7 },
      mirrorPlannedViews: { min: mirrorCount * viewCount },
      mirrorExecutedViews: { min: 1, max: budgets.reflectionViews },
      mirrorRttPixels: { min: 1 },
      drawsPerFrame: { min: viewCount, max: budgets.totalDraws },
      renderPassesPerFrame: { min: budgets.renderPasses, max: budgets.renderPasses },
      bufferUploadsPerFrame: { min: 1, max: budgets.uploadCalls },
      uploadBytesPerFrame: { min: 1, max: budgets.uploadBytes },
      maxDirectionalShadowPassesPerFrame: { max: 1 },
      pbrLightUniformUploadsPerFrame: { max: 1 },
      pbrEnvironmentUniformUploadsPerFrame: { max: 1 },
      pbrShadowUniformUploadsPerFrame: { max: 1 },
      ownerResidual: { max: 0 },
    },
    setup() {
      return createRealRendererBenchmarkScenario({
        device: createRealRendererAuditDevice(),
        entityCount,
        dynamicRatio: 0.1,
        viewCount,
        mirrorCount,
        maxBounces,
        mirrorWidth: 32,
        mirrorHeight: 32,
      });
    },
    resetMetrics: resetRealRendererBenchmarkMetrics,
    run: runRealRendererBenchmarkFrame,
    teardown: destroyRealRendererBenchmarkScenario,
    metrics: getRealRendererBenchmarkMetrics,
    allocationEvidence: getRealRendererAllocationEvidence,
  };
}

function mesh2dCollectCase(entityCount) {
  return {
    id: `render2d.mesh2d-collect.${entityCount}`,
    group: 'render2d',
    stage: 'mesh2d-collect',
    metricBudgets: {
      renderItemPoolMisses: { max: 0 },
      stableRenderItems: { min: entityCount, max: entityCount },
      renderItemPoolSize: { min: entityCount, max: entityCount },
    },
    setup() {
      const engine = {
        device: {}, displayWidth: 1280, displayHeight: 720, reverseZ: false, msaaSamples: 1,
        registerDeviceRecoveryParticipant() { return () => {}; },
      };
      const world = new World(`benchmark:mesh2d-collect:${entityCount}`);
      const camera = new Entity('camera2d').addComponent(new Transform2D()).addComponent(new Camera2D());
      world.addEntity(camera);
      const geometry = new Geometry2D(new Float32Array([0, 0, 1, 0, 0, 1]));
      const material = new Material2D();
      for (let index = 0; index < entityCount; index++) {
        world.addEntity(new Entity(`mesh2d:${index}`)
          .addComponent(new Transform2D({ x: index & 63, y: index >>> 6 }))
          .addComponent(new Mesh2D(geometry, material)));
      }
      const observed = { baseline: null, stable: 0 };
      const system = new Mesh2DRenderSystem(engine, camera);
      system._renderer = {
        reverseZ: false, msaaSamples: 1,
        prepare() {}, updateCamera() {},
        renderMany(_pass, items) {
          if (!observed.baseline) observed.baseline = [...items];
          let stable = 0;
          for (let index = 0; index < items.length; index++) {
            if (items[index] === observed.baseline[index]) stable++;
          }
          observed.stable = stable;
        },
        releaseEntitiesNotIn() {}, releaseGeometriesNotIn() {}, destroy() {},
      };
      world.addSystem(system);
      return { engine, world, system, observed, context: { device: engine.device, passEncoder: { end() {} } }, frameId: 0 };
    },
    resetMetrics(state) {
      state.poolBaseline = state.system._renderItemPool.length;
    },
    run(state) {
      state.world.frameData.begin(state.world, state.engine, ++state.frameId, 16);
      state.system.record(state.world, state.context);
      return state.system._renderItemPool.length;
    },
    teardown(state) {
      state.finalMetrics = mesh2dCollectMetrics(state);
      state.world.destroy();
    },
    metrics(state) {
      return state.finalMetrics ?? mesh2dCollectMetrics(state);
    },
    allocationEvidence(state) {
      return {
        kind: 'deterministic-mesh2d-item-pool',
        renderItemPoolMisses: state.finalMetrics?.renderItemPoolMisses
          ?? state.system._renderItemPool.length - (state.poolBaseline ?? 0),
      };
    },
  };
}

function mesh2dCollectMetrics(state) {
  return {
    renderItemPoolMisses: state.system._renderItemPool.length - (state.poolBaseline ?? 0),
    stableRenderItems: state.observed.stable,
    renderItemPoolSize: state.system._renderItemPool.length,
  };
}

function render3dRealFrameCase(entityCount, dynamicRatio, viewCount) {
  const dynamicPercent = Math.round(dynamicRatio * 100);
  const budgets = resolveRealRendererStructuralBudgets(entityCount, dynamicRatio, viewCount);
  return {
    id: `render3d.real-frame.${entityCount}e.${dynamicPercent}pct.${viewCount}v`,
    group: 'render3d',
    stage: 'real-frame',
    iterations: REAL_FRAME_WINDOW_ITERATIONS,
    metricBudgets: {
      bufferUploadsPerFrame: { min: viewCount, max: budgets.uploadCalls },
      uploadBytesPerFrame: { min: 1, max: budgets.uploadBytes },
      setupRenderPipelinesCreated: { min: 6 },
      setupBindGroupsCreated: { min: 6 },
      buffersCreatedTotal: { min: 1 },
      bufferExpansionsTotal: { min: 1 },
      bufferRetirementsTotal: { min: 1 },
      drawsPerFrame: { min: viewCount, max: budgets.totalDraws },
      renderPassesPerFrame: { min: budgets.renderPasses, max: budgets.renderPasses },
      maxDirectionalShadowPassesPerFrame: { max: 1 },
      pbrLightUniformUploadsPerFrame: { max: 1 },
      pbrEnvironmentUniformUploadsPerFrame: { max: 1 },
      pbrShadowUniformUploadsPerFrame: { max: 1 },
      poolMisses: { max: 0 },
      hotObjectsCreated: { max: 0 },
      ownerResidual: { max: 0 },
    },
    setup() {
      return createRealRendererBenchmarkScenario({
        device: createRealRendererAuditDevice(), entityCount, dynamicRatio, viewCount,
      });
    },
    resetMetrics: resetRealRendererBenchmarkMetrics,
    run: runRealRendererBenchmarkFrame,
    teardown: destroyRealRendererBenchmarkScenario,
    metrics: getRealRendererBenchmarkMetrics,
    allocationEvidence: getRealRendererAllocationEvidence,
  };
}

function frameDataTransformChurnCase(cycleCount, entityCount) {
  const cameraStride = 8;
  const cameraCount = Math.ceil(entityCount / cameraStride);
  return {
    id: `churn.frame-data-transform.${cycleCount}x${entityCount}`,
    group: 'churn',
    stage: 'frame-cache-churn',
    iterations: 1,
    budgetP95Ms: 400
      * scaleBudget(cycleCount, 2_000)
      * scaleBudget(entityCount, 64),
    metricBudgets: {
      capacityGrowths: { max: 0 },
      maxTransformCapacity: { max: nextPowerOfTwo(Math.max(64, entityCount)) },
      maxActiveTransformSlots: { max: entityCount },
      maxCameraCacheEntries: { max: cameraCount },
      uniqueCameraFrameObjects: { max: cameraCount },
      finalTransformSlots: { max: 0 },
      finalCameraCacheEntries: { max: 0 },
    },
    setup() {
      const world = new World('benchmark:frame-data-transform-churn');
      const banks = [createTransformCameraBank(entityCount, cameraStride), createTransformCameraBank(entityCount, cameraStride)];
      world.addEntity(banks[0].root);
      const state = {
        world,
        frame: new FrameData(),
        banks,
        activeBank: 0,
        frameId: 0,
        baselineCapacity: 0,
        capacityGrowths: 0,
        maxTransformCapacity: 0,
        maxActiveTransformSlots: 0,
        maxCameraCacheEntries: 0,
        cameraFrames: new Set(),
      };
      sampleFrameDataChurnState(state, 0);
      state.baselineCapacity = state.frame.transforms.capacity;
      return state;
    },
    resetMetrics(state) {
      state.baselineCapacity = state.frame.transforms.capacity;
      state.capacityGrowths = 0;
      state.maxTransformCapacity = state.baselineCapacity;
      state.maxActiveTransformSlots = 0;
      state.maxCameraCacheEntries = 0;
      state.cameraFrames.clear();
    },
    run(state) {
      let checksum = 0;
      for (let cycle = 0; cycle < cycleCount; cycle++) {
        state.world.removeEntity(state.banks[state.activeBank].root);
        state.activeBank ^= 1;
        const bank = state.banks[state.activeBank];
        state.world.addEntity(bank.root);
        bank.root.getComponent(Transform3D).setTranslation(cycle & 31, (cycle >>> 5) & 7, 0);
        checksum = (checksum + sampleFrameDataChurnState(state, cycle)) >>> 0;
      }
      return checksum;
    },
    teardown(state) {
      state.world.removeEntity(state.banks[state.activeBank].root);
      state.frame.begin(state.world, null, ++state.frameId, 16);
      state.world.destroy();
      for (const bank of state.banks) if (!bank.root.destroyed) bank.root.destroy();
    },
    metrics(state) {
      return {
        capacityGrowths: state.capacityGrowths,
        maxTransformCapacity: state.maxTransformCapacity,
        maxActiveTransformSlots: state.maxActiveTransformSlots,
        maxCameraCacheEntries: state.maxCameraCacheEntries,
        uniqueCameraFrameObjects: state.cameraFrames.size,
        finalTransformSlots: state.frame.transforms.activeSlotCount,
        finalCameraCacheEntries: state.frame.camera3DCacheSize,
      };
    },
  };
}

function createTransformCameraBank(entityCount, cameraStride) {
  const root = new Entity().addComponent(new Transform3D());
  const cameras = [];
  let parent = root;
  for (let index = 1; index < entityCount; index++) {
    const entity = new Entity().addComponent(new Transform3D().setTranslation(1, 0, 0));
    if ((index % cameraStride) === 0) {
      entity.addComponent(new Camera3D());
      cameras.push(entity);
    }
    parent.addChild(entity);
    parent = entity;
  }
  if (cameras.length === 0) {
    root.addComponent(new Camera3D());
    cameras.push(root);
  }
  return { root, leaf: parent, cameras };
}

function sampleFrameDataChurnState(state, cycle) {
  state.frame.begin(state.world, null, ++state.frameId, 16);
  const bank = state.banks[state.activeBank];
  const leafX = state.frame.transforms.getWorldMatrix(bank.leaf)[12] ?? 0;
  for (const cameraEntity of bank.cameras) {
    const cameraFrame = state.frame.getCamera3D(cameraEntity, cameraEntity.getComponent(Camera3D), 1280, 720, (cycle & 1) === 0);
    state.cameraFrames.add(cameraFrame);
  }
  const capacity = state.frame.transforms.capacity;
  if (capacity > state.baselineCapacity) state.capacityGrowths++;
  state.baselineCapacity = Math.max(state.baselineCapacity, capacity);
  state.maxTransformCapacity = Math.max(state.maxTransformCapacity, capacity);
  state.maxActiveTransformSlots = Math.max(state.maxActiveTransformSlots, state.frame.transforms.activeSlotCount);
  state.maxCameraCacheEntries = Math.max(state.maxCameraCacheEntries, state.frame.camera3DCacheSize);
  return Math.trunc(leafX) + state.frame.camera3DCacheSize;
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}


function gpuReadbackRingCase(frameCount) {
  return {
    id: `gpu-sync.readback-ring.${frameCount}`,
    group: 'gpu-sync',
    stage: 'readback-control-path',
    // The mock ring control path is intentionally cheap; batch complete frame
    // sequences so promise/microtask scheduling does not dominate P95.
    iterations: 50,
    budgetP95Ms: 3 * scaleBudget(frameCount, 120),
    metricBudgets: {
      skipRate: { max: 0.4 },
      maxPendingMappings: { max: 2 },
      mappingsBeforeSubmit: { max: 0 },
      pendingAfterRun: { max: 0 },
      averageLatencyFrames: { max: 3.1 },
    },
    setup() {
      ensureGpuConstants();
      const state = createReadbackBenchmarkState();
      state.batch = new GpuDrivenBatchBuffer({ device: state.device }, 'benchmark.readback');
      state.batch.upload([{ entityId: 1, geometryId: 1, materialId: 1, instanceCount: 1, indexCount: 3, vertexCount: 3, sortKey: 1 }]);
      return state;
    },
    resetMetrics: resetReadbackMetrics,
    async run(state) {
      for (let frame = 0; frame < frameCount; frame++) {
        state.frame += 1;
        await resolveDueMappings(state, 3);
        const context = createRenderFrameContext({ device: state.device }, { descriptor: { colorAttachments: [] } });
        state.requests += 1;
        if (state.batch.requestIndexedInstanceCountReadback(context)) state.accepted += 1;
        else state.skipped += 1;
        context.submit();
      }
      await resolveAllMappings(state);
      return state.accepted;
    },
    teardown(state) { state.batch.destroy(); },
    metrics(state) {
      return {
        skipRate: state.requests === 0 ? 0 : state.skipped / state.requests,
        maxPendingMappings: state.maxPending,
        mappingsBeforeSubmit: state.mappingsBeforeSubmit,
        pendingAfterRun: state.pendingMappings.length,
        averageLatencyFrames: state.completedMappings === 0 ? 0 : state.totalLatencyFrames / state.completedMappings,
      };
    },
  };
}

function gpuStagingRetirementCase(frameCount) {
  return {
    id: `gpu-sync.staging-retirement.${frameCount}`,
    group: 'gpu-sync',
    stage: 'staging-lifecycle',
    // Preserve the full submit/retire lifecycle in each iteration while
    // measuring above the host scheduler's sub-millisecond noise floor.
    iterations: 30,
    budgetP95Ms: 4 * scaleBudget(frameCount, 120),
    metricBudgets: {
      maxLiveStagingBuffers: { max: 4 },
      liveStagingBuffersAfterRun: { max: 0 },
      submittedWorkWaitRatio: { min: 1, max: 1 },
    },
    setup() {
      ensureGpuConstants();
      return createStagingBenchmarkState();
    },
    resetMetrics: resetStagingMetrics,
    async run(state) {
      for (let frame = 0; frame < frameCount; frame++) {
        state.frame += 1;
        await resolveDueSubmissions(state, 3);
        uploadPreparedKtx2Texture(state.device, createTinyKtx2Payload(), 'benchmark.staging');
      }
      await resolveAllSubmissions(state);
      return state.submissions;
    },
    metrics(state) {
      const bufferResources = state.audit.resources.get('buffer');
      return {
        maxLiveStagingBuffers: bufferResources?.maxLive ?? 0,
        liveStagingBuffersAfterRun: bufferResources?.live ?? 0,
        submittedWorkWaitRatio: state.submissions === 0 ? 0 : state.submittedWorkWaits / state.submissions,
      };
    },
  };
}

function rendererCacheChurnCase(count) {
  return {
    id: `churn.renderer-resource-cache.${count}`,
    group: 'churn',
    stage: 'gpu-cache-churn',
    iterations: 1,
    budgetP95Ms: 20 * scaleBudget(count, 10_000),
    metricBudgets: {
      maxCacheEntries: { max: 256 },
      residualEntries: { max: 0 },
      maxLiveResources: { max: 257 },
      liveResourceResiduals: { max: 0 },
      cacheHitRate: { min: 0.19 },
    },
    setup() {
      const device = {};
      RendererResourceCache.configure(device, { maxResources: 256 });
      return { device, hits: 0, requests: 0, maxEntries: 0, residualEntries: 0, liveResources: 0, maxLiveResources: 0 };
    },
    resetMetrics(state) {
      state.hits = 0;
      state.requests = 0;
      state.maxEntries = 0;
      state.residualEntries = 0;
      state.liveResources = 0;
      state.maxLiveResources = 0;
    },
    run(state) {
      RendererResourceCache.clear(state.device);
      for (let index = 0; index < count; index++) {
        const hit = index > 0 && index % 5 === 0;
        const key = `resource-${hit ? index - 1 : index}`;
        RendererResourceCache.get(state.device, key, () => {
          state.liveResources += 1;
          state.maxLiveResources = Math.max(state.maxLiveResources, state.liveResources);
          let destroyed = false;
          return { destroy() { if (!destroyed) { destroyed = true; state.liveResources -= 1; } } };
        });
        state.requests += 1;
        if (hit) state.hits += 1;
      }
      state.maxEntries = Math.max(state.maxEntries, RendererResourceCache.getStats(state.device).resources);
      RendererResourceCache.clear(state.device);
      state.residualEntries = RendererResourceCache.getStats(state.device).resources;
      return state.requests;
    },
    metrics(state) {
      return {
        maxCacheEntries: state.maxEntries,
        residualEntries: state.residualEntries,
        maxLiveResources: state.maxLiveResources,
        liveResourceResiduals: state.liveResources,
        cacheHitRate: state.requests === 0 ? 0 : state.hits / state.requests,
      };
    },
  };
}

function renderObjectChurnCase(count) {
  return {
    id: `churn.geometry-material-entity.${count}`,
    group: 'churn',
    stage: 'render-object-lifecycle',
    iterations: 1,
    budgetP95Ms: 150 * scaleBudget(count, 10_000),
    metricBudgets: {
      maxLiveEntities: { min: count, max: count },
      liveEntitiesAfterDestroy: { max: 0 },
    },
    setup: () => ({ maxLiveEntities: 0, liveEntitiesAfterDestroy: 0 }),
    resetMetrics(state) { state.maxLiveEntities = 0; state.liveEntitiesAfterDestroy = 0; },
    run(state) {
      const world = new World('benchmark:render-object-churn');
      for (let index = 0; index < count; index++) {
        const geometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
        const material = new BasicMaterial({ color: [(index % 17) / 16, 0.5, 1, 1] });
        world.addEntity(new Entity(`churn-${index}`).addComponent(new Mesh3D(geometry, material)));
      }
      state.maxLiveEntities = Math.max(state.maxLiveEntities, world.entities.size);
      world.destroy();
      state.liveEntitiesAfterDestroy = world.entities.size;
      return state.maxLiveEntities;
    },
    metrics: state => ({
      maxLiveEntities: state.maxLiveEntities,
      liveEntitiesAfterDestroy: state.liveEntitiesAfterDestroy,
    }),
  };
}

function rendererObjectTableDirtyRangeCase(slotCount, dirtyRatio) {
  const dirtySlotCount = Math.max(1, Math.round(slotCount * dirtyRatio));
  const wholeTableUpload = dirtyRatio >= 0.4;
  const targetRangeCount = wholeTableUpload ? 1 : Math.min(8, dirtySlotCount);
  const measurementIterations = dirtyRatio <= 0.01 ? 1_000 : dirtyRatio <= 0.1 ? 400 : 50;
  return {
    id: `render.object-table-dirty-ranges.${slotCount}.${Math.round(dirtyRatio * 100)}pct`,
    group: 'render',
    stage: 'object-table-upload',
    // One flush is sub-millisecond on the fixed Apple runner. Batch enough
    // independent flushes per timing sample to keep scheduler/GC jitter from
    // dominating the relative-performance signal; the harness reports ms/op.
    iterations: measurementIterations,
    budgetP95Ms: 8 * scaleBudget(slotCount, 10_000),
    metricBudgets: {
      dirtySlotCount: { min: dirtySlotCount, max: dirtySlotCount },
      uploadRangeCount: { max: targetRangeCount },
      uploadedSlotCount: { max: wholeTableUpload ? slotCount : dirtySlotCount },
      wholeTableUploads: { min: wholeTableUpload ? 1 : 0, max: wholeTableUpload ? 1 : 0 },
      queueWriteCalls: { max: targetRangeCount },
    },
    setup() {
      ensureGpuConstants();
      const state = {
        maxQueueWriteCallsPerFlush: 0,
        table: null,
        device: null,
        audit: null,
      };
      const device = createAuditGpuDevice({
        capabilities: ['buffer', 'bind-group', 'queue'],
      });
      state.device = device;
      state.audit = getAuditGpuDeviceState(device);
      state.table = new RendererObjectTable({
        device,
        bindGroupLayout: {},
        label: 'benchmark:renderer-object-table',
        floatsPerSlot: 20,
      });
      for (let slot = 0; slot < slotCount; slot++) state.table.allocateSlot();
      state.audit.reset();
      return state;
    },
    resetMetrics(state) {
      state.audit.reset();
      state.maxQueueWriteCallsPerFlush = 0;
    },
    run(state) {
      const writesBefore = state.audit.getCallCount('queue.writeBuffer');
      const slotsPerRange = Math.ceil(dirtySlotCount / targetRangeCount);
      let remaining = dirtySlotCount;
      for (let range = 0; range < targetRangeCount; range++) {
        const rangeLength = Math.min(slotsPerRange, remaining);
        const rangeStart = Math.floor((slotCount - rangeLength) * range / targetRangeCount);
        for (let offset = 0; offset < rangeLength; offset++) {
          const slot = rangeStart + offset;
          state.table.data[slot * state.table.floatsPerSlot] += 1;
          state.table.writeSlot(slot);
        }
        remaining -= rangeLength;
      }
      const stats = state.table.flushUploads();
      state.maxQueueWriteCallsPerFlush = Math.max(
        state.maxQueueWriteCallsPerFlush,
        state.audit.getCallCount('queue.writeBuffer') - writesBefore,
      );
      return stats.uploadedSlotCount;
    },
    teardown(state) {
      state.table.destroy();
    },
    metrics(state) {
      const stats = state.table.lastFlushStats;
      return {
        dirtySlotCount: stats.dirtySlotCount,
        uploadRangeCount: stats.uploadRangeCount,
        uploadedSlotCount: stats.uploadedSlotCount,
        wholeTableUploads: stats.wholeTableUpload ? 1 : 0,
        queueWriteCalls: state.maxQueueWriteCallsPerFlush,
      };
    },
  };
}

function editorPlayRestartImportChurnCase(count) {
  return {
    id: `churn.editor-play-restart-import.${count}`,
    group: 'churn',
    stage: 'editor-runtime-lifecycle',
    // A single lifecycle pass is close to the timer-noise floor. Averaging five
    // complete passes keeps every lifecycle transition in scope while making
    // the reported per-pass timing suitable for cohort decisions.
    iterations: 5,
    budgetP95Ms: 100 * scaleBudget(count, 500),
    metricBudgets: {
      listenerResiduals: { max: 0 },
      selectionSubscriptionResiduals: { max: 0 },
      sceneReferenceResiduals: { max: 0 },
      ownershipReleaseRatio: { min: 1, max: 1 },
      serializationRatio: { min: 1, max: 1 },
    },
    setup() { return createEditorChurnState(); },
    resetMetrics(state) {
      state.serializations = 0;
      state.ownerReleases = 0;
      state.cycles = 0;
      state.listenerResiduals = 0;
      state.selectionSubscriptionResiduals = 0;
      state.sceneReferenceResiduals = 0;
    },
    async run(state) {
      for (let index = 0; index < count; index++) {
        const scene = await state.session.prepare({});
        state.session.open(scene);
        state.session.restart();
        const ownership = new state.RuntimeOwnershipScope()
          .bindEngine({ stop() { state.ownerReleases += 0.5; }, destroy() { state.ownerReleases += 0.5; } })
          .bindWorld({ destroy() {} })
          .bindPointer({ destroy() {} });
        ownership.release();
        state.session.close();
        state.cycles += 1;
      }
      const diagnostics = state.session.diagnostics;
      state.listenerResiduals = state.listeners.size;
      state.selectionSubscriptionResiduals = diagnostics.selectionSubscriptions;
      state.sceneReferenceResiduals = diagnostics.sceneReferences;
      return state.serializations;
    },
    teardown(state) {
      state.session.close();
      globalThis.window = state.originalWindow;
    },
    metrics(state) {
      return {
        listenerResiduals: state.listenerResiduals,
        selectionSubscriptionResiduals: state.selectionSubscriptionResiduals,
        sceneReferenceResiduals: state.sceneReferenceResiduals,
        ownershipReleaseRatio: state.cycles === 0 ? 0 : state.ownerReleases / state.cycles,
        serializationRatio: state.cycles === 0 ? 0 : state.serializations / state.cycles,
      };
    },
  };
}

function pbrMaterialFrameCase(count) {
  return {
    id: `render-product.pbr-material-frame.${count}`,
    group: 'render-product',
    stage: 'pbr-material-prepare',
    // Covers the complete PBR extension state (clearcoat, specular/IOR, sheen,
    // transmission, and volume), not only the original metallic/roughness core.
    budgetP95Ms: 0.5 * scaleBudget(count, 1_000),
    setup() {
      return Array.from({ length: count }, (_, index) => new PbrMaterial({
        metallic: (index % 10) / 10,
        roughness: 0.08 + (index % 8) / 10,
        clearcoatFactor: index % 2,
        clearcoatRoughnessFactor: (index % 5) / 5,
        variants: [{
          name: 'alternate',
          state: { metallic: 0.9, roughness: 0.2, clearcoatFactor: index % 3 === 0 ? 1 : 0, clearcoatRoughnessFactor: 0.12 },
        }],
      }));
    },
    run(materials, iteration) {
      const name = iteration % 2 === 0 ? 'alternate' : null;
      let checksum = 0;
      for (const material of materials) {
        material.setVariant(name);
        checksum += material.metallic + material.roughness
          + material.clearcoatFactor + material.clearcoatRoughnessFactor
          + material.revision;
      }
      return checksum;
    },
  };
}

function capabilityNegotiationCase(count) {
  const adapter = { features: new Set(['indirect-first-instance', 'timestamp-query', 'texture-compression-bc']) };
  const device = createAuditGpuDevice({ capabilities: [], features: adapter.features });
  return {
    id: `render-product.capability-negotiation.${count}`,
    group: 'render-product',
    stage: 'device-negotiation',
    budgetP95Ms: 1.5 * scaleBudget(count, 1_000),
    run() {
      let enabled = 0;
      for (let index = 0; index < count; index++) {
        const result = createRenderCapabilities(index % 2 ? 'gpu-driven' : 'diagnostic', adapter, device, 'bgra8unorm');
        enabled += result.report.decisions.filter(decision => decision.enabled).length;
      }
      return enabled;
    },
  };
}

function scaleBudget(count, base) { return Math.max(1, count / base); }

function ecsQueryCase(count) {
  return {
    id: `ecs.query-structure.${count}`,
    group: 'ecs',
    // A single query registration/removal is below the host scheduler noise
    // floor on the fixed Apple runner. Measure a complete batch and let the
    // harness normalize the duration back to one lifecycle operation.
    iterations: 100,
    setup() {
      const world = new World('benchmark:ecs');
      const entities = [];
      for (let index = 0; index < count; index++) {
        const entity = new Entity().addComponent(new BenchA());
        if ((index & 1) === 0) entity.addComponent(new BenchB());
        world.addEntity(entity);
        entities.push(entity);
      }
      return { world, entities };
    },
    run({ world, entities }, iteration) {
      const query = new System({ all: [BenchA, BenchB] });
      world.addSystem(query);
      const matches = query.entitySet.get(world)?.size ?? 0;
      world.removeSystem(query);
      const entity = entities[iteration % entities.length];
      entity.removeComponent(BenchB);
      entity.addComponent(new BenchB());
      return matches;
    },
    teardown({ world }) { world.destroy(); },
  };
}

function transformCase(count) {
  return {
    id: `transform.hierarchy-frame-data.${count}`,
    group: 'transform',
    // FrameData reuse makes one hierarchy refresh too short for a stable P95.
    // The harness normalizes this batch back to one begin/getWorldMatrix op.
    iterations: 100,
    setup() {
      const world = new World('benchmark:transform');
      let parent = new Entity().addComponent(new Transform3D());
      world.addEntity(parent);
      for (let index = 1; index < count; index++) {
        const child = new Entity().addComponent(new Transform3D().setTranslation(1, 0, 0));
        parent.addChild(child);
        world.addEntity(child);
        parent = child;
      }
      return { world, leaf: parent, frame: new FrameData(), frameId: 0 };
    },
    run(state) {
      state.frame.begin(state.world, null, ++state.frameId, 16);
      return state.frame.transforms.getWorldMatrix(state.leaf)[12];
    },
    teardown({ world }) { world.destroy(); },
  };
}

function renderCollectionCase(count) {
  return {
    id: `render3d.collect-cull-sort.${count}`,
    group: 'render3d',
    setup() {
      const frustum = new Frustum();
      frustum.setFromViewProjection(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
      const spheres = Array.from({ length: count }, (_, index) => ({
        center: new Float32Array([(index % 17) / 8 - 1, ((index * 7) % 19) / 9 - 1, 0]),
        radius: 0.05 + (index % 3) * 0.01,
        id: index,
      }));
      return { frustum, spheres, visible: [] };
    },
    run({ frustum, spheres, visible }) {
      visible.length = 0;
      for (const sphere of spheres) if (frustum.containsSphere(sphere)) visible.push(sphere);
      visible.sort((a, b) => a.center[2] - b.center[2] || a.id - b.id);
      return visible.length;
    },
  };
}

function render3dFullPrepareCase(entityCount, viewCount) {
  return {
    id: `render3d.full-prepare.${entityCount}e.${viewCount}v`,
    group: 'render3d',
    stage: 'full-prepare',
    // The 1K control-path cases are below the stable timer window on the fixed
    // runner. Batch complete prepare frames; 10K cases already exceed it.
    iterations: entityCount <= 1_000 ? 20 : 1,
    metricBudgets: {
      sceneExtractionsPerFrame: { min: 1, max: 1 },
      viewCollectionsPerFrame: { min: viewCount, max: viewCount },
      uniformUploadsPerFrame: { min: viewCount, max: viewCount },
      rendererBeginViewsPerFrame: { min: viewCount, max: viewCount },
      rendererPrepareCallsPerFrame: { min: viewCount * 2, max: viewCount * 2 },
      rendererPreparedObjectsPerFrame: { min: entityCount * viewCount, max: entityCount * viewCount },
      rendererFlushesPerFrame: { min: viewCount, max: viewCount },
      rendererEndViewsPerFrame: { min: viewCount, max: viewCount },
      visibleItemsPerFrame: { min: entityCount * viewCount, max: entityCount * viewCount },
      drawCallsPerFrame: { min: entityCount * viewCount, max: entityCount * viewCount },
      lightCount: { min: 8, max: 8 },
    },
    setup() {
      return createRender3dFullPrepareState(entityCount, viewCount);
    },
    resetMetrics(state) {
      state.measuredFrames = 0;
      resetRender3dPhaseTimings(state.phaseTimings);
      state.extractionBaseline = state.render3d.sceneExtractionCount;
      state.uploadBaseline = state.arena.getStats().uploadCount;
      state.drawBaseline = state.counters.drawCalls;
      state.beginViewBaseline = state.counters.beginViews;
      state.prepareBaseline = state.counters.prepareCalls;
      state.preparedObjectBaseline = state.counters.preparedObjects;
      state.flushBaseline = state.counters.flushes;
      state.endViewBaseline = state.counters.endViews;
    },
    run(state) {
      state.world.frameData.begin(state.world, state.engine, ++state.frameId, 16);
      state.render3d.record(state.world, state.context);
      state.measuredFrames++;
      return state.render3d.lastVisibleCount + state.counters.drawCalls;
    },
    teardown(state) {
      state.finalMetrics = render3dFullPrepareMetrics(state);
      state.world.destroy();
      disposeSceneFrameGpuArena(state.device);
    },
    metrics(state) {
      return state.finalMetrics ?? render3dFullPrepareMetrics(state);
    },
  };
}

function render3dGpuMultiViewPrepareCase(entityCount, viewCount) {
  return {
    id: `render3d.gpu-multiview-prepare.${entityCount}e.${viewCount}v`,
    group: 'render3d',
    stage: 'gpu-multiview-prepare',
    iterations: 1,
    metricBudgets: {
      sceneExtractionsPerFrame: { min: 1, max: 1 },
      viewCollectionsPerFrame: { min: viewCount, max: viewCount },
      uniformUploadsPerFrame: { min: viewCount, max: viewCount },
      sceneGlobalInstanceTableUploadsPerFrame: { min: 1, max: 1 },
      viewLocalIndirectUploadsPerFrame: { min: viewCount, max: viewCount },
      globalCommandBuildsPerFrame: { min: 1, max: 1 },
      commandObjectsCreatedPerFrame: { min: 0, max: 0 },
      materialRendererResolutionsPerFrame: { min: 0, max: 0 },
      gpuBatchCount: { min: 1, max: entityCount },
      drawCallsPerFrame: { min: entityCount * viewCount, max: entityCount * viewCount },
    },
    setup() {
      return createRender3dFullPrepareState(entityCount, viewCount, false, true);
    },
    resetMetrics(state) {
      state.measuredFrames = 0;
      state.extractionBaseline = state.render3d.sceneExtractionCount;
      state.uploadBaseline = state.arena.getStats().uploadCount;
      state.drawBaseline = state.counters.drawCalls;
      state.globalInstanceUploadBaseline = getRender3dPrepareWriteCount(
        state.device,
        'Render3DSystem.batches.instanceTable',
      );
      state.viewIndirectUploadBaseline = getRender3dPrepareViewIndirectWriteCount(state.device);
    },
    run(state) {
      state.world.frameData.begin(state.world, state.engine, ++state.frameId, 16);
      state.render3d.record(state.world, state.context);
      state.measuredFrames++;
      return state.render3d.lastGpuDrivenBatchCount + state.counters.drawCalls;
    },
    teardown(state) {
      state.finalMetrics = render3dGpuMultiViewPrepareMetrics(state);
      state.world.destroy();
      disposeSceneFrameGpuArena(state.device);
    },
    metrics(state) {
      return state.finalMetrics ?? render3dGpuMultiViewPrepareMetrics(state);
    },
  };
}

function render3dSpatialIncrementalCase(entityCount, dynamicRatio, viewCount) {
  const dynamicPercent = Math.round(dynamicRatio * 100);
  const dynamicCount = Math.round(entityCount * dynamicRatio);
  const sparseUpdate = dynamicRatio > 0 && dynamicRatio < 0.25;
  return {
    id: `render3d.spatial-incremental.${entityCount}e.${dynamicPercent}pct.${viewCount}v`,
    group: 'render3d',
    stage: 'spatial-incremental',
    iterations: 1,
    metricBudgets: {
      sceneExtractionsPerFrame: { min: 1, max: 1 },
      spatialSyncsPerFrame: { min: dynamicRatio > 0 ? 1 : 0, max: dynamicRatio > 0 ? 1 : 0 },
      spatialQueriesPerFrame: { min: viewCount, max: viewCount },
      fullMeshScansPerFrame: { min: 0, max: 0 },
      updatedBoundsPerFrame: { min: dynamicCount, max: dynamicCount },
      refitsPerFrame: { min: sparseUpdate ? 1 : 0, max: sparseUpdate ? 1 : 0 },
      rebuildsPerFrame: { min: dynamicRatio >= 0.25 ? 1 : 0, max: dynamicRatio >= 0.25 ? 1 : 0 },
      uniformUploadsPerFrame: { min: viewCount, max: viewCount },
    },
    setup() {
      return createRender3dFullPrepareState(entityCount, viewCount, true);
    },
    resetMetrics(state) {
      const service = getSpatialIndexService(state.world);
      state.measuredFrames = 0;
      state.extractionBaseline = state.render3d.sceneExtractionCount;
      state.uploadBaseline = state.arena.getStats().uploadCount;
      state.spatialSyncBaseline = service.meshSyncCount;
      state.fullScanBaseline = service.meshFullScanCount;
      state.updatedBoundsBaseline = service.meshUpdatedEntryCount;
      state.refitBaseline = service.meshIndex.refitCount;
      state.rebuildBaseline = service.meshIndex.rebuildCount;
    },
    run(state) {
      state.motionTick++;
      for (let item = 0; item < dynamicCount; item++) {
        const transform = state.meshTransforms[item];
        transform.setTranslation(transform.localMatrix[12] + 0.001, transform.localMatrix[13], transform.localMatrix[14]);
      }
      state.world.frameData.begin(state.world, state.engine, ++state.frameId, 16);
      state.render3d.record(state.world, state.context);
      state.measuredFrames++;
      return state.render3d.lastSpatialCandidateCount + state.render3d.lastVisibleCount + state.motionTick;
    },
    teardown(state) {
      state.finalMetrics = render3dSpatialIncrementalMetrics(state);
      state.world.destroy();
      disposeSceneFrameGpuArena(state.device);
    },
    metrics(state) {
      return state.finalMetrics ?? render3dSpatialIncrementalMetrics(state);
    },
  };
}

function render3dShadowSpatialCase(entityCount, viewCount) {
  return {
    id: `render3d.shadow-spatial.${entityCount}e.${viewCount}v`,
    group: 'render3d',
    stage: 'shadow-spatial',
    iterations: 1,
    metricBudgets: {
      sceneExtractionsPerFrame: { min: 1, max: 1 },
      spatialSyncsPerFrame: { min: 0, max: 0 },
      spatialQueriesPerFrame: { min: viewCount + 1, max: viewCount + 1 },
      shadowQueriesPerFrame: { min: 1, max: 1 },
      spatialCandidatesPerFrame: { min: entityCount / 2, max: entityCount / 2 },
      fullMeshScansPerFrame: { min: 0, max: 0 },
      uniformUploadsPerFrame: { min: viewCount, max: viewCount },
    },
    setup() {
      const state = createRender3dFullPrepareState(entityCount, viewCount, true, false, true);
      for (let item = entityCount / 2; item < entityCount; item++) {
        const transform = state.meshTransforms[item];
        transform.setTranslation(
          (transform.localMatrix[12] ?? 0) + 1_000,
          transform.localMatrix[13] ?? 0,
          transform.localMatrix[14] ?? 0,
        );
      }
      return state;
    },
    resetMetrics(state) {
      const service = getSpatialIndexService(state.world);
      state.measuredFrames = 0;
      state.extractionBaseline = state.render3d.sceneExtractionCount;
      state.uploadBaseline = state.arena.getStats().uploadCount;
      state.spatialSyncBaseline = service.meshSyncCount;
      state.fullScanBaseline = service.meshFullScanCount;
    },
    run(state) {
      state.world.frameData.begin(state.world, state.engine, ++state.frameId, 16);
      state.render3d.record(state.world, state.context);
      state.measuredFrames++;
      return state.render3d.lastSpatialCandidateCount + state.render3d.lastVisibleCount;
    },
    teardown(state) {
      state.finalMetrics = render3dShadowSpatialMetrics(state);
      state.world.destroy();
      disposeSceneFrameGpuArena(state.device);
    },
    metrics(state) {
      return state.finalMetrics ?? render3dShadowSpatialMetrics(state);
    },
  };
}

function createRender3dFullPrepareState(
  entityCount,
  viewCount,
  spatialIncremental = false,
  gpuMultiView = false,
  directionalShadow = false,
) {
  ensureGpuConstants();
  const device = createRender3dPrepareDevice(gpuMultiView);
  const target = createRender3dPrepareTarget();
  const engine = createRender3dPrepareEngine(device, target);
  const world = new World(`benchmark:render3d-full-prepare:${entityCount}:${viewCount}`);
  const geometry = new Geometry3D({
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]),
    indices: new Uint16Array([0, 1, 2]),
    boundsMode: 'manual',
    localBounds: { center: [0, 0, 0], radius: 0.75 },
  });
  const opaqueMaterial = new BasicMaterial({ blending: 'none' });
  const transparentMaterial = new BasicMaterial({ blending: 'normal', depthWrite: false });
  const transparentEntityCount = Math.ceil(entityCount / 4);
  const meshTransforms = [];

  for (let index = 0; index < entityCount; index++) {
    const x = (index % 100) * 0.15 - 7.5;
    const y = (Math.floor(index / 100) % 100) * 0.15 - 7.5;
    const z = -((index * 17) % 31) * 0.02;
    const transform = new Transform3D().setTranslation(x, y, z);
    meshTransforms.push(transform);
    const entity = new Entity(`mesh:${index}`)
      .addComponent(transform)
      .addComponent(new Mesh3D(geometry, index < transparentEntityCount ? transparentMaterial : opaqueMaterial));
    world.addEntity(entity);
  }

  world.addEntity(new Entity('fog').addComponent(new Fog({
    mode: 'height',
    color: [0.3, 0.4, 0.5, 1],
    density: 0.025,
    heightFalloff: 0.15,
  })));
  world.addEntity(new Entity('sun')
    .addComponent(new Transform3D())
    .addComponent(new DirectionalLight({
      direction: [0.3, -1, -0.2],
      castShadow: directionalShadow,
      shadow: { extent: 20, far: 100 },
    })));
  for (let index = 0; index < 7; index++) {
    world.addEntity(new Entity(`point-light:${index}`)
      .addComponent(new Transform3D().setTranslation((index - 3) * 2, 2 + (index & 1), 4))
      .addComponent(new PointLight({ range: 20, intensity: 0.8 })));
  }

  const cameraEntities = [];
  const views = [];
  for (let index = 0; index < viewCount; index++) {
    const cameraEntity = new Entity(`camera:${index}`)
      .addComponent(new Transform3D().setTranslation((index - (viewCount - 1) / 2) * 0.4, 0, 18))
      .addComponent(new Camera3D({ near: 0.1, far: 100 }));
    world.addEntity(cameraEntity);
    cameraEntities.push(cameraEntity);
    views.push(new RenderView({
      key: `benchmark-view:${index}`,
      camera: cameraEntity,
      target,
      loadOp: index === 0 ? 'clear' : 'load',
    }).snapshot());
  }

  const arena = getSceneFrameGpuArena(device);
  const binding = arena.createBinding();
  const counters = {
    drawCalls: 0,
    beginViews: 0,
    prepareCalls: 0,
    preparedObjects: 0,
    flushes: 0,
    endViews: 0,
  };
  const materialRenderers = new MaterialRendererRegistry();
  materialRenderers.register({
    materialType: BasicMaterial,
    isTransparent: material => material.blending !== 'none',
    transparentOrder: () => 0,
    transparentDepthSort: () => true,
    beginView(context) {
      counters.beginViews++;
      binding.upload(context.sceneFrameUniforms);
    },
    prepareObjects(_context, _items, _first, count) {
      counters.prepareCalls++;
      counters.preparedObjects += count;
    },
    flushUploads() { counters.flushes++; },
    renderItem: () => { counters.drawCalls++; },
    endView() { counters.endViews++; },
  });
  const render3d = new Render3DSystem(engine, cameraEntities[0], {
    renderProfile: gpuMultiView ? 'gpu-driven' : spatialIncremental ? 'batched' : 'simple',
    spatialCullingThreshold: spatialIncremental ? 512 : undefined,
    transparentSort: true,
    materialRenderers,
    registerDefaultMaterialRenderers: false,
  });
  setRender3DMeshRenderer(render3d, {
    reverseZ: false,
    msaaSamples: 1,
    prepare() {},
    updateCamera() {},
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    releaseMaterialsNotIn() {},
    destroy() { binding.destroy(); },
  });
  const phaseTimings = createRender3dPhaseTimings();
  if (phaseTimings.enabled) installRender3dPhaseTiming(render3d, phaseTimings);
  world.addSystem(render3d);

  const context = {
    device,
    encoder: {},
    passEncoder: {},
    descriptor: target.getRenderPassDescriptor(),
    loadOp: 'clear',
    frameData: world.frameData,
    view: views[0],
    viewFamily: { views },
  };
  return {
    world,
    engine,
    device,
    render3d,
    arena,
    context,
    counters,
    entityCount,
    viewCount,
    transparentEntityCount,
    lightCount: 8,
    meshTransforms,
    motionTick: 0,
    frameId: 0,
    measuredFrames: 0,
    extractionBaseline: 0,
    uploadBaseline: 0,
    drawBaseline: 0,
    beginViewBaseline: 0,
    prepareBaseline: 0,
    preparedObjectBaseline: 0,
    flushBaseline: 0,
    endViewBaseline: 0,
    finalMetrics: null,
    phaseTimings,
    globalInstanceUploadBaseline: 0,
    viewIndirectUploadBaseline: 0,
  };
}

function render3dFullPrepareMetrics(state) {
  const frames = Math.max(1, state.measuredFrames);
  return {
    sceneExtractionsPerFrame: (state.render3d.sceneExtractionCount - state.extractionBaseline) / frames,
    viewCollectionsPerFrame: state.render3d.lastViewCount,
    uniformUploadsPerFrame: (state.arena.getStats().uploadCount - state.uploadBaseline) / frames,
    visibleItemsPerFrame: state.render3d.lastVisibleCount,
    drawCallsPerFrame: (state.counters.drawCalls - state.drawBaseline) / frames,
    rendererBeginViewsPerFrame: (state.counters.beginViews - state.beginViewBaseline) / frames,
    rendererPrepareCallsPerFrame: (state.counters.prepareCalls - state.prepareBaseline) / frames,
    rendererPreparedObjectsPerFrame: (state.counters.preparedObjects - state.preparedObjectBaseline) / frames,
    rendererFlushesPerFrame: (state.counters.flushes - state.flushBaseline) / frames,
    rendererEndViewsPerFrame: (state.counters.endViews - state.endViewBaseline) / frames,
    transparentEntityCount: state.transparentEntityCount,
    lightCount: state.lightCount,
    ...(state.phaseTimings.enabled
      ? { phaseTimingsMsPerFrame: render3dPhaseTimingsPerFrame(state.phaseTimings, frames) }
      : {}),
  };
}

function createRender3dPhaseTimings() {
  return {
    enabled: process.env.BENCHMARK_RENDER3D_PHASES === '1',
    sceneExtraction: 0,
    viewCollectionCulling: 0,
    opaqueTransparentSort: 0,
    rendererResolutionPrepare: 0,
    submissionLoop: 0,
  };
}

function resetRender3dPhaseTimings(timings) {
  timings.sceneExtraction = 0;
  timings.viewCollectionCulling = 0;
  timings.opaqueTransparentSort = 0;
  timings.rendererResolutionPrepare = 0;
  timings.submissionLoop = 0;
}

function installRender3dPhaseTiming(render3d, timings) {
  timeMethod(render3d._sceneCollector, 'extract', timings, 'sceneExtraction');
  timeMethod(render3d._sceneCollector, 'collectView', timings, 'viewCollectionCulling');
  timeMethod(render3d._viewPreparation.opaqueSorter, 'sort', timings, 'opaqueTransparentSort');
  timeMethod(
    render3d._transparentOrchestrator,
    'sortTransparentItems',
    timings,
    'opaqueTransparentSort',
  );
  timeMethod(render3d._submitter, 'prepareView', timings, 'rendererResolutionPrepare');
  timeMethod(render3d._submitter, 'drawOpaqueItems', timings, 'submissionLoop');
  timeMethod(render3d._submitter, 'drawDepthPrepassItems', timings, 'submissionLoop');
  timeMethod(render3d._submitter, 'drawTransparentItems', timings, 'submissionLoop');
}

function timeMethod(owner, name, timings, phase) {
  if (!owner || typeof owner[name] !== 'function') return;
  const method = owner[name];
  owner[name] = function timedRender3dBenchmarkPhase(...args) {
    const started = performance.now();
    try {
      return method.apply(this, args);
    } finally {
      timings[phase] += performance.now() - started;
    }
  };
}

function render3dPhaseTimingsPerFrame(timings, frames) {
  return {
    sceneExtraction: timings.sceneExtraction / frames,
    viewCollectionCulling: timings.viewCollectionCulling / frames,
    opaqueTransparentSort: timings.opaqueTransparentSort / frames,
    rendererResolutionPrepare: timings.rendererResolutionPrepare / frames,
    submissionLoop: timings.submissionLoop / frames,
  };
}

function render3dSpatialIncrementalMetrics(state) {
  const frames = Math.max(1, state.measuredFrames);
  const service = getSpatialIndexService(state.world);
  return {
    sceneExtractionsPerFrame: (state.render3d.sceneExtractionCount - state.extractionBaseline) / frames,
    spatialSyncsPerFrame: (service.meshSyncCount - state.spatialSyncBaseline) / frames,
    spatialQueriesPerFrame: state.render3d.lastSpatialQueryCount,
    spatialCandidatesPerFrame: state.render3d.lastSpatialCandidateCount,
    fullMeshScansPerFrame: (service.meshFullScanCount - state.fullScanBaseline) / frames,
    updatedBoundsPerFrame: (service.meshUpdatedEntryCount - state.updatedBoundsBaseline) / frames,
    refitsPerFrame: (service.meshIndex.refitCount - state.refitBaseline) / frames,
    rebuildsPerFrame: (service.meshIndex.rebuildCount - state.rebuildBaseline) / frames,
    uniformUploadsPerFrame: (state.arena.getStats().uploadCount - state.uploadBaseline) / frames,
  };
}

function render3dShadowSpatialMetrics(state) {
  const frames = Math.max(1, state.measuredFrames);
  const service = getSpatialIndexService(state.world);
  return {
    sceneExtractionsPerFrame: (state.render3d.sceneExtractionCount - state.extractionBaseline) / frames,
    spatialSyncsPerFrame: (service.meshSyncCount - state.spatialSyncBaseline) / frames,
    spatialQueriesPerFrame: state.render3d.lastSpatialQueryCount,
    shadowQueriesPerFrame: state.render3d.lastSpatialShadowQueryCount,
    spatialCandidatesPerFrame: state.render3d.lastSpatialCandidateCount,
    fullMeshScansPerFrame: (service.meshFullScanCount - state.fullScanBaseline) / frames,
    uniformUploadsPerFrame: (state.arena.getStats().uploadCount - state.uploadBaseline) / frames,
  };
}

function render3dGpuMultiViewPrepareMetrics(state) {
  const frames = Math.max(1, state.measuredFrames);
  return {
    sceneExtractionsPerFrame: (state.render3d.sceneExtractionCount - state.extractionBaseline) / frames,
    viewCollectionsPerFrame: state.render3d.lastViewCount,
    uniformUploadsPerFrame: (state.arena.getStats().uploadCount - state.uploadBaseline) / frames,
    sceneGlobalInstanceTableUploadsPerFrame: (
      getRender3dPrepareWriteCount(state.device, 'Render3DSystem.batches.instanceTable')
      - state.globalInstanceUploadBaseline
    ) / frames,
    viewLocalIndirectUploadsPerFrame: (
      getRender3dPrepareViewIndirectWriteCount(state.device)
      - state.viewIndirectUploadBaseline
    ) / frames,
    globalCommandBuildsPerFrame: state.render3d.lastGpuDrivenGlobalCommandBuilds,
    commandObjectsCreatedPerFrame: state.render3d.lastGpuDrivenCommandObjectsCreated,
    materialRendererResolutionsPerFrame: state.render3d.lastGpuDrivenMaterialRendererResolutions,
    gpuBatchCount: state.render3d.lastGpuDrivenBatchCount,
    drawCallsPerFrame: (state.counters.drawCalls - state.drawBaseline) / frames,
  };
}

function createRender3dPrepareDevice(indirect = false) {
  return createAuditGpuDevice({
    capabilities: ['buffer', 'bind-group-layout', 'bind-group', 'queue'],
    features: indirect ? ['indirect-first-instance'] : [],
  });
}

function getRender3dPrepareWriteCount(device, label) {
  return getAuditGpuDeviceState(device).getUploadCount(label);
}

function getRender3dPrepareViewIndirectWriteCount(device) {
  let count = 0;
  for (const [label, upload] of getAuditGpuDeviceState(device).uploadsByLabel) {
    if (/^Render3DSystem\.batches\.view\.\d+\.indexedIndirect$/.test(label)) count += upload.calls;
  }
  return count;
}

function createRender3dPrepareTarget() {
  const outputView = {};
  const descriptor = {
    colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store' }],
  };
  return {
    format: 'bgra8unorm',
    width: 1280,
    height: 720,
    displayWidth: 1280,
    displayHeight: 720,
    getRenderPassDescriptor() { return descriptor; },
    getOutputView() { return outputView; },
  };
}

function createRender3dPrepareEngine(device, renderTarget) {
  return {
    device,
    format: renderTarget.format,
    width: renderTarget.width,
    height: renderTarget.height,
    displayWidth: renderTarget.displayWidth,
    displayHeight: renderTarget.displayHeight,
    reverseZ: false,
    msaaSamples: 1,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    depthTextureView: {},
    msaaTextureView: null,
    assetManager: undefined,
    renderProfile: 'simple',
    renderTarget,
    getDepthFormat() { return 'depth24plus'; },
    getRenderPassDescriptor() { return renderTarget.getRenderPassDescriptor(); },
    getOutputView() { return renderTarget.getOutputView(); },
  };
}

function gpuBatchCase(count) {
  return {
    id: `gpu-driven.mega-batch-build.${count}`,
    group: 'gpu-driven',
    setup: () => new TransparentMegaBatch(null, 'benchmark'),
    run(batch) {
      batch.clear();
      for (let index = 0; index < count; index++) batch.push({
        payload: index,
        entityId: index,
        materialId: index % 32,
        rendererKey: index % 4,
        viewDepth: (index * 16807) % count,
        transparentOrder: index % 3,
        depthSort: true,
      });
      batch.sort();
      return batch.runs.length;
    },
  };
}

function gltfParseCase(nodeCount) {
  const document = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: Array.from({ length: nodeCount }, (_, i) => i) }], nodes: Array.from({ length: nodeCount }, (_, i) => ({ name: `Node${i}` })) });
  const url = `data:model/gltf+json,${encodeURIComponent(document)}`;
  return {
    id: `asset.gltf-parse.${nodeCount}`,
    group: 'asset',
    stage: 'parse',
    budgetP95Ms: 1,
    async run() { return (await loadParsedGltfAsset(url)).gltf.nodes?.length ?? 0; },
  };
}

function dracoDecodeCase(pointCount) {
  return {
    id: `asset.draco-decode.${pointCount}`,
    group: 'asset',
    stage: 'parse',
    budgetP95Ms: 0.5,
    async setup() {
      const draco = await import('draco3dgltf');
      const encoderModule = await draco.createEncoderModule({});
      const decoderModule = await draco.createDecoderModule({});
      const mesh = new encoderModule.Mesh();
      const builder = new encoderModule.MeshBuilder();
      const positions = new Float32Array(pointCount * 3);
      for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i * 0.01);
      builder.AddFloatAttributeToMesh(mesh, encoderModule.POSITION, pointCount, 3, positions);
      const faceCount = Math.floor(pointCount / 3);
      const faces = new Uint32Array(faceCount * 3);
      for (let i = 0; i < faces.length; i++) faces[i] = i;
      builder.AddFacesToMesh(mesh, faceCount, faces);
      const encoder = new encoderModule.Encoder();
      const encoded = new encoderModule.DracoInt8Array();
      const length = encoder.EncodeMeshToDracoBuffer(mesh, encoded);
      const bytes = new Int8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = encoded.GetValue(i);
      encoderModule.destroy(encoded); encoderModule.destroy(encoder); encoderModule.destroy(builder); encoderModule.destroy(mesh);
      return { decoderModule, bytes };
    },
    run({ decoderModule, bytes }) {
      const buffer = new decoderModule.DecoderBuffer();
      buffer.Init(bytes, bytes.length);
      const decoder = new decoderModule.Decoder();
      const mesh = new decoderModule.Mesh();
      const status = decoder.DecodeBufferToMesh(buffer, mesh);
      const points = status.ok() ? mesh.num_points() : 0;
      decoderModule.destroy(mesh); decoderModule.destroy(decoder); decoderModule.destroy(buffer);
      return points;
    },
  };
}

function ktx2ParseCase() {
  const buffer = createKtx2Fixture();
  return {
    id: 'asset.ktx2-header-parse.4x4',
    group: 'asset',
    stage: 'parse',
    iterations: HEADER_PARSE_WINDOW_ITERATIONS,
    budgetP95Ms: 0.05,
    run: () => inspectKtx2Texture(buffer).width,
  };
}

function spineParseCase(boneCount) {
  const data = { bones: Array.from({ length: boneCount }, (_, i) => ({ name: `bone${i}`, ...(i ? { parent: `bone${i - 1}` } : {}) })), slots: [{ name: 'slot', bone: 'bone0' }], skins: {} };
  const atlas = `page.png\nsize: 256,256\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n${Array.from({ length: boneCount }, (_, i) => `region${i}\n  xy: ${i}, ${i}\n  size: 8, 8`).join('\n')}`;
  return { id: `asset.spine-parse.${boneCount}`, group: 'asset', stage: 'parse', budgetP95Ms: 1, run: () => benchmarkSpineParse(data, atlas) };
}

function spineAnimationSampleCase(boneCount, keyframeCount) {
  const compiledTimelines = boneCount * 2 + 1;
  const compiledFrames = boneCount * keyframeCount * 2 + 2;
  return {
    id: `animation.spine-timeline-sample.${boneCount}b.${keyframeCount}f`,
    group: 'animation',
    stage: 'spine-timeline-sample',
    iterations: SPINE_SAMPLE_WINDOW_ITERATIONS,
    metricBudgets: {
      compiledTimelines: { min: compiledTimelines, max: compiledTimelines },
      compiledFrames: { min: compiledFrames, max: compiledFrames },
      sampledBones: { min: boneCount, max: boneCount },
      timelineCursorMisses: { max: 0 },
    },
    setup: () => createSpineAnimationBenchmarkState(boneCount, 1, keyframeCount),
    resetMetrics(state) {
      state.timelineCursorBaseline = state.runtime.timelineSamplerState.cursorMisses;
    },
    run: state => benchmarkSpineAnimationSample(state),
    metrics(state) {
      return {
        compiledTimelines: state.runtime.timelineCompileStats.timelineCount,
        compiledFrames: state.runtime.timelineCompileStats.frameCount,
        sampledBones: state.boneCount,
        timelineCursorMisses: state.runtime.timelineSamplerState.cursorMisses - (state.timelineCursorBaseline ?? 0),
      };
    },
    allocationEvidence(state) {
      return {
        kind: 'deterministic-spine-timeline-cursors',
        timelineCursorMisses: state.runtime.timelineSamplerState.cursorMisses - (state.timelineCursorBaseline ?? 0),
      };
    },
  };
}

function spineVertexBuildCase(boneCount, slotCount, keyframeCount) {
  const compiledTimelines = boneCount * 2 + slotCount;
  const compiledFrames = boneCount * keyframeCount * 2 + slotCount * 2;
  const vertexFloats = slotCount * 6 * 8;
  return {
    id: `render2d.spine-vertex-build.${boneCount}b.${slotCount}s.${keyframeCount}f`,
    group: 'render2d',
    stage: 'spine-vertex-build',
    metricBudgets: {
      compiledTimelines: { min: compiledTimelines, max: compiledTimelines },
      compiledFrames: { min: compiledFrames, max: compiledFrames },
      sampledBones: { min: boneCount, max: boneCount },
      builtSlots: { min: slotCount, max: slotCount },
      vertexFloats: { min: vertexFloats, max: vertexFloats },
      slotRegionGrowths: { max: 0 },
      batchPoolMisses: { max: 0 },
      dirtyRangePoolMisses: { max: 0 },
      stableSlotRegions: { min: slotCount, max: slotCount },
      stableBuildResult: { min: 1, max: 1 },
      timelineCursorMisses: { max: 0 },
    },
    setup: () => createSpineAnimationBenchmarkState(boneCount, slotCount, keyframeCount),
    resetMetrics(state) {
      state.allocationBaseline = { ...state.runtime.allocationStats };
      state.timelineCursorBaseline = state.runtime.timelineSamplerState.cursorMisses;
      state.buildResultBaseline = state.runtime.vertexBuildResult;
      state.slotRegionBaseline = new Map(
        [...state.runtime.slotGeometryCache].map(([key, cache]) => [key, cache.vertices]),
      );
    },
    run: state => benchmarkSpineVertexBuild(state),
    metrics(state) {
      const baseline = state.allocationBaseline ?? { slotRegionGrowths: 0, batchPoolMisses: 0, dirtyRangePoolMisses: 0 };
      let stableSlotRegions = 0;
      for (const [key, cache] of state.runtime.slotGeometryCache) {
        if (state.slotRegionBaseline?.get(key) === cache.vertices) stableSlotRegions++;
      }
      return {
        compiledTimelines: state.runtime.timelineCompileStats.timelineCount,
        compiledFrames: state.runtime.timelineCompileStats.frameCount,
        sampledBones: state.boneCount,
        builtSlots: state.slotCount,
        vertexFloats: state.runtime.vertexBuilder.length,
        slotRegionGrowths: state.runtime.allocationStats.slotRegionGrowths - baseline.slotRegionGrowths,
        batchPoolMisses: state.runtime.allocationStats.batchPoolMisses - baseline.batchPoolMisses,
        dirtyRangePoolMisses: state.runtime.allocationStats.dirtyRangePoolMisses - baseline.dirtyRangePoolMisses,
        stableSlotRegions,
        stableBuildResult: state.runtime.vertexBuildResult === state.buildResultBaseline ? 1 : 0,
        timelineCursorMisses: state.runtime.timelineSamplerState.cursorMisses - (state.timelineCursorBaseline ?? 0),
      };
    },
    allocationEvidence(state) {
      const baseline = state.allocationBaseline ?? { slotRegionGrowths: 0, batchPoolMisses: 0, dirtyRangePoolMisses: 0 };
      return {
        kind: 'deterministic-spine-pool-counters',
        slotRegionGrowths: state.runtime.allocationStats.slotRegionGrowths - baseline.slotRegionGrowths,
        batchPoolMisses: state.runtime.allocationStats.batchPoolMisses - baseline.batchPoolMisses,
        dirtyRangePoolMisses: state.runtime.allocationStats.dirtyRangePoolMisses - baseline.dirtyRangePoolMisses,
        timelineCursorMisses: state.runtime.timelineSamplerState.cursorMisses - (state.timelineCursorBaseline ?? 0),
      };
    },
  };
}

function assetUploadSchedulingCase(byteLength) {
  return {
    id: `asset.upload-budget.${byteLength}`,
    group: 'asset',
    stage: 'upload',
    // The scheduler deliberately performs no byte copy in this control-path
    // case, so one four-task drain only takes a few microseconds. A larger
    // measurement window keeps P95/RSD meaningful without changing ms/op.
    iterations: ASYNC_CONTROL_WINDOW_ITERATIONS,
    budgetP95Ms: 0.5,
    async run() {
      const scheduler = new AssetUploadScheduler(byteLength / 2);
      let checksum = 0;
      const tasks = [];
      for (let index = 0; index < 4; index++) {
        tasks.push(scheduler.enqueue({
          label: `chunk-${index}`,
          bytes: byteLength / 4,
          priority: index === 0 ? 'interactive' : 'normal',
          upload: () => { checksum = (checksum + byteLength / 4 + index) >>> 0; return index; },
        }));
      }
      while (scheduler.snapshot().pendingTasks > 0) await scheduler.drainFrame();
      await Promise.all(tasks);
      return checksum;
    },
  };
}

function imageMipmapUploadCase(size) {
  const expectedMipLevels = Math.floor(Math.log2(size)) + 1;
  const expectedBytes = mipChainBytes(size, size, 4, expectedMipLevels);
  return {
    id: `asset.image-mipmap-upload.${size}`,
    group: 'asset',
    stage: 'image-mipmap-upload',
    iterations: IMAGE_MIPMAP_WINDOW_ITERATIONS,
    budgetP95Ms: 2,
    metricBudgets: {
      mipLevelCount: { min: expectedMipLevels, max: expectedMipLevels },
      estimatedTextureBytes: { min: expectedBytes, max: expectedBytes },
      renderPassesPerUpload: { min: expectedMipLevels - 1, max: expectedMipLevels - 1 },
      submissionsPerUpload: { min: 1, max: 1 },
      liveTexturesAfterRun: { max: 0 },
    },
    setup() {
      ensureGpuConstants();
      const state = createImageMipmapBenchmarkState();
      state.manager = new AssetManager(state.device);
      return state;
    },
    resetMetrics(state) {
      state.uploads = 0;
      state.audit.reset();
      state.lastMipLevelCount = 0;
      state.lastEstimatedBytes = 0;
    },
    async run(state) {
      const handle = await state.manager.loadTexture(
        { width: size, height: size },
        { format: 'rgba8unorm-srgb', mipmaps: 'generate' },
      );
      state.uploads += 1;
      state.lastMipLevelCount = handle.value.mipLevelCount;
      state.lastEstimatedBytes = mipChainBytes(size, size, 4, state.lastMipLevelCount);
      handle.release();
      return state.lastMipLevelCount;
    },
    teardown(state) { state.manager.dispose(); },
    metrics(state) {
      const textureResources = state.audit.resources.get('texture');
      return {
        mipLevelCount: state.lastMipLevelCount,
        estimatedTextureBytes: state.lastEstimatedBytes,
        renderPassesPerUpload: state.uploads === 0
          ? 0
          : state.audit.getCallCount('commandEncoder.beginRenderPass') / state.uploads,
        submissionsPerUpload: state.uploads === 0
          ? 0
          : state.audit.getCallCount('queue.submit') / state.uploads,
        liveTexturesAfterRun: textureResources?.live ?? 0,
      };
    },
  };
}

function animationSamplingCase(frameCount) {
  return {
    id: `animation.gltf-sampling.${frameCount}`,
    group: 'animation',
    stage: 'animation-sampling',
    iterations: SYNC_MICRO_WINDOW_ITERATIONS,
    budgetP95Ms: 0.05,
    setup() {
      const target = { entity: new Entity(), transform: new Transform3D(), translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], weights: [], morphPrimitives: [] };
      const input = Float32Array.from({ length: frameCount }, (_, i) => i / (frameCount - 1));
      const output = new Float32Array(frameCount * 3);
      for (let i = 0; i < frameCount; i++) output[i * 3] = i;
      return { name: 'benchmark', duration: 1, channels: [{ target, path: 'translation', interpolation: 'LINEAR', valueSize: 3, input, output, sampleA: new Float32Array(3), sampleB: new Float32Array(3), sampleOut: new Float32Array(3), quatScratch: new Float32Array(4) }], skinnedPrimitives: [], stateCache: new Map(), activeStates: [] };
    },
    run(clip, iteration) { applyGltfAnimationClip(clip, (iteration % 100) / 100); return clip.channels[0].target.transform.localMatrix[12]; },
  };
}

function sceneLifecycleCase(count) {
  return {
    id: `scene.load-destroy.${count}`,
    group: 'scene',
    run() {
      const world = new World('benchmark:scene');
      for (let i = 0; i < count; i++) world.addEntity(new Entity().addComponent(new Transform3D()));
      const result = world.entities.size;
      world.destroy();
      return result;
    },
  };
}

function createKtx2Fixture() {
  const bytes = new Uint8Array(104);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, 37, true); view.setUint32(16, 1, true); view.setUint32(20, 4, true); view.setUint32(24, 4, true);
  view.setUint32(36, 1, true); view.setUint32(40, 1, true);
  return bytes.buffer;
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
  globalThis.GPUShaderStage ??= { VERTEX: 1 << 0, FRAGMENT: 1 << 1, COMPUTE: 1 << 2 };
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1 << 0, COPY_DST: 1 << 1, RENDER_ATTACHMENT: 1 << 2 };
  globalThis.GPUMapMode ??= { READ: 1 };
}

function createImageMipmapBenchmarkState() {
  const state = {
    uploads: 0,
    renderPasses: 0,
    submissions: 0,
    liveTextures: 0,
    lastMipLevelCount: 0,
    lastEstimatedBytes: 0,
    manager: null,
    device: null,
  };
  state.device = createAuditGpuDevice({ capabilities: GPU_MOCK_CAPABILITIES.RENDER });
  state.audit = getAuditGpuDeviceState(state.device);
  return state;
}

function mipChainBytes(width, height, bytesPerPixel, mipLevelCount) {
  let bytes = 0;
  for (let level = 0; level < mipLevelCount; level++) {
    bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * bytesPerPixel;
  }
  return bytes;
}

function createReadbackBenchmarkState() {
  const state = {
    frame: 0,
    submitSerial: 0,
    requests: 0,
    accepted: 0,
    skipped: 0,
    maxPending: 0,
    mappingsBeforeSubmit: 0,
    completedMappings: 0,
    totalLatencyFrames: 0,
    pendingMappings: [],
    batch: null,
    device: null,
  };
  state.device = createAuditGpuDevice({
    capabilities: composeGpuMockCapabilities(
      ['buffer', 'queue'],
      ['command-encoder'],
    ),
    behaviors: {
      'buffer.mapAsync'() {
        if (state.submitSerial === 0) state.mappingsBeforeSubmit += 1;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        state.pendingMappings.push({ resolve, startedFrame: state.frame });
        state.maxPending = Math.max(state.maxPending, state.pendingMappings.length);
        return promise;
      },
      'queue.submit'() { state.submitSerial += 1; },
    },
  });
  return state;
}

function resetReadbackMetrics(state) {
  state.frame = 0;
  state.submitSerial = 0;
  state.requests = 0;
  state.accepted = 0;
  state.skipped = 0;
  state.maxPending = 0;
  state.mappingsBeforeSubmit = 0;
  state.completedMappings = 0;
  state.totalLatencyFrames = 0;
  state.pendingMappings.length = 0;
}

async function resolveDueMappings(state, latencyFrames) {
  const due = state.pendingMappings.filter(mapping => state.frame - mapping.startedFrame >= latencyFrames);
  state.pendingMappings = state.pendingMappings.filter(mapping => state.frame - mapping.startedFrame < latencyFrames);
  for (const mapping of due) {
    state.completedMappings += 1;
    state.totalLatencyFrames += state.frame - mapping.startedFrame;
    mapping.resolve();
  }
  if (due.length > 0) await flushMicrotasks();
}

async function resolveAllMappings(state) {
  const pending = state.pendingMappings.splice(0);
  for (const mapping of pending) {
    state.completedMappings += 1;
    state.totalLatencyFrames += Math.min(3, Math.max(0, state.frame - mapping.startedFrame));
    mapping.resolve();
  }
  await flushMicrotasks();
}

function createStagingBenchmarkState() {
  const state = {
    frame: 0,
    submissions: 0,
    submittedWorkWaits: 0,
    liveStaging: 0,
    maxLiveStaging: 0,
    pendingSubmissions: [],
    device: null,
  };
  state.device = createAuditGpuDevice({
    capabilities: GPU_MOCK_CAPABILITIES.RESOURCE_UPLOAD,
    features: [],
    behaviors: {
      'queue.submit'({ defaultImplementation }) {
        state.submissions += 1;
        return defaultImplementation();
      },
      'queue.onSubmittedWorkDone'() {
        state.submittedWorkWaits += 1;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        state.pendingSubmissions.push({ resolve, startedFrame: state.frame });
        return promise;
      },
    },
  });
  state.audit = getAuditGpuDeviceState(state.device);
  return state;
}

function resetStagingMetrics(state) {
  state.frame = 0;
  state.submissions = 0;
  state.submittedWorkWaits = 0;
  state.audit.reset();
  state.pendingSubmissions.length = 0;
}

async function resolveDueSubmissions(state, latencyFrames) {
  const due = state.pendingSubmissions.filter(submission => state.frame - submission.startedFrame >= latencyFrames);
  state.pendingSubmissions = state.pendingSubmissions.filter(submission => state.frame - submission.startedFrame < latencyFrames);
  for (const submission of due) submission.resolve();
  if (due.length > 0) await flushMicrotasks();
}

async function resolveAllSubmissions(state) {
  for (const submission of state.pendingSubmissions.splice(0)) submission.resolve();
  await flushMicrotasks();
}

function createTinyKtx2Payload() {
  return {
    width: 4,
    height: 4,
    depth: 0,
    layerCount: 1,
    faceCount: 1,
    levelCount: 1,
    format: 'rgba8unorm',
    blockWidth: 1,
    blockHeight: 1,
    bytesPerBlock: 4,
    uploadPath: 'gpu-native',
    levels: [{ width: 4, height: 4, depthOrArrayLayers: 1, data: new Uint8Array(64) }],
  };
}

async function createEditorChurnState() {
  const { PlaySession, RuntimeOwnershipScope } = await import('../../editor/dist-test/testing.js');
  const originalWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    location: { origin: 'https://benchmark.haiyue.local', href: 'https://benchmark.haiyue.local/editor/' },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const state = {
    originalWindow,
    listeners,
    serializations: 0,
    ownerReleases: 0,
    cycles: 0,
    listenerResiduals: 0,
    selectionSubscriptionResiduals: 0,
    sceneReferenceResiduals: 0,
    session: null,
    RuntimeOwnershipScope,
  };
  state.session = new PlaySession({
    overlay: { hidden: true, tabIndex: 0, focus() {} },
    frame: { srcdoc: '', contentWindow: { postMessage() {} } },
    pauseButton: null,
    output: { clear() {}, append() {} },
    serializeScene: async () => {
      state.serializations += 1;
      return { version: 1, format: 'haiyue-editor-scene', entities: [] };
    },
    getDevicePixelRatio: () => 1,
    getOrigin: () => 'https://benchmark.haiyue.local',
  });
  return state;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
