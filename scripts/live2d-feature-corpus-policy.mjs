import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAMPLE_ID = /^[a-z0-9][a-z0-9-]*$/u;
const FORBIDDEN_RUNTIME_PATH = /live2dcubismcore|cubismcore|live2dcubismframework|\.moc3|\.model3\.json|\.motion3\.json|\.exp(?:ression)?3\.json|\.physics3\.json|\.pose3\.json|\.cmo3|\.wpk/iu;
const OBSERVATION_KEYS = Object.freeze([
  'maskReferenceCount',
  'invertedMaskDrawableCount',
  'additiveDrawableCount',
  'multiplicativeDrawableCount',
]);

export class Live2DFeatureCorpusPolicyError extends Error {
  constructor(path, message) {
    super(`${message} (${path})`);
    this.name = 'Live2DFeatureCorpusPolicyError';
    this.path = path;
  }
}

export function validateLive2DFeatureCorpusManifest(value) {
  const manifest = object(value, '$');
  equal(manifest.schemaVersion, 1, '$.schemaVersion');
  equal(manifest.kind, 'haiyue-deformable2d-feature-corpus', '$.kind');
  string(manifest.id, '$.id');
  const oracle = object(manifest.oracle, '$.oracle');
  for (const key of ['cubismWebSamplesTag', 'cubismWebSamplesRevision', 'cubismWebFrameworkRevision', 'adapterPackage', 'captureFormat']) string(oracle[key], `$.oracle.${key}`);
  positiveInteger(oracle.cubismCoreVersion, '$.oracle.cubismCoreVersion');
  const reference = object(manifest.referenceConfiguration, '$.referenceConfiguration');
  equal(reference.profile, 'clip-baked-reference-times', '$.referenceConfiguration.profile');
  numberList(reference.referenceTimes, '$.referenceConfiguration.referenceTimes', true);
  const viewport = numberList(reference.viewport, '$.referenceConfiguration.viewport', true);
  if (viewport.length !== 2 || viewport.some(value => !Number.isSafeInteger(value))) fail('$.referenceConfiguration.viewport', 'Viewport must contain two positive safe integers.');
  equal(reference.targetFormat, 'rgba8unorm', '$.referenceConfiguration.targetFormat');
  equal(reference.textureColorSpaceConversion, 'none', '$.referenceConfiguration.textureColorSpaceConversion');
  equal(reference.textureAlphaMode, 'premultiplied', '$.referenceConfiguration.textureAlphaMode');
  equal(reference.webglAntialias, false, '$.referenceConfiguration.webglAntialias');
  const fit = object(reference.fitTransform, '$.referenceConfiguration.fitTransform');
  equal(fit.viewportMode, 'fit', '$.referenceConfiguration.fitTransform.viewportMode');
  equal(fit.policy, 'bounds-centered-auto-zoom', '$.referenceConfiguration.fitTransform.policy');
  equal(fit.fill, 0.82, '$.referenceConfiguration.fitTransform.fill');
  equal(fit.userZoom, 1, '$.referenceConfiguration.fitTransform.userZoom');
  closeList(fit.pan, [0, 0], '$.referenceConfiguration.fitTransform.pan');
  const fitCanvas = numberList(fit.canvas, '$.referenceConfiguration.fitTransform.canvas', true);
  if (fitCanvas.length !== 2 || fitCanvas.some(value => !Number.isSafeInteger(value))) fail('$.referenceConfiguration.fitTransform.canvas', 'Fit canvas must contain two positive safe integers.');
  equal(fit.synchronizedViews, true, '$.referenceConfiguration.fitTransform.synchronizedViews');
  validateThresholds(reference.thresholds, '$.referenceConfiguration.thresholds');
  const required = object(manifest.requiredFeatures, '$.requiredFeatures');
  for (const key of OBSERVATION_KEYS) positiveInteger(required[key], `$.requiredFeatures.${key}`);

  const samples = array(manifest.samples, '$.samples');
  if (samples.length < 3) fail('$.samples', 'Feature corpus requires the public baseline and at least two licensed real samples.');
  const ids = new Set();
  for (let index = 0; index < samples.length; index++) validateManifestSample(samples[index], `$.samples[${index}]`, ids);
  const replay = object(manifest.replay, '$.replay');
  const requiredModelIds = array(replay.requiredModelIds, '$.replay.requiredModelIds');
  const localIds = samples.filter(sample => sample.sourcePolicy === 'caller-supplied-local-only').map(sample => sample.id);
  if (JSON.stringify(requiredModelIds) !== JSON.stringify(localIds)) fail('$.replay.requiredModelIds', 'Replay model population must exactly match licensed local samples.');
  string(replay.localReportCommand, '$.replay.localReportCommand');
  string(replay.candidateCommand, '$.replay.candidateCommand');
  for (const key of OBSERVATION_KEYS) {
    const total = samples.reduce((sum, sample) => sum + Number(sample.observations[key] ?? 0), 0);
    if (total < required[key]) fail(`$.requiredFeatures.${key}`, `Observed ${key} total ${total} is below ${required[key]}.`);
  }
  return manifest;
}

