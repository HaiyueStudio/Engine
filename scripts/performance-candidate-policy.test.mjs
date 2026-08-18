import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  candidateProfileRoot,
  validateCandidateRunManifest,
  validateGpuPerformanceCandidate,
  validateSharedPerformanceCandidates,
} from './performance-candidate-policy.mjs';
import {
  loadPerformanceBudgetConfig,
  performanceCandidateEvidencePath,
  performanceEvidencePath,
} from './webgpu-performance-budget.mjs';
import { validateCandidateCpuBenchmarkArtifact } from './benchmark/cpu-benchmark-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadPerformanceBudgetConfig(root);
const editorMemoryBudgetConfig = JSON.parse(
  readFileSync(resolve(root, 'config/editor-memory-budgets.json'), 'utf8'),
);
const revision = 'abcdef1234567890abcdef1234567890abcdef12';
const sourceFingerprint = `sha256:${'1'.repeat(64)}`;
const now = Date.parse('2026-08-06T00:00:00.000Z');

test('candidate paths are disjoint from formal performance evidence paths', () => {
  const candidate = performanceCandidateEvidencePath('apple-integrated', 'render3d.real-frame');
  const formal = performanceEvidencePath('apple-integrated', 'render3d.real-frame');
  assert.equal(candidate, 'artifacts/performance-candidates/apple-integrated/real-renderer.json');
  assert.equal(formal, 'artifacts/webgpu/performance/apple-integrated/real-renderer.json');
  assert.notEqual(candidate, formal);
  assert.equal(candidateProfileRoot(config, 'apple-integrated'), 'artifacts/performance-candidates/apple-integrated');
});

test('candidate runner covers every G04 workload and guards formal paths', () => {
  const source = readFileSync(resolve(root, 'scripts/run-release-performance-candidate.mjs'), 'utf8');
  assert.match(source, /WEBGPU_PERFORMANCE_EVIDENCE_MODE: 'candidate'/);
  assert.match(source, /assertFormalDigestsUnchanged\(formalDigests\)/);
  assert.match(source, /Node 22\+ CPU full three-round cohort/);
  assert.match(source, /nodeMajor < 22/);
  assert.match(source, /verify:webgpu-readback:long/);
  assert.match(source, /verify:gltf-asset/);
  assert.match(source, /hya:dashboard/);
  assert.match(source, /editor and AnimationEditor production cold-start candidate/);
  assert.match(source, /editor and AnimationEditor three-cohort cold-start measurement/);
  assert.match(source, /50k and resource-replacement memory candidate/);
  assert.match(source, /editor 1k\/10k large-project interaction candidate/);
  assert.doesNotMatch(source, /review\/baselines/);
});

test('candidate run manifest requires the exact successful Apple command set and runner identity', () => {
  const labels = [
    'full real-device renderer/reflection/AO candidate',
    'Node 22+ CPU full three-round cohort',
    'WebGPU readback/resource churn 1800 frames',
    'glTF first-visible-frame candidate',
    'HYA network/parse/first-frame candidate',
    'editor and AnimationEditor production cold-start candidate',
    'editor and AnimationEditor three-cohort cold-start measurement',
    '50k and resource-replacement memory candidate',
    'editor 1k/10k large-project interaction candidate',
  ];
  const manifest = {
    schemaVersion: 1,
    goal: 'g04-performance-device-readiness',
    profile: 'apple-integrated',
    revision,
    dirty: false,
    startedAt: '2026-08-06T00:00:00.000Z',
    finishedAt: '2026-08-06T01:00:00.000Z',
    formalBaselineUpdated: false,
    status: 'completed-awaiting-validator',
    environment: candidateEnvelope(),
    commands: labels.map(label => ({
      label,
      command: ['node', 'script.mjs'],
      durationMs: 100,
      status: 0,
      signal: null,
    })),
  };
  const expected = {
    manifest,
    profileId: 'apple-integrated',
    profile: config.profiles['apple-integrated'],
    revision,
  };
  assert.equal(validateCandidateRunManifest(expected).status, 'passed');

  manifest.commands.pop();
  const missing = validateCandidateRunManifest(expected);
  assert.equal(missing.status, 'failed');
  assert.ok(missing.violations.some(item => item.includes('exact required candidate command set')));
});

