export const RAY_PRODUCT_CANDIDATE_SCHEMA_VERSION = 1;
export const RAY_PRODUCT_CANDIDATE_SUITE = 'm04-g09-ray-tracing-product-candidates';

const EXPECTED_SCENES = Object.freeze(new Map([
  ['ray-analytic-sphere-v1', 'small-analytic'],
  ['ray-pbr-material-room-v1', 'medium-material-light'],
  ['gravity-maze-level-1-ray-v1', 'large-real-product'],
]));
const EXPECTED_BROWSERS = Object.freeze(['chrome', 'edge']);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;

export function validateRayProductCandidateArtifact(artifact, {
  formal = false,
  expectedEngineRevision = null,
  expectedGamesRevision = null,
} = {}) {
  const violations = [];
  equal(artifact?.schemaVersion, RAY_PRODUCT_CANDIDATE_SCHEMA_VERSION, 'schemaVersion');
  equal(artifact?.suite, RAY_PRODUCT_CANDIDATE_SUITE, 'suite');
  equal(artifact?.status, 'passed', 'status');
  equal(artifact?.unclassifiedFailureCount, 0, 'unclassified failure count');

  const evidence = artifact?.evidence;
  if (!Number.isFinite(Date.parse(evidence?.generatedAt ?? ''))) violations.push('evidence generatedAt is invalid');
  match(evidence?.engineRevision, REVISION, 'Engine revision');
  match(evidence?.gamesRevision, REVISION, 'Games revision');
  if (typeof evidence?.engineDirty !== 'boolean') violations.push('Engine dirty identity is missing');
  if (typeof evidence?.gamesDirty !== 'boolean') violations.push('Games dirty identity is missing');
  const expectedKind = evidence?.engineDirty || evidence?.gamesDirty ? 'diagnostic-candidate' : 'formal-candidate';
  equal(evidence?.kind, expectedKind, 'evidence kind');
  if (typeof evidence?.nodeVersion !== 'string' || !/^v\d+\./u.test(evidence.nodeVersion)) {
    violations.push('Node version identity is missing');
  }
  if (formal) {
    equal(evidence?.kind, 'formal-candidate', 'formal evidence kind');
    equal(evidence?.engineDirty, false, 'formal Engine dirty state');
    equal(evidence?.gamesDirty, false, 'formal Games dirty state');
    if (!/^v22\./u.test(evidence?.nodeVersion ?? '')) violations.push('formal evidence must use Node 22');
    if (expectedEngineRevision) equal(evidence?.engineRevision, expectedEngineRevision, 'expected Engine revision');
    if (expectedGamesRevision) equal(evidence?.gamesRevision, expectedGamesRevision, 'expected Games revision');
  }

  const topology = artifact?.bundleTopology;
  positiveInteger(topology?.defaultBundle?.bytes, 'default bundle bytes');
  match(topology?.defaultBundle?.sha256, /^[0-9a-f]{64}$/u, 'default bundle sha256');
  positiveInteger(topology?.rayTracingBundle?.bytes, 'ray tracing bundle bytes');
  match(topology?.rayTracingBundle?.sha256, /^[0-9a-f]{64}$/u, 'ray tracing bundle sha256');
  equal(topology?.defaultContainsRayTracingRuntime, false, 'default RT runtime boundary');
  equal(topology?.optInReferenceOnly, true, 'opt-in RT chunk boundary');

  const sceneClasses = artifact?.sceneClasses ?? [];
  equal(sceneClasses.length, EXPECTED_SCENES.size, 'scene class count');
  for (const expected of EXPECTED_SCENES.values()) {
    if (!sceneClasses.includes(expected)) violations.push(`missing scene class ${expected}`);
  }

  const reports = Array.isArray(artifact?.browsers) ? artifact.browsers : [];
  equal(reports.length, EXPECTED_BROWSERS.length, 'browser report count');
  const seenBrowsers = new Set();
  const referenceCandidates = new Map();
  for (const report of reports) {
    if (!EXPECTED_BROWSERS.includes(report?.browser)) violations.push(`unknown browser ${String(report?.browser)}`);
    if (seenBrowsers.has(report?.browser)) violations.push(`duplicate browser ${String(report?.browser)}`);
    seenBrowsers.add(report?.browser);
    validateBrowserLifecycle(report?.browser, 'examples', report?.browserDiagnostics?.examples);
    validateBrowserLifecycle(report?.browser, 'game', report?.browserDiagnostics?.game);
    validateBrowserEvidence(report?.browser, 'examples', report?.browserEvidence?.examples);
    validateBrowserEvidence(report?.browser, 'game', report?.browserEvidence?.game);
    validateHttpProvenance(report?.browser, report?.httpProvenance);

    const candidates = Array.isArray(report?.candidates) ? report.candidates : [];
    equal(candidates.length, EXPECTED_SCENES.size, `${report?.browser} candidate count`);
    const seenScenes = new Set();
    for (const candidate of candidates) {
      const expectedClass = EXPECTED_SCENES.get(candidate?.fixedSceneId);
      if (!expectedClass) violations.push(`${report?.browser} has unknown scene ${String(candidate?.fixedSceneId)}`);
      else equal(candidate?.sceneClass, expectedClass, `${report?.browser}:${candidate.fixedSceneId} scene class`);
      if (seenScenes.has(candidate?.fixedSceneId)) violations.push(`${report?.browser} duplicate scene ${String(candidate?.fixedSceneId)}`);
      seenScenes.add(candidate?.fixedSceneId);
      match(candidate?.sourceSha256, SHA256, `${report?.browser}:${candidate?.fixedSceneId} source hash`);
      match(candidate?.candidateSha256, SHA256, `${report?.browser}:${candidate?.fixedSceneId} candidate hash`);
      positiveNumber(candidate?.peakBytes, `${report?.browser}:${candidate?.fixedSceneId} peak bytes`);
      positiveNumber(candidate?.liveResourceCount, `${report?.browser}:${candidate?.fixedSceneId} live resources`);
      positiveNumber(candidate?.pixelSummary?.maximumChannel, `${report?.browser}:${candidate?.fixedSceneId} maximum channel`);
      positiveNumber(candidate?.pixelSummary?.nonBlackPixelCount, `${report?.browser}:${candidate?.fixedSceneId} non-black pixels`);
      if (!Number.isInteger(candidate?.diagnosticCount) || candidate.diagnosticCount < 0) {
        violations.push(`${report?.browser}:${candidate?.fixedSceneId} diagnostic count is invalid`);
      }
      const reference = referenceCandidates.get(candidate?.fixedSceneId);
      if (!reference) referenceCandidates.set(candidate?.fixedSceneId, candidate);
      else {
        equal(candidate?.sourceSha256, reference.sourceSha256, `${report?.browser}:${candidate?.fixedSceneId} cross-browser source hash`);
        equal(candidate?.candidateSha256, reference.candidateSha256, `${report?.browser}:${candidate?.fixedSceneId} cross-browser candidate hash`);
      }
    }
    for (const id of EXPECTED_SCENES.keys()) {
      if (!seenScenes.has(id)) violations.push(`${report?.browser} missing scene ${id}`);
    }
  }
  for (const browser of EXPECTED_BROWSERS) {
    if (!seenBrowsers.has(browser)) violations.push(`missing browser ${browser}`);
  }

  return {
    schemaVersion: 1,
    contract: 'haiyue-ray-product-candidate@1',
    mode: formal ? 'formal' : 'diagnostic',
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
  };

  function validateBrowserLifecycle(browser, phase, diagnostics) {
    equal(diagnostics?.consoleErrorCount, 0, `${browser}:${phase} console errors`);
    equal(diagnostics?.exceptionCount, 0, `${browser}:${phase} exceptions`);
    equal(diagnostics?.unclassifiedFailureCount, 0, `${browser}:${phase} unclassified failures`);
    equal(diagnostics?.profileCleanup?.status, 'passed', `${browser}:${phase} profile cleanup`);
    positiveInteger(diagnostics?.profileCleanup?.attempts, `${browser}:${phase} profile cleanup attempts`);
    nonNegativeNumber(diagnostics?.profileCleanup?.durationMs, `${browser}:${phase} profile cleanup duration`);
  }

  function validateBrowserEvidence(browser, phase, value) {
    if (typeof value?.product !== 'string' || value.product.length === 0) violations.push(`${browser}:${phase} product identity is missing`);
    equal(value?.angleBackend, 'd3d11', `${browser}:${phase} ANGLE backend`);
    equal(value?.nativeBackend, true, `${browser}:${phase} native backend`);
  }

  function validateHttpProvenance(browser, provenance) {
    const exampleFiles = provenance?.examples?.files?.map(value => value.sourcePath) ?? [];
    const gameFiles = provenance?.game?.files?.map(value => value.sourcePath) ?? [];
    if (!exampleFiles.includes('examples/ray-tracing/index.html')
      || !exampleFiles.includes('examples/ray-tracing/bundle.js')) {
      violations.push(`${browser}:examples HTTP provenance is incomplete`);
    }
    if (!gameFiles.includes('games/gravity-maze/dist/bundle.js')
      || !gameFiles.some(path => /^games\/gravity-maze\/dist\/chunks\/rayTracingPreview-[^/]+\.js$/u.test(path))) {
      violations.push(`${browser}:game HTTP provenance is incomplete`);
    }
  }

  function equal(actual, expected, label) {
    if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
  function match(actual, expression, label) {
    if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`);
  }
  function positiveInteger(actual, label) {
    if (!Number.isInteger(actual) || actual < 1) violations.push(`${label} must be a positive integer`);
  }
  function positiveNumber(actual, label) {
    if (!Number.isFinite(actual) || actual <= 0) violations.push(`${label} must be positive`);
  }
  function nonNegativeNumber(actual, label) {
    if (!Number.isFinite(actual) || actual < 0) violations.push(`${label} must be non-negative`);
  }
}