export function createLive2DFeatureCorpusCandidate(manifestValue, reportValue, options = {}) {
  const manifest = validateLive2DFeatureCorpusManifest(manifestValue);
  const report = object(reportValue, '$report');
  equal(report.schemaVersion, 1, '$report.schemaVersion');
  equal(report.kind, 'haiyue-live2d-local-corpus-candidate', '$report.kind');
  equal(report.formalEvidence, false, '$report.formalEvidence');
  equal(report.dirty, false, '$report.dirty');
  if (!/^[a-f0-9]{40}$/u.test(report.revision)) fail('$report.revision', 'Candidate must bind a full clean Engine Git revision.');
  const core = object(report.core, '$report.core');
  if (!['official-cdn', 'caller-supplied-local-official-sdk-only'].includes(core.sourcePolicy)) fail('$report.core.sourcePolicy', 'Core must come from an official CDN or caller-supplied official SDK.');
  const reportSamples = array(report.samples, '$report.samples');
  const byId = new Map(reportSamples.map((sample, index) => {
    const id = string(object(sample, `$report.samples[${index}]`).id, `$report.samples[${index}].id`);
    if (id && byDuplicate(reportSamples, index, id)) fail(`$report.samples[${index}].id`, `Duplicate report sample ${id}.`);
    return [id, sample];
  }));
  const accepted = [];
  const totals = Object.fromEntries(OBSERVATION_KEYS.map(key => [key, 0]));
  const localSamples = manifest.samples.filter(sample => sample.sourcePolicy === 'caller-supplied-local-only');
  for (const sample of localSamples) {
    const observed = byId.get(sample.id);
    if (!observed) fail('$report.samples', `Missing licensed sample ${sample.id}.`);
    accepted.push(validateReportSample(manifest, sample, observed, `$report.samples[id=${JSON.stringify(sample.id)}]`));
    for (const key of OBSERVATION_KEYS) totals[key] += observed.featureCoverage[key];
  }
  if (reportSamples.length !== localSamples.length) fail('$report.samples', 'Report population must exactly match the manifest licensed sample population.');
  for (const key of OBSERVATION_KEYS) {
    if (totals[key] < manifest.requiredFeatures[key]) fail(`$report.totals.${key}`, `Accepted total ${totals[key]} is below ${manifest.requiredFeatures[key]}.`);
    equal(report.totals?.[key], totals[key], `$report.totals.${key}`);
  }
  const coreVersions = new Set(accepted.map(sample => sample.coreVersion));
  if (coreVersions.size !== 1) fail('$report.samples', 'All samples must use one frozen Cubism Core version.');
  equal([...coreVersions][0], manifest.oracle.cubismCoreVersion, '$report.samples.coreVersion');
  const features = createCapabilityRows(totals);
  const featureEvidence = createFeatureEvidence(accepted, totals);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'haiyue-live2d-mask-blend-corpus-candidate',
    goal: 'm05/g12-mask-blend-corpus-acceptance',
    status: 'passed',
    revision: report.revision,
    dirty: false,
    formalEvidence: false,
    manifest: { id: manifest.id, sha256: options.manifestSha256 ?? null },
    oracle: manifest.oracle,
    referenceConfiguration: manifest.referenceConfiguration,
    core: { ...core, version: [...coreVersions][0] },
    samples: accepted,
    totals,
    features,
    featureEvidence,
    unclassifiedFailureCount: 0,
    runtimeClosure: { cubismRuntimeInProjectRequests: false, sourceAssetRequests: false },
    g07Handoff: {
      status: 'ready',
      manifestId: manifest.id,
      sampleIds: accepted.map(sample => sample.id),
      requiredObservationCounts: totals,
      consumerContract: 'read candidate samples/features without redefining feature taxonomy',
    },
    g09Handoff: { status: 'clean-candidate-ready-for-human-baseline-review' },
  });
}

