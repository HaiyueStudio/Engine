import {
  createAuditTarget,
  createRealRendererBenchmarkScenario,
  destroyRealRendererBenchmarkScenario,
  getRealRendererBenchmarkMetrics,
  resetRealRendererBenchmarkMetrics,
  runRealRendererBenchmarkFrame,
  warmRealRendererBenchmarkPipelines,
} from '../benchmark/real-renderer-scenario.mjs';
import { resolvePlanarReflectionStructuralBudgets } from '../benchmark/real-renderer-budgets.mjs';

const resultNode = document.querySelector('#result');
const progressNode = document.querySelector('#progress');
const query = new URLSearchParams(location.search);
const mode = query.get('mode') === 'full' ? 'full' : 'smoke';
const warmup = positiveInteger(query.get('warmup'), mode === 'full' ? 3 : 2);
const samples = positiveInteger(query.get('samples'), 40);
const budgetCaseIds = new Set([
  'render3d.planar-reflection.1000e.1m.1b.1v',
  'render3d.planar-reflection.1000e.2m.3b.4v',
  'render3d.planar-reflection.10000e.4m.5b.1v',
  'render3d.planar-reflection.10000e.4m.8b.4v',
]);

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const adapterInfo = plainAdapterInfo(adapter.info ?? {});
  const benchmarkResults = [];
  const configurations = createConfigurations(mode);
  for (let index = 0; index < configurations.length; index++) {
    const configuration = configurations[index];
    progressNode.textContent = `benchmark ${index + 1}/${configurations.length}: ${caseId(configuration)}`;
    benchmarkResults.push(await runBenchmarkCase(configuration));
  }
  assertBenchmarkSemantics(benchmarkResults);

  const pixelCases = {};
  const visualCases = createVisualCases();
  for (let index = 0; index < visualCases.length; index++) {
    const visualCase = visualCases[index];
    progressNode.textContent = `pixels ${index + 1}/${visualCases.length}: ${visualCase.id}`;
    pixelCases[visualCase.id] = await runPixelCase(visualCase);
  }
  assertPixelSemantics(pixelCases);

  resultNode.textContent = JSON.stringify({
    schemaVersion: 2,
    suite: 'render3d.planar-reflection',
    mode,
    generatedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    adapter: adapterInfo,
    configuration: {
      entityCounts: mode === 'full' ? [1_000, 10_000] : [1_000, 10_000],
      mirrorCounts: [1, 2, 4],
      bounceCounts: [1, 3, 5, 8],
      viewCounts: [1, 4],
      executedCases: configurations.length,
      fullMatrixCases: 48,
      warmup,
      budgetSamples: samples,
      nonBudgetMatrixSamples: 1,
    },
    benchmarkResults,
    pixelCases,
    gate: { status: 'passed', strictValidation: true, asyncPipelines: true, wgslCompilationErrorsFatal: true },
  });
  resultNode.dataset.status = 'passed';
  progressNode.textContent = 'complete';
} catch (error) {
  resultNode.textContent = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  resultNode.dataset.status = 'failed';
}

function createConfigurations(profile) {
  if (profile !== 'full') {
    return [
      { entityCount: 1_000, mirrorCount: 1, maxBounces: 1, viewCount: 1 },
      { entityCount: 1_000, mirrorCount: 2, maxBounces: 3, viewCount: 4 },
      { entityCount: 10_000, mirrorCount: 4, maxBounces: 5, viewCount: 1 },
      { entityCount: 10_000, mirrorCount: 4, maxBounces: 8, viewCount: 4 },
    ];
  }
  return [1_000, 10_000].flatMap(entityCount => [1, 4].flatMap(viewCount => (
    [1, 2, 4].flatMap(mirrorCount => [1, 3, 5, 8].map(maxBounces => (
      { entityCount, mirrorCount, maxBounces, viewCount }
    )))
  )));
}

