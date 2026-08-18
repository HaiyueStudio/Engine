import { Mesh3D } from '/engine/dist/index.js';
import { AssetManager, createKtx2TextureLoader } from '/engine/dist/assets.js';
import { Transform3D } from '/engine/dist/components.js';
import {
  FrameDiagnostics,
  GPUResourceTracker,
  SCENE_FRAME_UNIFORM_FLOATS,
  createGPUResourceOwner,
  createInlineKtx2TextureWorkerClient,
  disposeSceneFrameGpuArena,
  writeSceneFrameUniforms,
} from '/engine/dist/experimental.js';
import { PbrRenderer } from '/engine/dist/renderer.js';
import {
  disposeGltfModel,
  loadGltfModel,
} from '/extensions/dist/gltf.js';
import { createInlineGltfAssetWorkerClient } from '/extensions/dist/experimental-gltf-worker.js';
import {
  createGltfAnimation3DRuntime,
} from '/extensions/dist/gltf-animation3d.js';
import {
  GLTF_CORPUS_SCHEMA_VERSION,
  GLTF_CORPUS_SUITE,
} from './gltf-corpus-contract.mjs';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const result = await runCorpus();
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  progressNode.textContent = 'failed';
  resultNode.textContent = JSON.stringify({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  resultNode.dataset.status = 'failed';
}

async function runCorpus() {
  const mode = new URLSearchParams(location.search).get('mode') === 'reference' ? 'reference' : 'optimized';
  const useWorkers = mode === 'optimized';
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const manifest = await fetch('./assets/gltf-corpus/manifest.json').then(response => response.json());
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const optionalCompression = ['texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc']
    .filter(feature => adapter.features.has(feature));
  const device = await adapter.requestDevice({ requiredFeatures: optionalCompression });
  const uncapturedErrors = [];
  let deviceLost = false;
  const onUncapturedError = event => uncapturedErrors.push(event.error?.message ?? String(event.error));
  device.addEventListener('uncapturederror', onUncapturedError);
  void device.lost.then(info => { if (info.reason !== 'destroyed') deviceLost = true; });
  device.pushErrorScope('validation');

  const frameDiagnostics = new FrameDiagnostics({ enabled: true });
  const tracker = new GPUResourceTracker({ debug: true, frameDiagnostics });
  const engineOwner = createGPUResourceOwner('engine', 'gltf-production-corpus');
  const rendererOwner = createGPUResourceOwner('system', 'gltf-production-corpus-pbr');
  tracker.instrumentDevice(device, engineOwner);
  const largeTier = manifest.tiers.find(tier => tier.id === 'large');
  const uploadFrameBudgetBytes = largeTier.gate.uploadFrameBudgetBytes;
  const assetManager = new AssetManager(device, tracker, { uploadBudgetBytes: uploadFrameBudgetBytes });
  const ktxWorkerModule = useWorkers ? await createKtxWorkerModule() : null;
  const ktx2Worker = ktxWorkerModule
    ? createInlineKtx2TextureWorkerClient(ktxWorkerModule.url, { maxWorkers: 4 })
    : null;
  const ktxPhaseEvents = [];
  assetManager.registerLoader(createKtx2TextureLoader({
    textureWorker: ktx2Worker,
    basisEncoderScriptUrl: new URL('/node_modules/@loaders.gl/textures/dist/libs/basis_encoder.js', location.href).href,
    basisEncoderWasmUrl: new URL('/node_modules/@loaders.gl/textures/dist/libs/basis_encoder.wasm', location.href).href,
    diagnostics: { onPhase: event => ktxPhaseEvents.push(event) },
  }));
  const gltfWorker = useWorkers
    ? createInlineGltfAssetWorkerClient(new URL('/extensions/dist/gltf-worker-runtime.js', location.href).href)
    : null;
  const dracoWasm = await fetch('/node_modules/draco3dgltf/draco_decoder_gltf.wasm').then(response => response.arrayBuffer());
  const dracoDecoderConfig = {
    scriptUrl: new URL('/node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js', location.href).href,
    wasmBinary: dracoWasm,
  };
  const engine = {
    device,
    format: 'rgba8unorm',
    assetManager,
    gpuResourceTracker: tracker,
    getDepthFormat: () => 'depth24plus',
  };
  const renderer = new PbrRenderer();
  tracker.withOwner(rendererOwner, () => renderer.prepare(engine));
  const color = tracker.withOwner(rendererOwner, () => device.createTexture({
    label: 'gltf-production-corpus.color',
    size: [128, 128, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  }));
  const depth = tracker.withOwner(rendererOwner, () => device.createTexture({
    label: 'gltf-production-corpus.depth',
    size: [128, 128, 1],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  }));
  const readback = tracker.withOwner(rendererOwner, () => device.createBuffer({
    label: 'gltf-production-corpus.readback',
    size: 512 * 128,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  }));
  const sceneFrame = createSceneFrame();
  renderer.updateFrame(sceneFrame, [], null, null);

  progressNode.textContent = 'in-flight cancellation';
  const cancellation = await proveInFlightCancellation(manifest.tiers.at(-1), assetManager, gltfWorker, dracoDecoderConfig);
  progressNode.textContent = 'Animation3D Idle → Run cross-fade';
  const animation3D = await proveAnimation3DCrossFade(assetManager, gltfWorker, dracoDecoderConfig);
  const tiers = [];
  for (const [index, tier] of manifest.tiers.entries()) {
    progressNode.textContent = `${tier.id}: fetch, worker parse, decode, upload`;
    tiers.push(await measureTier(tier, index + 1));
  }

  renderer.destroy();
  disposeSceneFrameGpuArena(device);
  assetManager.dispose();
  ktx2Worker?.dispose();
  ktxWorkerModule?.dispose();
  gltfWorker?.dispose();
  color.destroy();
  depth.destroy();
  readback.destroy();
  tracker.releaseOwner(rendererOwner);
  tracker.releaseOwner(engineOwner);
  await device.queue.onSubmittedWorkDone();
  await Promise.resolve();
  const destroyedSnapshot = tracker.getDebugSnapshot();
  const liveGpuResourcesAfterDestroy = sumSnapshot(destroyedSnapshot, 'current');
  const liveGpuBytesAfterDestroy = sumSnapshot(destroyedSnapshot, 'estimatedBytes');
  const validationError = await device.popErrorScope();
  const validationErrors = validationError ? [validationError.message] : [];
  const adapterInfo = adapter.info ?? {};
  device.removeEventListener('uncapturederror', onUncapturedError);
  device.destroy();
  return {
    schemaVersion: GLTF_CORPUS_SCHEMA_VERSION,
    suite: GLTF_CORPUS_SUITE,
    configuration: {
      mode,
      gltfWorker: useWorkers ? 'production-inline' : 'disabled',
      ktx2Worker: useWorkers,
      ktx2WorkerPoolSize: useWorkers ? 4 : 0,
    },
    environment: {
      userAgent: navigator.userAgent,
      adapter: {
        vendor: adapterInfo.vendor ?? '',
        architecture: adapterInfo.architecture ?? '',
        device: adapterInfo.device ?? '',
        description: adapterInfo.description ?? '',
      },
      features: [...device.features].sort(),
    },
    corpus: {
      manifest: 'scripts/webgpu-gate/assets/gltf-corpus/manifest.json',
      upstreamCommit: manifest.upstream.commit,
      totalPinnedBytes: manifest.tiers.flatMap(tier => tier.files).reduce((sum, file) => sum + file.bytes, 0),
    },
    animation3D,
    tiers,
    timings: {
      firstVisibleFrameMs: tiers.reduce((sum, tier) => sum + tier.timings.firstVisibleFrameMs, 0),
      maxTierFirstVisibleFrameMs: Math.max(...tiers.map(tier => tier.timings.firstVisibleFrameMs)),
    },
    resources: {
      peakCpuStagingBytes: Math.max(...tiers.map(tier => tier.resources.peakCpuStagingBytes)),
      peakGpuEstimatedBytes: Math.max(...tiers.map(tier => tier.resources.peakGpuEstimatedBytes)),
      gpuUploadCalls: tiers.reduce((sum, tier) => sum + tier.resources.gpuUploadCalls, 0),
      gpuUploadBytes: tiers.reduce((sum, tier) => sum + tier.resources.gpuUploadBytes, 0),
      liveGpuResourcesAfterDestroy,
      liveGpuBytesAfterDestroy,
      releasedOwnerResiduals: destroyedSnapshot.releasedOwnerResiduals,
    },
    lifecycle: cancellation,
    validation: { errors: validationErrors, uncapturedErrors, deviceLost },
  };

  async function measureTier(tier, frameId) {
    performance.clearResourceTimings();
    const assetUrl = new URL(`./assets/gltf-corpus/${tier.entry}`, location.href).href;
    const beforeManager = assetManager.getDebugSnapshot();
    const beforeUploads = beforeManager.uploads;
    const ktxEventStart = ktxPhaseEvents.length;
    const heapStart = getUsedJsHeap();
    let peakHeap = heapStart;
    const heapSampler = setInterval(() => { peakHeap = Math.max(peakHeap, getUsedJsHeap()); }, 4);
    const startedAt = performance.now();
    frameDiagnostics.beginFrame(frameId);
    const model = await loadGltfModel(assetUrl, {
      assetManager,
      ...(gltfWorker ? { assetWorker: gltfWorker } : {}),
      dracoDecoderConfig,
    });
    clearInterval(heapSampler);
    peakHeap = Math.max(peakHeap, getUsedJsHeap());
    const meshes = collectMeshes(model.root);
    if (meshes.length !== tier.expected.primitiveCount) {
      disposeGltfModel(model);
      throw new Error(`${tier.id} expected ${tier.expected.primitiveCount} renderable meshes, received ${meshes.length}`);
    }
    const worldMatrix = createNormalizationMatrix(meshes);
    const afterLoadManager = assetManager.getDebugSnapshot();
    const tierKtxEvents = ktxPhaseEvents.slice(ktxEventStart);
    const assetUploadBytes = afterLoadManager.uploads.uploadedBytes - beforeUploads.uploadedBytes;
    const assetUploadCalls = afterLoadManager.uploads.uploadCalls - beforeUploads.uploadCalls;
    const scheduledUploadCpuMs = afterLoadManager.uploads.uploadDurationMs - beforeUploads.uploadDurationMs;

    progressNode.textContent = `${tier.id}: pipeline warmup`;
    const warmupStartedAt = performance.now();
    encodeFrame(meshes, worldMatrix, false);
    await device.queue.onSubmittedWorkDone();
    const pipelineWarmupMs = performance.now() - warmupStartedAt;

    progressNode.textContent = `${tier.id}: first visible submit`;
    const visibleStartedAt = performance.now();
    encodeFrame(meshes, worldMatrix, true);
    await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    const visiblePixel = hasVisiblePixel(new Uint8Array(readback.getMappedRange()));
    readback.unmap();
    const visibleSubmitMs = performance.now() - visibleStartedAt;
    const firstVisibleFrameMs = performance.now() - startedAt;
    const uploadsAtVisible = assetManager.getDebugSnapshot().uploads;
    await nextAnimationFrame();
    const uploadsAfterVisible = assetManager.getDebugSnapshot().uploads;

    progressNode.textContent = `${tier.id}: duplicate/cache hit`;
    const activityBeforeDuplicate = assetManager.getDebugSnapshot().activity;
    const duplicate = await loadGltfModel(assetUrl, {
      assetManager,
      ...(gltfWorker ? { assetWorker: gltfWorker } : {}),
      dracoDecoderConfig,
    });
    const activityAfterDuplicate = assetManager.getDebugSnapshot().activity;
    disposeGltfModel(duplicate);

    let recoveryFailures = null;
    let recoveredTextureRecords = 0;
    if (tier.id === 'large') {
      const textureRecordsBeforeRecovery = assetManager.getDebugSnapshot().records
        .filter(record => record.key.startsWith('texture:') || record.key.startsWith('asset:texture/')).length;
      assetManager.suspendForDeviceLoss();
      recoveryFailures = (await assetManager.recoverDevice(device, new AbortController().signal)).length;
      recoveredTextureRecords = textureRecordsBeforeRecovery;
    }

    const loadedTracker = tracker.getDebugSnapshot();
    const frameSnapshot = frameDiagnostics.snapshot();
    const resourceEntries = performance.getEntriesByType('resource')
      .filter(entry => entry.name.includes(`/gltf-corpus/${tier.entry.split('/')[0]}/`));
    const observedTransferBytes = resourceEntries.reduce(
      (sum, entry) => sum + (entry.decodedBodySize || entry.transferSize || 0),
      0,
    );
    const modelSourceObservedOnMainThread = resourceEntries.some(entry => entry.name === assetUrl);
    const assetTransferBytes = observedTransferBytes
      + (modelSourceObservedOnMainThread ? 0 : model.loadMetrics.sourceBytes);
    const parsedCacheBytes = assetManager.getDebugSnapshot().caches
      .filter(cache => cache.name === 'parsed-cpu')
      .reduce((sum, cache) => sum + cache.bytes, 0);
    const stagingEvidenceBytes = model.loadMetrics.sourceBytes
      + model.loadMetrics.workerTransferBytes
      + model.loadMetrics.decodedGeometryBytes
      + parsedCacheBytes
      + afterLoadManager.uploads.peakPendingBytes;
    const peakCpuStagingBytes = Math.max(0, peakHeap - heapStart, stagingEvidenceBytes);
    const imageDecodeTranscodeMs = phaseSpan(tierKtxEvents, 'decode-transcode')
      || model.loadMetrics.timings.textureDecodeTranscodeUploadMs;
    const gpuUploadMs = phaseSpan(tierKtxEvents, 'gpu-upload') || scheduledUploadCpuMs;
    const textureCount = model.assetStats.textureCount;
    const asset = {
      entry: tier.entry,
      meshCount: model.assetStats.meshCount,
      primitiveCount: model.assetStats.primitiveCount,
      materialCount: model.assetStats.materialCount,
      textureCount,
      animationCount: model.assetStats.animationCount,
      skinCount: countSkinRuntimes(model),
      morphTargetCount: countMorphTargets(meshes),
      features: [...tier.features],
    };
    disposeGltfModel(model);
    await Promise.resolve();
    const sceneDestroyResidualRecords = assetManager.getDebugSnapshot().records
      .filter(record => record.key.includes(assetUrl) || record.key.includes(tier.entry.split('/').at(-1))).length;
    return {
      id: tier.id,
      asset,
      timings: {
        fetchMs: model.loadMetrics.timings.fetchMs + phaseSpan(tierKtxEvents, 'fetch'),
        workerParseMs: useWorkers ? model.loadMetrics.timings.workerParseMs : 0,
        mainParseMs: useWorkers ? 0 : model.loadMetrics.timings.workerParseMs,
        dracoDecodeMs: model.loadMetrics.timings.dracoDecodeMs,
        geometryPreparationMs: model.loadMetrics.timings.geometryPreparationMs,
        instantiateMs: model.loadMetrics.timings.instantiateMs,
        imageDecodeTranscodeMs,
        gpuUploadMs,
        scheduledUploadCpuMs,
        pipelineWarmupMs,
        visibleSubmitMs,
        firstVisibleFrameMs,
      },
      resources: {
        assetTransferBytes,
        sourceBytes: model.loadMetrics.sourceBytes,
        decodedGeometryBytes: model.loadMetrics.decodedGeometryBytes,
        workerTransferBytes: model.loadMetrics.workerTransferBytes,
        workerTransferBufferCount: model.loadMetrics.workerTransferBufferCount,
        peakCpuStagingBytes,
        peakGpuEstimatedBytes: sumSnapshot(loadedTracker, 'peakEstimatedBytes'),
        gpuUploadCalls: frameSnapshot.counters.bufferUploads + assetUploadCalls,
        gpuUploadBytes: frameSnapshot.counters.bufferUploadBytes + assetUploadBytes,
        assetUploadCalls,
        assetUploadBytes,
        maxFrameAssetUploadBytes: uploadsAtVisible.maxFrameUploadedBytes,
        pendingUploadTasksAfterVisible: uploadsAtVisible.pendingTasks,
        postVisibleAssetUploadBytes: uploadsAfterVisible.uploadedBytes - uploadsAtVisible.uploadedBytes,
      },
      render: { passCount: 2, visiblePixel },
      lifecycle: {
        duplicateLoad: true,
        recordCacheHits: activityAfterDuplicate.recordHits - activityBeforeDuplicate.recordHits,
        sceneDestroyResidualRecords,
        recoveryFailures,
        recoveredTextureRecords,
      },
    };
  }

  function encodeFrame(meshes, worldMatrix, copyForReadback) {
    renderer.beginView(sceneFrame);
    renderer.prepareObjects(meshes.map(mesh => ({
      entityId: mesh.entityId,
      geometry: mesh.geometry,
      material: mesh.material,
      worldMatrix,
    })));
    renderer.flushUploads();
    const encoder = device.createCommandEncoder({ label: 'gltf-production-corpus.frame' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: color.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    for (const mesh of meshes) renderer.render(pass, mesh.entityId, mesh.geometry, mesh.material, worldMatrix);
    pass.end();
    renderer.endView();
    if (copyForReadback) {
      encoder.copyTextureToBuffer(
        { texture: color },
        { buffer: readback, bytesPerRow: 512 },
        [128, 128, 1],
      );
    }
    device.queue.submit([encoder.finish()]);
  }

  async function proveAnimation3DCrossFade(assetManager, gltfWorker, dracoDecoderConfig) {
    const fixture = '/extensions/test/fixtures/gltf/animation-characterization.gltf';
    const model = await loadGltfModel(new URL(fixture, location.href).href, {
      assetManager,
      ...(gltfWorker ? { assetWorker: gltfWorker } : {}),
      dracoDecoderConfig,
    });
    let runtime = null;
    try {
      runtime = createGltfAnimation3DRuntime(model, { clipIdPrefix: 'browser-character' });
      if (runtime.clips.length !== 2) {
        throw new Error(`Animation3D fixture expected two clips, received ${runtime.clips.length}`);
      }
      const animatedRoot = findEntity(model.root, 'AnimatedTRS');
      const animatedTransform = animatedRoot?.getComponent(Transform3D);
      const morphNode = findEntity(model.root, 'SkinnedMorph');
      const geometry = morphNode
        ? collectMeshes(morphNode).map(mesh => mesh.geometry).find(candidate => candidate.hasMorphTargets)
        : null;
      if (!animatedTransform || !geometry?.skinning) {
        throw new Error('Animation3D fixture is missing its root transform, skin, or morph runtime');
      }
      const basePositions = Float32Array.from(geometry.positions);
      const meshes = collectMeshes(model.root);
      // Keep the fixture's authored two-unit joint excursion inside the frame;
      // the ordinary corpus framing only sees undeformed CPU positions.
      const worldMatrix = createNormalizationMatrix(meshes, 0.2);
      const idle = runtime.mixer.createAction(runtime.clips[1], {
        id: 'Idle',
        loop: 'once',
        clampWhenFinished: true,
      });
      const run = runtime.mixer.createAction(runtime.clips[0], {
        id: 'Run',
        loop: 'once',
        clampWhenFinished: true,
      });
      idle.play();
      run.crossFadeFrom(idle, 1);

      const capturePhase = async (name, deltaSeconds) => {
        runtime.update(deltaSeconds);
        encodeFrame(meshes, worldMatrix, true);
        await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const visiblePixel = hasVisiblePixel(new Uint8Array(readback.getMappedRange()));
        readback.unmap();
        return {
          name,
          mixerTime: runtime.mixer.time,
          rootLocalMatrix: [...animatedTransform.localMatrix],
          morphWeights: [...geometry.morphWeights],
          skinJointTipMatrix: [...geometry.skinning.jointMatrices.slice(16, 32)],
          visiblePixel,
        };
      };
      const phases = [
        await capturePhase('start', 0),
        await capturePhase('mid', 0.5),
        await capturePhase('end', 0.5),
      ];
      const interpolation = [...new Set(
        runtime.clips.flatMap(clip => clip.tracks.map(track => track.interpolation)),
      )].sort();
      const gpuMorph = geometry.morphUseGpu && geometry.hasMorphTargets;
      const skinning = geometry.skinning !== null;
      const positionsRemainBase = arraysEqual(geometry.positions, basePositions);
      disposeGltfModel(model);
      return {
        fixture,
        clipIds: ['Idle', 'Run'],
        interpolation,
        phases,
        gpuMorph,
        skinning,
        positionsRemainBase,
        lifecycle: {
          runtimeState: runtime.state,
          actionCount: runtime.mixer.actions.length,
          bindingCount: runtime.bindingCount,
          targetCount: runtime.targetCount,
        },
      };
    } finally {
      if (!model.root.destroyed) disposeGltfModel(model);
      runtime?.destroy();
    }
  }
}

async function proveInFlightCancellation(tier, assetManager, gltfWorker, dracoDecoderConfig) {
  const controller = new AbortController();
  const url = new URL(`./assets/gltf-corpus/${tier.entry}?cancel=${performance.now()}`, location.href).href;
  let settled = false;
  const pending = loadGltfModel(url, {
    assetManager,
    ...(gltfWorker ? { assetWorker: gltfWorker } : {}),
    dracoDecoderConfig,
    signal: controller.signal,
  }).then(
    model => {
      settled = true;
      disposeGltfModel(model);
      return false;
    },
    () => {
      settled = true;
      return true;
    },
  );
  await nextAnimationFrame();
  const cancelledLoadWasInFlight = !settled;
  controller.abort('production-corpus-cancellation');
  const cancelledLoadRejected = await pending;
  return { cancelledLoadRejected, cancelledLoadWasInFlight };
}

function collectMeshes(root) {
  const meshes = [];
  let entityId = 0;
  const visit = entity => {
    const mesh = entity.getComponent(Mesh3D);
    if (mesh) meshes.push({ entityId: ++entityId, geometry: mesh.geometry, material: mesh.material });
    for (const child of entity.children) visit(child);
  };
  visit(root);
  return meshes;
}

function findEntity(root, name) {
  if (root.name === name) return root;
  for (const child of root.children) {
    const match = findEntity(child, name);
    if (match) return match;
  }
  return null;
}

function createNormalizationMatrix(meshes, coverage = 0.8) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const { geometry } of meshes) {
    const positions = geometry.positions;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]);
      minY = Math.min(minY, positions[i + 1]);
      minZ = Math.min(minZ, positions[i + 2]);
      maxX = Math.max(maxX, positions[i]);
      maxY = Math.max(maxY, positions[i + 1]);
      maxZ = Math.max(maxZ, positions[i + 2]);
    }
  }
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const scale = coverage / extent;
  return new Float32Array([
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    -centerX * scale, -centerY * scale, 0.5 - centerZ * scale, 1,
  ]);
}