export function createG07DeformableCorpusHandoff(candidateValue) {
  const candidate = object(candidateValue, '$candidate');
  equal(candidate.kind, 'haiyue-live2d-mask-blend-corpus-candidate', '$candidate.kind');
  equal(candidate.status, 'passed', '$candidate.status');
  equal(candidate.g07Handoff?.status, 'ready', '$candidate.g07Handoff.status');
  return Object.freeze({
    schemaVersion: 1,
    manifestId: candidate.manifest.id,
    sampleIds: Object.freeze(candidate.samples.map(sample => sample.id)),
    featureDefinitions: Object.freeze(candidate.features.map(feature => Object.freeze({ ...feature }))),
    featureEvidence: Object.freeze(candidate.featureEvidence.map(evidence => Object.freeze({ ...evidence }))),
    requiredObservationCounts: Object.freeze({ ...candidate.totals }),
  });
}

export function createLive2DDashboardStatus(candidate) {
  const value = object(candidate, '$candidate');
  equal(value.kind, 'haiyue-live2d-mask-blend-corpus-candidate', '$candidate.kind');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'haiyue-live2d-dashboard-feature-status',
    generatedFrom: { manifestId: value.manifest.id, candidateRevision: value.revision, formalEvidence: value.formalEvidence },
    features: value.features,
    licensedSamples: value.samples.map(sample => ({
      id: sample.id,
      title: sample.title,
      implementationEvidence: 'official-core-vs-hya',
      coverageStatus: 'covered',
      observations: sample.observations,
      localOnly: true,
    })),
    missingLocalAssetMessage: '官方模型不会随页面发布。请接受 Live2D 对应许可并在本地运行 feature-corpus verifier 以重放证据。',
  });
}

