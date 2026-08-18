import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  runStatisticalBenchmarks,
  summarizeBenchmarkCohorts,
} from './harness.mjs';
import { createBenchmarkCases } from './suite.mjs';
import {
  resolvePlanarReflectionStructuralBudgets,
  resolveRealRendererStructuralBudgets,
} from './real-renderer-budgets.mjs';
import {
  createLightingScalingFixtureConfiguration,
} from './lighting-scaling-fixture.mjs';
import {
  BILLIARDS_3D_SCENE_BYTE_LENGTH,
  BILLIARDS_3D_SCENE_PATH,
  BILLIARDS_3D_SCENE_SHA256,
  parseBilliards3DSceneDocument,
  validateBilliards3DSceneBytes,
} from './billiards-3d-real-renderer-content.mjs';
import {
  createRealRendererAuditDevice,
  createRealRendererBenchmarkScenario,
  destroyRealRendererBenchmarkScenario,
  getRealRendererBenchmarkMetrics,
  resetRealRendererBenchmarkMetrics,
  runRealRendererBenchmarkFrame,
} from './real-renderer-scenario.mjs';

test('lighting scale fixture drives the real renderer and reports the current forward cap', async () => {
  const lightingFixture = createLightingScalingFixtureConfiguration({
    localLightCount: 128,
    overlap: 'high',
    dynamicRatio: 0.25,
    viewCount: 4,
    resolution: '720p',
  });
  const lightingSceneDocument = await parseBilliards3DSceneDocument(
    await readFile(new URL(
      '../../games/pad-simulator/scenes/billiards-3d-import.scene.json',
      import.meta.url,
    )),
  );
  const state = await createRealRendererBenchmarkScenario({
    device: createRealRendererAuditDevice(),
    lightingFixture,
    lightingSceneDocument,
  });
  try {
    await runRealRendererBenchmarkFrame(state);
    resetRealRendererBenchmarkMetrics(state);
    await runRealRendererBenchmarkFrame(state);
    const metrics = getRealRendererBenchmarkMetrics(state);

    assert.equal(state.target.width, 1280);
    assert.equal(state.target.height, 720);
    assert.equal(state.targets.length, 4);
    assert.equal(new Set(state.targets).size, 4);
    assert.equal(state.views.length, 4);
    assert.equal(state.transforms.length, 0);
    assert.equal(
      state.dynamicCount,
      0,
      'real scene motion must not reuse the synthetic transform workload',
    );
    assert.ok(state.views.every(view => view.width === 1280 && view.height === 720));
    assert.equal(metrics.lightingFixtureId, lightingFixture.id);
    assert.equal(metrics.lightingSourceGame, 'billiards-3d');
    assert.equal(metrics.lightingCameraReplayId, 'billiards-3d-lighting-camera-v1');
    assert.equal(metrics.authoredLocalLightCount, 128);
    assert.equal(metrics.authoredAmbientLightCount, 1);
    assert.equal(metrics.authoredDirectionalLightCount, 1);
    assert.equal(metrics.authoredTotalLightCount, 130);
    assert.equal(metrics.lightingDynamicLocalLightCount, 32);
    assert.equal(metrics.lightingDynamicUpdatesPerFrame, 32);
    assert.equal(metrics.submittedLightCount, 8);
    assert.equal(metrics.submittedAmbientLightCount, 1);
    assert.equal(metrics.submittedDirectionalLightCount, 1);
    assert.equal(metrics.submittedLocalLightCount, 6);
    assert.equal(metrics.unsubmittedLocalLightCount, 122);
    assert.equal(metrics.unsubmittedTotalLightCount, 122);
    assert.equal(metrics.rendererTotalLightCapacity, 8);
    assert.equal(metrics.rendererLocalLightCapacity, 6);
    assert.equal(metrics.realContentProvenance.scenePath, BILLIARDS_3D_SCENE_PATH);
    assert.equal(
      metrics.realContentProvenance.sceneByteLength,
      BILLIARDS_3D_SCENE_BYTE_LENGTH,
    );
    assert.equal(
      metrics.realContentProvenance.sceneSha256,
      BILLIARDS_3D_SCENE_SHA256,
    );
    assert.equal(metrics.sourceSceneEntityCount, 43);
    assert.equal(metrics.runtimeWorldEntityCount, 175);
    assert.equal(metrics.realContentProvenance.authoredMeshCount, 35);
    assert.equal(metrics.realContentMeshCount, 24);
    assert.equal(metrics.realContentGeometryCount, 5);
    assert.equal(metrics.realContentMaterialCount, 7);
    assert.equal(metrics.realContentPhysicsBodyCount, 15);
    assert.equal(metrics.sourceSceneSkippedComponentCount, 17);
    assert.equal(metrics.sourceSceneIntentionallySkippedComponentCount, 6);
    assert.equal(metrics.sourceSceneUnsupportedMaterialMeshCount, 11);
    assert.equal(
      metrics.sourceSceneUnsupportedMaterialAffectedEntityCount,
      11,
    );
    assert.deepEqual(
      metrics.realContentProvenance.intentionallySkippedComponentTypes,
      [
        'Camera2D',
        'Camera3D',
        'CanvasTextComponent',
        'KeyboardComponent',
        'ScriptComponent',
      ],
    );
    assert.equal(metrics.physicsSyncProbeEntity, 'CueBall');
    assert.equal(metrics.physicsSyncChanged3DTransform, true);
    assert.equal(
      [...state.world.entities.values()]
        .filter(entity => entity.name.startsWith('real-mesh:')).length,
      0,
    );
    assert.equal(
      metrics.realContentProvenance.unsupportedMaterialDiagnostics.length,
      1,
    );
    const [diagnostic] =
      metrics.realContentProvenance.unsupportedMaterialDiagnostics;
    assert.equal(
      diagnostic.code,
      'BILLIARDS_REAL_RENDERER_UNSUPPORTED_MATERIAL',
    );
    assert.equal(diagnostic.materialType, 'RadialShadowMaterial');
    assert.equal(diagnostic.skippedMeshComponentCount, 11);
    assert.equal(diagnostic.affectedEntityCount, 11);
    assert.equal(diagnostic.affectedEntityNames.length, 11);
    assert.match(
      diagnostic.message,
      /skipped 11 Mesh3D components while retaining their entities/,
    );
    assert.equal(metrics.rendererAbiChanged, false);
  } finally {
    await destroyRealRendererBenchmarkScenario(state);
  }
  assert.equal(state.finalMetrics.ownerResidual, 0);
});

