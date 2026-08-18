import {
  BasicMaterial,
  BlinnPhongMaterial,
  BlinnPhongRenderSystem,
  Camera3D,
  DepthMaterial,
  DirectionalLight,
  Entity,
  Fog,
  FrameDiagnostics,
  Geometry3D,
  GPUResourceTracker,
  GrayscalePass,
  Mesh3D,
  NormalMaterial,
  PipelineWarmupPlan,
  PlanarMirror,
  PointLight,
  Render3DSystem,
  RenderView,
  Transform3D,
  VolumeMaterial,
  World,
  createGPUResourceOwner,
  createRenderFrameContext,
  disposeSceneFrameGpuArena,
  registerEngineDiagnostics,
} from '../../engine/dist/experimental.js';
import { PbrMaterial } from '../../engine/dist/index.js';
import {
  createRealRendererAuditDevice,
  ensureRealRendererGpuConstants,
} from './real-renderer-audit-device.mjs';
import { createLightingScalingRealRendererAdapter } from './lighting-scaling-real-renderer-adapter.mjs';

export { createRealRendererAuditDevice, ensureRealRendererGpuConstants } from './real-renderer-audit-device.mjs';
const OBJECT_TABLE_DIAGNOSTICS = Symbol('real-renderer-object-table-diagnostics');
export async function createRealRendererBenchmarkScenario(options) {
  ensureRealRendererGpuConstants();
  const device = options.device;
  const entityCount = options.entityCount ?? 600;
  const lightingScenario = createLightingScalingRealRendererAdapter(options.lightingFixture, options.lightingSceneDocument);
  lightingScenario?.assertViewCount(options.viewCount);
  const viewCount = lightingScenario?.viewCount ?? options.viewCount ?? 1;
  const dynamicRatio = options.dynamicRatio ?? 0;
  const mirrorConfigurations = options.mirrorConfigurations ?? null;
  const mirrorCount = mirrorConfigurations?.length ?? options.mirrorCount ?? 0;
  const maxBounces = options.maxBounces ?? 1;
  const scenarioIdentity = lightingScenario?.benchmarkIdentity ?? `real-frame:${entityCount}:${viewCount}:${dynamicRatio}`;
  let ownsTargets = false;
  let targets;
  if (lightingScenario) {
    ({ targets, ownsTargets } = lightingScenario.resolveTargets(
      { device, target: options.target, targets: options.targets, createTarget: createAuditTarget },
    ));
  } else {
    const defaultTarget = options.target ?? createAuditTarget(device);
    ownsTargets = !options.target;
    targets = Array.from({ length: viewCount }, () => defaultTarget);
  }
  if (targets.length !== viewCount) {
    throw new RangeError(
      `Real-renderer scenario requires ${viewCount} targets; received ${targets.length}.`,
    );
  }
  const target = targets[0];
  if (!target) throw new RangeError('Real-renderer scenario requires at least one target.');
  const diagnostics = new FrameDiagnostics({ enabled: true });
  const tracker = new GPUResourceTracker({ debug: true, frameDiagnostics: diagnostics });
  const owner = createGPUResourceOwner('system', `benchmark:render3d.${scenarioIdentity}`);
  instrumentBenchmarkDeviceAudit(device);
  tracker.instrumentDevice(device, owner);
  const engine = createBenchmarkEngine(device, target);
  registerEngineDiagnostics(engine, { resourceTracker: tracker, frameDiagnostics: diagnostics });
  const setupToken = tracker.enterOwner(owner);
  let world;
  let render3d;
  let blinn;
  let volumeTexture;
  try {
    world = new World(`benchmark:render3d.${scenarioIdentity}`);
    const transforms = [];
    if (lightingScenario) await lightingScenario.addSceneContent(world, mirrorCount);
    else {
      const geometry = createBenchmarkGeometry();
      volumeTexture = device.createTexture({
        label: 'render3d.real-frame.volume', size: [4, 4, 4], dimension: '3d',
        format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: volumeTexture }, new Uint8Array(4096).fill(128),
        { bytesPerRow: 256, rowsPerImage: 4 }, { width: 4, height: 4, depthOrArrayLayers: 4 },
      );
      const materials = [
        new BasicMaterial({ color: [0.7, 0.7, 0.8, 1] }),
        new PbrMaterial({ baseColor: [0.65, 0.5, 0.35, 1], metallic: 0.2, roughness: 0.65 }),
        new BlinnPhongMaterial({ diffuse: [0.45, 0.65, 0.85, 1], shininess: 24 }),
        new DepthMaterial({ near: 0.1, far: 100 }),
        new NormalMaterial({ space: 'view' }),
        new VolumeMaterial({ texture: volumeTexture, opacityScale: 0.25, steps: 8 }),
        new BasicMaterial({ color: [0.2, 0.55, 0.9, 0.45], blending: 'normal', depthWrite: false }),
      ];
      for (let index = 0; index < entityCount; index++) {
        const transform = new Transform3D().setTranslation(
          (index % 32) * 0.32 - 5,
          (Math.floor(index / 32) % 24) * 0.32 - 3.5,
          -((index * 17) % 29) * 0.035,
        );
        transforms.push(transform);
        world.addEntity(new Entity(`real-mesh:${index}`)
          .addComponent(transform)
          .addComponent(new Mesh3D(geometry, materials[index % materials.length])));
      }
      const mirrorGeometry = mirrorCount > 0 ? createBenchmarkMirrorGeometry() : null;
      for (let index = 0; index < mirrorCount; index++) {
        const configured = mirrorConfigurations?.[index];
        const x = configured?.position?.[0] ?? (mirrorCount === 1 ? 0 : (index / (mirrorCount - 1) - 0.5) * 8);
        const y = configured?.position?.[1] ?? 0;
        const z = configured?.position?.[2] ?? (index & 1 ? 2 : -2);
        const localNormal = configured?.localNormal ?? (index & 1 ? [0, 0, -1] : [0, 0, 1]);
        world.addEntity(new Entity(`real-mirror:${index}`)
          .addComponent(new Transform3D().setTranslation(x, y, z))
          .addComponent(new Mesh3D(mirrorGeometry, new BasicMaterial({ color: [0.08, 0.1, 0.14, 1] })))
          .addComponent(new PlanarMirror({
            localNormal,
            maxBounces: configured?.maxBounces ?? maxBounces,
            width: options.mirrorWidth ?? 64,
            height: options.mirrorHeight ?? 64,
            bounceResolutionScale: 0.75,
            reflectivity: 0.92,
          })));
      }
      world.addEntity(new Entity('fog').addComponent(new Fog({
        mode: 'height', color: [0.25, 0.35, 0.45, 1], density: 0.02, heightFalloff: 0.12,
      })));
      world.addEntity(new Entity('shadow-sun')
        .addComponent(new Transform3D())
        .addComponent(new DirectionalLight({
          direction: [0.3, -1, -0.2], castShadow: true,
          shadow: { extent: 18, near: 0.1, far: 80, mapSize: 256 },
        })));
      for (let index = 0; index < 7; index++) {
        world.addEntity(new Entity(`real-point-light:${index}`)
          .addComponent(new Transform3D().setTranslation((index - 3) * 1.5, 2 + (index & 1), 3))
          .addComponent(new PointLight({ range: 18, intensity: 0.7 })));
      }
    }
    const cameras = [];
    const views = [];
    for (let index = 0; index < viewCount; index++) {
      const cameraTransform = lightingScenario
        ? lightingScenario.createCameraTransform(index)
        : new Transform3D().setTranslation(
          (index - (viewCount - 1) / 2) * 0.3, 0, 16,
        );
      const camera = new Entity(`real-camera:${index}`)
        .addComponent(cameraTransform)
        .addComponent(new Camera3D(
          lightingScenario?.createCameraOptions() ?? { near: 0.1, far: 100 },
        ));
      world.addEntity(camera);
      cameras.push(camera);
      const viewTarget = targets[index];
      views.push(new RenderView({
        key: `real-frame-view:${index}`,
        camera,
        target: viewTarget,
        loadOp: index === 0 ? 'clear' : 'load',
        ...(lightingScenario?.createViewOptions(index) ?? {}),
      }).snapshot());
    }
    render3d = new Render3DSystem(engine, cameras[0], {
      renderProfile: options.renderProfile ?? 'batched',
      transparentSort: true,
      spatialCullingThreshold: 512,
      planarMirrorPlanner: mirrorCount > 0 ? {
        visibilityCulling: options.mirrorVisibilityCulling ?? false,
        minScreenPixels: 1,
        maxRttPixels: options.maxMirrorRttPixels ?? 64 * 64 * 64,
        ...(options.maxMirrorViews === undefined ? null : { maxViews: options.maxMirrorViews }),
        ...options.planarMirrorPlanner,
      } : undefined,
    });
    render3d.passes.push(new GrayscalePass());
    blinn = new BlinnPhongRenderSystem(engine, null, { render3DSystem: render3d });
    world.addSystem(render3d);
    world.addSystem(blinn);

    const audit = device.__realRendererBenchmarkAudit;
    const state = {
      device, target, targets, ownsTargets, engine, world, render3d, blinn, tracker, diagnostics, owner,
      views, transforms,
      dynamicCount: lightingScenario ? 0 : Math.round(entityCount * dynamicRatio),
      mirrorCount, maxBounces,
      frameId: 0, measuredFrames: 0, motionTick: 0, finalMetrics: null,
      lightingScenario,
      audit,
      opaqueRunBreakdown: createOpaqueRunBreakdown(),
      diagnosticTotals: emptyDiagnosticTotals(),
      allocationBaseline: snapshotHotPools(render3d),
      auditBaseline: snapshotAudit(audit),
      auditBreakdownBaseline: snapshotAuditBreakdown(audit),
      objectTableDiagnosticTotals: createObjectTableDiagnosticSnapshot(),
      objectTableDiagnosticBaseline: createObjectTableDiagnosticSnapshot(),
      objectTableDiagnosticsBefore: createObjectTableDiagnosticSnapshot(),
      objectTableDiagnosticsAfter: createObjectTableDiagnosticSnapshot(),
      resourceBaseline: null,
    };
    installOpaqueRunBreakdownDiagnostics(state, viewCount);
    return state;
  } finally {
    tracker.leaveOwner(setupToken);
  }
}