function validateManifestSample(value, path, ids) {
  const sample = object(value, path);
  const id = string(sample.id, `${path}.id`);
  if (!SAMPLE_ID.test(id) || ids.has(id)) fail(`${path}.id`, 'Sample id must be unique kebab-case.');
  ids.add(id);
  string(sample.title, `${path}.title`);
  if (!['bundled-redistributable', 'caller-supplied-local-only'].includes(sample.sourcePolicy)) fail(`${path}.sourcePolicy`, 'Unknown source policy.');
  const license = object(sample.license, `${path}.license`);
  string(license.id, `${path}.license.id`);
  url(license.url, `${path}.license.url`);
  if (typeof license.acceptanceRequired !== 'boolean') fail(`${path}.license.acceptanceRequired`, 'License acceptanceRequired must be boolean.');
  const distribution = object(sample.distribution, `${path}.distribution`);
  for (const key of ['rawAssets', 'derivedStatistics', 'pixelReferences']) if (typeof distribution[key] !== 'boolean') fail(`${path}.distribution.${key}`, 'Distribution flags must be boolean.');
  if (sample.sourcePolicy === 'caller-supplied-local-only' && distribution.rawAssets !== false) fail(`${path}.distribution.rawAssets`, 'Licensed local-only source assets cannot be redistributed.');
  const files = array(sample.files, `${path}.files`);
  if (files.length === 0) fail(`${path}.files`, 'File inventory cannot be empty.');
  const paths = new Set();
  let totalBytes = 0;
  for (let index = 0; index < files.length; index++) {
    const file = object(files[index], `${path}.files[${index}]`);
    const filePath = string(file.path, `${path}.files[${index}].path`);
    if (filePath.includes('\\') || filePath.startsWith('/') || /^[A-Za-z]:/u.test(filePath) || paths.has(filePath)) fail(`${path}.files[${index}].path`, 'File paths must be unique relative POSIX paths.');
    paths.add(filePath);
    positiveInteger(file.byteLength, `${path}.files[${index}].byteLength`);
    if (!SHA256.test(file.sha256)) fail(`${path}.files[${index}].sha256`, 'File SHA-256 must be lowercase hexadecimal.');
    totalBytes += file.byteLength;
  }
  const observations = object(sample.observations, `${path}.observations`);
  positiveInteger(observations.drawableCount, `${path}.observations.drawableCount`);
  for (const key of OBSERVATION_KEYS) nonnegativeInteger(observations[key], `${path}.observations.${key}`);
  if (sample.sourcePolicy === 'caller-supplied-local-only') {
    const source = object(sample.source, `${path}.source`);
    url(source.url, `${path}.source.url`);
    string(source.revisionKind, `${path}.source.revisionKind`);
    string(source.revision, `${path}.source.revision`);
    string(source.entry, `${path}.source.entry`);
    if (!paths.has(source.entry)) fail(`${path}.source.entry`, 'Source entry must exist in the file inventory.');
    if (!SHA256.test(source.aggregateSha256)) fail(`${path}.source.aggregateSha256`, 'Aggregate SHA-256 must be lowercase hexadecimal.');
    if (!/^sha256-[a-f0-9]{64}$/u.test(source.runtimeDirectoryHash)) fail(`${path}.source.runtimeDirectoryHash`, 'Runtime directory hash is invalid.');
    equal(source.fileCount, files.length, `${path}.source.fileCount`);
    equal(source.sourceBytes, totalBytes, `${path}.source.sourceBytes`);
    const recipe = object(sample.recipe, `${path}.recipe`);
    string(recipe.motionId, `${path}.recipe.motionId`);
    string(recipe.motionFile, `${path}.recipe.motionFile`);
    if (!paths.has(recipe.motionFile)) fail(`${path}.recipe.motionFile`, 'Recipe motion must exist in the file inventory.');
    numberList(recipe.bakedFrameTimes, `${path}.recipe.bakedFrameTimes`, false);
    numberList(recipe.referenceTimes, `${path}.recipe.referenceTimes`, true);
  }
}