async function runBenchmarkCase(configuration) {
  const id = caseId(configuration);
  const budgetCase = budgetCaseIds.has(id);
  const caseWarmup = budgetCase ? warmup : 1;
  const caseSamples = budgetCase ? samples : 1;
  return withStrictDevice(`benchmark:${caseId(configuration)}`, async device => {
    const state = await createRealRendererBenchmarkScenario({
      device,
      ...configuration,
      dynamicRatio: 0.1,
      mirrorWidth: 32,
      mirrorHeight: 32,
      mirrorVisibilityCulling: false,
    });
    try {
      const pipelineWarmup = await warmRealRendererBenchmarkPipelines(state);
      for (let index = 0; index < caseWarmup; index++) await runRealRendererBenchmarkFrame(state);
      resetRealRendererBenchmarkMetrics(state);
      const durations = [];
      for (let index = 0; index < caseSamples; index++) {
        const startedAt = performance.now();
        await runRealRendererBenchmarkFrame(state);
        durations.push(performance.now() - startedAt);
      }
      const timing = summarize(durations);
      const metrics = getRealRendererBenchmarkMetrics(state);
      return {
        id,
        ...configuration,
        performanceBudgetCase: budgetCase,
        warmup: caseWarmup,
        samples: caseSamples,
        timing,
        frameMs: timing.p95,
        pipelineWarmup,
        metrics,
      };
    } finally {
      await destroyRealRendererBenchmarkScenario(state);
    }
  });
}

function createVisualCases() {
  return [
    {
      id: 'front-visible', maxBounces: 1, mirrorVisibilityCulling: true,
      mirrors: [{ position: [0, 0, -2], localNormal: [0, 0, 1], maxBounces: 1 }],
    },
    {
      id: 'recursive-deepest-first', maxBounces: 5, mirrorVisibilityCulling: false,
      mirrors: [
        { position: [-2.2, 0, -2], localNormal: [0, 0, 1], maxBounces: 5 },
        { position: [2.2, 0, 2], localNormal: [0, 0, -1], maxBounces: 5 },
      ],
    },
    {
      id: 'frustum-culled', maxBounces: 1, mirrorVisibilityCulling: true,
      mirrors: [{ position: [40, 0, -2], localNormal: [0, 0, 1], maxBounces: 1 }],
    },
    {
      id: 'back-facing', maxBounces: 1, mirrorVisibilityCulling: true,
      mirrors: [{ position: [0, 0, -2], localNormal: [0, 0, -1], maxBounces: 1 }],
    },
  ];
}

async function runPixelCase(visualCase) {
  return withStrictDevice(`pixels:${visualCase.id}`, async device => {
    const width = 320;
    const height = 192;
    const target = createAuditTarget(device, width, height, true);
    const state = await createRealRendererBenchmarkScenario({
      device,
      target,
      entityCount: 256,
      dynamicRatio: 0,
      viewCount: 1,
      maxBounces: visualCase.maxBounces,
      mirrorConfigurations: visualCase.mirrors,
      mirrorWidth: 128,
      mirrorHeight: 96,
      mirrorVisibilityCulling: visualCase.mirrorVisibilityCulling,
      planarMirrorPlanner: { maxViews: 32, maxRttPixels: 128 * 96 * 32 },
    });
    try {
      const pipelineWarmup = await warmRealRendererBenchmarkPipelines(state);
      resetRealRendererBenchmarkMetrics(state);
      await runRealRendererBenchmarkFrame(state);
      await runRealRendererBenchmarkFrame(state);
      const pixels = await readTargetPixels(device, target.colorTexture, width, height);
      const stats = state.render3d.lastMirrorPlanStats;
      const graph = state.render3d.lastRenderGraphStats;
      const resources = state.render3d.lastMirrorGpuResourceStats;
      return {
        ...pixels,
        pipelineWarmupStatus: pipelineWarmup.status,
        mirrorStats: {
          planned: stats.plannedViewCount,
          executed: stats.executedViewCount,
          dropped: stats.droppedViewCount,
          rttPixels: stats.rttPixels,
          maxDepth: stats.maxDepth,
          dropReasons: { ...stats.dropReasons },
        },
        renderGraphStats: {
          passes: graph.executedPassCount,
          dependencies: graph.dependencyCount,
          reflectionPasses: graph.reflectionLocalPassCount,
        },
        mirrorResourceStats: {
          logicalTargets: resources.logicalTargetCount,
          physicalTargets: resources.transientPhysicalTargetCount + resources.persistentTargetCount,
          logicalBytes: resources.estimatedLogicalBytes,
          residentBytes: resources.estimatedResidentBytes,
          aliasSavedBytes: resources.aliasSavedBytes,
          scopeCount: resources.scopes.length,
        },
      };
    } finally {
      await destroyRealRendererBenchmarkScenario(state);
      target.destroy();
    }
  });
}