export async function warmRealRendererBenchmarkPipelines(state) {
  const plan = new PipelineWarmupPlan(`benchmark:${state.world.name}:pipelines`);
  state.render3d.contributePipelineWarmup(plan);
  state.blinn.contributePipelineWarmup(plan);
  const result = await plan.run({ concurrency: 4 });
  installRendererObjectTableDiagnostics(state);
  return result;
}

export function resetRealRendererBenchmarkMetrics(state) {
  state.measuredFrames = 0;
  state.diagnosticTotals = emptyDiagnosticTotals();
  state.auditBaseline = snapshotAudit(state.audit);
  state.auditBreakdownBaseline = snapshotAuditBreakdown(state.audit);
  copyObjectTableDiagnostics(
    state.objectTableDiagnosticBaseline,
    state.objectTableDiagnosticTotals,
  );
  state.resourceBaseline = state.tracker.getDebugSnapshot();
  state.allocationBaseline = snapshotHotPools(state.render3d);
  state.lightingScenario?.resetMetrics();
}

export async function runRealRendererBenchmarkFrame(
  state,
  { gpuTimestampProbe = null } = {},
) {
  // Installing the benchmark-only wrappers is deliberately outside the frame
  // timing boundary. Pipeline warmup normally installs all of them up front;
  // this also catches renderers that a custom scenario creates lazily.
  installRendererObjectTableDiagnostics(state);
  const frameStartedAt = performance.now();
  state.motionTick++;
  for (let index = 0; index < state.dynamicCount; index++) {
    const transform = state.transforms[index];
    transform.setTranslation(
      (index % 32) * 0.32 - 5 + ((state.motionTick + index) & 1) * 0.002,
      (Math.floor(index / 32) % 24) * 0.32 - 3.5,
      -((index * 17) % 29) * 0.035,
    );
  }
  state.lightingScenario?.applyReplayFrame();
  state.lightingScenario?.updateScene(state.world, state.motionTick * (1_000 / 60), 1_000 / 60);
  const frameId = ++state.frameId;
  state.diagnostics.beginFrame(frameId);
  state.tracker.beginFrame(frameId);
  state.world.frameData.begin(state.world, state.engine, frameId, 16);
  if (gpuTimestampProbe?.supported) {
    gpuTimestampProbe.beginFrame();
    state.audit.gpuTimestampProbe = gpuTimestampProbe;
  }
  let context;
  let cpuRecordMs = 0;
  let cpuSubmitMs = 0;
  let cpuUpdateMs = 0;
  let runtimeFrameMs = 0;
  let queueWaitMs = 0;
  let gpuUploadCpuMs = 0;
  const objectTableDiagnosticsBefore = state.objectTableDiagnosticsBefore;
  const objectTableDiagnosticsAfter = state.objectTableDiagnosticsAfter;
  try {
    context = createRenderFrameContext(state.engine, {
      frameData: state.world.frameData,
      view: state.views[0],
      viewFamily: { views: state.views },
      label: `benchmark:real-frame:${frameId}`,
    });
    const token = state.tracker.enterOwner(state.owner);
    try {
      const recordStartedAt = performance.now();
      cpuUpdateMs = recordStartedAt - frameStartedAt;
      snapshotRendererObjectTableDiagnostics(state, objectTableDiagnosticsBefore);
      const uploadCpuBefore = state.audit.bufferUploadCpuMs;
      state.render3d.record(state.world, context);
      cpuRecordMs = performance.now() - recordStartedAt;
      gpuUploadCpuMs = state.audit.bufferUploadCpuMs - uploadCpuBefore;
      snapshotRendererObjectTableDiagnostics(state, objectTableDiagnosticsAfter);
      gpuTimestampProbe?.resolve(context.encoder);
      const submitStartedAt = performance.now();
      context.submit();
      cpuSubmitMs = performance.now() - submitStartedAt;
    } finally {
      state.tracker.leaveOwner(token);
    }
  } finally {
    state.audit.gpuTimestampProbe = null;
  }
  runtimeFrameMs = performance.now() - frameStartedAt;
  const queueWaitStartedAt = performance.now();
  await state.device.queue.onSubmittedWorkDone();
  queueWaitMs = performance.now() - queueWaitStartedAt;
  const gpuTimestamp = gpuTimestampProbe?.supported
    ? await gpuTimestampProbe.readFrame()
    : null;
  state.lastFrameTiming = {
    totalMs: runtimeFrameMs,
    runtimeFrameMs,
    sampleWallMs: performance.now() - frameStartedAt,
    cpuUpdateMs,
    cpuRecordMs,
    cpuSubmitMs,
    queueWaitMs,
    gpuUploadCpuMs,
    objectTableDirtyRangeCpuMs:
      objectTableDiagnosticsAfter.dirtyRangeCpuMs
      - objectTableDiagnosticsBefore.dirtyRangeCpuMs,
    objectTableUploadCpuMs:
      objectTableDiagnosticsAfter.uploadCpuMs
      - objectTableDiagnosticsBefore.uploadCpuMs,
    objectTableFlushCount:
      objectTableDiagnosticsAfter.flushCount
      - objectTableDiagnosticsBefore.flushCount,
    denseWholeSpanUploadCount:
      objectTableDiagnosticsAfter.denseWholeSpanUploadCount
      - objectTableDiagnosticsBefore.denseWholeSpanUploadCount,
    gpuTimestamp,
  };
  addDiagnostics(state.diagnosticTotals, state.diagnostics.snapshot());
  state.diagnosticTotals.directionalShadowPasses += state.render3d.lastDirectionalShadowPassCount;
  state.diagnosticTotals.directionalShadowCacheHits += Number(state.render3d.lastDirectionalShadowCacheHit);
  state.diagnosticTotals.maxDirectionalShadowPasses = Math.max(
    state.diagnosticTotals.maxDirectionalShadowPasses,
    state.render3d.lastDirectionalShadowPassCount,
  );
  state.measuredFrames++;
  return state.render3d.lastVisibleCount + state.diagnosticTotals.draws;
}

