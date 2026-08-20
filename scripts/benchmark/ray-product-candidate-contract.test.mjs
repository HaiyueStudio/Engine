import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRayProductCandidateArtifact } from './ray-product-candidate-contract.mjs';

test('ray product artifact accepts complete diagnostic evidence and rejects it as formal', () => {
  const artifact = fixtureArtifact();
  assert.equal(validateRayProductCandidateArtifact(artifact).status, 'passed');
  const formal = validateRayProductCandidateArtifact(artifact, { formal: true });
  assert.equal(formal.status, 'failed');
  assert.ok(formal.violations.some(value => value.includes('formal evidence kind')));
});

test('ray product artifact accepts a clean Node 22 revision-bound formal candidate', () => {
  const artifact = fixtureArtifact();
  artifact.evidence.kind = 'formal-candidate';
  artifact.evidence.engineDirty = false;
  artifact.evidence.gamesDirty = false;
  artifact.evidence.nodeVersion = 'v22.23.2';
  assert.equal(validateRayProductCandidateArtifact(artifact, {
    formal: true,
    expectedEngineRevision: 'a'.repeat(40),
    expectedGamesRevision: 'b'.repeat(40),
  }).status, 'passed');
});

test('ray product artifact rejects topology, device, lifecycle, coverage and hash drift', () => {
  const artifact = fixtureArtifact();
  artifact.bundleTopology.defaultContainsRayTracingRuntime = true;
  artifact.browsers[0].browserEvidence.examples.nativeBackend = false;
  artifact.browsers[0].browserDiagnostics.game.profileCleanup.status = 'failed';
  artifact.browsers[1].candidates[2].sourceSha256 = `sha256:${'f'.repeat(64)}`;
  artifact.browsers[1].candidates.pop();
  const validation = validateRayProductCandidateArtifact(artifact);
  assert.equal(validation.status, 'failed');
  for (const expected of ['default RT runtime boundary', 'native backend', 'profile cleanup', 'candidate count', 'missing scene']) {
    assert.ok(validation.violations.some(value => value.includes(expected)), expected);
  }
});

function fixtureArtifact() {
  const scenes = [
    ['small-analytic', 'ray-analytic-sphere-v1', '1'],
    ['medium-material-light', 'ray-pbr-material-room-v1', '2'],
    ['large-real-product', 'gravity-maze-level-1-ray-v1', '3'],
  ];
  return {
    schemaVersion: 1,
    suite: 'm04-g09-ray-tracing-product-candidates',
    status: 'passed',
    evidence: {
      kind: 'diagnostic-candidate',
      generatedAt: '2026-08-19T00:00:00.000Z',
      engineRevision: 'a'.repeat(40),
      engineDirty: true,
      gamesRevision: 'b'.repeat(40),
      gamesDirty: true,
      nodeVersion: 'v24.19.0',
    },
    sceneClasses: scenes.map(([sceneClass]) => sceneClass),
    bundleTopology: {
      defaultBundle: { bytes: 100, sha256: 'a'.repeat(64) },
      rayTracingBundle: { bytes: 20, sha256: 'b'.repeat(64) },
      defaultContainsRayTracingRuntime: false,
      optInReferenceOnly: true,
    },
    browsers: ['chrome', 'edge'].map(browser => ({
      browser,
      candidates: scenes.map(([sceneClass, fixedSceneId, hash]) => ({
        sceneClass,
        fixedSceneId,
        fixedCameraReplayId: `${fixedSceneId}:camera`,
        sourceSha256: `sha256:${hash.repeat(64)}`,
        candidateSha256: `sha256:${hash.repeat(64)}`,
        peakBytes: 1024,
        liveResourceCount: 1,
        diagnosticCount: 0,
        pixelSummary: { maximumChannel: 255, nonBlackPixelCount: 10, meanRgb: [1, 2, 3] },
      })),
      browserEvidence: {
        examples: { product: browser, angleBackend: 'd3d11', nativeBackend: true },
        game: { product: browser, angleBackend: 'd3d11', nativeBackend: true },
      },
      browserDiagnostics: {
        examples: diagnostics(),
        game: diagnostics(),
      },
      httpProvenance: {
        examples: { files: [{ sourcePath: 'examples/ray-tracing/index.html' }, { sourcePath: 'examples/ray-tracing/bundle.js' }] },
        game: { files: [{ sourcePath: 'games/gravity-maze/dist/bundle.js' }, { sourcePath: 'games/gravity-maze/dist/chunks/rayTracingPreview-fixture.js' }] },
      },
    })),
    unclassifiedFailureCount: 0,
  };
}

function diagnostics() {
  return {
    consoleErrorCount: 0,
    exceptionCount: 0,
    unclassifiedFailureCount: 0,
    profileCleanup: { status: 'passed', attempts: 1, durationMs: 1 },
  };
}