test('billiards scene provenance rejects same-length content with a different hash', async () => {
  const tampered = new Uint8Array(BILLIARDS_3D_SCENE_BYTE_LENGTH);
  await assert.rejects(
    validateBilliards3DSceneBytes(tampered),
    new RegExp(
      `Billiards scene SHA-256 mismatch for ${BILLIARDS_3D_SCENE_PATH}`,
    ),
  );
});

test('render3d.real-frame uses real renderers and leaves no steady-state or owner residuals', async () => {
  const benchmark = createBenchmarkCases('ci')
    .find(candidate => candidate.id === 'render3d.real-frame.256e.100pct.4v');
  assert.ok(benchmark);
  const [result] = await runStatisticalBenchmarks([benchmark], { warmup: 1, samples: 1, iterations: 1 });
  assert.ok(result.metrics.bufferUploadsPerFrame > 0);
  assert.ok(result.metrics.uploadBytesPerFrame > 0);
  assert.ok(result.metrics.setupRenderPipelinesCreated >= 6);
  assert.ok(result.metrics.setupBindGroupsCreated >= 6);
  assert.ok(result.metrics.bufferExpansionsTotal > 0);
  assert.ok(result.metrics.bufferRetirementsTotal > 0);
  const budgets = resolveRealRendererStructuralBudgets(256, 1, 4);
  assert.ok(
    result.metrics.drawsPerFrame <= budgets.totalDraws,
    'portable batching and shadow slot ordering must satisfy the structural draw budget',
  );
  assert.ok(result.metrics.bufferUploadsPerFrame <= 128, 'full transform churn must stay within the upload-call budget');
  assert.equal(result.metrics.renderPassesPerFrame, 9);
  assert.ok(result.metrics.pbrLightUniformUploadsPerFrame <= 1);
  assert.ok(result.metrics.pbrEnvironmentUniformUploadsPerFrame <= 1);
  assert.ok(result.metrics.pbrShadowUniformUploadsPerFrame <= 1);
  const classification = result.metrics.metricClassification;
  assert.equal(classification.schemaVersion, 1);
  assert.equal(classification.strictEquality.passed, true);
  assert.ok(classification.strictEquality.checks.every(check => check.equal));
  assert.equal(classification.render.categories.mainScene.passesPerFrame, 4);
  assert.equal(classification.render.categories.shadow.passesPerFrame, 1);
  assert.ok(classification.render.categories.shadow.drawsPerFrame <= budgets.shadowDraws);
  assert.equal(classification.render.categories.postprocess.passesPerFrame, 4);
  assert.equal(
    sum(Object.values(classification.render.categories), 'draws'),
    classification.render.totals.draws,
  );
  assert.equal(
    sum(Object.values(classification.render.categories), 'passes'),
    classification.render.totals.passes,
  );
  assert.equal(
    sum(classification.uploads.dimensions.gpuBufferLabel, 'calls'),
    classification.uploads.totals.calls,
  );
  assert.equal(
    sum(classification.uploads.dimensions.gpuBufferLabel, 'bytes'),
    classification.uploads.totals.bytes,
  );
  assert.equal(
    sum(classification.uploads.dimensions.renderer, 'calls'),
    classification.uploads.totals.calls,
  );
  assert.equal(
    sum(classification.uploads.dimensions.renderer, 'bytes'),
    classification.uploads.totals.bytes,
  );
  assert.ok(classification.uploads.dimensions.gpuBufferLabel.every(entry => typeof entry.label === 'string'));
  assert.ok(classification.uploads.dimensions.renderer.every(entry => typeof entry.renderer === 'string'));
  const runBreakdown = result.metrics.rendererRunBreakdown;
  assert.equal(runBreakdown.sampledViews, 4);
  assert.equal(runBreakdown.legalOpaqueDrawLowerBound, runBreakdown.actualDraws);
  assert.equal(runBreakdown.legalMainSceneDrawLowerBound, runBreakdown.mainSceneDraws);
  assert.equal(
    runBreakdown.runBreaks.transparentDirectInstancingProhibited,
    runBreakdown.transparentDraws,
  );
  assert.equal(
    sumNamedCounts(runBreakdown.mainSceneDrawsByRenderer),
    classification.render.categories.mainScene.drawsPerFrame,
  );
  assert.equal(result.metrics.poolMisses, 0);
  assert.equal(result.metrics.hotObjectsCreated, 0);
  assert.ok(result.metrics.objectTableDirtyRangeCpuMsPerFrame >= 0);
  assert.ok(result.metrics.objectTableUploadCpuMsPerFrame >= 0);
  assert.ok(result.metrics.objectTableFlushesPerFrame > 0);
  assert.ok(
    result.metrics.denseWholeSpanUploadsPerFrame >= 5,
    '100% dynamic batch tables must use the explicit continuous upload path',
  );
  assert.equal(result.metrics.ownerResidual, 0);
  assert.equal(result.allocationEvidence.kind, 'deterministic-hot-path-counters');
});