function createObjectTableDiagnosticSnapshot() {
  return {
    dirtyRangeCpuMs: 0,
    uploadCpuMs: 0,
    flushCount: 0,
    denseWholeSpanUploadCount: 0,
  };
}

function snapshotRendererObjectTableDiagnostics(state, total) {
  return copyObjectTableDiagnostics(total, state.objectTableDiagnosticTotals);
}

function copyObjectTableDiagnostics(target, source) {
  target.dirtyRangeCpuMs = source.dirtyRangeCpuMs;
  target.uploadCpuMs = source.uploadCpuMs;
  target.flushCount = source.flushCount;
  target.denseWholeSpanUploadCount = source.denseWholeSpanUploadCount;
  return target;
}

function installRendererObjectTableDiagnostics(state) {
  const render3d = state.render3d;
  const blinn = state.blinn?._renderer;
  instrumentObjectTableDiagnostics(state, render3d.mesh3DRenderer?.objectTable);
  instrumentObjectTableDiagnostics(state, render3d.mesh3DRenderer?.batchObjectTable);
  instrumentObjectTableDiagnostics(state, render3d._pbrRenderer?._objectTable);
  instrumentObjectTableDiagnostics(state, render3d._pbrRenderer?._batchObjectTable);
  instrumentObjectTableDiagnostics(state, render3d._depthRenderer?.objectTable);
  instrumentObjectTableDiagnostics(state, render3d._depthRenderer?.batchObjectTable);
  instrumentObjectTableDiagnostics(state, render3d._normalRenderer?.objectTable);
  instrumentObjectTableDiagnostics(state, render3d._normalRenderer?.batchObjectTable);
  instrumentObjectTableDiagnostics(state, render3d._volumeRenderer?.objectTable);
  instrumentObjectTableDiagnostics(state, render3d._shadowRenderer?._objectTable);
  instrumentObjectTableDiagnostics(state, blinn?._objectTable);
  instrumentObjectTableDiagnostics(state, blinn?._batchObjectTable);
}

function instrumentObjectTableDiagnostics(state, table) {
  if (!table || table[OBJECT_TABLE_DIAGNOSTICS]) return;
  const totals = state.objectTableDiagnosticTotals;
  const audit = state.audit;
  const flushUploads = table.flushUploads;
  Object.defineProperty(table, OBJECT_TABLE_DIAGNOSTICS, {
    value: true,
    configurable: true,
  });
  table.flushUploads = function() {
    const startedAt = performance.now();
    const uploadStartedAt = audit.bufferUploadCpuMs;
    const usedDenseWholeSpanPath = this._slots?.highWaterMark === 0
      && this._frameVisitedSlotCount > 0
      && this._dirtySlotCount === this._frameVisitedSlotCount;
    let completed = false;
    try {
      const result = flushUploads.call(this);
      completed = true;
      return result;
    } finally {
      const uploadCpuMs = Math.max(0, audit.bufferUploadCpuMs - uploadStartedAt);
      totals.uploadCpuMs += uploadCpuMs;
      totals.dirtyRangeCpuMs += Math.max(
        0,
        performance.now() - startedAt - uploadCpuMs,
      );
      totals.flushCount++;
      if (completed && usedDenseWholeSpanPath) {
        totals.denseWholeSpanUploadCount++;
      }
    }
  };
}

/**
 * Freezes the accepted CPU timing-pass metrics before a separate diagnostic
 * probe runs against the same scenario.
 */
export function captureRealRendererBenchmarkMetrics(state) {
  state.finalMetrics = getRealRendererBenchmarkMetrics(state);
  return state.finalMetrics;
}

export function createRealRendererGpuTimestampProbe(state) {
  return new RealRendererGpuTimestampProbe(state.device);
}

