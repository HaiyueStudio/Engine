import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createLive2DDrawableFidelityCandidate,
  createLive2DDrawableFidelityDashboard,
  Live2DDrawableFidelityCorpusPolicyError,
} from './live2d-drawable-fidelity-corpus-policy.mjs';

const manifest = JSON.parse(readFileSync(new URL('../animation-spec/corpus/deformable2d/drawable-color-culling-corpus-manifest.json', import.meta.url), 'utf8'));
const provenance = { manifestSha256: 'a'.repeat(64), sourceManifestSha256: manifest.sourceManifest.sha256 };

test('G16 policy accepts independent real multiply, screen, and non-degenerate mirrored culling observations', () => {
  const candidate = createLive2DDrawableFidelityCandidate(manifest, fixtureReport(), provenance);
  assert.equal(candidate.dirty, false);
  assert.deepEqual(candidate.totals, {
    nonNeutralMultiplyDrawableFrameCount: 54,
    nonNeutralScreenDrawableFrameCount: 38,
    cullingDrawableCount: 9,
    nondegenerateCullingDrawableFrameCount: 9,
    mirroredCullingDrawableFrameCount: 9,
  });
  assert.deepEqual(candidate.features.map(feature => [feature.id, feature.status, feature.observationCount]), [
    ['multiply-color', 'passed', 54],
    ['screen-color', 'passed', 38],
    ['drawable-culling', 'passed', 9],
  ]);
  const dashboard = createLive2DDrawableFidelityDashboard(candidate);
  assert.deepEqual([...new Set(dashboard.features.map(feature => feature.implementationStatus))].sort(), ['degraded', 'supported', 'unsupported']);
  assert.deepEqual([...new Set(dashboard.features.map(feature => feature.coverageStatus))].sort(), ['covered', 'not-applicable', 'not-covered']);
  for (const id of ['multiply-color', 'screen-color', 'drawable-culling']) {
    const row = dashboard.features.find(feature => feature.id === id);
    assert.deepEqual([row.implementationStatus, row.coverageStatus], ['supported', 'covered']);
  }
});

test('G16 policy rejects dirty, missing-color, duplicate observations, invalid metrics, degenerate-culling, population, source, and closure drift', () => {
  const mutations = [
    report => { report.dirty = true; },
    report => { report.samples[0].featureObservations.multiplyColor = []; },
    report => { report.samples[0].featureObservations.multiplyColor[1] = structuredClone(report.samples[0].featureObservations.multiplyColor[0]); },
    report => { report.samples[0].surfaceReadback.meanAbsoluteError = Number.NaN; },
    report => { report.samples[1].featureObservations.culling.forEach(observation => { observation.sourceWinding = { ccw: 0, cw: 0, degenerate: observation.triangleCount }; observation.mirroredXWinding = { ccw: 0, cw: 0, degenerate: observation.triangleCount }; observation.mirrorFlipsWinding = false; }); },
    report => { report.samples.push(structuredClone(report.samples[1])); report.sampleCount++; },
    report => { report.samples[0].runtimeDirectoryHash = `sha256-${'0'.repeat(64)}`; },
    report => { report.samples[0].requestedProjectFiles.push('source/Mao.moc3'); },
  ];
  for (const mutate of mutations) {
    const report = fixtureReport();
    mutate(report);
    assert.throws(() => createLive2DDrawableFidelityCandidate(manifest, report, provenance), Live2DDrawableFidelityCorpusPolicyError);
  }
});

test('G16 policy rejects source-manifest provenance drift', () => {
  assert.throws(() => createLive2DDrawableFidelityCandidate(manifest, fixtureReport(), { ...provenance, sourceManifestSha256: 'b'.repeat(64) }), /sourceManifestSha256/u);
});

function fixtureReport() {
  const samples = manifest.samples.map(sample => sample.id === 'niziiro-mao' ? maoSample(sample) : riceSample(sample));
  return {
    schemaVersion: 1,
    kind: 'haiyue-live2d-local-corpus-candidate',
    revision: 'c'.repeat(40),
    dirty: false,
    formalEvidence: false,
    core: { sourcePolicy: 'official-cdn', url: manifest.oracle.cubismCoreUrl, byteLength: manifest.oracle.cubismCoreByteLength, sha256: manifest.oracle.cubismCoreSha256, transport: 'network' },
    adapter: { package: manifest.oracle.adapterPackage, aggregateSha256: 'd'.repeat(64), files: [] },
    sampleCount: samples.length,
    samples,
    totals: {
      nonNeutralMultiplyDrawableFrameCount: 54,
      nonNeutralScreenDrawableFrameCount: 38,
      cullingDrawableCount: 9,
      nondegenerateCullingDrawableFrameCount: 9,
      mirroredCullingDrawableFrameCount: 9,
    },
  };
}

