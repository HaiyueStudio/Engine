const resultNode = document.querySelector('#result');
const progressNode = document.querySelector('#progress');
const query = new URLSearchParams(location.search);
const entityCount = positiveInteger(query.get('entities'), 256);
const warmup = positiveInteger(query.get('warmup'), 2);
const samples = positiveInteger(query.get('samples'), 6);
const gpuSamples = nonNegativeInteger(query.get('gpuSamples'), 4);
const passKind = query.get('pass') === 'allocation' ? 'allocation' : 'timing';
const fixtureStartedAt = performance.now();

try {
  const {
    captureRealRendererBenchmarkMetrics,
    createRealRendererGpuTimestampProbe,
    createRealRendererBenchmarkScenario,
    destroyRealRendererBenchmarkScenario,
    getRealRendererAllocationEvidence,
    getRealRendererBenchmarkMetrics,
    resetRealRendererBenchmarkMetrics,
    runRealRendererBenchmarkFrame,
    warmRealRendererBenchmarkPipelines,
  } = await import('../benchmark/real-renderer-scenario.mjs');
  const { resolveRealRendererStructuralBudgets } = await import('../benchmark/real-renderer-budgets.mjs');
  const { summarizeTimingSamples } = await import('../benchmark/timing-cohorts.mjs');
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  // Give the fixed runner time to attach the V8 allocation sampler before setup.
  await new Promise(resolve => setTimeout(resolve, 750));
  const adapterRequestStartedAt = performance.now();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const adapterRequestMs = performance.now() - adapterRequestStartedAt;
  if (!adapter) throw new Error('No WebGPU adapter');
  const adapterInfo = adapter.info ? plainAdapterInfo(adapter.info) : {};
  const results = [];
  for (const dynamicRatio of [0, 0.01, 0.1, 1]) {
    for (const viewCount of [1, 4]) {
      const label = `${Math.round(dynamicRatio * 100)}% dynamic, ${viewCount} view`;
      progressNode.textContent = label;
      const caseStartedAt = performance.now();
      const caseAdapterRequestStartedAt = performance.now();
      const caseAdapter = results.length === 0
        ? adapter
        : await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      const caseAdapterRequestMs = performance.now() - caseAdapterRequestStartedAt;
      if (!caseAdapter) throw new Error(`No WebGPU adapter for ${label}`);
      const timestampQuerySupported = caseAdapter.features.has('timestamp-query');
      const deviceRequestStartedAt = performance.now();
      const device = await caseAdapter.requestDevice({
        label: `real-renderer-benchmark:${label}`,
        requiredFeatures: timestampQuerySupported ? ['timestamp-query'] : [],
      });
      const deviceRequestMs = performance.now() - deviceRequestStartedAt;
      const validation = beginStrictValidation(device);
      const scenarioSetupStartedAt = performance.now();
      const state = await createRealRendererBenchmarkScenario({ device, entityCount, dynamicRatio, viewCount });
      const scenarioSetupMs = performance.now() - scenarioSetupStartedAt;
      const pipelineWarmupStartedAt = performance.now();
      const pipelineWarmupResult = await warmRealRendererBenchmarkPipelines(state);
      const pipelineWarmupMs = performance.now() - pipelineWarmupStartedAt;
      const warmupDurations = [];
      for (let index = 0; index < warmup; index++) {
        const started = performance.now();
        await runRealRendererBenchmarkFrame(state);
        warmupDurations.push(performance.now() - started);
      }
      resetRealRendererBenchmarkMetrics(state);
      const durations = [];
      const sampleWallDurations = [];
      const cpuUpdateDurations = [];
      const cpuRecordDurations = [];
      const dirtyRangeDurations = [];
      const uploadDurations = [];
      const objectTableUploadDurations = [];
      const cpuSubmitDurations = [];
      const queueWaitDurations = [];
      const objectTableFlushCounts = [];
      const denseWholeSpanUploadCounts = [];
      for (let index = 0; index < samples; index++) {
        await runRealRendererBenchmarkFrame(state);
        durations.push(state.lastFrameTiming.runtimeFrameMs);
        sampleWallDurations.push(state.lastFrameTiming.sampleWallMs);
        cpuUpdateDurations.push(state.lastFrameTiming.cpuUpdateMs);
        cpuRecordDurations.push(state.lastFrameTiming.cpuRecordMs);
        dirtyRangeDurations.push(state.lastFrameTiming.objectTableDirtyRangeCpuMs);
        uploadDurations.push(state.lastFrameTiming.gpuUploadCpuMs);
        objectTableUploadDurations.push(state.lastFrameTiming.objectTableUploadCpuMs);
        cpuSubmitDurations.push(state.lastFrameTiming.cpuSubmitMs);
        queueWaitDurations.push(state.lastFrameTiming.queueWaitMs);
        objectTableFlushCounts.push(state.lastFrameTiming.objectTableFlushCount);
        denseWholeSpanUploadCounts.push(state.lastFrameTiming.denseWholeSpanUploadCount);
      }
      const metricsBeforeDestroy = captureRealRendererBenchmarkMetrics(state);
      const allocationEvidence = getRealRendererAllocationEvidence(state);
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
      await finishStrictValidation(device, validation);
      const coldStartRaw = {
        pageToCaseMs: caseStartedAt - fixtureStartedAt,
        sharedAdapterRequestMs: adapterRequestMs,
        caseAdapterRequestMs,
        deviceRequestMs,
        scenarioSetupMs,
        pipelineWarmupMs,
        firstWarmupFrameMs: warmupDurations[0] ?? 0,
      };
      const coldStartTotalMs = caseAdapterRequestMs
        + deviceRequestMs
        + scenarioSetupMs
        + pipelineWarmupMs
        + (warmupDurations[0] ?? 0);
      results.push({
        id: `render3d.real-frame.${entityCount}e.${Math.round(dynamicRatio * 100)}pct.${viewCount}v`,
        entityCount, dynamicRatio, viewCount, warmup, samples,
        coldStart: {
          unit: 'ms',
          rawSamples: [coldStartRaw],
          total: summarizeTimingSamples([coldStartTotalMs]),
        },
        warmup: summarizeTimingSamples(warmupDurations),
        timing: summarizeTimingSamples(durations),
        sampleWall: summarizeTimingSamples(sampleWallDurations),
        cpuUpdate: summarizeTimingSamples(cpuUpdateDurations),
        cpuRecord: summarizeTimingSamples(cpuRecordDurations),
        dirtyRange: summarizeTimingSamples(dirtyRangeDurations),
        upload: summarizeTimingSamples(uploadDurations),
        objectTableUpload: summarizeTimingSamples(objectTableUploadDurations),
        cpuSubmit: summarizeTimingSamples(cpuSubmitDurations),
        queueWait: summarizeTimingSamples(queueWaitDurations),
        timingBoundary: {
          runtime: 'frame-start-through-single-submit-return',
          samplingFence: 'queue.onSubmittedWorkDone',
          queueWaitIncludedInTiming: false,
          gpuTimestampSamplingIsolated: true,
        },
        objectTableFlushes: summarizeCountSamples(objectTableFlushCounts),
        denseWholeSpanUploads: summarizeCountSamples(denseWholeSpanUploadCounts),
        gpuTimestamp: gpuTimestampProbe.supported && gpuDurations.length > 0
          ? {
              status: 'available',
              timing: summarizeTimingSamples(gpuDurations),
              passLabels: gpuPassLabels,
            }
          : {
              status: 'unavailable',
              reason: gpuTimestampProbe.supported
                ? 'GPU timestamp sampling was disabled for this pass'
                : gpuTimestampProbe.reason,
              timing: null,
              passLabels: [],
            },
        metrics: { ...metricsBeforeDestroy, ...state.finalMetrics },
        allocationEvidence,
        pipelineWarmup: {
          ...pipelineWarmupResult,
          elapsedMs: pipelineWarmupMs,
        },
      });
      device.destroy();
    }
  }
  const failures = [];
  for (const result of results) {
    if (result.metrics.ownerResidual !== 0) failures.push(`${result.id}: ownerResidual=${result.metrics.ownerResidual}`);
    if (result.metrics.poolMisses !== 0) failures.push(`${result.id}: poolMisses=${result.metrics.poolMisses}`);
    if (result.metrics.hotObjectsCreated !== 0) failures.push(`${result.id}: hotObjectsCreated=${result.metrics.hotObjectsCreated}`);
    if (result.metrics.setupRenderPipelinesCreated < 6) failures.push(`${result.id}: renderer pipelines were not created`);
    if (result.metrics.setupBindGroupsCreated < 6) failures.push(`${result.id}: bind groups were not created`);
    if (result.metrics.bufferUploadsPerFrame <= 0 || result.metrics.uploadBytesPerFrame <= 0) failures.push(`${result.id}: uploads were not observed`);
    if (result.metrics.metricClassification?.strictEquality?.passed !== true) {
      failures.push(`${result.id}: metric classifications did not exactly match aggregate metrics`);
    }
    assertClassificationSums(result, failures);
    assertRendererRunBreakdown(result, failures);
    const budgets = resolveRealRendererStructuralBudgets(
      result.entityCount,
      result.dynamicRatio,
      result.viewCount,
    );
    if (result.metrics.drawsPerFrame > budgets.totalDraws) {
      failures.push(`${result.id}: draws=${result.metrics.drawsPerFrame} budget=${budgets.totalDraws}`);
    }
    if (result.metrics.bufferUploadsPerFrame > budgets.uploadCalls) {
      failures.push(`${result.id}: uploads=${result.metrics.bufferUploadsPerFrame} budget=${budgets.uploadCalls}`);
    }
    if (result.metrics.uploadBytesPerFrame > budgets.uploadBytes) {
      failures.push(`${result.id}: uploadBytes=${result.metrics.uploadBytesPerFrame} budget=${budgets.uploadBytes}`);
    }
    if (result.metrics.renderPassesPerFrame !== budgets.renderPasses) {
      failures.push(`${result.id}: renderPasses=${result.metrics.renderPassesPerFrame} budget=${budgets.renderPasses}`);
    }
    if (result.metrics.maxDirectionalShadowPassesPerFrame > 1) failures.push(`${result.id}: directional shadow rendered more than once per frame`);
    if (result.metrics.pbrLightUniformUploadsPerFrame > 1) failures.push(`${result.id}: PBR lights uploaded more than once per frame`);
    if (result.metrics.pbrEnvironmentUniformUploadsPerFrame > 1) failures.push(`${result.id}: PBR environment uploaded more than once per frame`);
    if (result.metrics.pbrShadowUniformUploadsPerFrame > 1) failures.push(`${result.id}: PBR shadow uniform uploaded more than once per frame`);
    if (result.timingBoundary?.queueWaitIncludedInTiming !== false) {
      failures.push(`${result.id}: benchmark sampling wait leaked into runtime timing`);
    }
    if (result.dynamicRatio === 0.01 && result.denseWholeSpanUploads.total !== 0) {
      failures.push(`${result.id}: sparse 1% dirty slots incorrectly used the dense whole-span path`);
    }
    if (result.dynamicRatio === 1 && result.denseWholeSpanUploads.perFrame < 5) {
      failures.push(`${result.id}: full-dynamic batch tables did not use the continuous whole-span path`);
    }
  }
  const dynamicRatios = [0, 0.01, 0.1, 1];
  const viewCounts = [1, 4];
  const expectedCaseIds = dynamicRatios.flatMap(dynamicRatio => viewCounts.map(viewCount => (
    `render3d.real-frame.${entityCount}e.${Math.round(dynamicRatio * 100)}pct.${viewCount}v`
  )));
  const actualCaseIds = results.map(result => result.id);
  if (JSON.stringify(actualCaseIds) !== JSON.stringify(expectedCaseIds)) {
    throw new Error(`Real-renderer coverage mismatch: expected ${expectedCaseIds.join(', ')}, received ${actualCaseIds.join(', ')}`);
  }
  const artifact = {
    schemaVersion: 3,
    suite: 'render3d.real-frame',
    passKind,
    generatedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    adapter: adapterInfo,
    configuration: {
      entityCount,
      warmup,
      samples,
      gpuSamples,
      passKind,
      renderProfile: 'batched',
      dynamicRatios,
      viewCounts,
    },
    coverage: {
      entityCounts: [entityCount],
      dynamicRatios,
      dynamicPercentages: dynamicRatios.map(ratio => Math.round(ratio * 100)),
      viewCounts,
      expectedCaseCount: expectedCaseIds.length,
      observedCaseCount: results.length,
      caseIds: actualCaseIds,
    },
    metricSchema: {
      timingChannels: [
        'timing',
        'sampleWall',
        'cpuUpdate',
        'cpuRecord',
        'dirtyRange',
        'upload',
        'objectTableUpload',
        'cpuSubmit',
        'queueWait',
        'gpuTimestamp',
      ],
      timingBoundary: 'runtime timing excludes the benchmark-only queue sampling fence',
      renderPhases: ['mainScene', 'shadow', 'postprocess'],
      uploadDimensions: ['gpuBufferLabel', 'renderer'],
      runBreakDimensions: [
        'material',
        'geometry',
        'pipeline',
        'indexFormat',
        'cullMode',
        'deformationBinding',
        'depthPrepass',
        'objectSlotContiguity',
        'transparentDirectInstancingProhibited',
      ],
      aggregateEquality: 'strict-integer-totals',
    },
    results,
    gate: {
      status: failures.length === 0 ? 'passed' : 'failed',
      failures,
    },
  };
  if (failures.length > 0 && query.get('structuralGate') !== 'off') {
    throw new Error(failures.join('\n'));
  }
  resultNode.textContent = JSON.stringify(artifact);
  resultNode.dataset.status = 'passed';
  progressNode.textContent = 'complete';
} catch (error) {
  resultNode.textContent = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  resultNode.dataset.status = 'failed';
}