export function getRealRendererBenchmarkMetrics(state) {
  if (state.finalMetrics) return state.finalMetrics;
  const frames = Math.max(1, state.measuredFrames);
  const audit = diffAudit(state.audit, state.auditBaseline ?? snapshotAudit(state.audit));
  const metricClassification = createMetricClassification(
    state,
    audit,
    diffAuditBreakdown(
      state.audit,
      state.auditBreakdownBaseline ?? snapshotAuditBreakdown(state.audit),
    ),
    frames,
  );
  const resources = state.tracker.getDebugSnapshot();
  const pools = diffHotPools(snapshotHotPools(state.render3d), state.allocationBaseline ?? snapshotHotPools(state.render3d));
  const objectTableDiagnostics = diffObjectTableDiagnostics(
    state.objectTableDiagnosticTotals,
    state.objectTableDiagnosticBaseline,
  );
  const lightingMetrics = state.lightingScenario?.captureMetrics(state.render3d, frames);
  return {
    bufferUploadsPerFrame: state.diagnosticTotals.bufferUploads / frames,
    uploadBytesPerFrame: state.diagnosticTotals.bufferUploadBytes / frames,
    renderPipelinesCreated: audit.renderPipelinesCreated,
    bindGroupsCreated: audit.bindGroupsCreated,
    setupRenderPipelinesCreated: state.audit.renderPipelinesCreated,
    setupBindGroupsCreated: state.audit.bindGroupsCreated,
    buffersCreatedTotal: state.audit.buffersCreated,
    bufferExpansionsTotal: state.audit.bufferExpansions,
    bufferRetirementsTotal: state.audit.bufferRetirements,
    buffersCreated: audit.buffersCreated,
    bufferExpansions: audit.bufferExpansions,
    bufferRetirements: audit.bufferRetirements,
    objectTableDirtyRangeCpuMsPerFrame: objectTableDiagnostics.dirtyRangeCpuMs / frames,
    objectTableUploadCpuMsPerFrame: objectTableDiagnostics.uploadCpuMs / frames,
    objectTableFlushesPerFrame: objectTableDiagnostics.flushCount / frames,
    denseWholeSpanUploadsPerFrame:
      objectTableDiagnostics.denseWholeSpanUploadCount / frames,
    poolMisses: pools.poolMisses,
    hotObjectsCreated: pools.hotObjectsCreated,
    drawsPerFrame: state.diagnosticTotals.draws / frames,
    renderPassesPerFrame: audit.renderPasses / frames,
    metricClassification,
    renderPhaseBreakdown: metricClassification.render,
    rendererRunBreakdown: state.opaqueRunBreakdown,
    uploadBreakdown: metricClassification.uploads,
    directionalShadowPassesPerFrame: state.diagnosticTotals.directionalShadowPasses / frames,
    directionalShadowCacheHits: state.diagnosticTotals.directionalShadowCacheHits,
    maxDirectionalShadowPassesPerFrame: state.diagnosticTotals.maxDirectionalShadowPasses,
    pbrLightUniformUploadsPerFrame: audit.pbrLightUniformUploads / frames,
    pbrEnvironmentUniformUploadsPerFrame: audit.pbrEnvironmentUniformUploads / frames,
    pbrShadowUniformUploadsPerFrame: audit.pbrShadowUniformUploads / frames,
    mirrorPlannedViews: state.render3d.lastMirrorPlanStats.plannedViewCount,
    mirrorExecutedViews: state.render3d.lastMirrorPlanStats.executedViewCount,
    mirrorDroppedViews: state.render3d.lastMirrorPlanStats.droppedViewCount,
    mirrorRttPixels: state.render3d.lastMirrorPlanStats.rttPixels,
    renderGraphPasses: state.render3d.lastRenderGraphStats.executedPassCount,
    renderGraphCulledPasses: state.render3d.lastRenderGraphStats.culledPassCount,
    mirrorLogicalTargets: state.render3d.lastMirrorGpuResourceStats.logicalTargetCount,
    mirrorPhysicalTargets: state.render3d.lastMirrorGpuResourceStats.transientPhysicalTargetCount
      + state.render3d.lastMirrorGpuResourceStats.persistentTargetCount,
    mirrorTargetAliasCount: state.render3d.lastMirrorTargetPoolStats.aliasCount,
    mirrorTargetLogicalBytes: state.render3d.lastMirrorGpuResourceStats.estimatedLogicalBytes,
    mirrorTargetResidentBytes: state.render3d.lastMirrorGpuResourceStats.estimatedResidentBytes,
    mirrorTargetAliasSavedBytes: state.render3d.lastMirrorGpuResourceStats.aliasSavedBytes,
    mirrorResourceScopeCount: state.render3d.lastMirrorGpuResourceStats.scopes.length,
    liveGpuResources: countLiveGpuResources(resources),
    ownerResidual: resources.releasedOwnerResiduals,
    ...(lightingMetrics ?? {}),
  };
}

function diffObjectTableDiagnostics(current, baseline) {
  return {
    dirtyRangeCpuMs: current.dirtyRangeCpuMs - baseline.dirtyRangeCpuMs,
    uploadCpuMs: current.uploadCpuMs - baseline.uploadCpuMs,
    flushCount: current.flushCount - baseline.flushCount,
    denseWholeSpanUploadCount:
      current.denseWholeSpanUploadCount - baseline.denseWholeSpanUploadCount,
  };
}

export function getRealRendererAllocationEvidence(state) {
  const metrics = state.finalMetrics ?? getRealRendererBenchmarkMetrics(state);
  return {
    kind: 'deterministic-hot-path-counters',
    poolMisses: metrics.poolMisses,
    hotObjectsCreated: metrics.hotObjectsCreated,
    note: 'heapUsed delta is retained as a coarse signal; these counters are the steady-state allocation gate.',
  };
}

export async function destroyRealRendererBenchmarkScenario(state) {
  state.finalMetrics = getRealRendererBenchmarkMetrics(state);
  const token = state.tracker.enterOwner(state.owner);
  try {
    state.world.destroy();
    disposeSceneFrameGpuArena(state.device);
    if (state.ownsTargets) {
      for (const target of new Set(state.targets)) target.destroy();
    }
  } finally {
    state.tracker.leaveOwner(token);
  }
  await state.device.queue.onSubmittedWorkDone();
  state.tracker.releaseOwner(state.owner);
  const released = state.tracker.getDebugSnapshot();
  state.finalMetrics.ownerResidual = released.releasedOwnerResiduals;
  state.finalMetrics.liveGpuResources = countLiveGpuResources(released);
}