function maoSample(sample) {
  const multiplyColor = Array.from({ length: 54 }, (_, index) => colorObservation(index === 0 ? 'ArtMesh82' : `Multiply${index}`, index, 'multiplyColor', index === 0 ? [0.980392, 1, 0.427451, 1] : [0.5, 0.75, 1, 1], 1));
  const screenColor = Array.from({ length: 38 }, (_, index) => colorObservation(index === 0 ? 'ArtMesh194' : `Screen${index}`, index, 'screenColor', index === 0 ? [1, 0.454902, 0.513726, 1] : [0.25, 0.5, 0.75, 1], 1));
  return baseSample(sample, {
    featureCoverage: { cullingDrawableCount: 0, multiplyColorDrawableCount: 54, screenColorDrawableCount: 38 },
    featureObservations: { multiplyColor, screenColor, culling: [] },
  });
}

function riceSample(sample) {
  const culling = Array.from({ length: 9 }, (_, index) => ({
    drawableId: index === 0 ? 'ArtMesh161' : `Cull${index}`,
    drawableIndex: 138 + index,
    path: `$.frames[1].drawables[${138 + index}].culling`,
    time: 0.75,
    triangleCount: 23,
    sourceWinding: { ccw: 23, cw: 0, degenerate: 0 },
    mirroredXWinding: { ccw: 0, cw: 23, degenerate: 0 },
    mirrorFlipsWinding: true,
  }));
  return baseSample(sample, {
    featureCoverage: { cullingDrawableCount: 9, multiplyColorDrawableCount: 0, screenColorDrawableCount: 0 },
    featureObservations: { multiplyColor: [], screenColor: [], culling },
  });
}

function baseSample(sample, additions) {
  return {
    id: sample.id,
    sourcePolicy: sample.sourcePolicy,
    runtimeDirectoryHash: sample.source.runtimeDirectoryHash,
    fileCount: sample.source.fileCount,
    sourceBytes: sample.source.sourceBytes,
    sourceEntry: sample.source.entry,
    sourceFiles: sample.requiredFiles.map(file => ({ ...file })),
    coreVersion: manifest.oracle.cubismCoreVersion,
    evidenceRecipe: { profile: 'clip-baked-reference-times', ...sample.recipe },
    conversionDiagnostics: [],
    observedBlendModes: ['normal'],
    drawables: sample.id === 'niziiro-mao' ? 262 : 178,
    bakedFrameCount: sample.recipe.bakedFrameTimes.length,
    maskTargets: 1,
    sampledAt: sample.recipe.referenceTimes[0],
    recoverySmoke: true,
    comparisonConfiguration: {
      viewportMode: manifest.referenceConfiguration.viewportMode,
      fitPolicy: manifest.referenceConfiguration.fitPolicy,
      fitFill: manifest.referenceConfiguration.fitFill,
      userZoom: manifest.referenceConfiguration.userZoom,
      pan: [...manifest.referenceConfiguration.pan],
      resolvedZoom: 1,
      synchronizedViews: true,
      canvas: [...manifest.referenceConfiguration.canvas],
      targetFormat: manifest.referenceConfiguration.targetFormat,
      textureColorSpaceConversion: manifest.referenceConfiguration.textureColorSpaceConversion,
      alphaMode: manifest.referenceConfiguration.textureAlphaMode,
      antialias: false,
    },
    surfaceReadback: { width: 719, height: 694, maxChannelError: 100, meanAbsoluteError: 0.2, mismatchPixelCount: 100, mismatchRatio: 0.01 },
    browser: { product: 'Chrome', userAgent: 'Chrome', platform: 'Win32', angleBackend: 'd3d11', nativeBackend: true, gpuAdapter: { vendor: 'nvidia', architecture: 'pascal', device: '', description: '' } },
    browserDiagnostics: { unclassifiedFailureCount: 0 },
    requestedProjectFiles: ['examples/live2d-hya-compare/bundle.js', 'examples/shared/engine.js'],
    ...additions,
  };
}

function colorObservation(drawableIndex, index, field, rgba, time) {
  return { drawableId: drawableIndex, drawableIndex: index, path: `$.frames[1].drawables[${index}].${field}`, time, rgba };
}