function countMorphTargets(meshes) {
  return meshes.reduce((sum, mesh) => sum + mesh.geometry.morphTargets.length, 0);
}

function countSkinRuntimes(model) {
  return model.animationClips.reduce((maximum, clip) => Math.max(maximum, clip.skinnedPrimitives.length), 0);
}

function createSceneFrame() {
  return {
    frameId: 1,
    phaseRevision: 1,
    cameraEntityId: 0,
    data: writeSceneFrameUniforms(
      new Float32Array(SCENE_FRAME_UNIFORM_FLOATS),
      {
        viewProjectionMatrix: identityMatrix(),
        viewMatrix: identityMatrix(),
        inverseViewProjectionMatrix: identityMatrix(),
        position: [0, 0, 3],
        width: 128,
        height: 128,
      },
      null,
    ),
  };
}

function hasVisiblePixel(bytes) {
  for (let row = 16; row < 112; row++) {
    for (let column = 16; column < 112; column++) {
      const offset = row * 512 + column * 4;
      if (
        (bytes[offset] ?? 0) !== 0
        || (bytes[offset + 1] ?? 0) !== 0
        || (bytes[offset + 2] ?? 0) !== 0
        || (bytes[offset + 3] ?? 0) !== 0
      ) return true;
    }
  }
  return false;
}

function sumSnapshot(snapshot, key) {
  return Object.values(snapshot.byType).reduce((sum, stats) => sum + (stats?.[key] ?? 0), 0);
}

function phaseSpan(events, phase) {
  const matches = events.filter(event => event.phase === phase);
  if (matches.length === 0) return 0;
  return Math.max(...matches.map(event => event.endedAt))
    - Math.min(...matches.map(event => event.startedAt));
}

function identityMatrix() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function getUsedJsHeap() {
  return Number(performance.memory?.usedJSHeapSize ?? 0);
}

function nextAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

async function createKtxWorkerModule() {
  const workerEntryUrl = new URL('/engine/dist/experimental/ktx2-worker-runtime.js', location.href);
  const response = await fetch(workerEntryUrl);
  if (!response.ok) {
    throw new Error(`Could not resolve the KTX2 worker runtime entry (${response.status})`);
  }
  return {
    url: workerEntryUrl.href,
    dispose() {},
  };
}