function assertClassificationSums(result, failures) {
  const classification = result.metrics.metricClassification;
  if (!classification) {
    failures.push(`${result.id}: metricClassification is missing`);
    return;
  }
  const renderCategories = Object.values(classification.render?.categories ?? {});
  const renderDraws = sum(renderCategories, 'draws');
  const renderPasses = sum(renderCategories, 'passes');
  const labelEntries = classification.uploads?.dimensions?.gpuBufferLabel ?? [];
  const rendererEntries = classification.uploads?.dimensions?.renderer ?? [];
  const labelCalls = sum(labelEntries, 'calls');
  const labelBytes = sum(labelEntries, 'bytes');
  const rendererCalls = sum(rendererEntries, 'calls');
  const rendererBytes = sum(rendererEntries, 'bytes');
  const checks = [
    ['render draws', renderDraws, classification.render?.totals?.draws],
    ['render passes', renderPasses, classification.render?.totals?.passes],
    ['GPUBuffer label upload calls', labelCalls, classification.uploads?.totals?.calls],
    ['GPUBuffer label upload bytes', labelBytes, classification.uploads?.totals?.bytes],
    ['renderer upload calls', rendererCalls, classification.uploads?.totals?.calls],
    ['renderer upload bytes', rendererBytes, classification.uploads?.totals?.bytes],
  ];
  for (const [label, classified, aggregate] of checks) {
    if (classified !== aggregate) {
      failures.push(`${result.id}: ${label} classified=${classified} aggregate=${aggregate}`);
    }
  }
}