test('render3d.real-frame full profile covers 1000 entities, four dynamic ratios, and one/four views', () => {
  const realRendererCases = createBenchmarkCases('full')
    .filter(candidate => candidate.stage === 'real-frame');
  const expectedIds = [0, 1, 10, 100].flatMap(dynamicPercent => [1, 4].map(viewCount => (
    `render3d.real-frame.1000e.${dynamicPercent}pct.${viewCount}v`
  )));
  assert.deepEqual(realRendererCases.map(candidate => candidate.id), expectedIds);
  assert.deepEqual(
    [
      resolveRealRendererStructuralBudgets(1_000, 1, 1).totalDraws,
      resolveRealRendererStructuralBudgets(1_000, 1, 4).totalDraws,
    ],
    [292, 1_165],
    'full-dynamic structural budgets require one camera-independent shadow draw',
  );
  assert.deepEqual(
    [0, 0.01, 0.1, 1].flatMap(dynamicRatio => [1, 4].map(viewCount => {
      const budget = resolveRealRendererStructuralBudgets(
        1_000,
        dynamicRatio,
        viewCount,
      );
      return [budget.uploadCalls, budget.uploadBytes];
    })),
    [
      [1, 272],
      [4, 1_088],
      [12, 4_864],
      [15, 5_680],
      [25, 40_176],
      [28, 40_992],
      [11, 197_088],
      [14, 197_904],
    ],
    'structural upload budgets must retain the reviewed cost-model tradeoff',
  );
  assert.deepEqual(
    [0, 0.01, 0.1, 1].flatMap(dynamicRatio => [1, 4].map(viewCount => {
      const budget = resolveRealRendererStructuralBudgets(
        256,
        dynamicRatio,
        viewCount,
      );
      return [budget.uploadCalls, budget.uploadBytes];
    })),
    [
      [1, 272],
      [4, 1_088],
      [7, 1_088],
      [10, 1_904],
      [12, 6_784],
      [15, 7_600],
      [11, 50_816],
      [14, 51_632],
    ],
    'smoke budgets must retain fixed renderer costs at the enrolled anchor',
  );
  assert.deepEqual(
    [0.01, 0.1, 1].map(dynamicRatio => (
      resolveRealRendererStructuralBudgets(256, dynamicRatio, 1)
        .uploadBytesBreakdown.deformationFlags
    )),
    [4 * 16, 33 * 16, 257 * 16],
    'the 16-byte Mesh3D/shadow deformation ABI must remain explicit in the budget source',
  );
  assert.deepEqual(
    [0.01, 0.1, 1].map(dynamicRatio => (
      resolveRealRendererStructuralBudgets(1_000, dynamicRatio, 1)
        .uploadBytesBreakdown.deformationFlags
    )),
    [11 * 16, 162 * 16, 1_000 * 16],
    'the long-fixture ABI uplift must use label-classified uploaded slot counts',
  );
});