test('registered Apple full renderer candidate retains timing cohorts, structural metrics, allocation, and identity', () => {
  const artifact = rendererArtifact();
  const validation = validateGpuPerformanceCandidate({
    artifact,
    config,
    profileId: 'apple-integrated',
    suiteId: artifact.suite,
    revision,
    sourceFingerprint,
    now,
  });
  assert.equal(validation.status, 'passed', validation.violations.join('\n'));
  assert.equal(validation.summary.cases.length, 8);
  assert.ok(validation.summary.cases.every(item => Number.isFinite(item.queueWait.p95)));
  assert.ok(validation.summary.cases.every(item => item.drawsPerFrame === 10));
  assert.ok(validation.summary.cases.every(item => item.noise.status === 'available'));

  artifact.results.pop();
  const incomplete = validateGpuPerformanceCandidate({
    artifact,
    config,
    profileId: 'apple-integrated',
    suiteId: artifact.suite,
    revision,
    sourceFingerprint,
    now,
  });
  assert.equal(incomplete.status, 'failed');
  assert.ok(incomplete.violations.some(item => item.includes('matrix is incomplete')));
});

test('candidate validator rejects dirty, software, remote, and unstructured GPU-unavailable evidence', () => {
  const artifact = rendererArtifact();
  artifact.evidence.dirty = true;
  artifact.evidence.remoteSession = true;
  artifact.evidence.adapterFingerprint = 'google swiftshader software';
  artifact.adapter = { vendor: 'google', architecture: 'swiftshader' };
  artifact.results[0].gpuTimestamp = { status: 'unavailable', reason: '' };
  const validation = validateGpuPerformanceCandidate({
    artifact,
    config,
    profileId: 'apple-integrated',
    suiteId: artifact.suite,
    revision,
    sourceFingerprint,
    now,
  });
  assert.equal(validation.status, 'failed');
  assert.ok(validation.violations.some(item => item.includes('dirty source')));
  assert.ok(validation.violations.some(item => item.includes('remote desktop')));
  assert.ok(validation.violations.some(item => item.includes('software adapter')));
  assert.ok(validation.violations.some(item => item.includes('structured unavailable reason')));
});

test('pending Windows profiles stay blocked and carry executable local-console enrollment steps', () => {
  for (const profileId of ['windows-integrated', 'windows-discrete']) {
    const enrollment = config.profiles[profileId].enrollment;
    assert.equal(enrollment.status, 'pending-real-device');
    assert.ok(enrollment.steps.some(step => step.includes('local-console Windows 10 22H2 or newer')));
    assert.ok(enrollment.steps.some(step => step.includes(`--profile ${profileId}`)));
    assert.ok(enrollment.steps.some(step => /RDP|SwiftShader/.test(step)));
  }
});

