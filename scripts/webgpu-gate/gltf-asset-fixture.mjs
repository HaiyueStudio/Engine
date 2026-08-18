import { Mesh3D } from '/engine/dist/index.js';
import { AssetManager } from '/engine/dist/assets.js';
import {
  FrameDiagnostics,
  GPUResourceTracker,
  SCENE_FRAME_UNIFORM_FLOATS,
  createGPUResourceOwner,
  disposeSceneFrameGpuArena,
  writeSceneFrameUniforms,
} from '/engine/dist/experimental.js';
import { PbrRenderer } from '/engine/dist/renderer.js';
import { disposeGltfModel, loadGltfModel } from '/extensions/dist/gltf.js';
import {
  GLTF_ASSET_BASELINE_SCHEMA_VERSION,
  GLTF_ASSET_BASELINE_SUITE,
} from './gltf-asset-contract.mjs';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const result = await runBaseline();
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  progressNode.textContent = 'failed';
  resultNode.textContent = JSON.stringify({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  resultNode.dataset.status = 'failed';
}

async function runBaseline() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const uncapturedErrors = [];
  let deviceLost = false;
  const onUncapturedError = event => uncapturedErrors.push(event.error?.message ?? String(event.error));
  device.addEventListener('uncapturederror', onUncapturedError);
  void device.lost.then(info => { if (info.reason !== 'destroyed') deviceLost = true; });
  device.pushErrorScope('validation');

  const frameDiagnostics = new FrameDiagnostics({ enabled: true });
  const tracker = new GPUResourceTracker({ debug: true, frameDiagnostics });
  const engineOwner = createGPUResourceOwner('engine', 'gltf-asset-baseline');
  const rendererOwner = createGPUResourceOwner('system', 'gltf-asset-baseline-pbr');
  tracker.instrumentDevice(device, engineOwner);
  const assetManager = new AssetManager(device, tracker);
  const engine = {
    device,
    format: 'rgba8unorm',
    assetManager,
    gpuResourceTracker: tracker,
    getDepthFormat: () => 'depth24plus',
  };
  const renderer = new PbrRenderer();
  const assetUrl = new URL('./assets/stage11-dynamic-uv-character.gltf', location.href).href;
  const cpuStart = getUsedJsHeap();
  let peakCpu = cpuStart;
  const sampleCpu = () => { peakCpu = Math.max(peakCpu, getUsedJsHeap()); };
  const startedAt = performance.now();
  frameDiagnostics.beginFrame(1);
  const cancelledController = new AbortController();
  cancelledController.abort('gltf-asset-baseline-cancel');
  let cancelledLoadRejected = false;
  try {
    await loadGltfModel(assetUrl, { signal: cancelledController.signal, assetManager });
  } catch {
    cancelledLoadRejected = true;
  }
  progressNode.textContent = 'fetch + parse';
  const importStartedAt = performance.now();
  const model = await loadGltfModel(assetUrl, { assetManager });
  const assetImportMs = performance.now() - importStartedAt;
  sampleCpu();

  progressNode.textContent = 'renderer prepare';
  const prepareStartedAt = performance.now();
  tracker.withOwner(rendererOwner, () => renderer.prepare(engine));
  const rendererPrepareMs = performance.now() - prepareStartedAt;
  const color = tracker.withOwner(rendererOwner, () => device.createTexture({
    label: 'gltf-asset-baseline.color',
    size: [64, 64, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  }));
  const depth = tracker.withOwner(rendererOwner, () => device.createTexture({
    label: 'gltf-asset-baseline.depth',
    size: [64, 64, 1],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  }));
  const readback = tracker.withOwner(rendererOwner, () => device.createBuffer({
    label: 'gltf-asset-baseline.readback',
    size: 256 * 64,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  }));
  const meshes = collectMeshes(model.root);
  if (meshes.length !== 1) throw new Error(`Expected one renderable mesh, received ${meshes.length}`);
  const sceneFrame = {
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
        width: 64,
        height: 64,
      },
      null,
    ),
  };
  renderer.updateFrame(sceneFrame, [], null, null);

  progressNode.textContent = 'pipeline + geometry warmup';
  const warmupStartedAt = performance.now();
  tracker.withOwner(rendererOwner, () => encodeFrame(false));
  await device.queue.onSubmittedWorkDone();
  const pipelineWarmupMs = performance.now() - warmupStartedAt;
  sampleCpu();

  progressNode.textContent = 'image decode + mip upload';
  const textureStartedAt = performance.now();
  await waitFor(() => {
    sampleCpu();
    const records = assetManager.getDebugSnapshot().records;
    return records.length >= 2 && records.every(record => record.state === 'ready');
  }, 10_000, 'ordinary image texture readiness');
  await nextAnimationFrame();
  const textureReadyMs = performance.now() - textureStartedAt;

  progressNode.textContent = 'first material-ready visible frame';
  const visibleStartedAt = performance.now();
  tracker.withOwner(rendererOwner, () => encodeFrame(true));
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(GPUMapMode.READ);
  const visibleBytes = new Uint8Array(readback.getMappedRange());
  let visiblePixel = false;
  for (let row = 20; row < 44 && !visiblePixel; row++) {
    for (let column = 20; column < 44; column++) {
      const offset = row * 256 + column * 4;
      if ((visibleBytes[offset] ?? 0) !== 0 || (visibleBytes[offset + 1] ?? 0) !== 0 || (visibleBytes[offset + 2] ?? 0) !== 0) {
        visiblePixel = true;
        break;
      }
    }
  }
  readback.unmap();
  const visibleSubmitMs = performance.now() - visibleStartedAt;
  const firstVisibleFrameMs = performance.now() - startedAt;
  sampleCpu();

  progressNode.textContent = 'asset device recovery';
  const recoveryStartedAt = performance.now();
  assetManager.suspendForDeviceLoss();
  const recoveryFailures = (await assetManager.recoverDevice(device, new AbortController().signal)).length;
  const recoveryMs = performance.now() - recoveryStartedAt;
  sampleCpu();

  const loadedSnapshot = tracker.getDebugSnapshot();
  const frameSnapshot = frameDiagnostics.snapshot();
  const bufferStats = loadedSnapshot.byType.buffer;
  const textureStats = loadedSnapshot.byType.texture;
  const peakGpuBufferBytes = bufferStats?.peakEstimatedBytes ?? 0;
  const peakGpuTextureBytes = textureStats?.peakEstimatedBytes ?? 0;
  const peakGpuEstimatedBytes = Object.values(loadedSnapshot.byType)
    .reduce((sum, stats) => sum + (stats?.peakEstimatedBytes ?? 0), 0);
  const assetEntry = performance.getEntriesByName(assetUrl).at(-1);
  const assetTransferBytes = assetEntry?.decodedBodySize || assetEntry?.transferSize || 0;
  const decodedGeometryBytes = countDecodedGeometryBytes(meshes);
  const peakCpuStagingBytes = Math.max(peakCpu - cpuStart, assetTransferBytes + decodedGeometryBytes);
  const assetTextureBytes = loadedSnapshot.resources
    .filter(resource => resource.type === 'texture' && resource.owner.kind === 'asset')
    .reduce((sum, resource) => sum + resource.estimatedBytes, 0);
  const uvSemantics = model.compatibilityReport.uvSemantics.map(entry => ({
    capacity: entry.capacity,
    availableSemantics: [...entry.availableSemantics],
    referencedSemantics: [...entry.referencedSemantics],
    mappings: entry.mappings.map(mapping => ({ ...mapping })),
  }));
  const asset = {
    fixtureVersion: 1,
    url: assetUrl,
    meshCount: model.assetStats.meshCount,
    primitiveCount: model.assetStats.primitiveCount,
    textureCount: model.assetStats.textureCount,
    animationCount: model.assetStats.animationCount,
  };

  disposeGltfModel(model);
  renderer.destroy();
  disposeSceneFrameGpuArena(device);
  assetManager.dispose();
  color.destroy();
  depth.destroy();
  readback.destroy();
  tracker.releaseOwner(rendererOwner);
  tracker.releaseOwner(engineOwner);
  await Promise.resolve();
  const destroyedSnapshot = tracker.getDebugSnapshot();
  const liveGpuResourcesAfterDestroy = Object.values(destroyedSnapshot.byType).reduce((sum, stats) => sum + (stats?.current ?? 0), 0);
  const liveGpuBytesAfterDestroy = Object.values(destroyedSnapshot.byType).reduce((sum, stats) => sum + (stats?.estimatedBytes ?? 0), 0);
  const validationError = await device.popErrorScope();
  const validationErrors = validationError ? [validationError.message] : [];
  const adapterInfo = adapter.info ?? {};
  const result = {
    schemaVersion: GLTF_ASSET_BASELINE_SCHEMA_VERSION,
    suite: GLTF_ASSET_BASELINE_SUITE,
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
    asset,
    contract: {
      uvSemantics,
      extensions: model.extensionReport.entries.map(entry => ({
        extension: entry.extension,
        required: entry.required,
        support: entry.support,
        disposition: entry.disposition,
      })),
      clearcoat: meshes.map(mesh => ({
        factor: mesh.material.clearcoatFactor,
        roughnessFactor: mesh.material.clearcoatRoughnessFactor,
        normalScale: mesh.material.clearcoatNormalScale,
      })),
    },
    timings: {
      fetchMs: assetEntry?.duration ?? 0,
      parseInstantiateMs: Math.max(0, assetImportMs - (assetEntry?.duration ?? 0)),
      dracoDecodeMs: 0,
      assetImportMs,
      rendererPrepareMs,
      pipelineWarmupMs,
      imageDecodeUploadMs: textureReadyMs,
      visibleSubmitMs,
      firstVisibleFrameMs,
      recoveryMs,
    },
    resources: {
      assetTransferBytes,
      peakCpuStagingBytes,
      cpuStagingMeasurement: 'max(js-heap delta, transferred asset plus unique decoded geometry buffers)',
      peakGpuEstimatedBytes,
      peakGpuBufferBytes,
      peakGpuTextureBytes,
      gpuUploadBytes: frameSnapshot.counters.bufferUploadBytes + assetTextureBytes,
      liveGpuResourcesAfterDestroy,
      liveGpuBytesAfterDestroy,
      releasedOwnerResiduals: destroyedSnapshot.releasedOwnerResiduals,
    },
    lifecycle: { cancelledLoadRejected, recoveryFailures },
    validation: { errors: validationErrors, uncapturedErrors, deviceLost, visiblePixel },
  };
  device.removeEventListener('uncapturederror', onUncapturedError);
  device.destroy();
  return result;

  function encodeFrame(copyForReadback) {
    renderer.beginView(sceneFrame);
    renderer.prepareObjects(meshes.map(mesh => ({
      entityId: mesh.entityId,
      geometry: mesh.geometry,
      material: mesh.material,
      worldMatrix: identityMatrix(),
    })));
    renderer.flushUploads();
    const encoder = device.createCommandEncoder({ label: 'gltf-asset-baseline.frame' });
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
    for (const mesh of meshes) renderer.render(pass, mesh.entityId, mesh.geometry, mesh.material, identityMatrix());
    pass.end();
    renderer.endView();
    if (copyForReadback) encoder.copyTextureToBuffer({ texture: color }, { buffer: readback, bytesPerRow: 256 }, [64, 64, 1]);
    device.queue.submit([encoder.finish()]);
  }
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

function countDecodedGeometryBytes(meshes) {
  const buffers = new Set();
  const add = value => { if (ArrayBuffer.isView(value)) buffers.add(value.buffer); };
  for (const { geometry } of meshes) {
    add(geometry.positions);
    add(geometry.normals);
    add(geometry.indices);
    add(geometry.morphBasePositions);
    add(geometry.morphBaseNormals);
    for (const value of geometry.textureCoordinates.values()) add(value);
    for (const target of geometry.morphTargets) {
      add(target.positions);
      add(target.normals);
    }
    add(geometry.skinning?.joints);
    add(geometry.skinning?.weights);
    add(geometry.skinning?.jointMatrices);
  }
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

function identityMatrix() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function getUsedJsHeap() {
  return Number(performance.memory?.usedJSHeapSize ?? 0);
}

function nextAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

async function waitFor(read, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