function validateReportSample(manifest, expected, observedValue, path) {
  const observed = object(observedValue, path);
  equal(observed.sourcePolicy, 'caller-supplied-local-only', `${path}.sourcePolicy`);
  equal(observed.runtimeDirectoryHash, expected.source.runtimeDirectoryHash, `${path}.runtimeDirectoryHash`);
  equal(observed.fileCount, expected.source.fileCount, `${path}.fileCount`);
  equal(observed.sourceBytes, expected.source.sourceBytes, `${path}.sourceBytes`);
  equal(observed.sourceEntry, expected.source.entry, `${path}.sourceEntry`);
  positiveInteger(observed.coreVersion, `${path}.coreVersion`);
  const sourceFiles = array(observed.sourceFiles, `${path}.sourceFiles`);
  equal(sourceFiles.length, expected.files.length, `${path}.sourceFiles.length`);
  const expectedFiles = new Map(expected.files.map(file => [file.path, file]));
  for (let index = 0; index < sourceFiles.length; index++) {
    const file = object(sourceFiles[index], `${path}.sourceFiles[${index}]`);
    const pinned = expectedFiles.get(file.path);
    if (!pinned) fail(`${path}.sourceFiles[${index}].path`, `Unpinned source file ${String(file.path)}.`);
    equal(file.byteLength, pinned.byteLength, `${path}.sourceFiles[${index}].byteLength`);
    equal(file.sha256, pinned.sha256, `${path}.sourceFiles[${index}].sha256`);
  }
  const aggregateText = sourceFiles
    .map(file => `${file.path}\t${file.sha256}\t${file.byteLength}\n`)
    .sort((left, right) => left.localeCompare(right))
    .join('');
  equal(createHash('sha256').update(aggregateText).digest('hex'), expected.source.aggregateSha256, `${path}.sourceAggregateSha256`);
  const coverage = object(observed.featureCoverage, `${path}.featureCoverage`);
  for (const key of ['drawableCount', ...OBSERVATION_KEYS]) equal(key === 'drawableCount' ? observed.drawables : coverage[key], expected.observations[key], `${path}.${key}`);
  const recipe = object(observed.evidenceRecipe, `${path}.evidenceRecipe`);
  equal(recipe.profile, manifest.referenceConfiguration.profile, `${path}.evidenceRecipe.profile`);
  equal(recipe.motionId, expected.recipe.motionId, `${path}.evidenceRecipe.motionId`);
  equal(recipe.motionFile, expected.recipe.motionFile, `${path}.evidenceRecipe.motionFile`);
  closeList(recipe.bakedFrameTimes, expected.recipe.bakedFrameTimes, `${path}.evidenceRecipe.bakedFrameTimes`);
  closeList(recipe.referenceTimes, expected.recipe.referenceTimes, `${path}.evidenceRecipe.referenceTimes`);
  equal(observed.sampledAt, expected.recipe.referenceTimes[0], `${path}.sampledAt`);
  equal(observed.recoverySmoke, true, `${path}.recoverySmoke`);
  const comparison = object(observed.comparisonConfiguration, `${path}.comparisonConfiguration`);
  equal(comparison.viewportMode, manifest.referenceConfiguration.fitTransform.viewportMode, `${path}.comparisonConfiguration.viewportMode`);
  equal(comparison.fitPolicy, manifest.referenceConfiguration.fitTransform.policy, `${path}.comparisonConfiguration.fitPolicy`);
  equal(comparison.fitFill, manifest.referenceConfiguration.fitTransform.fill, `${path}.comparisonConfiguration.fitFill`);
  equal(comparison.userZoom, manifest.referenceConfiguration.fitTransform.userZoom, `${path}.comparisonConfiguration.userZoom`);
  closeList(comparison.pan, manifest.referenceConfiguration.fitTransform.pan, `${path}.comparisonConfiguration.pan`);
  equal(comparison.synchronizedViews, manifest.referenceConfiguration.fitTransform.synchronizedViews, `${path}.comparisonConfiguration.synchronizedViews`);
  closeList(comparison.canvas, manifest.referenceConfiguration.fitTransform.canvas, `${path}.comparisonConfiguration.canvas`);
  equal(comparison.targetFormat, manifest.referenceConfiguration.targetFormat, `${path}.comparisonConfiguration.targetFormat`);
  equal(comparison.textureColorSpaceConversion, manifest.referenceConfiguration.textureColorSpaceConversion, `${path}.comparisonConfiguration.textureColorSpaceConversion`);
  equal(comparison.alphaMode, manifest.referenceConfiguration.textureAlphaMode, `${path}.comparisonConfiguration.alphaMode`);
  equal(comparison.antialias, manifest.referenceConfiguration.webglAntialias, `${path}.comparisonConfiguration.antialias`);
  if (!(comparison.resolvedZoom > 0)) fail(`${path}.comparisonConfiguration.resolvedZoom`, 'Resolved comparison zoom must be positive.');
  const diagnostics = array(observed.conversionDiagnostics, `${path}.conversionDiagnostics`);
  for (let index = 0; index < diagnostics.length; index++) {
    const diagnostic = object(diagnostics[index], `${path}.conversionDiagnostics[${index}]`);
    equal(diagnostic.severity, 'warning', `${path}.conversionDiagnostics[${index}].severity`);
    if (!['W_CUBISM_COLOR_APPROXIMATED', 'W_CUBISM_CULLING_IGNORED'].includes(diagnostic.code)) fail(`${path}.conversionDiagnostics[${index}].code`, `Unclassified conversion diagnostic ${String(diagnostic.code)}.`);
    if (typeof diagnostic.path !== 'string' || !diagnostic.path.startsWith('$')) fail(`${path}.conversionDiagnostics[${index}].path`, 'Diagnostic path must be a JSON path.');
  }
  const surface = object(observed.surfaceReadback, `${path}.surfaceReadback`);
  equal(surface.width, manifest.referenceConfiguration.viewport[0], `${path}.surfaceReadback.width`);
  equal(surface.height, manifest.referenceConfiguration.viewport[1], `${path}.surfaceReadback.height`);
  const thresholds = manifest.referenceConfiguration.thresholds;
  if (surface.maxChannelError > thresholds.maxChannelError) fail(`${path}.surfaceReadback.maxChannelError`, 'Maximum channel error exceeds the manifest threshold.');
  if (surface.meanAbsoluteError > thresholds.meanAbsoluteError) fail(`${path}.surfaceReadback.meanAbsoluteError`, 'Mean absolute error exceeds the manifest threshold.');
  if (surface.mismatchRatio > thresholds.mismatchRatio) fail(`${path}.surfaceReadback.mismatchRatio`, 'Mismatch ratio exceeds the manifest threshold.');
  equal(observed.browser?.nativeBackend, true, `${path}.browser.nativeBackend`);
  const gpuAdapter = object(observed.browser?.gpuAdapter, `${path}.browser.gpuAdapter`);
  for (const key of ['vendor', 'architecture', 'device', 'description']) if (typeof gpuAdapter[key] !== 'string') fail(`${path}.browser.gpuAdapter.${key}`, 'GPU adapter identity fields must be strings.');
  if (![gpuAdapter.vendor, gpuAdapter.architecture, gpuAdapter.device, gpuAdapter.description].some(value => value.length > 0)) fail(`${path}.browser.gpuAdapter`, 'GPU adapter identity cannot be empty.');
  equal(observed.browserDiagnostics?.unclassifiedFailureCount, 0, `${path}.browserDiagnostics.unclassifiedFailureCount`);
  const requested = array(observed.requestedProjectFiles, `${path}.requestedProjectFiles`);
  for (let index = 0; index < requested.length; index++) if (FORBIDDEN_RUNTIME_PATH.test(requested[index])) fail(`${path}.requestedProjectFiles[${index}]`, 'Playback project request contains a source runtime or source asset.');
  return Object.freeze({
    id: expected.id,
    title: expected.title,
    sourcePolicy: expected.sourcePolicy,
    rawAssetCommitted: false,
    license: expected.license,
    source: expected.source,
    recipe: expected.recipe,
    observations: expected.observations,
    maskTargetCount: observed.maskTargets,
    coreVersion: observed.coreVersion,
    browser: observed.browser,
    surfaceReadback: observed.surfaceReadback,
    recoverySmoke: true,
    comparisonConfiguration: observed.comparisonConfiguration,
    conversionDiagnostics: diagnostics.map(diagnostic => ({ severity: diagnostic.severity, code: diagnostic.code, path: diagnostic.path })),
    fileInventoryVerified: true,
    unclassifiedFailureCount: 0,
  });
}

