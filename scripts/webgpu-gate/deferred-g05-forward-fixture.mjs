// G05 copy of the frozen G01 replay; timing populations and workload remain identical.
import {observeForwardAllocations} from './deferred-g05-forward-allocation.mjs';
import {readFloatTexture} from './float-texture-readback.mjs';
import {encodeFrameGraphPixels} from './framegraph-pixel-oracle.mjs';
const resultNode = document.querySelector('#result');
const progressNode = document.querySelector('#progress');
const query = new URLSearchParams(location.search);

try {
  const {
    LIGHTING_SCALING_DYNAMIC_RATIOS,
    LIGHTING_SCALING_LOCAL_LIGHT_COUNTS,
    LIGHTING_SCALING_OVERLAPS,
    LIGHTING_SCALING_RESOLUTIONS,
    LIGHTING_SCALING_VIEW_COUNTS,
    createLightingScalingFixtureConfiguration,
  } = await import('../benchmark/lighting-scaling-fixture.mjs');
  const {
    captureRealRendererBenchmarkMetrics,
    createRealRendererGpuTimestampProbe,
    createRealRendererBenchmarkScenario,
    destroyRealRendererBenchmarkScenario,
    resetRealRendererBenchmarkMetrics,
    runRealRendererBenchmarkFrame,
    warmRealRendererBenchmarkPipelines,
  } = await import(query.get('framegraphRuntime') === '1' ? '../../artifacts/engine-0.2.1/g09/oracle-runtime/fixture.js' : '../benchmark/real-renderer-scenario.mjs');
  const {
    summarizeTimingSamples,
  } = await import('../benchmark/timing-cohorts.mjs');
  const {
    assertLightingScalingResult,
  } = await import('./lighting-scaling-contract.mjs');
  const {
    buildLightingScalingReport,
  } = await import('./lighting-scaling-report.mjs');
  const {
    BILLIARDS_3D_SCENE_BYTE_LENGTH,
    BILLIARDS_3D_SCENE_PATH,
    BILLIARDS_3D_SCENE_SHA256,
    parseBilliards3DSceneDocument,
  } = await import(query.get('framegraphRuntime') === '1' ? '../../artifacts/engine-0.2.1/g09/oracle-runtime/fixture.js' : '../benchmark/billiards-3d-real-renderer-content.mjs');

  progressNode.textContent = 'fetching and verifying billiards scene';
  const {
    document: lightingSceneDocument,
    url: lightingSceneUrl,
  } = await fetchAndParseBilliardsScene(
    BILLIARDS_3D_SCENE_PATH,
    parseBilliards3DSceneDocument,
  );

  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const powerPreference = query.get('powerPreference') ?? 'high-performance';
  if (!['high-performance', 'low-power'].includes(powerPreference)) throw new Error('Invalid powerPreference');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference });
  if (!adapter) throw new Error('No WebGPU adapter');
  const timestampQuerySupported = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    label: 'lighting-scaling-real-fixture',
    requiredFeatures: timestampQuerySupported ? ['timestamp-query'] : [],
  });
  const allocationAudit = observeForwardAllocations(device);
  const validation = beginStrictValidation(device);
  const configuration = createLightingScalingFixtureConfiguration({
    localLightCount: numberParameter(query, 'lights', 8),
    overlap: query.get('overlap') ?? 'medium',
    dynamicRatio: numberParameter(query, 'dynamic', 0.25),
    viewCount: numberParameter(query, 'views', 1),
    resolution: query.get('resolution') ?? '720p',
  });
  const warmup = positiveInteger(query.get('warmup'), 4);
  const samples = positiveInteger(query.get('samples'), 30);
  const gpuSamples = nonNegativeInteger(query.get('gpuSamples'), 8);
  const samplingMode = query.get('framegraphSampling');
  if (samplingMode !== null && (!['calibration', 'baseline'].includes(samplingMode) || query.get('framegraphRuntime') !== '1')) throw Error('Invalid G09 sampling mode');
  const samplingProtocol = query.get('framegraphSamplingProtocol') ?? 'g09-forward-cold-steady-v1';
  if (samplingMode && !['g09-forward-cold-steady-v1', 'g09-forward-cold-steady-v2', 'g09-forward-cold-steady-v3'].includes(samplingProtocol)) throw Error('Invalid G09 sampling protocol');
  const gpuWarmup = samplingMode ? 120 : warmup;
  const timeline = samplingMode ? { cpu: [], cpuUpdate: [], cpuRecord: [], cpuSubmit: [], frameWall: [], queueWait: [] } : null;
  progressNode.textContent = configuration.id;

  const setupStartedAt = performance.now();
  const state = await createRealRendererBenchmarkScenario({
    device,
    lightingFixture: configuration,
    lightingSceneDocument,
  });
  const sceneHttpRequestCount =
    performance.getEntriesByName(lightingSceneUrl.href).length;
  if (sceneHttpRequestCount !== 1) {
    throw new Error(
      `Lighting gate expected one scene HTTP request; observed `
      + `${sceneHttpRequestCount}.`,
    );
  }
  const setupMs = performance.now() - setupStartedAt;
  const pipelineWarmupStartedAt = performance.now();
  const pipelineWarmup = await warmRealRendererBenchmarkPipelines(state);
  const pipelineWarmupMs = performance.now() - pipelineWarmupStartedAt;
  const warmupDurations = [];
  for (let index = 0; index < warmup; index++) {
    const startedAt = performance.now();
    await runRealRendererBenchmarkFrame(state);
    warmupDurations.push(performance.now() - startedAt);
    if (timeline) recordTimeline(timeline, state.lastFrameTiming);
  }

  resetRealRendererBenchmarkMetrics(state);
  const cpuDurations = [];
  const cpuRecordDurations = [];
  const cpuSubmitDurations = [];
  const cpuUpdateDurations = [];
  const sampleWallDurations = [];
  const queueWaitDurations = [];
  for (let index = 0; index < samples; index++) {
    await runRealRendererBenchmarkFrame(state);
    cpuDurations.push(state.lastFrameTiming.runtimeFrameMs);
    cpuRecordDurations.push(state.lastFrameTiming.cpuRecordMs);
    cpuSubmitDurations.push(state.lastFrameTiming.cpuSubmitMs);
    cpuUpdateDurations.push(state.lastFrameTiming.cpuUpdateMs);
    sampleWallDurations.push(state.lastFrameTiming.sampleWallMs);
    queueWaitDurations.push(state.lastFrameTiming.queueWaitMs);
    if (timeline) recordTimeline(timeline, state.lastFrameTiming);
  }
  const metricsBeforeGpuProbe = captureRealRendererBenchmarkMetrics(state);
  const gpuTimestampProbe = createRealRendererGpuTimestampProbe(state, { includeCompute: query.get('framegraphRuntime') === '1' });
  const gpuDurations = [];
  const gpuSpans = [];
  let gpuPassLabels = [];
  if (gpuTimestampProbe.supported) {
    if (query.get('framegraphRuntime') === '1') for (let index = 0; index < gpuWarmup; index++) await runRealRendererBenchmarkFrame(state, { gpuTimestampProbe });
    for (let index = 0; index < gpuSamples; index++) {
      await runRealRendererBenchmarkFrame(state, { gpuTimestampProbe });
      const sample = state.lastFrameTiming.gpuTimestamp;
      gpuDurations.push(sample.totalMs);
      gpuSpans.push(sample.spanMs);
      gpuPassLabels = sample.passLabels;
    }
  }
  gpuTimestampProbe.destroy();
  if (query.get('framegraphOracle') === '1') {
    const ldr = await readFloatTexture(state.device, state.targets[0].colorTexture);
    globalThis.__framegraphPixels = encodeFrameGraphPixels([{ key: 'real-frame-view:0', hdr: ldr, ldr }]);
  }
  await destroyRealRendererBenchmarkScenario(state);
  const validationErrors = await finishStrictValidation(device, validation);

  const metrics = { ...metricsBeforeGpuProbe, ...state.finalMetrics };
  const timing = summarizeTimingSamples(cpuDurations);
  const warmupTiming = summarizeTimingSamples(warmupDurations);
  const sampleWall = summarizeTimingSamples(sampleWallDurations);
  const queueWait = summarizeTimingSamples(queueWaitDurations);
  const cpuRecord = summarizeTimingSamples(cpuRecordDurations);
  const cpuSubmit = summarizeTimingSamples(cpuSubmitDurations);
  const cpuUpdate = summarizeTimingSamples(cpuUpdateDurations);
  const gpuTimestamp = gpuTimestampProbe.supported && gpuDurations.length > 0
    ? {
        status: 'available',
        timing: summarizeTimingSamples(gpuDurations),
        passLabels: gpuPassLabels,
      }
    : {
        status: 'unavailable',
        reason: gpuTimestampProbe.reason
          ?? 'timestamp-query feature is unavailable on this adapter',
        timing: null,
        passLabels: [],
      };
  const matrix = {
    localLightCounts: LIGHTING_SCALING_LOCAL_LIGHT_COUNTS,
    overlaps: LIGHTING_SCALING_OVERLAPS,
    dynamicRatios: LIGHTING_SCALING_DYNAMIC_RATIOS,
    viewCounts: LIGHTING_SCALING_VIEW_COUNTS,
    resolutions: LIGHTING_SCALING_RESOLUTIONS.map(item => item.id),
    caseCount: LIGHTING_SCALING_LOCAL_LIGHT_COUNTS.length
      * LIGHTING_SCALING_OVERLAPS.length
      * LIGHTING_SCALING_DYNAMIC_RATIOS.length
      * LIGHTING_SCALING_VIEW_COUNTS.length
      * LIGHTING_SCALING_RESOLUTIONS.length,
  };
  const adapterInfo = plainAdapterInfo(adapter.info ?? {});
  const setup = {
    scenarioMs: setupMs,
    pipelineWarmupMs,
    pipelineWarmup,
  };
  const sceneProvenance = {
    hashAlgorithm: 'sha256',
    expected: {
      sourcePath: BILLIARDS_3D_SCENE_PATH,
      byteLength: BILLIARDS_3D_SCENE_BYTE_LENGTH,
      hash: `sha256:${BILLIARDS_3D_SCENE_SHA256}`,
    },
    observed: {
      sourcePath: metrics.realContentProvenance?.scenePath,
      byteLength: metrics.realContentProvenance?.sceneByteLength,
      hash: metrics.realContentProvenance?.sceneSha256
        ? `sha256:${metrics.realContentProvenance.sceneSha256}`
        : null,
    },
  };
  const report = buildLightingScalingReport({
    fixture: configuration,
    timingSamples: {
      warmup: warmupTiming,
      timing,
      cpuRecord,
      cpuUpdate,
      sampleWall,
      queueWait,
      cpuSubmit,
      gpuTimestamp,
    },
    rendererMetrics: metrics,
    sceneProvenance,
    execution: {
      status: validationErrors.length === 0 ? 'passed' : 'failed',
      validationErrors,
      ownerResidual: state.finalMetrics.ownerResidual,
    },
    metadata: {
      matrix,
      adapter: adapterInfo,
      browser: navigator.userAgent,
      sceneHttpRequestCount,
      setup,
    },
  });
  const result = assertLightingScalingResult(report);
  result.g05Forward = {...allocationAudit.snapshot(), cleanup:{ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources}};
  if (query.get('framegraphRuntime') === '1') result.g09WholeGpu = { scope: 'render-and-compute-span-v1', rawSamples: gpuSpans, warmup: gpuWarmup };
  if (timeline) result.g09Sampling = { protocol: samplingProtocol, mode: samplingMode, warmup, gpuWarmup, coldFrames: 120, timeline };
  device.destroy();
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify(result);
  progressNode.textContent = 'complete';
} catch (error) {
  resultNode.dataset.status = 'failed';
  resultNode.textContent = error?.stack ?? String(error);
  progressNode.textContent = 'failed';
}

