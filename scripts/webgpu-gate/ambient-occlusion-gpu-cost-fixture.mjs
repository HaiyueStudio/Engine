import { GtaoPass } from '/engine/dist/postprocess.js';
import { createAoCostMatrix } from '../benchmark/ambient-occlusion-cost-model.mjs';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');
const query = new URLSearchParams(location.search);
let adapterInfo = {};

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available');
  adapterInfo = plainAdapterInfo(adapter.info ?? {});
  if (!adapter.features.has('timestamp-query')) {
    const error = new Error('The selected WebGPU adapter does not expose the optional timestamp-query feature.');
    error.code = 'timestamp-query-unavailable';
    throw error;
  }
  const device = await adapter.requestDevice({
    label: 'ambient-occlusion-gpu-cost',
    requiredFeatures: ['timestamp-query'],
  });
  const validationErrors = [];
  device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  device.pushErrorScope('validation');
  const warmupCount = positiveInteger(query.get('warmup'), 8);
  const sampleCount = positiveInteger(query.get('samples'), 30);
  const cases = [];
  const matrix = createAoCostMatrix();

  for (let index = 0; index < matrix.length; index++) {
    const cost = matrix[index];
    progressNode.textContent = `AO GPU cost ${index + 1}/${matrix.length}: ${cost.id}`;
    cases.push(await measureCase(device, cost, warmupCount, sampleCount));
  }

  const scopedError = await device.popErrorScope();
  if (scopedError) validationErrors.push(scopedError.message);
  const result = {
    schemaVersion: 2,
    suite: 'ambient-occlusion.gpu-cost',
    status: validationErrors.length === 0 ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    configuration: {
      algorithm: 'gtao',
      warmupCount,
      sampleCount,
      resolutionScale: 0.5,
      denoiseTapCount: 16,
      caseCount: cases.length,
    },
    formatDecision: {
      selected: 'r8unorm',
      reason: 'r8unorm is a core normalized render target and avoids half-float sampling/throughput variability; AO is bounded visibility',
      optionalFloatFilteringRequired: false,
      comparisonFormats: ['r8unorm', 'r16float'],
    },
    adapter: adapterInfo,
    capabilities: {
      timestampQuery: { status: 'available', reason: null },
    },
    cases,
    validation: { errorCount: validationErrors.length, errors: validationErrors },
  };
  resultNode.dataset.status = result.status;
  resultNode.textContent = JSON.stringify(result);
  progressNode.textContent = result.status;
  device.destroy();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const unavailable = error?.code === 'timestamp-query-unavailable';
  const result = {
    schemaVersion: 2,
    suite: 'ambient-occlusion.gpu-cost',
    status: unavailable ? 'unavailable' : 'failed',
    generatedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    adapter: adapterInfo,
    capabilities: {
      timestampQuery: {
        status: unavailable ? 'unavailable' : 'unknown',
        reason: unavailable ? error.message : null,
      },
    },
    cases: [],
    errors: unavailable ? [] : [message],
  };
  resultNode.dataset.status = result.status;
  resultNode.textContent = JSON.stringify(result);
  progressNode.textContent = message;
}