function createFeatureEvidence(samples, totals) {
  const evidence = (id, observationKey, acceptedSamples) => Object.freeze({
    id,
    status: 'passed',
    sampleIds: Object.freeze(acceptedSamples.map(sample => sample.id)),
    referenceTimes: Object.freeze([1]),
    observationCount: totals[observationKey],
    diagnosticAttribution: Object.freeze({ codes: Object.freeze([]), paths: Object.freeze([]), unclassifiedFailureCount: 0 }),
    structuralMetrics: Object.freeze({
      drawables: acceptedSamples.reduce((sum, sample) => sum + sample.observations.drawableCount, 0),
      maskTargets: acceptedSamples.reduce((sum, sample) => sum + sample.maskTargetCount, 0),
    }),
    pixelMetrics: Object.freeze(acceptedSamples.map(sample => Object.freeze({
      sampleId: sample.id,
      time: 1,
      maxChannelError: sample.surfaceReadback.maxChannelError,
      meanAbsoluteError: sample.surfaceReadback.meanAbsoluteError,
      mismatchRatio: sample.surfaceReadback.mismatchRatio,
    }))),
    gpuValidation: Object.freeze({ nativeBackend: true, deviceRecovery: acceptedSamples.every(sample => sample.recoverySmoke), adapters: Object.freeze(acceptedSamples.map(sample => Object.freeze({ sampleId: sample.id, ...sample.browser.gpuAdapter }))) }),
    runtimeClosure: Object.freeze({ sourceRuntimeRequested: false, sourceAssetRequested: false }),
  });
  const maskSamples = samples.filter(sample => sample.observations.maskReferenceCount > 0);
  const invertedSamples = samples.filter(sample => sample.observations.invertedMaskDrawableCount > 0);
  const additiveSamples = samples.filter(sample => sample.observations.additiveDrawableCount > 0);
  const multiplicativeSamples = samples.filter(sample => sample.observations.multiplicativeDrawableCount > 0);
  return Object.freeze([
    evidence('mask-composition', 'maskReferenceCount', maskSamples),
    evidence('inverted-mask', 'invertedMaskDrawableCount', invertedSamples),
    evidence('additive-blend', 'additiveDrawableCount', additiveSamples),
    evidence('multiplicative-blend', 'multiplicativeDrawableCount', multiplicativeSamples),
  ]);
}