test('frame-data churn absolute budget scales with both cycles and hierarchy size', () => {
  const ciCase = createBenchmarkCases('ci')
    .find(candidate => candidate.id === 'churn.frame-data-transform.2000x64');
  const fullCase = createBenchmarkCases('full')
    .find(candidate => candidate.id === 'churn.frame-data-transform.8000x256');

  assert.equal(ciCase?.budgetP95Ms, 400);
  assert.equal(fullCase?.budgetP95Ms, 6_400);
});

test('render3d.planar-reflection exposes the smoke and complete parameter matrices', async () => {
  const ciCases = createBenchmarkCases('ci').filter(candidate => candidate.stage === 'planar-reflection');
  const fullCases = createBenchmarkCases('full').filter(candidate => candidate.stage === 'planar-reflection');
  assert.equal(ciCases.length, 4);
  assert.equal(fullCases.length, 2 * 2 * 3 * 4);
  for (const token of ['.1m.', '.2m.', '.4m.', '.1b.', '.3b.', '.5b.', '.8b.', '.1v', '.4v', '.1000e.', '.10000e.']) {
    assert.ok(fullCases.some(candidate => candidate.id.includes(token)), `missing ${token}`);
  }

  const benchmark = ciCases.find(candidate => candidate.id === 'render3d.planar-reflection.1000e.2m.3b.4v');
  assert.ok(benchmark);
  const [result] = await runStatisticalBenchmarks([benchmark], { warmup: 1, samples: 1, iterations: 1 });
  const budgets = resolvePlanarReflectionStructuralBudgets(1_000, 2, 3, 4);
  assert.ok(result.metrics.mirrorPlannedViews >= 8);
  assert.ok(result.metrics.mirrorExecutedViews > 0);
  assert.ok(result.metrics.mirrorRttPixels > 0);
  assert.ok(result.metrics.renderGraphPasses > 0);
  assert.ok(result.metrics.mirrorLogicalTargets > 0);
  assert.ok(result.metrics.mirrorPhysicalTargets > 0);
  assert.ok(result.metrics.mirrorTargetLogicalBytes >= result.metrics.mirrorTargetResidentBytes);
  assert.equal(result.metrics.mirrorResourceScopeCount, result.metrics.mirrorLogicalTargets);
  assert.ok(result.metrics.maxDirectionalShadowPassesPerFrame <= 1);
  assert.ok(result.metrics.pbrLightUniformUploadsPerFrame <= 1);
  assert.ok(result.metrics.pbrEnvironmentUniformUploadsPerFrame <= 1);
  assert.ok(result.metrics.pbrShadowUniformUploadsPerFrame <= 1);
  assert.ok(result.metrics.setupRenderPipelinesCreated >= 7);
  assert.equal(result.metrics.mirrorExecutedViews, budgets.reflectionViews);
  assert.ok(result.metrics.drawsPerFrame <= budgets.totalDraws);
  assert.equal(result.metrics.renderPassesPerFrame, budgets.renderPasses);
  assert.ok(result.metrics.bufferUploadsPerFrame <= budgets.uploadCalls);
  assert.ok(result.metrics.uploadBytesPerFrame <= budgets.uploadBytes);
  assert.equal(result.metrics.ownerResidual, 0);
});

