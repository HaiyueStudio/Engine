import {
  GpuDrivenBatchBuffer,
  GPUResourceTracker,
  RendererPipelineLayoutCache,
  RendererResourceCache,
  createGPUResourceOwner,
  createRenderFrameContext,
} from '/engine/dist/experimental.js';
import { READBACK_CHURN_SCHEMA_VERSION, READBACK_CHURN_SUITE } from './readback-churn-contract.mjs';

const parameters = new URLSearchParams(location.search);
const profile = parameters.get('profile') === 'long' ? 'long' : 'short';
const defaultFrames = profile === 'long' ? 1_800 : 120;
const frameCount = clampInteger(parameters.get('frames'), defaultFrames, 1, 20_000);
const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const result = await runGate(profile, frameCount);
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  const failure = { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) };
  progressNode.textContent = 'failed';
  resultNode.textContent = JSON.stringify(failure);
  resultNode.dataset.status = 'failed';
}

async function runGate(activeProfile, frames) {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const startedAt = performance.now();
  const validationErrors = [];
  const uncapturedErrors = [];
  let deviceLost = false;
  const onUncapturedError = event => uncapturedErrors.push(event.error?.message ?? String(event.error));
  device.addEventListener('uncapturederror', onUncapturedError);
  void device.lost.then(info => {
    if (info.reason !== 'destroyed') deviceLost = true;
  });
  device.pushErrorScope('validation');

  const tracker = new GPUResourceTracker({ debug: true });
  const engineOwner = createGPUResourceOwner('engine', 'webgpu-gate');
  const readbackOwner = createGPUResourceOwner('system', 'webgpu-gate-readback');
  tracker.instrumentDevice(device, engineOwner);
  const engine = { device, gpuResourceTracker: tracker };
  RendererResourceCache.configure(device, { maxResources: 8, maxPipelineLayouts: 8 });

  const batches = [];
  const liveScopes = [];
  const expectedValues = new Map();
  const submittedTokens = new Set();
  const seenResultTokens = new Set();
  const latencyFrames = [];
  const counters = {
    delivered: 0,
    cancelled: 0,
    mapFailures: 0,
    mappingsBeforeSubmit: 0,
    resultsBeforeSubmit: 0,
    duplicateResults: 0,
    unknownResults: 0,
    valueMismatches: 0,
    stalePublishedResults: 0,
    pendingDestroyEvents: 0,
    churnCycles: 0,
  };
  let currentFrame = 0;
  let batch = createBatch(0);

  function createBatch(frame) {
    return tracker.withOwner(readbackOwner, () => {
      const next = new GpuDrivenBatchBuffer(engine, `webgpu-gate.readback.${batches.length}`);
      next.upload(commandsForFrame(frame));
      batches.push(next);
      return next;
    });
  }

  function onReadback(result) {
    if (result.token !== undefined && seenResultTokens.has(result.token)) counters.duplicateResults++;
    if (result.token !== undefined) seenResultTokens.add(result.token);
    const expected = result.token === undefined ? undefined : expectedValues.get(result.token);
    if (!expected) counters.unknownResults++;
    if (result.token === undefined || !submittedTokens.has(result.token)) counters.resultsBeforeSubmit++;
    if (result.status === 'completed') {
      counters.delivered++;
      if (result.value !== expected?.value) counters.valueMismatches++;
      if (!result.published) counters.stalePublishedResults++;
      if (expected) latencyFrames.push(Math.max(0, currentFrame - expected.frame));
    } else if (result.status === 'cancelled') {
      counters.cancelled++;
    } else {
      counters.mapFailures++;
    }
  }

  for (let frame = 1; frame <= frames; frame++) {
    currentFrame = frame;
    tracker.beginFrame(frame);
    progressNode.textContent = `${activeProfile}: frame ${frame}/${frames}`;
    if (!batch) batch = createBatch(frame);
    const commands = commandsForFrame(frame);
    const expected = commands.reduce((sum, command) => sum + command.instanceCount, 0);
    tracker.withOwner(readbackOwner, () => batch.upload(commands));

    const requestsThisFrame = frame % 31 === 0 ? 3 : 1;
    let acceptedForPendingDestroy = false;
    for (let sample = 0; sample < requestsThisFrame; sample++) {
      const token = frame * 4 + sample;
      expectedValues.set(token, { value: expected, frame });
      const context = createRenderFrameContext(engine, { descriptor: { colorAttachments: [] }, label: `webgpu-gate.frame.${frame}.${sample}` });
      const mappingBeforeRequest = batch.getReadbackDebugSnapshot().indexedInstanceCounts.mappingStarted;
      const accepted = batch.requestIndexedInstanceCountReadback(context, { token, onComplete: onReadback });
      const mappingBeforeSubmit = batch.getReadbackDebugSnapshot().indexedInstanceCounts.mappingStarted;
      counters.mappingsBeforeSubmit += Math.max(0, mappingBeforeSubmit - mappingBeforeRequest);
      context.submit();
      submittedTokens.add(token);
      acceptedForPendingDestroy ||= accepted;
    }

    if (acceptedForPendingDestroy && frame % 47 === 0) {
      counters.pendingDestroyEvents++;
      batch.destroy();
      batch = null;
    }
    if (frame % 4 === 0) {
      runChurnCycle(frame);
      counters.churnCycles++;
    }
    if (liveScopes.length > 4) {
      await device.queue.onSubmittedWorkDone();
      liveScopes.shift().release();
    }
    await nextAnimationFrame();
  }

  await device.queue.onSubmittedWorkDone();
  for (const scope of liveScopes.splice(0)) scope.release();
  await waitFor(() => aggregateReadback(batches).pending === 0, 15_000, 'readback drain');
  batch?.destroy();
  RendererResourceCache.clear(device);
  tracker.releaseOwner(readbackOwner);
  tracker.releaseOwner(engineOwner);
  await Promise.resolve();

  const validationError = await device.popErrorScope();
  if (validationError) validationErrors.push(validationError.message);
  const debug = aggregateReadback(batches);
  const resourceSnapshot = tracker.getDebugSnapshot();
  const caches = aggregateCaches(resourceSnapshot.caches);
  const cacheStats = caches.reduce((totals, cache) => ({
    hits: totals.hits + cache.hits,
    misses: totals.misses + cache.misses,
  }), { hits: 0, misses: 0 });
  const rendererCacheStats = RendererResourceCache.getStats(device);
  const resourcesCreated = Object.values(resourceSnapshot.byType).reduce((sum, stats) => sum + (stats?.created ?? 0), 0);
  const peakLiveResources = Object.values(resourceSnapshot.byType).reduce((sum, stats) => sum + (stats?.peak ?? 0), 0);
  const liveResourcesAfterDrain = Object.values(resourceSnapshot.byType).reduce((sum, stats) => sum + (stats?.current ?? 0), 0);
  const liveEstimatedBytesAfterDrain = Object.values(resourceSnapshot.byType).reduce((sum, stats) => sum + (stats?.estimatedBytes ?? 0), 0);
  const adapterInfo = adapter.info ?? {};
  const result = {
    schemaVersion: READBACK_CHURN_SCHEMA_VERSION,
    suite: READBACK_CHURN_SUITE,
    profile: activeProfile,
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
    config: {
      frames,
      commandsPerFrame: 4,
      readbackRingSlots: 2,
      churnIntervalFrames: 4,
      pendingDestroyIntervalFrames: 47,
      burstIntervalFrames: 31,
      burstRequests: 3,
    },
    durationMs: performance.now() - startedAt,
    readback: {
      requests: debug.requests,
      accepted: debug.accepted,
      skipped: debug.skipped,
      mappingStarted: debug.mappingStarted,
      delivered: counters.delivered,
      cancelled: counters.cancelled,
      mapFailures: counters.mapFailures,
      skipRate: debug.requests === 0 ? 0 : debug.skipped / debug.requests,
      mappingsBeforeSubmit: counters.mappingsBeforeSubmit,
      resultsBeforeSubmit: counters.resultsBeforeSubmit,
      duplicateResults: counters.duplicateResults,
      unknownResults: counters.unknownResults,
      valueMismatches: counters.valueMismatches,
      stalePublishedResults: counters.stalePublishedResults,
      pendingDestroyEvents: counters.pendingDestroyEvents,
      maxRingOccupancy: debug.maxPending,
      pendingAfterDrain: debug.pending,
      latencyFrames: distribution(latencyFrames),
    },
    churn: {
      cycles: counters.churnCycles,
      resourcesCreated,
      peakLiveResources,
      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      caches,
      resourceTypes: Object.fromEntries(Object.entries(resourceSnapshot.byType).map(([type, stats]) => [type, {
        created: stats.created,
        destroyed: stats.destroyed,
        peak: stats.peak,
        current: stats.current,
        peakEstimatedBytes: stats.peakEstimatedBytes,
      }])),
      liveResourcesAfterDrain,
      liveEstimatedBytesAfterDrain,
      cacheEntriesAfterClear: rendererCacheStats.resources + rendererCacheStats.pipelineLayouts,
      releasedOwnerResiduals: resourceSnapshot.releasedOwnerResiduals,
      deviceLost,
    },
    validation: { errors: validationErrors, uncapturedErrors },
  };
  device.removeEventListener('uncapturederror', onUncapturedError);
  device.destroy();
  return result;

  function runChurnCycle(frame) {
    const scope = tracker.createScope('frame', `webgpu-gate-churn:${frame}`);
    tracker.withOwner(scope.owner, () => {
      const source = device.createBuffer({ label: `churn.source.${frame}`, size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const target = device.createBuffer({ label: `churn.target.${frame}`, size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(source, 0, new Uint32Array([frame, frame + 1, frame + 2, frame + 3]));
      device.createTexture({ label: `churn.texture.${frame}`, size: [16, 16, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.createSampler({ label: `churn.sampler.${frame}` });
      const shader = device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> values: array<u32>; @compute @workgroup_size(1) fn main() { values[0] = values[0] + 1u; }' });
      const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      RendererPipelineLayoutCache.get(device, 'webgpu-gate.compute-layout', [layout]);
      RendererPipelineLayoutCache.get(device, 'webgpu-gate.compute-layout', [layout]);
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const pipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module: shader, entryPoint: 'main' } });
      const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: target } }] });
      const encoder = device.createCommandEncoder({ label: `churn.encoder.${frame}` });
      encoder.copyBufferToBuffer(source, 0, target, 0, 256);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
    });
    liveScopes.push(scope);

    const key = frame % 12 === 0 ? `cold:${frame}` : `hot:${frame % 2}`;
    tracker.withOwner(engineOwner, () => {
      RendererResourceCache.get(device, key, () => device.createBuffer({ label: `cache.${key}`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      RendererResourceCache.get(device, key, () => { throw new Error('cache hit unexpectedly invoked its factory'); });
    });
  }
}

function commandsForFrame(frame) {
  return Array.from({ length: 4 }, (_, index) => ({
    entityId: index + 1,
    geometryId: 1,
    materialId: 1,
    instanceCount: ((frame * 5 + index * 3) % 17) + 1,
    indexCount: 3,
    vertexCount: 3,
    sortKey: (frame + index) >>> 0,
  }));
}

function aggregateReadback(batches) {
  return batches.reduce((total, batch) => {
    const state = batch.getReadbackDebugSnapshot().indexedInstanceCounts;
    for (const key of ['requests', 'accepted', 'skipped', 'mappingStarted', 'completed', 'cancelled', 'failed', 'staleCompletions', 'pending']) total[key] += state[key];
    total.maxPending = Math.max(total.maxPending, state.maxPending);
    return total;
  }, { requests: 0, accepted: 0, skipped: 0, mappingStarted: 0, completed: 0, cancelled: 0, failed: 0, staleCompletions: 0, pending: 0, maxPending: 0 });
}

function distribution(values) {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] };
}

function aggregateCaches(caches) {
  const byLabel = new Map();
  for (const cache of caches) {
    const current = byLabel.get(cache.label) ?? { label: cache.label, hits: 0, misses: 0, peakEntries: 0 };
    current.hits += cache.hits;
    current.misses += cache.misses;
    current.peakEntries = Math.max(current.peakEntries, cache.peakEntries);
    byLabel.set(cache.label, current);
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
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

function clampInteger(value, fallback, min, max) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