function createCapabilityRows(totals) {
  return Object.freeze([
    row('drawable-topology', 'Drawable topology / vertex animation', 'supported', 'covered', 'MIT fixture and licensed Core captures'),
    row('normal-blend', 'Normal drawable blend', 'supported', 'covered', 'MIT fixture plus both licensed samples'),
    row('mask-composition', 'Mask composition', 'supported', 'covered', `${totals.maskReferenceCount} observed mask contributions`),
    row('inverted-mask', 'Inverted mask', 'supported', 'covered', `${totals.invertedMaskDrawableCount} observed consumers`),
    row('additive-blend', 'Additive drawable blend', 'supported', 'covered', `${totals.additiveDrawableCount} observed drawables`),
    row('multiplicative-blend', 'Multiplicative drawable blend', 'supported', 'covered', `${totals.multiplicativeDrawableCount} observed drawables`),
    row('multiply-screen-color', 'Multiply / screen drawable color', 'degraded', 'not-covered', 'v1 diagnoses non-neutral tint and strict conversion fails'),
    row('culling', 'Drawable culling', 'unsupported', 'not-covered', 'payload is retained but v1 renderer does not execute culling'),
    row('runtime-parameters', 'Runtime parameters / lip-sync / look input', 'unsupported', 'not-applicable', 'outside the clip-baked profile'),
  ]);
}

function row(id, title, implementationStatus, coverageStatus, detail) { return Object.freeze({ id, title, implementationStatus, coverageStatus, detail }); }
function validateThresholds(value, path) { const thresholds = object(value, path); for (const key of ['maxChannelError', 'meanAbsoluteError', 'mismatchRatio']) { const item = Number(thresholds[key]); if (!Number.isFinite(item) || item <= 0) fail(`${path}.${key}`, 'Threshold must be positive and finite.'); } }
function byDuplicate(values, index, id) { return values.slice(0, index).some(value => value?.id === id); }
function closeList(actualValue, expected, path) { const actual = numberList(actualValue, path, false); equal(actual.length, expected.length, `${path}.length`); for (let index = 0; index < actual.length; index++) if (Math.abs(actual[index] - expected[index]) > 1e-5) fail(`${path}[${index}]`, `Expected ${expected[index]}, received ${actual[index]}.`); }
function numberList(value, path, positive) { const list = array(value, path); if (list.length === 0) fail(path, 'Number list cannot be empty.'); for (let index = 0; index < list.length; index++) { const item = Number(list[index]); if (!Number.isFinite(item) || (positive ? item <= 0 : item < 0)) fail(`${path}[${index}]`, `Expected ${positive ? 'positive' : 'non-negative'} finite number.`); } return list; }
function object(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'Expected an object.'); return value; }
function array(value, path) { if (!Array.isArray(value)) fail(path, 'Expected an array.'); return value; }
function string(value, path) { if (typeof value !== 'string' || value.length === 0) fail(path, 'Expected a non-empty string.'); return value; }
function url(value, path) { string(value, path); try { const parsed = new URL(value); if (parsed.protocol !== 'https:') fail(path, 'URL must use HTTPS.'); } catch (error) { if (error instanceof Live2DFeatureCorpusPolicyError) throw error; fail(path, 'Expected a valid URL.'); } }
function positiveInteger(value, path) { if (!Number.isSafeInteger(value) || value <= 0) fail(path, 'Expected a positive safe integer.'); return value; }
function nonnegativeInteger(value, path) { if (!Number.isSafeInteger(value) || value < 0) fail(path, 'Expected a non-negative safe integer.'); return value; }
function equal(actual, expected, path) { if (actual !== expected) fail(path, `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`); }
function fail(path, message) { throw new Live2DFeatureCorpusPolicyError(path, message); }