test('shared candidate validators cover readback, glTF, HYA, editor cold-start, large scene, and memory residuals', () => {
  const envelope = candidateEnvelope();
  const artifacts = {
    readback: {
      candidateEvidence: envelope,
      gate: { status: 'passed' },
      config: { frames: 1800 },
      durationMs: 1000,
      readback: { pendingAfterDrain: 0, skipRate: 0.01, latencyFrames: { p50: 0, p95: 1 } },
      churn: { liveResourcesAfterDrain: 0, releasedOwnerResiduals: 0, peakLiveResources: 10 },
    },
    gltf: {
      candidateEvidence: envelope,
      gate: { status: 'passed' },
      timings: { firstVisibleFrameMs: 100, maxTierFirstVisibleFrameMs: 90 },
      resources: {
        liveGpuResourcesAfterDestroy: 0,
        releasedOwnerResiduals: 0,
        gpuUploadCalls: 4,
        gpuUploadBytes: 1024,
      },
    },
    hya: {
      schemaVersion: 3,
      candidateEvidence: envelope,
      environment: { browser: { userAgent: 'HeadlessChrome/151.0.0.0' }, gitRevision: revision },
      methodology: { parseStabilityRuns: 5, parseAcceptanceThreshold: 1.25 },
      summary: { unclassifiedFailureCount: 0 },
      parseStabilityByCohort: {
        small: { minimum: 1.3, runs: [1.3, 1.4, 1.5, 1.6, 1.7] },
        large: { minimum: 1.4, runs: [1.4, 1.5, 1.6, 1.7, 1.8] },
      },
      cohorts: {
        small: hyaCohort(),
        large: hyaCohort(),
      },
    },
    appStartup: {
      candidateEvidence: envelope,
      suite: 'editor.app-cold-start',
      sourceCandidate: { revision, workingTreeDirty: false, gateStatus: 'passed' },
      configuration: {
        independentBrowserCohorts: 3,
        browserProcessesPerApp: 3,
        totalBrowserProcesses: 6,
        cachePolicy: 'fresh Chrome process and user-data directory per app per cohort',
      },
      cohorts: [1, 2, 3].map(round => ({
        round,
        apps: ['scene-editor', 'animation-editor'].map(id => ({
          id,
          coldStartMs: 30 + round,
          browserEvidence: { product: 'Chrome/151.0.0.0', nativeBackend: true },
        })),
      })),
      gate: { status: 'passed' },
      apps: [
        { id: 'scene-editor', samples: 3, timing: timing(30), status: 'passed' },
        { id: 'animation-editor', samples: 3, timing: timing(40), status: 'passed' },
      ],
    },
    editorLargeScene: {
      candidateEvidence: envelope,
      status: 'passed',
      gate: { passed: true },
      counts: {
        1000: largeSceneCase(1000),
        10000: largeSceneCase(10000),
      },
    },
    editorMemory: {
      schemaVersion: 1,
      candidateEvidence: envelope,
      headCommit: revision,
      scenarios: ['entities-50k', 'long-edit', 'resource-replacement'].map(id => {
        const policy = editorMemoryBudgetConfig.scenarios[id];
        return {
          id,
          parameters: policy.parameters,
          observed: {
            ...policy.expected,
            ...(id === 'resource-replacement' ? { latestResourceRetained: true } : {}),
          },
          metrics: memoryMetrics(),
        };
      }),
    },
  };
  const validation = validateSharedPerformanceCandidates({
    artifacts,
    revision,
    profileId: 'apple-integrated',
    profile: config.profiles['apple-integrated'],
    editorMemoryBudgetConfig,
  });
  assert.equal(validation.status, 'passed', validation.violations.join('\n'));
  assert.equal(validation.checks.readback.summary.frames, 1800);
  assert.equal(validation.checks.editorMemory.summary['resource-replacement'].cleanupHeapResidualBytes, 0);

  artifacts.appStartup.configuration.browserProcessesPerApp = 1;
  const sharedProcessEvidence = validateSharedPerformanceCandidates({
    artifacts,
    revision,
    profileId: 'apple-integrated',
    profile: config.profiles['apple-integrated'],
    editorMemoryBudgetConfig,
  });
  assert.equal(sharedProcessEvidence.status, 'failed');
  assert.ok(sharedProcessEvidence.violations.some(item => item.includes('independent browser processes')));
});

test('CPU candidate accepts Node.js 22+ on a clean fixed Apple runner and requires three complete full rounds', () => {
  const artifact = cpuArtifact();
  const passed = validateCandidateCpuBenchmarkArtifact(artifact, {
    revision,
    runnerProfile: 'apple-m4-pro-fixed',
    caseIds: artifact.results.map(result => result.id),
  });
  assert.equal(passed.status, 'passed', passed.violations.join('\n'));
  assert.equal(passed.summary.cohort.rounds, 3);

  const belowMinimum = cpuArtifact();
  belowMinimum.identity.node = 'v21.7.0';
  const unsupported = validateCandidateCpuBenchmarkArtifact(belowMinimum, {
    revision,
    runnerProfile: 'apple-m4-pro-fixed',
    caseIds: belowMinimum.results.map(result => result.id),
  });
  assert.equal(unsupported.status, 'failed');
  assert.ok(unsupported.violations.some(item => item.includes('Node.js >=22')));

  const incomplete = cpuArtifact();
  incomplete.baselineCohort.rounds = 1;
  incomplete.results[0].baselineCohort.roundEvidence.length = 1;
  const failed = validateCandidateCpuBenchmarkArtifact(incomplete, {
    revision,
    runnerProfile: 'apple-m4-pro-fixed',
    caseIds: incomplete.results.map(result => result.id),
  });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.violations.some(item => item.includes('three complete independent rounds')));
});