export function createAuditTarget(device, width = 960, height = 540, copySource = false) {
  const colorTexture = device.createTexture({
    label: 'render3d.real-frame.output', size: [width, height], format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      | (copySource ? GPUTextureUsage.COPY_SRC : 0),
  });
  const depthTexture = device.createTexture({
    label: 'render3d.real-frame.depth', size: [width, height], format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const outputView = colorTexture.createView();
  const depthView = depthTexture.createView();
  return {
    format: 'bgra8unorm', width, height, displayWidth: width, displayHeight: height,
    colorTexture, depthTexture, depthTextureView: depthView,
    getOutputView() { return outputView; },
    getRenderPassDescriptor() {
      return {
        colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
      };
    },
    destroy() { colorTexture.destroy(); depthTexture.destroy(); },
  };
}

function createBenchmarkGeometry() {
  return new Geometry3D({
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: [{ set: 0, data: new Float32Array([0, 0, 1, 0, 0.5, 1]) }],
    // Uint32 also keeps the real WebGPU upload size aligned to four bytes.
    indices: new Uint32Array([0, 1, 2]),
    boundsMode: 'manual', localBounds: { center: [0, 0, 0], radius: 0.75 },
  });
}

function createBenchmarkMirrorGeometry() {
  return new Geometry3D({
    positions: new Float32Array([
      -1.8, -1.8, 0, 1.8, -1.8, 0, 1.8, 1.8, 0,
      -1.8, -1.8, 0, 1.8, 1.8, 0, -1.8, 1.8, 0,
    ]),
    normals: new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1]).flat()),
    textureCoordinates: [{ set: 0, data: new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]) }],
    boundsMode: 'manual', localBounds: { center: [0, 0, 0], radius: 2.6 },
  });
}

function createBenchmarkEngine(device, target) {
  return {
    device, format: target.format, width: target.width, height: target.height,
    displayWidth: target.displayWidth, displayHeight: target.displayHeight,
    reverseZ: false, msaaSamples: 1, clearColor: { r: 0, g: 0, b: 0, a: 1 },
    depthTextureView: target.depthTextureView, msaaTextureView: null,
    assetManager: undefined, defaults: {}, renderProfile: 'simple', renderTarget: target,
    getDepthFormat() { return 'depth24plus'; },
    getRenderPassDescriptor() { return target.getRenderPassDescriptor(); },
    getRenderPassDescriptorVersion() { return 1; },
    getOutputView() { return target.getOutputView(); },
    registerDeviceRecoveryParticipant() { return () => {}; },
  };
}

function instrumentBenchmarkDeviceAudit(device) {
  if (device.__realRendererBenchmarkAudit) return device.__realRendererBenchmarkAudit;
  const audit = {
    bufferUploads: 0, uploadBytes: 0, buffersCreated: 0, buffersDestroyed: 0,
    bufferUploadCpuMs: 0,
    renderPasses: 0, draws: 0, renderPassInstrumentationFailures: 0,
    bufferExpansions: 0, bufferRetirements: 0, renderPipelinesCreated: 0, bindGroupsCreated: 0,
    pbrLightUniformUploads: 0, pbrEnvironmentUniformUploads: 0, pbrShadowUniformUploads: 0,
  };
  Object.defineProperties(audit, {
    renderByPhase: { value: createRenderPhaseTotals() },
    uploadsByBufferLabel: { value: new Map() },
    uploadsByRenderer: { value: new Map() },
    gpuTimestampProbe: { value: null, writable: true },
  });
  const liveByLabel = new Map();
  const createdByLabel = new Map();
  const destroyedBuffers = new WeakSet();
  const originalWriteBuffer = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = function(buffer, bufferOffset, data, dataOffset, size) {
    const uploadStartedAt = performance.now();
    const bytes = size ?? Math.max(0, (data?.byteLength ?? 0) - (dataOffset ?? 0));
    const bufferLabel = normalizeGpuBufferLabel(buffer?.label);
    audit.bufferUploads++;
    audit.uploadBytes += bytes;
    incrementUploadCategory(audit.uploadsByBufferLabel, bufferLabel, bytes);
    incrementUploadCategory(audit.uploadsByRenderer, classifyUploadRenderer(bufferLabel), bytes);
    if (buffer?.label === 'PbrRenderer.lights') audit.pbrLightUniformUploads++;
    else if (buffer?.label === 'PbrRenderer.environment') audit.pbrEnvironmentUniformUploads++;
    else if (buffer?.label === 'PbrRenderer.shadow') audit.pbrShadowUniformUploads++;
    try {
      return originalWriteBuffer(buffer, bufferOffset, data, dataOffset, size);
    } finally {
      audit.bufferUploadCpuMs += performance.now() - uploadStartedAt;
    }
  };
  const originalCreateBuffer = device.createBuffer.bind(device);
  device.createBuffer = function(descriptor) {
    const label = descriptor.label ?? '';
    const priorCreates = createdByLabel.get(label) ?? 0;
    audit.buffersCreated++;
    if (label && priorCreates > 0 && /object|table|batch|uniform/i.test(label)) audit.bufferExpansions++;
    createdByLabel.set(label, priorCreates + 1);
    liveByLabel.set(label, (liveByLabel.get(label) ?? 0) + 1);
    const buffer = originalCreateBuffer(descriptor);
    const originalDestroy = buffer.destroy?.bind(buffer);
    if (originalDestroy) buffer.destroy = function() {
      if (!destroyedBuffers.has(buffer)) {
        destroyedBuffers.add(buffer);
        audit.buffersDestroyed++;
        const live = liveByLabel.get(label) ?? 0;
        if (live > 1 && /object|table|batch|uniform/i.test(label)) audit.bufferRetirements++;
        liveByLabel.set(label, Math.max(0, live - 1));
      }
      return originalDestroy();
    };
    return buffer;
  };
  const originalCreatePipeline = device.createRenderPipeline.bind(device);
  device.createRenderPipeline = function(descriptor) { audit.renderPipelinesCreated++; return originalCreatePipeline(descriptor); };
  if (typeof device.createRenderPipelineAsync === 'function') {
    const originalCreatePipelineAsync = device.createRenderPipelineAsync.bind(device);
    device.createRenderPipelineAsync = function(descriptor) {
      audit.renderPipelinesCreated++;
      return originalCreatePipelineAsync(descriptor);
    };
  }
  const originalCreateBindGroup = device.createBindGroup.bind(device);
  device.createBindGroup = function(descriptor) { audit.bindGroupsCreated++; return originalCreateBindGroup(descriptor); };
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = function(descriptor) {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = function(passDescriptor) {
      const phase = classifyRenderPhase(passDescriptor);
      audit.renderPasses++;
      audit.renderByPhase[phase].passes++;
      const timedDescriptor = audit.gpuTimestampProbe?.decorateRenderPass(
        passDescriptor,
      ) ?? passDescriptor;
      return instrumentAuditRenderPass(originalBeginRenderPass(timedDescriptor), audit, phase);
    };
    return encoder;
  };
  Object.defineProperty(device, '__realRendererBenchmarkAudit', { value: audit, configurable: true });
  return audit;
}