async function readTargetPixels(device, texture, width, height) {
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256;
  const buffer = device.createBuffer({
    label: 'planar-reflection.pixel-readback',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: 'planar-reflection.pixel-readback' });
  encoder.copyTextureToBuffer(
    { texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buffer.getMappedRange());
  let hash = 0x811c9dc5;
  let nonBlackPixels = 0;
  let luminanceSum = 0;
  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const offset = row + x * 4;
      const b = mapped[offset] ?? 0;
      const g = mapped[offset + 1] ?? 0;
      const r = mapped[offset + 2] ?? 0;
      const a = mapped[offset + 3] ?? 0;
      if (r + g + b > 15) nonBlackPixels++;
      luminanceSum += r * 3 + g * 6 + b;
      hash ^= b; hash = Math.imul(hash, 0x01000193);
      hash ^= g; hash = Math.imul(hash, 0x01000193);
      hash ^= r; hash = Math.imul(hash, 0x01000193);
      hash ^= a; hash = Math.imul(hash, 0x01000193);
    }
  }
  const samples = {
    center: samplePixel(mapped, bytesPerRow, width >> 1, height >> 1),
    leftMirror: samplePixel(mapped, bytesPerRow, width >> 2, height >> 1),
    rightMirror: samplePixel(mapped, bytesPerRow, width * 3 >> 2, height >> 1),
    corner: samplePixel(mapped, bytesPerRow, 4, 4),
  };
  buffer.unmap();
  buffer.destroy();
  return {
    width, height,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    nonBlackPixels,
    averageLuminance: Math.round(luminanceSum / (width * height * 10)),
    samples,
  };
}

function samplePixel(pixels, bytesPerRow, x, y) {
  const offset = y * bytesPerRow + x * 4;
  return [pixels[offset + 2] ?? 0, pixels[offset + 1] ?? 0, pixels[offset] ?? 0, pixels[offset + 3] ?? 0];
}

function assertPixelSemantics(pixelCases) {
  const front = pixelCases['front-visible'];
  const recursive = pixelCases['recursive-deepest-first'];
  const frustum = pixelCases['frustum-culled'];
  const back = pixelCases['back-facing'];
  if (front.nonBlackPixels < 512 || front.averageLuminance < 2) throw new Error('Visible mirror frame is black or nearly empty.');
  if (front.mirrorStats.executed !== 1) throw new Error(`Front mirror did not execute exactly once: ${front.mirrorStats.executed}`);
  if (recursive.mirrorStats.executed <= front.mirrorStats.executed || recursive.mirrorStats.maxDepth < 2) {
    throw new Error('Recursive mirror views were not executed deepest-first beyond the root.');
  }
  if ((frustum.mirrorStats.dropReasons['outside-frustum'] ?? 0) < 1 || frustum.mirrorStats.executed !== 0) {
    throw new Error('Off-frustum mirror was not culled.');
  }
  if ((back.mirrorStats.dropReasons['back-facing'] ?? 0) < 1 || back.mirrorStats.executed !== 0) {
    throw new Error('Back-facing mirror was not culled.');
  }
}