function rendererArtifact() {
  const results = [0, 0.01, 0.1, 1].flatMap(dynamicRatio => [1, 4].map(viewCount => ({
    id: `render3d.real-frame.1000e.${dynamicRatio * 100}pct.${viewCount}v`,
    entityCount: 1000,
    dynamicRatio,
    viewCount,
    samples: 90,
    timing: timing(3),
    sampleWall: timing(4),
    queueWait: timing(2),
    timingCohorts: [1, 2, 3].map(round => ({ id: `timing-${round}`, timing: timing(3) })),
    cohortStatistics: { p95: { variance: 0.01 } },
    gpuTimestamp: { status: 'unavailable', reason: 'timestamp-query feature not exposed by this adapter' },
    metrics: {
      drawsPerFrame: 10,
      renderPassesPerFrame: 2,
      bufferUploadsPerFrame: 1,
      uploadBytesPerFrame: 256,
      metricClassification: { strictEquality: { passed: true } },
    },
  })));
  return {
    schemaVersion: 3,
    suite: 'render3d.real-frame',
    mode: 'full',
    generatedAt: '2026-08-06T00:00:00.000Z',
    browser: 'Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36',
    adapter: { vendor: 'apple', architecture: 'metal-3' },
    configuration: {
      dynamicRatios: [0, 0.01, 0.1, 1],
      viewCounts: [1, 4],
      timingCohortCount: 3,
      samplesPerCohort: 30,
    },
    gate: { status: 'passed' },
    performanceBudget: { status: 'passed' },
    allocationProbe: { isolatedFromTiming: true },
    allocationSampling: { sampledBytes: 1024 },
    evidence: {
      schemaVersion: 2,
      kind: 'candidate',
      profile: 'apple-integrated',
      nodePlatform: 'darwin',
      adapterFingerprint: 'apple metal-3',
      revision,
      dirty: false,
      generatedAt: '2026-08-06T00:00:00.000Z',
      sourceFingerprint,
      driver: 'Apple M4 Pro; Metal Supported; macOS 26.5.1 (25F80), arm64',
      operatingSystem: 'macOS 26.5.1 (25F80), arm64',
      runnerLabels: ['self-hosted', 'haiyue-performance', 'apple-integrated'],
      remoteSession: false,
    },
    results,
  };
}

function cpuArtifact() {
  const identity = {
    node: 'v24.8.0',
    v8: '13.6.233.10-node.24',
    platform: 'darwin',
    arch: 'arm64',
    cpu: 'Apple M4 Pro',
    runnerProfile: 'apple-m4-pro-fixed',
    benchmarkProfile: 'full',
    warmup: 8,
    samples: 30,
    iterations: 10,
    revision,
    dirty: false,
  };
  return {
    schemaVersion: 4,
    profile: 'full',
    revision,
    dirty: false,
    identity,
    configuration: {
      benchmarkProfile: 'full', warmup: 8, samples: 30, iterations: 10, caseFilter: [], cohortRounds: 3,
    },
    policy: { mode: 'enforce-cohort' },
    budgetStatus: 'within-budget',
    budgetViolations: [],
    metricBudgetViolations: [],
    baselineCohort: {
      rounds: 3,
      aggregation: 'per-case-median-of-all-independent-process-rounds',
      outlierPolicy: 'retain-all-rounds',
      caseCoverage: 'complete-profile',
    },
    results: [{
      id: 'synthetic.case',
      p50: 1,
      p95: 1.2,
      relativeStddev: 0.02,
      allocationBytesP50: 128,
      baselineCohort: {
        rounds: 3,
        roundEvidence: [1, 2, 3].map(round => ({
          round,
          p50: 1,
          p95: 1.2,
          relativeStddev: 0.02,
          allocationBytesP50: 128,
        })),
      },
    }],
  };
}

function candidateEnvelope() {
  return {
    kind: 'candidate',
    profile: 'apple-integrated',
    revision,
    dirty: false,
    remoteSession: false,
    operatingSystem: 'macOS 26.5.1 (25F80), arm64',
    driver: 'Apple M4 Pro; Metal Supported; macOS 26.5.1 (25F80), arm64',
    node: 'v22.15.0',
    platform: 'darwin-arm64',
    runnerLabels: ['self-hosted', 'haiyue-performance', 'apple-integrated'],
  };
}

function timing(value) {
  return { p50: value, p95: value, sampleCount: 90, rawSamples: new Array(90).fill(value) };
}

function hyaCohort() {
  return {
    sampleCount: 2,
    unclassifiedFailureCount: 0,
    networkP50Ms: 1,
    networkP95Ms: 2,
    firstFrameP50Ms: 3,
    firstFrameP95Ms: 4,
    medianParseSpeedup: 1.5,
  };
}

function largeSceneCase(entityCount) {
  return {
    entityCount,
    metrics: {
      inputToPaint: { sampleCount: 40, p50Ms: 20, p95Ms: 30 },
      hierarchyDrag: { sampleCount: 40, p50Ms: 20, p95Ms: 30 },
      domNodes: 900,
      heapBytes: 10_000_000,
    },
  };
}

function memoryMetrics() {
  return {
    heapDeltaBytes: 1,
    arrayBufferDeltaBytes: 1,
    rssDeltaBytes: 1,
    cleanupHeapResidualBytes: 0,
    cleanupArrayBufferResidualBytes: 0,
  };
}
