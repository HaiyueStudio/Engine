import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createG07DeformableCorpusHandoff, createLive2DDashboardStatus, createLive2DFeatureCorpusCandidate, validateLive2DFeatureCorpusManifest } from './live2d-feature-corpus-policy.mjs';

test('G12 policy accepts an exact licensed population and generates dual-dimension dashboard states', () => {
  const manifest = fixtureManifest();
  const candidate = createLive2DFeatureCorpusCandidate(manifest, fixtureReport(manifest), { manifestSha256: 'a'.repeat(64) });
  assert.equal(candidate.status, 'passed');
  assert.deepEqual(candidate.totals, { maskReferenceCount: 3, invertedMaskDrawableCount: 1, additiveDrawableCount: 2, multiplicativeDrawableCount: 1 });
  assert.equal(candidate.samples.every(sample => sample.fileInventoryVerified), true);
  assert.deepEqual(candidate.featureEvidence.map(evidence => evidence.id), ['mask-composition', 'inverted-mask', 'additive-blend', 'multiplicative-blend']);
  assert.equal(candidate.featureEvidence.every(evidence => evidence.gpuValidation.deviceRecovery), true);
  const g07 = createG07DeformableCorpusHandoff(candidate);
  assert.deepEqual(g07.sampleIds, ['rice', 'mao']);
  assert.deepEqual(g07.featureDefinitions, candidate.features);
  const dashboard = createLive2DDashboardStatus(candidate);
  assert.deepEqual(new Set(dashboard.features.map(feature => feature.implementationStatus)), new Set(['supported', 'degraded', 'unsupported']));
  assert.deepEqual(new Set(dashboard.features.map(feature => feature.coverageStatus)), new Set(['covered', 'not-covered', 'not-applicable']));
  assert.match(dashboard.missingLocalAssetMessage, /许可/u);
});

test('G12 policy rejects population changes, missing observations, hash drift, pixel regressions and runtime closure leaks', () => {
  const manifest = fixtureManifest();
  const mutate = callback => { const report = fixtureReport(manifest); callback(report); return () => createLive2DFeatureCorpusCandidate(manifest, report); };
  assert.throws(mutate(report => report.samples.pop()), /Missing licensed sample/);
  assert.throws(mutate(report => { report.samples[1].featureCoverage.multiplicativeDrawableCount = 0; }), /multiplicativeDrawableCount/);
  assert.throws(mutate(report => { report.samples[0].sourceFiles[0].sha256 = 'b'.repeat(64); }), /sha256/);
  assert.throws(() => { const changed = fixtureManifest(); changed.samples[1].source.aggregateSha256 = 'f'.repeat(64); return createLive2DFeatureCorpusCandidate(changed, fixtureReport(changed)); }, /sourceAggregateSha256/);
  assert.throws(mutate(report => { report.samples[0].coreVersion += 1; }), /Cubism Core version|coreVersion/);
  assert.throws(mutate(report => { report.samples[0].comparisonConfiguration.synchronizedViews = false; }), /synchronizedViews/);
  assert.throws(mutate(report => { report.samples[0].comparisonConfiguration.pan = [1, 0]; }), /comparisonConfiguration.pan/);
  assert.throws(mutate(report => { report.samples[0].browser.gpuAdapter = null; }), /gpuAdapter/);
  assert.throws(mutate(report => { report.dirty = true; }), /dirty/);
  assert.throws(mutate(report => { report.revision = 'working-tree'; }), /clean Engine Git revision/);
  assert.throws(mutate(report => { report.samples[0].surfaceReadback.meanAbsoluteError = 2; }), /Mean absolute error/);
  assert.throws(mutate(report => { report.samples[0].requestedProjectFiles.push('model.moc3'); }), /source runtime or source asset/);
  assert.throws(mutate(report => { report.samples[0].browserDiagnostics.unclassifiedFailureCount = 1; }), /unclassifiedFailureCount/);
  assert.throws(mutate(report => { report.samples[0].conversionDiagnostics.push({ severity: 'warning', code: 'UNKNOWN', path: '$.x' }); }), /Unclassified conversion diagnostic/);
});

test('G12 manifest rejects redistributable licensed inputs, unpinned files and zero feature coverage', () => {
  const licensed = fixtureManifest(); licensed.samples[1].distribution.rawAssets = true;
  assert.throws(() => validateLive2DFeatureCorpusManifest(licensed), /cannot be redistributed/);
  const missing = fixtureManifest(); missing.samples[1].source.entry = 'missing.model3.json';
  assert.throws(() => validateLive2DFeatureCorpusManifest(missing), /file inventory/);
  const uncovered = fixtureManifest(); uncovered.samples[2].observations.multiplicativeDrawableCount = 0;
  assert.throws(() => validateLive2DFeatureCorpusManifest(uncovered), /Observed multiplicativeDrawableCount/);
});