function recordTimeline(timeline, timing) {
  timeline.cpu.push(timing.runtimeFrameMs);
  timeline.cpuUpdate.push(timing.cpuUpdateMs);
  timeline.cpuRecord.push(timing.cpuRecordMs);
  timeline.cpuSubmit.push(timing.cpuSubmitMs);
  timeline.frameWall.push(timing.sampleWallMs);
  timeline.queueWait.push(timing.queueWaitMs);
}

function numberParameter(parameters, name, fallback) {
  const value = parameters.get(name);
  return value === null || value === '' ? fallback : Number(value);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function plainAdapterInfo(info) {
  return {
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
    isFallbackAdapter: info.isFallbackAdapter,
  };
}

async function fetchAndParseBilliardsScene(
  scenePath,
  parseSceneDocument,
) {
  const url = new URL(`/${scenePath}`, location.origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Lighting gate scene must be delivered over HTTP; received ${url.href}.`,
    );
  }
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `Could not fetch billiards scene: HTTP ${response.status}.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    document: await parseSceneDocument(bytes),
    url,
  };
}

function beginStrictValidation(device) {
  const uncapturedErrors = [];
  const listener = event => {
    uncapturedErrors.push(event.error?.message ?? String(event.error ?? event));
  };
  device.addEventListener('uncapturederror', listener);
  device.pushErrorScope('validation');
  return { uncapturedErrors, listener };
}

async function finishStrictValidation(device, validation) {
  await device.queue.onSubmittedWorkDone();
  const scopedError = await device.popErrorScope();
  device.removeEventListener('uncapturederror', validation.listener);
  const errors = [...validation.uncapturedErrors];
  if (scopedError) errors.push(scopedError.message);
  return errors;
}
