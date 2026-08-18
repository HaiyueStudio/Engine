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
  } = await import('../benchmark/real-renderer-scenario.mjs');
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
  } = await import('../benchmark/billiards-3d-real-renderer-content.mjs');

  progressNode.textContent = 'fetching and verifying billiards scene';
  const {
    document: lightingSceneDocument,
    url: lightingSceneUrl,
  } = await fetchAndParseBilliardsScene(
    BILLIARDS_3D_SCENE_PATH,
    parseBilliards3DSceneDocument,
  );

  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) throw new Error('No WebGPU adapter');
  const timestampQuerySupported = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    label: 'lighting-scaling-real-fixture',
    requiredFeatures: timestampQuerySupported ? ['timestamp-query'] : [],
  });
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
  }
  const metricsBeforeGpuProbe = captureRealRendererBenchmarkMetrics(state);
  const gpuTimestampProbe = createRealRendererGpuTimestampProbe(state);
  const gpuDurations = [];
  let gpuPassLabels = [];
  if (gpuTimestampProbe.supported) {
    for (let index = 0; index < gpuSamples; index++) {
      await runRealRendererBenchmarkFrame(state, { gpuTimestampProbe });
      const sample = state.lastFrameTiming.gpuTimestamp;
      gpuDurations.push(sample.totalMs);
      gpuPassLabels = sample.passLabels;
    }
  }
  gpuTimestampProbe.destroy();
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
  device.destroy();
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify(result);
  progressNode.textContent = 'complete';
} catch (error) {
  resultNode.dataset.status = 'failed';
  resultNode.textContent = error?.stack ?? String(error);
  progressNode.textContent = 'failed';
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