class RealRendererGpuTimestampProbe {
  constructor(device) {
    this.device = device;
    this.supported = device.features?.has?.('timestamp-query') === true;
    this.reason = this.supported
      ? null
      : 'GPU adapter/device does not expose timestamp-query';
    this.queryCount = 0;
    this.passLabels = [];
    this.pendingByteSize = 0;
    if (!this.supported) return;
    this.querySet = device.createQuerySet({
      label: 'benchmark.real-renderer.gpu-timestamp.queries',
      type: 'timestamp',
      count: 256,
    });
    this.resolveBuffer = device.createBuffer({
      label: 'benchmark.real-renderer.gpu-timestamp.resolve',
      size: 256 * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readbackBuffer = device.createBuffer({
      label: 'benchmark.real-renderer.gpu-timestamp.readback',
      size: 256 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  beginFrame() {
    if (!this.supported) return;
    this.queryCount = 0;
    this.passLabels.length = 0;
    this.pendingByteSize = 0;
  }

  decorateRenderPass(descriptor) {
    if (!this.supported || descriptor.timestampWrites || this.queryCount + 2 > 256) {
      return descriptor;
    }
    const beginningOfPassWriteIndex = this.queryCount;
    const endOfPassWriteIndex = this.queryCount + 1;
    this.queryCount += 2;
    this.passLabels.push(descriptor.label ?? '(unlabeled render pass)');
    return {
      ...descriptor,
      timestampWrites: {
        querySet: this.querySet,
        beginningOfPassWriteIndex,
        endOfPassWriteIndex,
      },
    };
  }

  resolve(encoder) {
    if (!this.supported || this.queryCount === 0) return;
    this.pendingByteSize = this.queryCount * 8;
    encoder.resolveQuerySet(
      this.querySet,
      0,
      this.queryCount,
      this.resolveBuffer,
      0,
    );
    encoder.copyBufferToBuffer(
      this.resolveBuffer,
      0,
      this.readbackBuffer,
      0,
      this.pendingByteSize,
    );
  }

  async readFrame() {
    if (!this.supported || this.pendingByteSize === 0) {
      return {
        totalMs: 0,
        passes: [],
        passLabels: [],
      };
    }
    await this.readbackBuffer.mapAsync(GPUMapMode.READ, 0, this.pendingByteSize);
    const timestamps = new BigUint64Array(
      this.readbackBuffer.getMappedRange(0, this.pendingByteSize),
    ).slice();
    this.readbackBuffer.unmap();
    const passes = this.passLabels.map((label, index) => {
      const start = timestamps[index * 2] ?? 0n;
      const end = timestamps[index * 2 + 1] ?? 0n;
      return {
        label,
        durationMs: end > start ? Number(end - start) / 1_000_000 : 0,
      };
    });
    return {
      totalMs: passes.reduce((total, pass) => total + pass.durationMs, 0),
      passes,
      passLabels: [...this.passLabels],
    };
  }

  destroy() {
    if (!this.supported) return;
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}

function emptyDiagnosticTotals() {
  return {
    draws: 0,
    renderPasses: 0,
    bufferUploads: 0,
    bufferUploadBytes: 0,
    directionalShadowPasses: 0,
    directionalShadowCacheHits: 0,
    maxDirectionalShadowPasses: 0,
  };
}

function addDiagnostics(total, snapshot) {
  total.draws += snapshot.counters.draws;
  total.renderPasses += snapshot.counters.passes;
  total.bufferUploads += snapshot.counters.bufferUploads;
  total.bufferUploadBytes += snapshot.counters.bufferUploadBytes;
}

function snapshotAudit(audit) { return { ...audit }; }
function diffAudit(current, baseline) {
  const result = {};
  for (const key of Object.keys(current)) result[key] = current[key] - (baseline[key] ?? 0);
  return result;
}

function createRenderPhaseTotals() {
  return {
    mainScene: { draws: 0, passes: 0 },
    shadow: { draws: 0, passes: 0 },
    postprocess: { draws: 0, passes: 0 },
  };
}

function createOpaqueRunBreakdown() {
  return {
    sampledViews: 0,
    opaqueItems: 0,
    transparentItems: 0,
    actualDraws: 0,
    transparentDraws: 0,
    mainSceneDraws: 0,
    theoreticalCompatibleDraws: 0,
    legalOpaqueDrawLowerBound: 0,
    legalMainSceneDrawLowerBound: 0,
    drawsByRenderer: {},
    transparentDrawsByRenderer: {},
    mainSceneDrawsByRenderer: {},
    theoreticalDrawsByRenderer: {},
    runBreaks: {
      material: 0,
      geometry: 0,
      pipeline: 0,
      indexFormat: 0,
      cullMode: 0,
      deformationBinding: 0,
      depthPrepass: 0,
      objectSlotContiguity: 0,
      transparentDirectInstancingProhibited: 0,
    },
    views: [],
  };
}

/**
 * Captures the first warmed frame only. The wrapper removes itself after all
 * views are sampled, so benchmark timing and steady-state allocation metrics
 * do not include run-breakdown work.
 */
function installOpaqueRunBreakdownDiagnostics(state, viewCount) {
  const submitter = state.render3d._submitter;
  if (!submitter || typeof submitter.drawOpaqueItems !== 'function') return;
  const original = submitter.drawOpaqueItems;
  let remainingViews = Math.max(1, viewCount);
  submitter.drawOpaqueItems = function(items, passEncoder, viewProj, viewMatrix, options) {
    captureOpaqueRunBreakdown(
      state.opaqueRunBreakdown,
      items,
      state.render3d._viewPreparation?.frameItems.transparentItems ?? [],
      options?.batchBuffer,
    );
    remainingViews--;
    if (remainingViews === 0) submitter.drawOpaqueItems = original;
    return original.call(this, items, passEncoder, viewProj, viewMatrix, options);
  };
}

function captureOpaqueRunBreakdown(total, items, transparentItems, batchBuffer) {
  const view = {
    opaqueItems: items.length,
    transparentItems: transparentItems.length,
    actualDraws: 0,
    transparentDraws: 0,
    mainSceneDraws: 0,
    theoreticalCompatibleDraws: 0,
    legalOpaqueDrawLowerBound: 0,
    legalMainSceneDrawLowerBound: 0,
    drawsByRenderer: {},
    transparentDrawsByRenderer: {},
    mainSceneDrawsByRenderer: {},
    theoreticalDrawsByRenderer: {},
    runBreaks: Object.fromEntries(Object.keys(total.runBreaks).map(key => [key, 0])),
  };
  let previous = null;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item?.geometry || !item.material || !item.worldMatrix) continue;
    const current = opaqueCompatibility(item, batchBuffer?.getObjectSlot(index) ?? item.entityId);
    const compatibilityBreak = previous ? classifyOpaqueCompatibilityBreak(previous, current) : null;
    const objectSlotBreak = previous && current.objectSlot !== previous.objectSlot + 1;
    if (!previous || compatibilityBreak) {
      view.theoreticalCompatibleDraws++;
      incrementNamedCount(view.theoreticalDrawsByRenderer, current.renderer);
    }
    if (!previous || compatibilityBreak || objectSlotBreak) {
      view.actualDraws++;
      incrementNamedCount(view.drawsByRenderer, current.renderer);
      if (previous) {
        const reason = compatibilityBreak ?? 'objectSlotContiguity';
        view.runBreaks[reason]++;
      }
    }
    previous = current;
  }
  for (const item of transparentItems) {
    if (!item?.geometry || !item.material || !item.worldMatrix) continue;
    view.transparentDraws++;
    incrementNamedCount(view.transparentDrawsByRenderer, opaqueRendererName(item.material));
  }
  view.mainSceneDraws = view.actualDraws + view.transparentDraws;
  view.legalOpaqueDrawLowerBound = view.theoreticalCompatibleDraws;
  view.legalMainSceneDrawLowerBound = view.legalOpaqueDrawLowerBound + view.transparentDraws;
  mergeNamedCounts(view.mainSceneDrawsByRenderer, view.drawsByRenderer);
  mergeNamedCounts(view.mainSceneDrawsByRenderer, view.transparentDrawsByRenderer);
  view.runBreaks.transparentDirectInstancingProhibited = view.transparentDraws;
  total.sampledViews++;
  total.opaqueItems += view.opaqueItems;
  total.transparentItems += view.transparentItems;
  total.actualDraws += view.actualDraws;
  total.transparentDraws += view.transparentDraws;
  total.mainSceneDraws += view.mainSceneDraws;
  total.theoreticalCompatibleDraws += view.theoreticalCompatibleDraws;
  total.legalOpaqueDrawLowerBound += view.legalOpaqueDrawLowerBound;
  total.legalMainSceneDrawLowerBound += view.legalMainSceneDrawLowerBound;
  mergeNamedCounts(total.drawsByRenderer, view.drawsByRenderer);
  mergeNamedCounts(total.transparentDrawsByRenderer, view.transparentDrawsByRenderer);
  mergeNamedCounts(total.mainSceneDrawsByRenderer, view.mainSceneDrawsByRenderer);
  mergeNamedCounts(total.theoreticalDrawsByRenderer, view.theoreticalDrawsByRenderer);
  mergeNamedCounts(total.runBreaks, view.runBreaks);
  total.views.push(view);
}

function opaqueCompatibility(item, objectSlot) {
  const geometry = item.geometry;
  const material = item.material;
  const renderer = opaqueRendererName(material);
  const indexFormat = geometry.indices instanceof Uint32Array
    ? 'uint32'
    : geometry.indices instanceof Uint16Array ? 'uint16' : 'none';
  const cullMode = material instanceof BasicMaterial
    ? material.cullMode ?? geometry.cullMode ?? 'back'
    : material instanceof PbrMaterial && material.doubleSided
      ? 'none'
      : geometry.cullMode ?? 'back';
  const frontFace = material instanceof BasicMaterial
    ? material.frontFace ?? geometry.frontFace ?? 'ccw'
    : geometry.frontFace ?? 'ccw';
  const depthPrepass = material instanceof BasicMaterial
    && material.blending === 'normal'
    && material.depthWrite;
  const deformationBinding = geometry.skinning
    ? `skin:${geometry.id}:${geometry.skinning.version}:morph:${geometry.morphVersion}`
    : geometry.morphTargets.length > 0
      ? `morph:${geometry.id}:${geometry.morphVersion}`
      : 'static';
  return {
    renderer,
    materialId: material.id,
    geometryId: geometry.id,
    pipeline: [
      renderer,
      geometry.topology ?? 'triangle-list',
      frontFace,
      material instanceof PbrMaterial ? material.alphaMode : material.blending ?? 'none',
      depthPrepass ? 'depth-prepass' : 'single-pass',
    ].join('|'),
    indexFormat,
    cullMode,
    deformationBinding,
    depthPrepass,
    objectSlot,
  };
}

function classifyOpaqueCompatibilityBreak(previous, current) {
  if (previous.materialId !== current.materialId) return 'material';
  if (previous.geometryId !== current.geometryId) return 'geometry';
  if (previous.indexFormat !== current.indexFormat) return 'indexFormat';
  if (previous.cullMode !== current.cullMode) return 'cullMode';
  if (previous.deformationBinding !== current.deformationBinding) return 'deformationBinding';
  if (previous.depthPrepass !== current.depthPrepass) return 'depthPrepass';
  if (previous.pipeline !== current.pipeline) return 'pipeline';
  return null;
}

function opaqueRendererName(material) {
  if (material instanceof BasicMaterial) return 'Mesh3DRenderer';
  if (material instanceof PbrMaterial) return 'PbrRenderer';
  if (material instanceof BlinnPhongMaterial) return 'BlinnPhongRenderer';
  if (material instanceof DepthMaterial) return 'DepthRenderer';
  if (material instanceof NormalMaterial) return 'NormalRenderer';
  if (material instanceof VolumeMaterial) return 'VolumeRenderer';
  return material.constructor?.name ?? '(unknown)';
}

function incrementNamedCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeNamedCounts(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function snapshotAuditBreakdown(audit) {
  return {
    renderByPhase: Object.fromEntries(
      Object.entries(audit.renderByPhase).map(([phase, totals]) => [phase, { ...totals }]),
    ),
    uploadsByBufferLabel: cloneUploadCategories(audit.uploadsByBufferLabel),
    uploadsByRenderer: cloneUploadCategories(audit.uploadsByRenderer),
  };
}

function diffAuditBreakdown(audit, baseline) {
  const renderByPhase = createRenderPhaseTotals();
  for (const phase of Object.keys(renderByPhase)) {
    renderByPhase[phase].draws = audit.renderByPhase[phase].draws
      - (baseline.renderByPhase[phase]?.draws ?? 0);
    renderByPhase[phase].passes = audit.renderByPhase[phase].passes
      - (baseline.renderByPhase[phase]?.passes ?? 0);
  }
  return {
    renderByPhase,
    uploadsByBufferLabel: diffUploadCategories(
      audit.uploadsByBufferLabel,
      baseline.uploadsByBufferLabel,
    ),
    uploadsByRenderer: diffUploadCategories(
      audit.uploadsByRenderer,
      baseline.uploadsByRenderer,
    ),
  };
}

function createMetricClassification(state, audit, breakdown, frames) {
  const renderCategories = Object.fromEntries(
    Object.entries(breakdown.renderByPhase).map(([phase, totals]) => [
      phase,
      withPerFrame(totals, frames, 'draws', 'passes'),
    ]),
  );
  const renderTotals = sumCounterObjects(Object.values(breakdown.renderByPhase), ['draws', 'passes']);
  const labelTotals = sumCounterObjects(breakdown.uploadsByBufferLabel.values(), ['calls', 'bytes']);
  const rendererTotals = sumCounterObjects(breakdown.uploadsByRenderer.values(), ['calls', 'bytes']);
  const checks = [
    strictClassificationCheck('render.draws', renderTotals.draws, state.diagnosticTotals.draws),
    strictClassificationCheck('render.passes', renderTotals.passes, audit.renderPasses),
    strictClassificationCheck('uploads.gpuBufferLabel.calls', labelTotals.calls, state.diagnosticTotals.bufferUploads),
    strictClassificationCheck('uploads.gpuBufferLabel.bytes', labelTotals.bytes, state.diagnosticTotals.bufferUploadBytes),
    strictClassificationCheck('uploads.renderer.calls', rendererTotals.calls, state.diagnosticTotals.bufferUploads),
    strictClassificationCheck('uploads.renderer.bytes', rendererTotals.bytes, state.diagnosticTotals.bufferUploadBytes),
    strictClassificationCheck('audit.draws', audit.draws, state.diagnosticTotals.draws),
    strictClassificationCheck('audit.uploadCalls', audit.bufferUploads, state.diagnosticTotals.bufferUploads),
    strictClassificationCheck('audit.uploadBytes', audit.uploadBytes, state.diagnosticTotals.bufferUploadBytes),
    strictClassificationCheck('audit.renderPassInstrumentationFailures', audit.renderPassInstrumentationFailures, 0),
  ];
  const failures = checks.filter(check => !check.equal);
  if (failures.length > 0) {
    const detail = failures
      .map(check => `${check.name}: classified=${check.classified}, aggregate=${check.aggregate}`)
      .join('; ');
    throw new Error(`Real-renderer metric classification mismatch for ${state.world.name}: ${detail}`);
  }
  return {
    schemaVersion: 1,
    measuredFrames: state.measuredFrames,
    strictEquality: { passed: true, checks },
    render: {
      categories: renderCategories,
      totals: withPerFrame(renderTotals, frames, 'draws', 'passes'),
    },
    uploads: {
      dimensions: {
        gpuBufferLabel: serializeUploadCategories(breakdown.uploadsByBufferLabel, frames, 'label'),
        renderer: serializeUploadCategories(breakdown.uploadsByRenderer, frames, 'renderer'),
      },
      totals: withPerFrame(labelTotals, frames, 'calls', 'bytes'),
    },
  };
}

function classifyRenderPhase(descriptor) {
  const label = String(descriptor?.label ?? '').toLowerCase();
  if (
    label.includes('postprocess')
    || label.includes('render3dsystem.post')
    || label.endsWith('pass.renderpass')
  ) return 'postprocess';
  if (
    label.includes('shadow')
    || (
      Array.isArray(descriptor?.colorAttachments)
      && descriptor.colorAttachments.filter(Boolean).length === 0
      && descriptor.depthStencilAttachment
    )
  ) return 'shadow';
  return 'mainScene';
}

function instrumentAuditRenderPass(pass, audit, phase) {
  for (const methodName of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
    const method = pass?.[methodName];
    if (typeof method !== 'function') continue;
    const bound = method.bind(pass);
    try {
      Object.defineProperty(pass, methodName, {
        configurable: true,
        value(...args) {
          audit.draws++;
          audit.renderByPhase[phase].draws++;
          return bound(...args);
        },
      });
    } catch {
      audit.renderPassInstrumentationFailures++;
    }
  }
  return pass;
}

function normalizeGpuBufferLabel(label) {
  const normalized = typeof label === 'string' ? label.trim() : '';
  return normalized || '(unlabeled)';
}

const UPLOAD_RENDERER_LABELS = [
  'BlinnPhongRenderer',
  'DepthRenderer',
  'GpuDrivenBatchBuffer',
  'Mesh3DRenderer',
  'MotionVectorRenderer',
  'NormalRenderer',
  'OutlineMaskRenderer',
  'PbrRenderer',
  'PlanarMirrorRenderer',
  'PostProcessRenderer',
  'Render3DSystem',
  'RendererObjectTable',
  'SceneFrameGpuArena',
  'ShadowMapRenderer',
  'SharedGeometry3DGPUCache',
  'VolumeRenderer',
];

function classifyUploadRenderer(label) {
  for (const renderer of UPLOAD_RENDERER_LABELS) {
    if (label === renderer || label.startsWith(`${renderer}.`) || label.includes(`.${renderer}.`)) {
      return renderer;
    }
  }
  const rendererMatch = /(?:^|\.)([A-Za-z0-9]+Renderer)(?:\.|$)/.exec(label);
  return rendererMatch?.[1] ?? '(unattributed)';
}

function incrementUploadCategory(categories, key, bytes) {
  const totals = categories.get(key) ?? { calls: 0, bytes: 0 };
  totals.calls++;
  totals.bytes += bytes;
  categories.set(key, totals);
}

function cloneUploadCategories(categories) {
  return new Map([...categories].map(([key, totals]) => [key, { ...totals }]));
}

function diffUploadCategories(current, baseline) {
  const result = new Map();
  const keys = new Set([...current.keys(), ...baseline.keys()]);
  for (const key of keys) {
    const currentTotals = current.get(key);
    const baselineTotals = baseline.get(key);
    const calls = (currentTotals?.calls ?? 0) - (baselineTotals?.calls ?? 0);
    const bytes = (currentTotals?.bytes ?? 0) - (baselineTotals?.bytes ?? 0);
    if (calls !== 0 || bytes !== 0) result.set(key, { calls, bytes });
  }
  return result;
}

function serializeUploadCategories(categories, frames, keyName) {
  return [...categories]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, totals]) => ({
      [keyName]: key,
      ...withPerFrame(totals, frames, 'calls', 'bytes'),
    }));
}

function sumCounterObjects(values, keys) {
  const totals = Object.fromEntries(keys.map(key => [key, 0]));
  for (const value of values) {
    for (const key of keys) totals[key] += value?.[key] ?? 0;
  }
  return totals;
}

function withPerFrame(totals, frames, ...keys) {
  const result = { ...totals };
  for (const key of keys) result[`${key}PerFrame`] = totals[key] / frames;
  return result;
}

function strictClassificationCheck(name, classified, aggregate) {
  return { name, classified, aggregate, equal: classified === aggregate };
}

function snapshotHotPools(render3d) {
  const collector = render3d._sceneCollector;
  const framePlan = render3d._frameCoordinator?.viewPlan;
  return {
    renderItems: render3d._viewPreparation?.frameItems.renderItemPool.length ?? 0,
    helperItems: render3d._viewPreparation?.frameItems.helperItemPool.length ?? 0,
    renderables: collector?._renderablePool?.length ?? 0,
    worldSpheres: collector?._worldSpherePool?.length ?? 0,
    passes: framePlan?._passPool?.length ?? 0,
    snapshots: framePlan?._snapshotPool?.length ?? 0,
  };
}

function diffHotPools(current, baseline) {
  let poolMisses = 0;
  for (const key of Object.keys(current)) poolMisses += Math.max(0, current[key] - (baseline[key] ?? 0));
  return { poolMisses, hotObjectsCreated: poolMisses };
}

function countLiveGpuResources(snapshot) {
  return Object.values(snapshot.byType).reduce((sum, stats) => sum + (stats?.current ?? 0), 0);
}
