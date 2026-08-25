import { createHash } from 'node:crypto';

export class Live2DDrawableFidelityCorpusPolicyError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'Live2DDrawableFidelityCorpusPolicyError';
    this.path = path;
  }
}

export function createLive2DDrawableFidelityCandidate(manifestValue, reportValue, provenance = {}) {
  const manifest = validateManifest(manifestValue);
  const report = validateReport(reportValue, manifest);
  sha256(provenance.manifestSha256, '$provenance.manifestSha256');
  equal(string(provenance.sourceManifestSha256, '$provenance.sourceManifestSha256'), manifest.sourceManifest.sha256, '$provenance.sourceManifestSha256');
  const samples = manifest.samples.map((expected, index) => validateSample(report.samples[index], expected, manifest, `$.samples[${index}]`));
  const totals = aggregate(samples);
  for (const [key, minimum] of Object.entries(manifest.requiredFeatures)) {
    if (totals[key] < minimum) fail(`$.totals.${key}`, `Expected at least ${minimum}, received ${totals[key]}.`);
    equal(report.totals[key], totals[key], `$.report.totals.${key}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'haiyue-live2d-drawable-fidelity-corpus-candidate',
    goal: 'M05-G16',
    formalEvidence: false,
    revision: report.revision,
    dirty: false,
    manifest: Object.freeze({ id: manifest.id, sha256: provenance.manifestSha256, sourceManifestId: manifest.sourceManifest.id, sourceManifestSha256: provenance.sourceManifestSha256 }),
    oracle: manifest.oracle,
    referenceConfiguration: manifest.referenceConfiguration,
    core: report.core,
    adapter: report.adapter,
    samples: Object.freeze(samples),
    totals,
    features: Object.freeze([
      featureEvidence('multiply-color', samples, sample => sample.observations.multiplyColor, totals.nonNeutralMultiplyDrawableFrameCount),
      featureEvidence('screen-color', samples, sample => sample.observations.screenColor, totals.nonNeutralScreenDrawableFrameCount),
      featureEvidence('drawable-culling', samples, sample => sample.observations.culling.filter(observation => observation.mirrorFlipsWinding), totals.mirroredCullingDrawableFrameCount),
    ]),
    runtimeClosure: Object.freeze({ sourceRuntimeRequested: false, sourceAssetRequested: false, forbiddenRequestCount: 0 }),
    unclassifiedFailureCount: 0,
    handoff: Object.freeze({ consumers: Object.freeze(['M05-G07', 'M05-G09']), baselinePromotionOwner: 'M05-G09' }),
  });
}

export function createLive2DDrawableFidelityDashboard(candidateValue) {
  const candidate = object(candidateValue, '$candidate');
  const totals = object(candidate.totals, '$candidate.totals');
  const samples = array(candidate.samples, '$candidate.samples');
  return Object.freeze({
    schemaVersion: 2,
    kind: 'haiyue-live2d-dashboard-feature-status',
    generatedFrom: Object.freeze({ manifestId: candidate.manifest.id, candidateRevision: candidate.revision, formalEvidence: false }),
    features: Object.freeze([
      row('drawable-topology', 'Drawable topology / vertex animation', 'supported', 'covered', 'MIT fixture and licensed Core captures'),
      row('normal-blend', 'Normal drawable blend', 'supported', 'covered', 'MIT fixture plus licensed samples'),
      row('mask-composition', 'Mask composition', 'supported', 'covered', 'Rice and Mao reference captures'),
      row('inverted-mask', 'Inverted mask', 'supported', 'covered', 'Rice and Mao reference captures'),
      row('additive-blend', 'Additive drawable blend', 'supported', 'covered', 'Rice and Mao reference captures'),
      row('multiplicative-blend', 'Multiplicative drawable blend', 'supported', 'covered', 'Mao reference capture'),
      row('multiply-color', 'Multiply drawable color', 'supported', 'covered', `${totals.nonNeutralMultiplyDrawableFrameCount} observed drawable-frames`),
      row('screen-color', 'Screen drawable color', 'supported', 'covered', `${totals.nonNeutralScreenDrawableFrameCount} observed drawable-frames`),
      row('drawable-culling', 'Drawable culling', 'supported', 'covered', `${totals.mirroredCullingDrawableFrameCount} non-degenerate mirrored drawable-frames`),
      row('source-evaluation', 'Expression / Pose / Physics source evaluation', 'degraded', 'not-covered', 'clip-baked evaluator coverage remains recipe-dependent'),
      row('runtime-parameters', 'Runtime parameters / lip-sync / look input', 'unsupported', 'not-applicable', 'outside the clip-baked profile'),
    ]),
    licensedSamples: Object.freeze(samples.map(sample => Object.freeze({
      id: sample.id,
      title: sample.title,
      implementationEvidence: 'official-core-vs-hya',
      coverageStatus: 'covered',
      observations: Object.freeze({
        nonNeutralMultiplyDrawableFrameCount: sample.observations.multiplyColor.length,
        nonNeutralScreenDrawableFrameCount: sample.observations.screenColor.length,
        cullingDrawableCount: sample.featureCoverage.cullingDrawableCount,
        mirroredCullingDrawableFrameCount: sample.observations.culling.filter(observation => observation.mirrorFlipsWinding).length,
      }),
      localOnly: true,
    }))),
    missingLocalAssetMessage: '官方模型与 Cubism Core 不随页面发布。请接受 Live2D 许可并运行本地 G16 verifier 重放证据。',
  });
}

function validateManifest(value) {
  const manifest = object(value, '$manifest');
  equal(manifest.schemaVersion, 1, '$manifest.schemaVersion');
  equal(manifest.kind, 'haiyue-deformable2d-drawable-color-culling-corpus', '$manifest.kind');
  string(manifest.id, '$manifest.id');
  const sourceManifest = object(manifest.sourceManifest, '$manifest.sourceManifest');
  string(sourceManifest.path, '$manifest.sourceManifest.path');
  string(sourceManifest.id, '$manifest.sourceManifest.id');
  sha256(sourceManifest.sha256, '$manifest.sourceManifest.sha256');
  const oracle = object(manifest.oracle, '$manifest.oracle');
  sha1(oracle.cubismWebSamplesRevision, '$manifest.oracle.cubismWebSamplesRevision');
  sha1(oracle.cubismWebFrameworkRevision, '$manifest.oracle.cubismWebFrameworkRevision');
  positiveInteger(oracle.cubismCoreVersion, '$manifest.oracle.cubismCoreVersion');
  url(oracle.cubismCoreUrl, '$manifest.oracle.cubismCoreUrl');
  positiveInteger(oracle.cubismCoreByteLength, '$manifest.oracle.cubismCoreByteLength');
  sha256(oracle.cubismCoreSha256, '$manifest.oracle.cubismCoreSha256');
  const referenceConfiguration = object(manifest.referenceConfiguration, '$manifest.referenceConfiguration');
  validateReferenceConfiguration(referenceConfiguration, '$manifest.referenceConfiguration');
  const requiredFeatures = object(manifest.requiredFeatures, '$manifest.requiredFeatures');
  for (const key of requiredFeatureKeys()) positiveInteger(requiredFeatures[key], `$manifest.requiredFeatures.${key}`);
  const samples = array(manifest.samples, '$manifest.samples');
  equal(samples.length, 2, '$manifest.samples.length');
  samples.forEach((sample, index) => validateManifestSample(sample, `$manifest.samples[${index}]`));
  if (new Set(samples.map(sample => sample.id)).size !== samples.length) fail('$manifest.samples', 'Sample ids must be unique.');
  return manifest;
}

function validateManifestSample(value, path) {
  const sample = object(value, path);
  string(sample.id, `${path}.id`);
  string(sample.title, `${path}.title`);
  equal(sample.sourcePolicy, 'caller-supplied-local-only', `${path}.sourcePolicy`);
  const source = object(sample.source, `${path}.source`);
  url(source.url, `${path}.source.url`);
  string(source.revision, `${path}.source.revision`);
  directoryHash(source.runtimeDirectoryHash, `${path}.source.runtimeDirectoryHash`);
  positiveInteger(source.fileCount, `${path}.source.fileCount`);
  positiveInteger(source.sourceBytes, `${path}.source.sourceBytes`);
  string(source.entry, `${path}.source.entry`);
  const license = object(sample.license, `${path}.license`);
  string(license.id, `${path}.license.id`);
  url(license.url, `${path}.license.url`);
  equal(license.acceptanceRequired, true, `${path}.license.acceptanceRequired`);
  const distribution = object(sample.distribution, `${path}.distribution`);
  equal(distribution.rawAssets, false, `${path}.distribution.rawAssets`);
  equal(distribution.derivedStatistics, true, `${path}.distribution.derivedStatistics`);
  equal(distribution.pixelReferences, false, `${path}.distribution.pixelReferences`);
  validateRecipe(sample.recipe, `${path}.recipe`);
  const files = array(sample.requiredFiles, `${path}.requiredFiles`);
  files.forEach((file, index) => validateFile(file, `${path}.requiredFiles[${index}]`));
}

function validateReport(value, manifest) {
  const report = object(value, '$report');
  equal(report.schemaVersion, 1, '$report.schemaVersion');
  equal(report.kind, 'haiyue-live2d-local-corpus-candidate', '$report.kind');
  sha1(report.revision, '$report.revision');
  equal(report.dirty, false, '$report.dirty');
  equal(report.formalEvidence, false, '$report.formalEvidence');
  const core = object(report.core, '$report.core');
  equal(core.url, manifest.oracle.cubismCoreUrl, '$report.core.url');
  equal(core.byteLength, manifest.oracle.cubismCoreByteLength, '$report.core.byteLength');
  equal(core.sha256, manifest.oracle.cubismCoreSha256, '$report.core.sha256');
  const adapter = object(report.adapter, '$report.adapter');
  equal(adapter.package, manifest.oracle.adapterPackage, '$report.adapter.package');
  sha256(adapter.aggregateSha256, '$report.adapter.aggregateSha256');
  const samples = array(report.samples, '$report.samples');
  equal(report.sampleCount, manifest.samples.length, '$report.sampleCount');
  equal(samples.length, manifest.samples.length, '$report.samples.length');
  manifest.samples.forEach((expected, index) => equal(samples[index]?.id, expected.id, `$report.samples[${index}].id`));
  object(report.totals, '$report.totals');
  return report;
}

function validateSample(value, expected, manifest, path) {
  const sample = object(value, path);
  equal(sample.id, expected.id, `${path}.id`);
  equal(sample.sourcePolicy, expected.sourcePolicy, `${path}.sourcePolicy`);
  equal(sample.runtimeDirectoryHash, expected.source.runtimeDirectoryHash, `${path}.runtimeDirectoryHash`);
  equal(sample.fileCount, expected.source.fileCount, `${path}.fileCount`);
  equal(sample.sourceBytes, expected.source.sourceBytes, `${path}.sourceBytes`);
  equal(sample.sourceEntry, expected.source.entry, `${path}.sourceEntry`);
  equal(sample.coreVersion, manifest.oracle.cubismCoreVersion, `${path}.coreVersion`);
  validateRecipeMatch(sample.evidenceRecipe, expected.recipe, `${path}.evidenceRecipe`);
  validateRequiredFiles(sample.sourceFiles, expected.requiredFiles, `${path}.sourceFiles`);
  const diagnostics = array(sample.conversionDiagnostics, `${path}.conversionDiagnostics`);
  if (diagnostics.length !== 0) fail(`${path}.conversionDiagnostics`, 'G16 promoted samples must have zero conversion diagnostics.');
  const coverage = object(sample.featureCoverage, `${path}.featureCoverage`);
  const observations = validateObservations(sample.featureObservations, expected, `${path}.featureObservations`);
  validatePixelMetrics(sample.surfaceReadback, manifest.referenceConfiguration.thresholds, `${path}.surfaceReadback`);
  equal(sample.recoverySmoke, true, `${path}.recoverySmoke`);
  validateComparisonConfiguration(sample.comparisonConfiguration, manifest.referenceConfiguration, `${path}.comparisonConfiguration`);
  const browser = object(sample.browser, `${path}.browser`);
  equal(browser.nativeBackend, true, `${path}.browser.nativeBackend`);
  const gpu = object(browser.gpuAdapter, `${path}.browser.gpuAdapter`);
  if (![gpu.vendor, gpu.architecture, gpu.device, gpu.description].some(value => typeof value === 'string' && value.length > 0)) fail(`${path}.browser.gpuAdapter`, 'GPU adapter identity is empty.');
  equal(object(sample.browserDiagnostics, `${path}.browserDiagnostics`).unclassifiedFailureCount, 0, `${path}.browserDiagnostics.unclassifiedFailureCount`);
  validateRuntimeClosure(sample.requestedProjectFiles, `${path}.requestedProjectFiles`);
  return Object.freeze({
    id: expected.id,
    title: expected.title,
    source: expected.source,
    license: expected.license,
    distribution: expected.distribution,
    recipe: expected.recipe,
    featureCoverage: Object.freeze({ ...coverage }),
    observations,
    conversionDiagnostics: Object.freeze([]),
    surfaceReadback: Object.freeze({ ...sample.surfaceReadback }),
    browser: Object.freeze({ ...browser, gpuAdapter: Object.freeze({ ...gpu }) }),
    browserDiagnostics: Object.freeze({ ...sample.browserDiagnostics }),
    recoverySmoke: true,
  });
}

function validateObservations(value, expected, path) {
  const observations = object(value, path);
  const multiplyColor = validateColorObservations(observations.multiplyColor, `${path}.multiplyColor`, 'multiplyColor');
  const screenColor = validateColorObservations(observations.screenColor, `${path}.screenColor`, 'screenColor');
  const culling = validateCullingObservations(observations.culling, `${path}.culling`);
  uniqueDrawableObservations(multiplyColor, `${path}.multiplyColor`);
  uniqueDrawableObservations(screenColor, `${path}.screenColor`);
  uniqueDrawableObservations(culling, `${path}.culling`);
  const expectedValues = object(expected.expectedObservations, '$expected.expectedObservations');
  if (expectedValues.nonNeutralMultiplyDrawableFrameCount !== undefined) equal(multiplyColor.length, expectedValues.nonNeutralMultiplyDrawableFrameCount, `${path}.multiplyColor.length`);
  if (expectedValues.nonNeutralScreenDrawableFrameCount !== undefined) equal(screenColor.length, expectedValues.nonNeutralScreenDrawableFrameCount, `${path}.screenColor.length`);
  if (expectedValues.cullingDrawableCount !== undefined) equal(culling.length, expectedValues.cullingDrawableCount, `${path}.culling.length`);
  validateColorRepresentative(multiplyColor, expectedValues.multiplyRepresentative, `${path}.multiplyColor`);
  validateColorRepresentative(screenColor, expectedValues.screenRepresentative, `${path}.screenColor`);
  if (expectedValues.nondegenerateCullingDrawableFrameCount !== undefined) equal(culling.filter(item => item.sourceWinding.ccw + item.sourceWinding.cw > 0).length, expectedValues.nondegenerateCullingDrawableFrameCount, `${path}.culling.nondegenerateCount`);
  if (expectedValues.mirroredCullingDrawableFrameCount !== undefined) equal(culling.filter(item => item.mirrorFlipsWinding).length, expectedValues.mirroredCullingDrawableFrameCount, `${path}.culling.mirroredCount`);
  if (expectedValues.cullingRepresentative) {
    const representative = culling.find(item => item.drawableId === expectedValues.cullingRepresentative.drawableId);
    if (!representative) fail(`${path}.culling`, `Missing representative ${expectedValues.cullingRepresentative.drawableId}.`);
    windingEqual(representative.sourceWinding, expectedValues.cullingRepresentative.sourceWinding, `${path}.culling.sourceWinding`);
    windingEqual(representative.mirroredXWinding, expectedValues.cullingRepresentative.mirroredXWinding, `${path}.culling.mirroredXWinding`);
  }
  return Object.freeze({ multiplyColor: Object.freeze(multiplyColor), screenColor: Object.freeze(screenColor), culling: Object.freeze(culling) });
}

function validateColorObservations(value, path, field) {
  return array(value, path).map((item, index) => {
    const observation = object(item, `${path}[${index}]`);
    string(observation.drawableId, `${path}[${index}].drawableId`);
    nonnegativeInteger(observation.drawableIndex, `${path}[${index}].drawableIndex`);
    if (!string(observation.path, `${path}[${index}].path`).endsWith(`.${field}`)) fail(`${path}[${index}].path`, `Expected ${field} path.`);
    nonnegativeFinite(observation.time, `${path}[${index}].time`);
    color(observation.rgba, `${path}[${index}].rgba`);
    return Object.freeze({ ...observation, rgba: Object.freeze([...observation.rgba]) });
  });
}

function validateCullingObservations(value, path) {
  return array(value, path).map((item, index) => {
    const observation = object(item, `${path}[${index}]`);
    string(observation.drawableId, `${path}[${index}].drawableId`);
    nonnegativeInteger(observation.drawableIndex, `${path}[${index}].drawableIndex`);
    if (!string(observation.path, `${path}[${index}].path`).endsWith('.culling')) fail(`${path}[${index}].path`, 'Expected culling path.');
    nonnegativeFinite(observation.time, `${path}[${index}].time`);
    positiveInteger(observation.triangleCount, `${path}[${index}].triangleCount`);
    const sourceWinding = winding(observation.sourceWinding, `${path}[${index}].sourceWinding`);
    const mirroredXWinding = winding(observation.mirroredXWinding, `${path}[${index}].mirroredXWinding`);
    equal(sourceWinding.ccw, mirroredXWinding.cw, `${path}[${index}].mirroredXWinding.cw`);
    equal(sourceWinding.cw, mirroredXWinding.ccw, `${path}[${index}].mirroredXWinding.ccw`);
    equal(sourceWinding.degenerate, mirroredXWinding.degenerate, `${path}[${index}].mirroredXWinding.degenerate`);
    equal(observation.mirrorFlipsWinding, sourceWinding.ccw + sourceWinding.cw > 0, `${path}[${index}].mirrorFlipsWinding`);
    equal(sourceWinding.ccw + sourceWinding.cw + sourceWinding.degenerate, observation.triangleCount, `${path}[${index}].triangleCount`);
    return Object.freeze({ ...observation, sourceWinding, mirroredXWinding });
  });
}

function validateColorRepresentative(observations, expected, path) {
  if (!expected) return;
  const representative = observations.find(item => item.drawableId === expected.drawableId);
  if (!representative) fail(path, `Missing representative ${expected.drawableId}.`);
  expected.rgba.forEach((value, index) => {
    if (Math.abs(representative.rgba[index] - value) > 1e-5) fail(`${path}.${expected.drawableId}.rgba[${index}]`, `Expected ${value}, received ${representative.rgba[index]}.`);
  });
}

function aggregate(samples) {
  const totals = samples.reduce((result, sample) => ({
    nonNeutralMultiplyDrawableFrameCount: result.nonNeutralMultiplyDrawableFrameCount + sample.observations.multiplyColor.length,
    nonNeutralScreenDrawableFrameCount: result.nonNeutralScreenDrawableFrameCount + sample.observations.screenColor.length,
    cullingDrawableCount: result.cullingDrawableCount + sample.featureCoverage.cullingDrawableCount,
    nondegenerateCullingDrawableFrameCount: result.nondegenerateCullingDrawableFrameCount + sample.observations.culling.filter(item => item.sourceWinding.ccw + item.sourceWinding.cw > 0).length,
    mirroredCullingDrawableFrameCount: result.mirroredCullingDrawableFrameCount + sample.observations.culling.filter(item => item.mirrorFlipsWinding).length,
  }), Object.fromEntries(requiredFeatureKeys().map(key => [key, 0])));
  return Object.freeze(totals);
}

function featureEvidence(id, samples, select, observationCount) {
  const selected = samples.filter(sample => select(sample).length > 0);
  return Object.freeze({
    id,
    status: 'passed',
    sampleIds: Object.freeze(selected.map(sample => sample.id)),
    observationCount,
    observations: Object.freeze(selected.flatMap(sample => select(sample).map(observation => Object.freeze({ sampleId: sample.id, ...observation })))),
    pixelMetrics: Object.freeze(selected.map(sample => Object.freeze({ sampleId: sample.id, time: sample.recipe.referenceTimes[0], ...sample.surfaceReadback }))),
    gpuValidation: Object.freeze({ nativeBackend: true, deviceRecovery: selected.every(sample => sample.recoverySmoke), adapters: Object.freeze(selected.map(sample => Object.freeze({ sampleId: sample.id, ...sample.browser.gpuAdapter }))) }),
    diagnosticAttribution: Object.freeze({ codes: Object.freeze([]), paths: Object.freeze([]), unclassifiedFailureCount: 0 }),
    runtimeClosure: Object.freeze({ sourceRuntimeRequested: false, sourceAssetRequested: false }),
  });
}

function validateRecipe(value, path) {
  const recipe = object(value, path);
  string(recipe.motionId, `${path}.motionId`);
  string(recipe.motionFile, `${path}.motionFile`);
  finiteList(recipe.bakedFrameTimes, `${path}.bakedFrameTimes`);
  finiteList(recipe.referenceTimes, `${path}.referenceTimes`);
}
function validateRecipeMatch(actualValue, expected, path) {
  const actual = object(actualValue, path);
  equal(actual.profile, 'clip-baked-reference-times', `${path}.profile`);
  equal(actual.motionId, expected.motionId, `${path}.motionId`);
  equal(actual.motionFile, expected.motionFile, `${path}.motionFile`);
  closeList(actual.bakedFrameTimes, expected.bakedFrameTimes, `${path}.bakedFrameTimes`);
  closeList(actual.referenceTimes, expected.referenceTimes, `${path}.referenceTimes`);
}
function validateRequiredFiles(actualValue, expectedFiles, path) {
  const actual = array(actualValue, path);
  expectedFiles.forEach((expected, index) => {
    const item = actual.find(candidate => candidate.path === expected.path);
    if (!item) fail(path, `Missing required file ${expected.path}.`);
    equal(item.byteLength, expected.byteLength, `${path}[${index}].byteLength`);
    equal(item.sha256, expected.sha256, `${path}[${index}].sha256`);
  });
}
function validateFile(value, path) { const file = object(value, path); string(file.path, `${path}.path`); positiveInteger(file.byteLength, `${path}.byteLength`); sha256(file.sha256, `${path}.sha256`); }
function validateReferenceConfiguration(value, path) {
  exactList(value.viewport, [719, 694], `${path}.viewport`);
  exactList(value.canvas, [719, 746], `${path}.canvas`);
  equal(value.clearColor, '#050817', `${path}.clearColor`);
  equal(value.targetFormat, 'rgba8unorm', `${path}.targetFormat`);
  equal(value.textureColorSpaceConversion, 'none', `${path}.textureColorSpaceConversion`);
  equal(value.textureAlphaMode, 'premultiplied', `${path}.textureAlphaMode`);
  equal(value.webglAntialias, false, `${path}.webglAntialias`);
  const thresholds = object(value.thresholds, `${path}.thresholds`);
  positiveFinite(thresholds.maxChannelError, `${path}.thresholds.maxChannelError`);
  positiveFinite(thresholds.meanAbsoluteError, `${path}.thresholds.meanAbsoluteError`);
  positiveFinite(thresholds.mismatchRatio, `${path}.thresholds.mismatchRatio`);
}
function validateComparisonConfiguration(value, expected, path) {
  const actual = object(value, path);
  equal(actual.viewportMode, expected.viewportMode, `${path}.viewportMode`);
  equal(actual.fitPolicy, expected.fitPolicy, `${path}.fitPolicy`);
  equal(actual.fitFill, expected.fitFill, `${path}.fitFill`);
  equal(actual.userZoom, expected.userZoom, `${path}.userZoom`);
  closeList(actual.pan, expected.pan, `${path}.pan`);
  equal(actual.synchronizedViews, expected.synchronizedViews, `${path}.synchronizedViews`);
  closeList(actual.canvas, expected.canvas, `${path}.canvas`);
  equal(actual.targetFormat, expected.targetFormat, `${path}.targetFormat`);
  equal(actual.textureColorSpaceConversion, expected.textureColorSpaceConversion, `${path}.textureColorSpaceConversion`);
  equal(actual.alphaMode, expected.textureAlphaMode, `${path}.alphaMode`);
  equal(actual.antialias, expected.webglAntialias, `${path}.antialias`);
}
function validatePixelMetrics(value, thresholds, path) {
  const metrics = object(value, path);
  equal(metrics.width, 719, `${path}.width`);
  equal(metrics.height, 694, `${path}.height`);
  nonnegativeFinite(metrics.maxChannelError, `${path}.maxChannelError`);
  nonnegativeFinite(metrics.meanAbsoluteError, `${path}.meanAbsoluteError`);
  nonnegativeFinite(metrics.mismatchRatio, `${path}.mismatchRatio`);
  if (metrics.maxChannelError > thresholds.maxChannelError) fail(`${path}.maxChannelError`, `Exceeded ${thresholds.maxChannelError}.`);
  if (metrics.meanAbsoluteError > thresholds.meanAbsoluteError) fail(`${path}.meanAbsoluteError`, `Exceeded ${thresholds.meanAbsoluteError}.`);
  if (metrics.mismatchRatio > thresholds.mismatchRatio) fail(`${path}.mismatchRatio`, `Exceeded ${thresholds.mismatchRatio}.`);
}

function uniqueDrawableObservations(observations, path) {
  const seen = new Set();
  observations.forEach((observation, index) => {
    const key = `${observation.drawableIndex}:${observation.drawableId}`;
    if (seen.has(key)) fail(`${path}[${index}]`, `Duplicate drawable observation ${key}.`);
    seen.add(key);
  });
}
function validateRuntimeClosure(value, path) {
  const files = array(value, path);
  const forbidden = files.filter(file => /(?:live2dcubismcore|\.moc3|\.model3\.json|\.motion3\.json)$/iu.test(String(file)));
  if (forbidden.length > 0) fail(path, `Runtime closure requested source assets: ${forbidden.join(', ')}.`);
}

function row(id, title, implementationStatus, coverageStatus, detail) { return Object.freeze({ id, title, implementationStatus, coverageStatus, detail }); }
function requiredFeatureKeys() { return ['nonNeutralMultiplyDrawableFrameCount', 'nonNeutralScreenDrawableFrameCount', 'cullingDrawableCount', 'nondegenerateCullingDrawableFrameCount', 'mirroredCullingDrawableFrameCount']; }
function winding(value, path) { const item = object(value, path); return Object.freeze({ ccw: nonnegativeInteger(item.ccw, `${path}.ccw`), cw: nonnegativeInteger(item.cw, `${path}.cw`), degenerate: nonnegativeInteger(item.degenerate, `${path}.degenerate`) }); }
function windingEqual(actual, expected, path) { for (const key of ['ccw', 'cw', 'degenerate']) equal(actual[key], expected[key], `${path}.${key}`); }
function color(value, path) { const items = array(value, path); equal(items.length, 4, `${path}.length`); items.forEach((item, index) => { if (!Number.isFinite(item) || item < 0 || item > 1) fail(`${path}[${index}]`, 'Color channel must be finite and within [0,1].'); }); }
function finiteList(value, path) { const items = array(value, path); if (items.length === 0) fail(path, 'List cannot be empty.'); items.forEach((item, index) => nonnegativeFinite(item, `${path}[${index}]`)); return items; }
function closeList(actualValue, expected, path) { const actual = finiteList(actualValue, path); equal(actual.length, expected.length, `${path}.length`); actual.forEach((item, index) => { if (Math.abs(item - expected[index]) > 1e-5) fail(`${path}[${index}]`, `Expected ${expected[index]}, received ${item}.`); }); }
function exactList(actualValue, expected, path) { const actual = array(actualValue, path); equal(actual.length, expected.length, `${path}.length`); actual.forEach((item, index) => equal(item, expected[index], `${path}[${index}]`)); }
function object(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'Expected an object.'); return value; }
function array(value, path) { if (!Array.isArray(value)) fail(path, 'Expected an array.'); return value; }
function string(value, path) { if (typeof value !== 'string' || value.length === 0) fail(path, 'Expected a non-empty string.'); return value; }
function url(value, path) { string(value, path); try { const parsed = new URL(value); if (parsed.protocol !== 'https:') fail(path, 'URL must use HTTPS.'); } catch (error) { if (error instanceof Live2DDrawableFidelityCorpusPolicyError) throw error; fail(path, 'Expected a valid URL.'); } }
function sha1(value, path) { if (!/^[a-f0-9]{40}$/u.test(String(value))) fail(path, 'Expected a full lowercase SHA-1.'); return value; }
function sha256(value, path) { if (!/^[a-f0-9]{64}$/u.test(String(value))) fail(path, 'Expected a lowercase SHA-256.'); return value; }
function directoryHash(value, path) { if (!/^sha256-[a-f0-9]{64}$/u.test(String(value))) fail(path, 'Expected a sha256- directory hash.'); return value; }
function positiveInteger(value, path) { if (!Number.isSafeInteger(value) || value <= 0) fail(path, 'Expected a positive safe integer.'); return value; }
function nonnegativeInteger(value, path) { if (!Number.isSafeInteger(value) || value < 0) fail(path, 'Expected a non-negative safe integer.'); return value; }
function positiveFinite(value, path) { if (!Number.isFinite(value) || value <= 0) fail(path, 'Expected a positive finite number.'); return value; }
function nonnegativeFinite(value, path) { if (!Number.isFinite(value) || value < 0) fail(path, 'Expected a non-negative finite number.'); return value; }
function equal(actual, expected, path) { if (actual !== expected) fail(path, `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`); }
function fail(path, message) { throw new Live2DDrawableFidelityCorpusPolicyError(path, message); }

export function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