function fixtureManifest() {
  const file = name => ({ path: name, byteLength: 1, sha256: 'a'.repeat(64) });
  const local = (id, observations, motion) => {
    const files = [file(`${id}.model3.json`), file(motion)];
    const aggregateSha256 = aggregate(files);
    return ({
    id, title: id, sourcePolicy: 'caller-supplied-local-only',
    source: { url: 'https://example.com/model', revisionKind: 'hash', revision: 'rev', entry: `${id}.model3.json`, aggregateSha256, runtimeDirectoryHash: `sha256-${id === 'rice' ? 'b' : 'c'}`.padEnd(71, id === 'rice' ? 'b' : 'c'), fileCount: 2, sourceBytes: 2 },
    license: { id: 'terms', url: 'https://example.com/terms', acceptanceRequired: true },
    distribution: { rawAssets: false, derivedStatistics: true, pixelReferences: false }, role: ['feature'],
    recipe: { motionId: 'Idle:0', motionFile: motion, bakedFrameTimes: [0, 1, 2], referenceTimes: [1] }, observations,
    files,
  }); };
  return {
    schemaVersion: 1, kind: 'haiyue-deformable2d-feature-corpus', id: 'fixture', hashAlgorithm: 'sha256',
    oracle: { cubismWebSamplesTag: 'tag', cubismWebSamplesRevision: 'revision', cubismWebFrameworkRevision: 'framework', adapterPackage: 'adapter', captureFormat: 'capture', cubismCoreVersion: 83886080 },
    referenceConfiguration: { profile: 'clip-baked-reference-times', referenceTimes: [1], viewport: [719, 694], clearColor: '#050817', targetFormat: 'rgba8unorm', textureColorSpaceConversion: 'none', textureAlphaMode: 'premultiplied', webglAntialias: false, fitTransform: { viewportMode: 'fit', policy: 'bounds-centered-auto-zoom', fill: 0.82, userZoom: 1, pan: [0, 0], canvas: [719, 746], synchronizedViews: true }, thresholds: { maxChannelError: 224, meanAbsoluteError: 1, mismatchRatio: 0.025 } },
    requiredFeatures: { maskReferenceCount: 1, invertedMaskDrawableCount: 1, additiveDrawableCount: 1, multiplicativeDrawableCount: 1 },
    replay: { requiredModelIds: ['rice', 'mao'], localReportCommand: 'verify local', candidateCommand: 'verify candidate' },
    samples: [
      { id: 'public', title: 'public', sourcePolicy: 'bundled-redistributable', license: { id: 'MIT', url: 'https://example.com/mit', acceptanceRequired: false }, distribution: { rawAssets: true, derivedStatistics: true, pixelReferences: true }, role: ['baseline'], files: [file('public.hya')], observations: { drawableCount: 1, maskReferenceCount: 0, invertedMaskDrawableCount: 0, additiveDrawableCount: 0, multiplicativeDrawableCount: 0 } },
      local('rice', { drawableCount: 2, maskReferenceCount: 1, invertedMaskDrawableCount: 1, additiveDrawableCount: 1, multiplicativeDrawableCount: 0 }, 'rice.motion3.json'),
      local('mao', { drawableCount: 3, maskReferenceCount: 2, invertedMaskDrawableCount: 0, additiveDrawableCount: 1, multiplicativeDrawableCount: 1 }, 'mao.motion3.json'),
    ],
  };
}

function aggregate(files) { return createHash('sha256').update(files.map(file => `${file.path}\t${file.sha256}\t${file.byteLength}\n`).sort((left, right) => left.localeCompare(right)).join('')).digest('hex'); }

function fixtureReport(manifest) {
  const local = manifest.samples.filter(sample => sample.sourcePolicy === 'caller-supplied-local-only');
  const samples = local.map(sample => ({
    id: sample.id, sourcePolicy: sample.sourcePolicy, runtimeDirectoryHash: sample.source.runtimeDirectoryHash, fileCount: sample.source.fileCount, sourceBytes: sample.source.sourceBytes, sourceEntry: sample.source.entry,
    sourceFiles: sample.files.map(file => ({ path: file.path, byteLength: file.byteLength, sha256: file.sha256 })), coreVersion: 83886080,
    evidenceRecipe: { profile: 'clip-baked-reference-times', motionId: sample.recipe.motionId, motionFile: sample.recipe.motionFile, bakedFrameTimes: [...sample.recipe.bakedFrameTimes], referenceTimes: [...sample.recipe.referenceTimes] },
    featureCoverage: { maskReferenceCount: sample.observations.maskReferenceCount, invertedMaskDrawableCount: sample.observations.invertedMaskDrawableCount, additiveDrawableCount: sample.observations.additiveDrawableCount, multiplicativeDrawableCount: sample.observations.multiplicativeDrawableCount },
    drawables: sample.observations.drawableCount, maskTargets: sample.observations.maskReferenceCount > 0 ? 1 : 0, sampledAt: 1, recoverySmoke: true, conversionDiagnostics: [],
    comparisonConfiguration: { viewportMode: 'fit', fitPolicy: 'bounds-centered-auto-zoom', fitFill: 0.82, userZoom: 1, pan: [0, 0], resolvedZoom: 1, synchronizedViews: true, canvas: [719, 746], targetFormat: 'rgba8unorm', textureColorSpaceConversion: 'none', alphaMode: 'premultiplied', antialias: false },
    surfaceReadback: { width: 719, height: 694, maxChannelError: 100, meanAbsoluteError: 0.2, mismatchRatio: 0.01 },
    browser: { nativeBackend: true, gpuAdapter: { vendor: 'vendor', architecture: 'architecture', device: 'device', description: 'description' } }, browserDiagnostics: { unclassifiedFailureCount: 0 }, requestedProjectFiles: ['examples/shared/engine.js'],
  }));
  return { schemaVersion: 1, kind: 'haiyue-live2d-local-corpus-candidate', revision: 'd'.repeat(40), dirty: false, formalEvidence: false, core: { sourcePolicy: 'official-cdn' }, samples, sampleCount: samples.length, totals: Object.fromEntries(['maskReferenceCount', 'invertedMaskDrawableCount', 'additiveDrawableCount', 'multiplicativeDrawableCount'].map(key => [key, samples.reduce((sum, sample) => sum + sample.featureCoverage[key], 0)])) };
}