function assertBenchmarkSemantics(results) {
  for (const result of results) {
    const budgets = resolvePlanarReflectionStructuralBudgets(
      result.entityCount,
      result.mirrorCount,
      result.maxBounces,
      result.viewCount,
    );
    if (result.pipelineWarmup.status !== 'completed') throw new Error(`${result.id}: pipeline warmup did not complete.`);
    if (result.metrics.setupRenderPipelinesCreated < 7) throw new Error(`${result.id}: renderer pipelines were not created asynchronously.`);
    if (result.metrics.mirrorPlannedViews < result.mirrorCount * result.viewCount) throw new Error(`${result.id}: root mirror views were not planned.`);
    if (result.metrics.mirrorExecutedViews < 1 || result.metrics.mirrorRttPixels < 1) throw new Error(`${result.id}: reflection RTT work was not executed.`);
    if (result.metrics.mirrorExecutedViews > budgets.reflectionViews) throw new Error(`${result.id}: reflection views=${result.metrics.mirrorExecutedViews} budget=${budgets.reflectionViews}.`);
    if (result.metrics.drawsPerFrame > budgets.totalDraws) throw new Error(`${result.id}: draws=${result.metrics.drawsPerFrame} budget=${budgets.totalDraws}.`);
    if (result.metrics.renderPassesPerFrame !== budgets.renderPasses) throw new Error(`${result.id}: passes=${result.metrics.renderPassesPerFrame} budget=${budgets.renderPasses}.`);
    if (result.metrics.bufferUploadsPerFrame > budgets.uploadCalls) throw new Error(`${result.id}: uploads=${result.metrics.bufferUploadsPerFrame} budget=${budgets.uploadCalls}.`);
    if (result.metrics.uploadBytesPerFrame > budgets.uploadBytes) throw new Error(`${result.id}: upload bytes=${result.metrics.uploadBytesPerFrame} budget=${budgets.uploadBytes}.`);
    if (result.metrics.maxDirectionalShadowPassesPerFrame > 1) throw new Error(`${result.id}: directional shadow rendered more than once.`);
    if (result.metrics.pbrLightUniformUploadsPerFrame > 1) throw new Error(`${result.id}: PBR lights uploaded more than once.`);
    if (result.metrics.pbrEnvironmentUniformUploadsPerFrame > 1) throw new Error(`${result.id}: PBR environment uploaded more than once.`);
    if (result.metrics.pbrShadowUniformUploadsPerFrame > 1) throw new Error(`${result.id}: PBR shadow uniform uploaded more than once.`);
    if (result.metrics.ownerResidual !== 0) throw new Error(`${result.id}: GPU owner residual=${result.metrics.ownerResidual}.`);
  }
}

async function withStrictDevice(label, run) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error(`No WebGPU adapter for ${label}`);
  const device = await adapter.requestDevice({ label: `planar-reflection:${label}` });
  const uncapturedErrors = [];
  let lost = null;
  const onUncapturedError = event => uncapturedErrors.push(event.error?.message ?? String(event.error ?? event));
  device.addEventListener('uncapturederror', onUncapturedError);
  void device.lost.then(info => { lost = info; });
  device.pushErrorScope('validation');
  let value;
  let runError = null;
  try {
    value = await run(device);
  } catch (error) {
    runError = error;
  }
  await device.queue.onSubmittedWorkDone().catch(error => { runError ??= error; });
  const scopedError = await device.popErrorScope().catch(error => error);
  device.removeEventListener('uncapturederror', onUncapturedError);
  const failures = [...uncapturedErrors];
  if (scopedError) failures.push(scopedError.message ?? String(scopedError));
  if (lost) failures.push(`device lost: ${lost.message || lost.reason}`);
  device.destroy();
  if (runError || failures.length) {
    const messages = [runError instanceof Error ? runError.stack ?? runError.message : String(runError ?? ''), ...failures].filter(Boolean);
    throw new Error(`${label} failed strict WebGPU validation:\n${messages.join('\n')}`);
  }
  return value;
}

function caseId(configuration) {
  return `render3d.planar-reflection.${configuration.entityCount}e.${configuration.mirrorCount}m.${configuration.maxBounces}b.${configuration.viewCount}v`;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    unit: 'ms/frame',
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function plainAdapterInfo(info) {
  return {
    vendor: info.vendor ?? '', architecture: info.architecture ?? '',
    device: info.device ?? '', description: info.description ?? '',
  };
}