function assertRendererRunBreakdown(result, failures) {
  const breakdown = result.metrics.rendererRunBreakdown;
  if (!breakdown) {
    failures.push(`${result.id}: rendererRunBreakdown is missing`);
    return;
  }
  const mainSceneDraws = result.metrics.metricClassification?.render?.categories?.mainScene?.drawsPerFrame;
  const checks = [
    ['sampled views', breakdown.sampledViews, result.viewCount],
    ['opaque renderer draws', sumNamedCounts(breakdown.drawsByRenderer), breakdown.actualDraws],
    ['transparent renderer draws', sumNamedCounts(breakdown.transparentDrawsByRenderer), breakdown.transparentDraws],
    ['main-scene renderer draws', sumNamedCounts(breakdown.mainSceneDrawsByRenderer), breakdown.mainSceneDraws],
    ['main-scene audited draws', breakdown.mainSceneDraws, mainSceneDraws],
  ];
  for (const [label, observed, expected] of checks) {
    if (observed !== expected) {
      failures.push(`${result.id}: ${label} observed=${observed} expected=${expected}`);
    }
  }
  if (breakdown.legalOpaqueDrawLowerBound > breakdown.actualDraws) {
    failures.push(`${result.id}: legal opaque draw lower bound exceeds actual opaque draws`);
  }
  if (breakdown.legalMainSceneDrawLowerBound > breakdown.mainSceneDraws) {
    failures.push(`${result.id}: legal main-scene draw lower bound exceeds actual main-scene draws`);
  }
}

function sumNamedCounts(counts) {
  return Object.values(counts ?? {}).reduce((total, value) => total + value, 0);
}

function sum(values, key) {
  return values.reduce((total, value) => total + (value?.[key] ?? 0), 0);
}

function summarizeCountSamples(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    total,
    perFrame: values.length > 0 ? total / values.length : 0,
    min: values.length > 0 ? Math.min(...values) : 0,
    max: values.length > 0 ? Math.max(...values) : 0,
    rawSamples: values,
  };
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
    vendor: info.vendor ?? '', architecture: info.architecture ?? '',
    device: info.device ?? '', description: info.description ?? '',
  };
}

function beginStrictValidation(device) {
  const uncapturedErrors = [];
  const listener = event => uncapturedErrors.push(event.error?.message ?? String(event.error ?? event));
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
  if (errors.length) throw new Error(`WebGPU validation failed:\n${errors.join('\n')}`);
}