async function measureCase(device, cost, warmupCount, sampleCount) {
  const { width, height } = cost.resolution;
  const pass = new GtaoPass({
    quality: cost.quality.id,
    resolutionScale: cost.resolutionScale,
    scratchFormat: cost.scratchFormat.id,
  });
  const resources = createCaseResources(device, width, height);
  pass.prepare(device, 'rgba8unorm', width, height);
  pass.setSceneTextures({
    depth: resources.depth,
    normal: resources.normal,
    frame: createFrameContext(width, height),
  });
  initializeCaseTextures(device, resources, width, height);
  for (let index = 0; index < warmupCount; index++) {
    const encoder = device.createCommandEncoder({ label: `AO warmup ${cost.id}.${index}` });
    pass.apply(encoder, resources.source, resources.destinationView, device);
    device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();

  const probe = createTimestampProbe(device);
  const phaseSamples = { occlusion: [], denoise: [], upscale: [], total: [] };
  try {
    for (let index = 0; index < sampleCount; index++) {
      const sample = await probe.measure(pass, resources, createFrameContext(width, height, index + warmupCount));
      phaseSamples.occlusion.push(sample.occlusion);
      phaseSamples.denoise.push(sample.denoise);
      phaseSamples.upscale.push(sample.upscale);
      phaseSamples.total.push(sample.total);
    }
  } finally {
    probe.destroy();
    pass.destroy();
    resources.source.destroy();
    resources.depth.destroy();
    resources.normal.destroy();
    resources.destination.destroy();
  }
  return {
    id: cost.id,
    resolution: cost.resolution,
    quality: cost.quality,
    scratchFormat: cost.scratchFormat,
    scratch: cost.scratch,
    estimatedBandwidth: cost.estimatedBandwidth,
    gpu: {
      occlusion: summarize(phaseSamples.occlusion),
      denoise: summarize(phaseSamples.denoise),
      upscale: summarize(phaseSamples.upscale),
      total: summarize(phaseSamples.total),
    },
  };
}

function createCaseResources(device, width, height) {
  const source = device.createTexture({
    label: 'AO cost source', size: [width, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const depth = device.createTexture({
    label: 'AO cost linear depth', size: [width, height], format: 'r32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const normal = device.createTexture({
    label: 'AO cost view normal', size: [width, height], format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const destination = device.createTexture({
    label: 'AO cost destination', size: [width, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  return { source, depth, normal, destination, destinationView: destination.createView() };
}

function initializeCaseTextures(device, resources, width, height) {
  const encoder = device.createCommandEncoder({ label: 'AO cost initialize inputs' });
  for (const [texture, clearValue] of [
    [resources.source, { r: 0.42, g: 0.48, b: 0.56, a: 1 }],
    [resources.depth, { r: 0.45, g: 0, b: 0, a: 1 }],
    [resources.normal, { r: 0.5, g: 0.5, b: 1, a: 1 }],
  ]) {
    encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), clearValue, loadOp: 'clear', storeOp: 'store' }],
    }).end();
  }
  device.queue.submit([encoder.finish()]);
  void width;
  void height;
}

function createTimestampProbe(device) {
  const querySet = device.createQuerySet({ label: 'AO cost timestamps', type: 'timestamp', count: 6 });
  const resolveBuffer = device.createBuffer({
    label: 'AO cost timestamp resolve', size: 48,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    label: 'AO cost timestamp readback', size: 48,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  return {
    async measure(pass, resources, frame) {
      const encoder = device.createCommandEncoder({ label: 'AO cost timed frame' });
      let phaseIndex = 0;
      const timedEncoder = new Proxy(encoder, {
        get(target, property) {
          if (property === 'beginRenderPass') {
            return descriptor => {
              if (phaseIndex >= 3) throw new Error('AO pass emitted more than three render passes');
              const queryIndex = phaseIndex++ * 2;
              return target.beginRenderPass({
                ...descriptor,
                timestampWrites: {
                  querySet,
                  beginningOfPassWriteIndex: queryIndex,
                  endOfPassWriteIndex: queryIndex + 1,
                },
              });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      pass.setSceneTextures({ depth: resources.depth, normal: resources.normal, frame });
      pass.apply(timedEncoder, resources.source, resources.destinationView, device);
      if (phaseIndex !== 3) throw new Error(`AO pass emitted ${phaseIndex} render passes instead of three`);
      encoder.resolveQuerySet(querySet, 0, 6, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readbackBuffer, 0, 48);
      device.queue.submit([encoder.finish()]);
      await readbackBuffer.mapAsync(GPUMapMode.READ, 0, 48);
      const timestamps = new BigUint64Array(readbackBuffer.getMappedRange(0, 48)).slice();
      readbackBuffer.unmap();
      const values = [0, 1, 2].map(index => {
        const start = timestamps[index * 2] ?? 0n;
        const end = timestamps[index * 2 + 1] ?? 0n;
        return end > start ? Number(end - start) / 1_000_000 : 0;
      });
      return {
        occlusion: values[0],
        denoise: values[1],
        upscale: values[2],
        total: values[0] + values[1] + values[2],
      };
    },
    destroy() {
      querySet.destroy();
      resolveBuffer.destroy();
      readbackBuffer.destroy();
    },
  };
}

function createFrameContext(width, height, frameId = 0) {
  const near = 0.1;
  const far = 100;
  const f = 1 / Math.tan(Math.PI / 8);
  const projectionMatrix = new Float32Array([
    f / (width / height), 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, near * far / (near - far), 0,
  ]);
  return {
    viewKey: 'ao-cost', frameId, width, height, cameraId: 1,
    reverseZ: false, near, far, isOrthographic: false,
    projectionJitter: new Float32Array(2),
    projectionMatrix,
    viewProjectionMatrix: projectionMatrix,
    inverseViewProjectionMatrix: projectionMatrix,
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    rawSamples: values,
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function positiveInteger(value, fallback) {
  const parsed = value === null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new RangeError(`Expected a positive integer; received ${String(value)}.`);
  return parsed;
}

function plainAdapterInfo(info) {
  return Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(key => [key, String(info[key] ?? '')]));
}