test('render3d full-prepare phase diagnostics preserve the 10K four-view contract', async () => {
  const previousPhaseTiming = process.env.BENCHMARK_RENDER3D_PHASES;
  process.env.BENCHMARK_RENDER3D_PHASES = '1';
  try {
    const benchmark = createBenchmarkCases('ci')
      .find(candidate => candidate.id === 'render3d.full-prepare.10000e.4v');
    assert.ok(benchmark);
    const [result] = await runStatisticalBenchmarks(
      [benchmark],
      { warmup: 1, samples: 1, iterations: 1 },
    );

    assert.equal(result.metrics.sceneExtractionsPerFrame, 1);
    assert.equal(result.metrics.viewCollectionsPerFrame, 4);
    assert.equal(result.metrics.uniformUploadsPerFrame, 4);
    assert.equal(result.metrics.rendererBeginViewsPerFrame, 4);
    assert.equal(result.metrics.rendererPrepareCallsPerFrame, 8);
    assert.equal(result.metrics.rendererPreparedObjectsPerFrame, 40_000);
    assert.equal(result.metrics.rendererFlushesPerFrame, 4);
    assert.equal(result.metrics.rendererEndViewsPerFrame, 4);
    assert.equal(result.metrics.visibleItemsPerFrame, 40_000);
    assert.equal(result.metrics.drawCallsPerFrame, 40_000);
    assert.equal(result.metrics.lightCount, 8);
    assert.deepEqual(
      Object.keys(result.metrics.phaseTimingsMsPerFrame),
      [
        'sceneExtraction',
        'viewCollectionCulling',
        'opaqueTransparentSort',
        'rendererResolutionPrepare',
        'submissionLoop',
      ],
    );
    for (const timing of Object.values(result.metrics.phaseTimingsMsPerFrame)) {
      assert.ok(Number.isFinite(timing));
      assert.ok(timing >= 0);
    }
  } finally {
    if (previousPhaseTiming === undefined) delete process.env.BENCHMARK_RENDER3D_PHASES;
    else process.env.BENCHMARK_RENDER3D_PHASES = previousPhaseTiming;
  }
});

test('isolated benchmark cohort summary uses medians without hiding a slow cohort', () => {
  const relativeStddevs = [0.03, 0.04, 0.16, 0.05, 0.04];
  const cohorts = [11, 14, 12, 15, 13].map((p50, index) => ({
    node: 'v22.23.1',
    warmup: 8,
    samples: 30,
    iterations: 1,
    p50,
    p95: p50 + 1,
    relativeStddev: relativeStddevs[index],
    allocationBytesP50: (index + 1) * 100,
    metrics: {
      phaseTimingsMsPerFrame: {
        sceneExtraction: index + 1,
      },
    },
  }));

  const summary = summarizeBenchmarkCohorts(
    'render3d.full-prepare.10000e.4v',
    cohorts,
  );

  assert.equal(summary.cohortCount, 5);
  assert.equal(summary.node, 'v22.23.1');
  assert.equal(summary.warmup, 8);
  assert.equal(summary.samples, 30);
  assert.equal(summary.p50Median, 13);
  assert.equal(summary.p95Median, 14);
  assert.equal(summary.allocationBytesP50Median, 300);
  assert.equal(summary.phaseTimingsMsPerFrame.sceneExtraction, 3);
  assert.equal(summary.stability.status, 'stable-majority');
  assert.deepEqual(summary.stability.noisyRounds, [3]);
  assert.deepEqual(
    summary.cohorts.map(cohort => cohort.p50),
    [11, 14, 12, 15, 13],
    'raw cohorts remain available so per-run acceptance limits can be enforced',
  );
});

test('planar-reflection structural budgets cap recursive work before exponential growth', () => {
  assert.deepEqual(
    [
      resolvePlanarReflectionStructuralBudgets(1_000, 1, 1, 1).reflectionViews,
      resolvePlanarReflectionStructuralBudgets(1_000, 2, 3, 4).reflectionViews,
      resolvePlanarReflectionStructuralBudgets(10_000, 4, 5, 1).reflectionViews,
      resolvePlanarReflectionStructuralBudgets(10_000, 4, 8, 4).reflectionViews,
    ],
    [1, 16, 16, 16],
  );
  assert.deepEqual(
    [
      resolvePlanarReflectionStructuralBudgets(1_000, 1, 1, 1).renderPasses,
      resolvePlanarReflectionStructuralBudgets(1_000, 2, 3, 4).renderPasses,
      resolvePlanarReflectionStructuralBudgets(10_000, 4, 5, 1).renderPasses,
      resolvePlanarReflectionStructuralBudgets(10_000, 4, 8, 4).renderPasses,
    ],
    [4, 25, 19, 25],
  );
  assert.equal(
    resolvePlanarReflectionStructuralBudgets(10_000, 4, 8, 4).uploadBytes,
    200_080,
    'the full planar upload envelope must retain the post-deformation-ABI label total',
  );
});

function sum(values, key) {
  return values.reduce((total, value) => total + (value?.[key] ?? 0), 0);
}

function sumNamedCounts(counts) {
  return Object.values(counts ?? {}).reduce((total, value) => total + value, 0);
}
