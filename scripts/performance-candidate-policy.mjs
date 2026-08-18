import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createPerformanceSourceFingerprint,
  evaluatePerformanceBudget,
  performanceCandidateEvidencePath,
  selectPerformanceProfile,
} from './webgpu-performance-budget.mjs';
import { validateCandidateCpuBenchmarkArtifact } from './benchmark/cpu-benchmark-policy.mjs';
import { createBenchmarkCases } from './benchmark/suite.mjs';
import { evaluateEditorMemoryArtifact } from './editor-memory-budget-policy.mjs';

export const PERFORMANCE_CANDIDATE_FILES = Object.freeze({
  cpu: 'cpu-full.json',
  readback: 'readback-1800.json',
  gltf: 'gltf-first-frame.json',
  hya: 'hya-network-parse-first-frame.json',
  appStartup: 'editor-app-cold-start.json',
  editorLargeScene: 'editor-large-scene.json',
  editorMemory: 'editor-memory.json',
  report: 'report.json',
});

const REQUIRED_CANDIDATE_COMMAND_LABELS = Object.freeze({
  'apple-integrated': Object.freeze([
    'full real-device renderer/reflection/AO candidate',
    'Node 22+ CPU full three-round cohort',
    'WebGPU readback/resource churn 1800 frames',
    'glTF first-visible-frame candidate',
    'HYA network/parse/first-frame candidate',
    'editor and AnimationEditor production cold-start candidate',
    'editor and AnimationEditor three-cohort cold-start measurement',
    '50k and resource-replacement memory candidate',
    'editor 1k/10k large-project interaction candidate',
  ]),
  'windows-integrated': Object.freeze([
    'full real-device renderer/reflection/AO candidate',
  ]),
  'windows-discrete': Object.freeze([
    'full real-device renderer/reflection/AO candidate',
  ]),
});

export function candidateProfileRoot(config, profileId) {
  return `${config.candidateEvidence.root}/${profileId}`;
}

export function validateCandidateRunManifest({ manifest, profileId, profile, revision }) {
  if (!manifest) return failed([`${profileId}: candidate run manifest is missing`]);
  const violations = [];
  check(manifest.schemaVersion === 1, `${profileId}: run manifest schemaVersion must be 1`, violations);
  check(manifest.goal === 'g04-performance-device-readiness', `${profileId}: run manifest goal is invalid`, violations);
  check(manifest.profile === profileId, `${profileId}: run manifest profile is invalid`, violations);
  check(manifest.status === 'completed-awaiting-validator',
    `${profileId}: candidate run did not complete successfully`, violations);
  check(manifest.revision === revision && manifest.dirty === false,
    `${profileId}: candidate run manifest is not bound to the clean expected revision`, violations);
  check(manifest.formalBaselineUpdated === false,
    `${profileId}: candidate run manifest claims a formal baseline update`, violations);
  const startedAt = Date.parse(manifest.startedAt ?? '');
  const finishedAt = Date.parse(manifest.finishedAt ?? '');
  check(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt,
    `${profileId}: candidate run timestamps are invalid`, violations);

  const environment = manifest.environment;
  check(environment?.kind === 'candidate', `${profileId}: run manifest candidate identity is missing`, violations);
  check(environment?.profile === profileId, `${profileId}: run manifest environment profile is invalid`, violations);
  check(environment?.revision === revision && environment?.dirty === false,
    `${profileId}: run manifest environment is not clean and revision-bound`, violations);
  check(environment?.remoteSession === false,
    `${profileId}: run manifest environment was a remote session`, violations);
  check(nonEmpty(environment?.operatingSystem), `${profileId}: run manifest OS fingerprint is missing`, violations);
  check(nonEmpty(environment?.driver), `${profileId}: run manifest driver fingerprint is missing`, violations);
  check(includesEvery(environment?.runnerLabels, profile?.enrollment?.runnerLabels),
    `${profileId}: run manifest runner labels are incomplete`, violations);

  const expectedLabels = REQUIRED_CANDIDATE_COMMAND_LABELS[profileId] ?? [];
  const commands = Array.isArray(manifest.commands) ? manifest.commands : [];
  const actualLabels = commands.map(command => command?.label);
  check(commands.length === expectedLabels.length
    && new Set(actualLabels).size === expectedLabels.length
    && expectedLabels.every(label => actualLabels.includes(label)),
  `${profileId}: run manifest does not contain the exact required candidate command set`, violations);
  for (const command of commands) {
    check(command?.status === 0 && !command?.signal,
      `${profileId}: candidate command ${command?.label ?? 'unknown'} did not exit cleanly`, violations);
    check(Array.isArray(command?.command) && command.command.every(nonEmpty),
      `${profileId}: candidate command ${command?.label ?? 'unknown'} has no executable argv`, violations);
    check(Number.isFinite(command?.durationMs) && command.durationMs >= 0,
      `${profileId}: candidate command ${command?.label ?? 'unknown'} has no duration`, violations);
  }
  return resultWithSummary(violations, {
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    commands: commands.map(command => ({ label: command.label, durationMs: command.durationMs })),
    environment,
  });
}

export function validateGpuPerformanceCandidate({
  artifact,
  config,
  profileId,
  suiteId,
  revision,
  sourceFingerprint,
  now = Date.now(),
  evidenceKind = 'candidate',
}) {
  const violations = [];
  const profile = config.profiles[profileId];
  check(Boolean(profile), `${profileId}: profile is not registered`, violations);
  if (!profile) return failed(violations);
  check(profile.tier === 'required', `${profileId}: candidate profile must be required`, violations);
  check(profile.enrollment?.status === 'enrolled', `${profileId}: real device enrollment is pending`, violations);
  check(artifact?.suite === suiteId, `${suiteId}: suite identity is invalid`, violations);
  check(artifact?.mode === 'full', `${suiteId}: candidate must use the full workload`, violations);
  check(artifact?.gate?.status === 'passed', `${suiteId}: correctness gate did not pass`, violations);
  check(artifact?.performanceBudget?.status === 'passed', `${suiteId}: performance budget did not pass`, violations);
  check(artifact?.evidence?.schemaVersion === 2, `${suiteId}: evidence schemaVersion must be 2`, violations);
  check(artifact?.evidence?.kind === evidenceKind,
    `${suiteId}: evidence kind must be ${evidenceKind}`, violations);
  check(artifact?.evidence?.profile === profileId, `${suiteId}: evidence profile is invalid`, violations);
  check(artifact?.evidence?.revision === revision, `${suiteId}: evidence revision does not match ${revision}`, violations);
  check(artifact?.evidence?.dirty === false, `${suiteId}: dirty source cannot be candidate evidence`, violations);
  check(artifact?.evidence?.remoteSession === false, `${suiteId}: remote desktop sessions cannot be candidate evidence`, violations);
  check(nonEmpty(artifact?.evidence?.driver), `${suiteId}: display driver fingerprint is missing`, violations);
  check(nonEmpty(artifact?.evidence?.operatingSystem), `${suiteId}: operating-system fingerprint is missing`, violations);
  check(
    includesEvery(artifact?.evidence?.runnerLabels, profile.enrollment?.runnerLabels),
    `${suiteId}: self-hosted runner labels do not match ${profileId}`,
    violations,
  );
  check(
    artifact?.evidence?.sourceFingerprint === sourceFingerprint,
    `${suiteId}: executable source fingerprint does not match the current candidate`,
    violations,
  );
  checkFresh(artifact?.evidence?.generatedAt, config.evidenceMaxAgeHours, now, `${suiteId}: evidence`, violations);

  const adapterText = artifact?.evidence?.adapterFingerprint ?? '';
  check(!isSoftwareAdapter(adapterText), `${suiteId}: software adapter is not physical-device evidence`, violations);
  try {
    selectPerformanceProfile(config, {
      nodePlatform: artifact?.evidence?.nodePlatform,
      adapter: artifact?.adapter,
    }, profileId);
  } catch (error) {
    violations.push(`${suiteId}: ${error.message}`);
  }
  if (profile.enrollment?.adapterFingerprint) {
    check(
      adapterText === profile.enrollment.adapterFingerprint,
      `${suiteId}: adapter fingerprint is not the reviewed ${profileId} fingerprint`,
      violations,
    );
  }
  if (profile.enrollment?.driver) {
    check(artifact?.evidence?.driver === profile.enrollment.driver,
      `${suiteId}: driver fingerprint is not the reviewed ${profileId} driver`, violations);
  }
  if (profile.enrollment?.operatingSystem) {
    check(artifact?.evidence?.operatingSystem === profile.enrollment.operatingSystem,
      `${suiteId}: operating system is not the reviewed ${profileId} environment`, violations);
  }
  checkBrowserEnrollment(artifact?.browser, profile.enrollment?.browser, suiteId, violations);

  try {
    const reevaluated = evaluatePerformanceBudget(config, profileId, suiteId, 'full', artifact);
    check(reevaluated.status === 'passed', `${suiteId}: current checked-in budget failed`, violations);
  } catch (error) {
    violations.push(`${suiteId}: budget re-evaluation failed: ${error.message}`);
  }
  validateGpuStructure(artifact, suiteId, config, violations);
  return {
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    summary: summarizeGpuArtifact(artifact, suiteId),
  };
}

export function validateSharedPerformanceCandidates({
  artifacts,
  revision,
  profileId,
  profile,
  editorMemoryBudgetConfig,
}) {
  const identity = { profileId, profile };
  const checks = {};
  checks.readback = validateReadback(artifacts.readback, revision, identity);
  checks.gltf = validateGltf(artifacts.gltf, revision, identity);
  checks.hya = validateHya(artifacts.hya, revision, identity);
  checks.appStartup = validateAppStartup(artifacts.appStartup, revision, identity);
  checks.editorLargeScene = validateEditorLargeScene(artifacts.editorLargeScene, revision, identity);
  checks.editorMemory = validateEditorMemory(
    artifacts.editorMemory,
    revision,
    identity,
    editorMemoryBudgetConfig,
  );
  const violations = Object.entries(checks).flatMap(([id, result]) => (
    result.violations.map(violation => `${id}: ${violation}`)
  ));
  return { status: violations.length === 0 ? 'passed' : 'failed', violations, checks };
}

export function validateCandidateProfileFromDisk(root, config, profileId, options = {}) {
  const revision = options.revision ?? git(root, ['rev-parse', 'HEAD']);
  const benchmarkRoot = options.benchmarkRoot ?? root;
  const sourceFingerprint = options.sourceFingerprint
    ?? createPerformanceSourceFingerprint(root, benchmarkRoot);
  const profileRoot = resolve(root, candidateProfileRoot(config, profileId));
  const runManifest = readArtifact(resolve(profileRoot, 'run-manifest.json'));
  const gpu = {};
  const violations = [];
  const runManifestValidation = validateCandidateRunManifest({
    manifest: runManifest,
    profileId,
    profile: config.profiles[profileId],
    revision,
  });
  violations.push(...runManifestValidation.violations);
  for (const suiteId of Object.keys(config.suites)) {
    const path = resolve(root, performanceCandidateEvidencePath(profileId, suiteId));
    const artifact = readArtifact(path);
    if (!artifact) {
      const result = failed([`${suiteId}: candidate artifact is missing`]);
      gpu[suiteId] = result;
      violations.push(...result.violations);
      continue;
    }
    const result = validateGpuPerformanceCandidate({
      artifact,
      config,
      profileId,
      suiteId,
      revision,
      sourceFingerprint,
      now: options.now,
    });
    gpu[suiteId] = result;
    violations.push(...result.violations);
  }

  let cpu = null;
  let shared = null;
  if (profileId === 'apple-integrated') {
    const cpuArtifact = readArtifact(resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.cpu));
    cpu = cpuArtifact
      ? validateCandidateCpuBenchmarkArtifact(cpuArtifact, {
        revision,
        runnerProfile: config.profiles[profileId].enrollment.cpuRunnerProfile,
        caseIds: createBenchmarkCases('full').map(item => item.id),
      })
      : failed(['CPU full-cohort candidate artifact is missing']);
    violations.push(...cpu.violations);
    const sharedArtifacts = Object.fromEntries(
      ['readback', 'gltf', 'hya', 'appStartup', 'editorLargeScene', 'editorMemory']
        .map(id => [id, readArtifact(resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES[id]))]),
    );
    const editorMemoryBudgetConfig = readArtifact(
      resolve(root, 'config/editor-memory-budgets.json'),
    );
    shared = validateSharedPerformanceCandidates({
      artifacts: sharedArtifacts,
      revision,
      profileId,
      profile: config.profiles[profileId],
      editorMemoryBudgetConfig,
    });
    violations.push(...shared.violations);
  }

  const enrollment = config.profiles[profileId]?.enrollment;
  if (enrollment?.status !== 'enrolled') {
    violations.push(`${profileId}: ${enrollment?.status ?? 'missing-enrollment'}; ${enrollment?.steps?.join(' ') ?? ''}`);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    goal: 'g04-performance-device-readiness',
    profile: profileId,
    revision,
    sourceFingerprint,
    environment: runManifest?.environment ?? null,
    runManifest: runManifest ? {
      startedAt: runManifest.startedAt,
      finishedAt: runManifest.finishedAt,
      status: runManifest.status,
      commands: runManifest.commands,
      formalBaselineUpdated: runManifest.formalBaselineUpdated,
      validation: runManifestValidation,
    } : null,
    candidateState: violations.length === 0
      ? 'candidate-passed-g07-formal-replay-required'
      : 'blocked',
    formalBaselineUpdated: false,
    enrollment,
    gpu,
    cpu,
    shared,
    gate: { status: violations.length === 0 ? 'passed' : 'blocked', violations },
  };
}

function validateGpuStructure(artifact, suiteId, config, violations) {
  if (suiteId === 'render3d.real-frame') {
    const expectedCases = (artifact.configuration?.dynamicRatios?.length ?? 0)
      * (artifact.configuration?.viewCounts?.length ?? 0);
    check(expectedCases > 0 && artifact.results?.length === expectedCases,
      `${suiteId}: full dynamic-ratio/view matrix is incomplete`, violations);
    check(artifact.configuration?.timingCohortCount >= config.candidateEvidence.requiredTimingCohorts,
      `${suiteId}: at least three independent timing cohorts are required`, violations);
    check(artifact.configuration?.samplesPerCohort >= 30,
      `${suiteId}: each timing cohort requires at least 30 samples`, violations);
    check(artifact.allocationProbe?.isolatedFromTiming === true,
      `${suiteId}: isolated allocation pass is missing`, violations);
    check(Number.isFinite(artifact.allocationSampling?.sampledBytes),
      `${suiteId}: allocation sampling summary is missing`, violations);
    for (const item of artifact.results ?? []) {
      check(item.samples >= artifact.configuration.samplesPerCohort
        * artifact.configuration.timingCohortCount,
      `${item.id}: pooled timing sample count is incomplete`, violations);
      checkTiming({ ...item.timing, sampleCount: item.samples }, `${item.id}.timing`, violations);
      checkTiming(item.sampleWall, `${item.id}.sampleWall`, violations);
      checkTiming(item.queueWait, `${item.id}.queueWait`, violations);
      check(Array.isArray(item.timingCohorts)
        && item.timingCohorts.length >= config.candidateEvidence.requiredTimingCohorts,
      `${item.id}: timing cohort evidence is incomplete`, violations);
      for (const metric of ['drawsPerFrame', 'renderPassesPerFrame', 'bufferUploadsPerFrame', 'uploadBytesPerFrame']) {
        check(Number.isFinite(item.metrics?.[metric]), `${item.id}: ${metric} is missing`, violations);
      }
      check(item.metrics?.metricClassification?.strictEquality?.passed === true,
        `${item.id}: structural metric attribution did not reconcile`, violations);
      validateOptionalGpuTimestamp(item, violations);
    }
  } else if (suiteId === 'render3d.planar-reflection') {
    check(artifact.configuration?.executedCases === artifact.configuration?.fullMatrixCases,
      `${suiteId}: full reflection matrix was not executed`, violations);
    check(artifact.configuration?.budgetSamples >= 40,
      `${suiteId}: budget cases require at least 40 samples`, violations);
    check(artifact.benchmarkResults?.length === artifact.configuration?.executedCases,
      `${suiteId}: executed matrix case evidence is incomplete`, violations);
    for (const item of artifact.benchmarkResults ?? []) {
      check(item.samples >= (item.performanceBudgetCase
        ? artifact.configuration.budgetSamples
        : artifact.configuration.nonBudgetMatrixSamples),
      `${item.id}: planar-reflection sample count is incomplete`, violations);
      checkTiming({ ...item.timing, sampleCount: item.samples }, `${item.id}.timing`, violations);
      for (const metric of ['drawsPerFrame', 'renderPassesPerFrame', 'bufferUploadsPerFrame', 'uploadBytesPerFrame']) {
        check(Number.isFinite(item.metrics?.[metric]), `${item.id}: ${metric} is missing`, violations);
      }
      check(item.metrics?.metricClassification?.strictEquality?.passed === true,
        `${item.id}: structural metric attribution did not reconcile`, violations);
    }
  } else if (suiteId === 'ambient-occlusion.gpu-cost') {
    check(artifact.capabilities?.timestampQuery?.status === 'available',
      `${suiteId}: timestamp-query unavailable: ${artifact.capabilities?.timestampQuery?.reason ?? 'reason missing'}`,
      violations);
    check(artifact.configuration?.warmupCount >= 8, `${suiteId}: warmup must be at least 8`, violations);
    check(artifact.configuration?.sampleCount >= 30, `${suiteId}: sample count must be at least 30`, violations);
    check(artifact.cases?.length === artifact.configuration?.caseCount,
      `${suiteId}: full AO case matrix is incomplete`, violations);
    check(artifact.artifactValidation?.status === 'passed', `${suiteId}: artifact validator did not pass`, violations);
    for (const item of artifact.cases ?? []) {
      for (const channel of ['occlusion', 'denoise', 'upscale', 'total']) {
        checkTiming(item.gpu?.[channel], `${item.id}.gpu.${channel}`, violations);
      }
    }
  }
}

function validateOptionalGpuTimestamp(item, violations) {
  const timestamp = item.gpuTimestamp;
  if (timestamp?.status === 'available') {
    checkTiming(timestamp.timing, `${item.id}.gpuTimestamp`, violations);
    const passLabels = timestamp.passLabels
      ?? timestamp.cohorts?.flatMap(cohort => cohort.passLabels ?? []);
    check(Array.isArray(passLabels) && passLabels.length > 0,
      `${item.id}: GPU pass attribution is missing`, violations);
    return;
  }
  check(timestamp?.status === 'unavailable' && nonEmpty(timestamp.reason),
    `${item.id}: GPU timestamp must be measured or carry a structured unavailable reason`, violations);
}

function validateReadback(artifact, revision, identity) {
  if (!artifact) return failed(['readback artifact is missing']);
  const violations = commonCandidateEnvelope(artifact, revision, 'readback', identity);
  check(artifact?.gate?.status === 'passed', 'gate did not pass', violations);
  check(artifact?.config?.frames === 1800, 'long candidate must run exactly 1800 frames', violations);
  check(artifact?.readback?.pendingAfterDrain === 0, 'readback mappings remain pending', violations);
  check(artifact?.churn?.liveResourcesAfterDrain === 0, 'live GPU resources remain after drain', violations);
  check(artifact?.churn?.releasedOwnerResiduals === 0, 'released owner residuals remain', violations);
  check(Number.isFinite(artifact?.readback?.latencyFrames?.p95), 'readback latency P95 is missing', violations);
  return resultWithSummary(violations, artifact && {
    frames: artifact.config?.frames,
    durationMs: artifact.durationMs,
    latencyFrames: artifact.readback?.latencyFrames,
    skipRate: artifact.readback?.skipRate,
    peakLiveResources: artifact.churn?.peakLiveResources,
    residuals: artifact.churn?.releasedOwnerResiduals,
  });
}

function validateGltf(artifact, revision, identity) {
  if (!artifact) return failed(['glTF artifact is missing']);
  const violations = commonCandidateEnvelope(artifact, revision, 'gltf', identity);
  check(artifact?.gate?.status === 'passed', 'gate did not pass', violations);
  check(Number.isFinite(artifact?.timings?.firstVisibleFrameMs), 'first-visible-frame timing is missing', violations);
  check(artifact?.resources?.liveGpuResourcesAfterDestroy === 0, 'GPU resources remain after destroy', violations);
  check(artifact?.resources?.releasedOwnerResiduals === 0, 'released owner residuals remain', violations);
  return resultWithSummary(violations, artifact && {
    firstVisibleFrameMs: artifact.timings?.firstVisibleFrameMs,
    maxTierFirstVisibleFrameMs: artifact.timings?.maxTierFirstVisibleFrameMs,
    gpuUploadCalls: artifact.resources?.gpuUploadCalls,
    gpuUploadBytes: artifact.resources?.gpuUploadBytes,
    residuals: artifact.resources?.releasedOwnerResiduals,
  });
}

function validateHya(artifact, revision, identity) {
  if (!artifact) return failed(['HYA artifact is missing']);
  const violations = commonCandidateEnvelope(artifact, revision, 'HYA', identity);
  check(artifact?.schemaVersion === 3, 'report schemaVersion must be 3', violations);
  check(artifact?.environment?.gitRevision === revision, 'internal git revision does not match the candidate', violations);
  check(Boolean(artifact?.environment?.browser), 'browser environment is missing', violations);
  checkBrowserEnrollment(
    artifact?.environment?.browser?.userAgent,
    identity?.profile?.enrollment?.browser,
    'HYA',
    violations,
  );
  check(artifact?.summary?.unclassifiedFailureCount === 0, 'unclassified conversion failures remain', violations);
  const stabilityRunCount = artifact?.methodology?.parseStabilityRuns;
  const parseThreshold = artifact?.methodology?.parseAcceptanceThreshold;
  check(Number.isInteger(stabilityRunCount) && stabilityRunCount >= 5,
    'parse stability requires at least five independent runs', violations);
  check(Number.isFinite(parseThreshold) && parseThreshold > 0,
    'parse acceptance threshold is missing', violations);
  for (const cohort of ['small', 'large']) {
    const summary = artifact?.cohorts?.[cohort];
    const stability = artifact?.parseStabilityByCohort?.[cohort];
    check(summary?.sampleCount > 0, `${cohort} corpus is empty`, violations);
    check(summary?.unclassifiedFailureCount === 0,
      `${cohort}.unclassifiedFailureCount must be zero`, violations);
    for (const metric of ['networkP50Ms', 'networkP95Ms', 'firstFrameP50Ms', 'firstFrameP95Ms']) {
      check(Number.isFinite(summary?.[metric]), `${cohort}.${metric} is missing`, violations);
    }
    check(Number.isFinite(summary?.medianParseSpeedup), `${cohort}.medianParseSpeedup is missing`, violations);
    check(Array.isArray(stability?.runs)
      && stability.runs.length === stabilityRunCount
      && stability.runs.every(Number.isFinite),
    `${cohort}.parseStability runs are incomplete`, violations);
    check(Number.isFinite(stability?.minimum), `${cohort}.parseStability minimum is missing`, violations);
  }
  check(artifact?.parseStabilityByCohort?.small?.minimum >= parseThreshold,
    'small corpus parse stability is below the acceptance threshold', violations);
  return resultWithSummary(violations, artifact && {
    parseStability: artifact.parseStabilityByCohort,
    small: artifact.cohorts?.small,
    large: artifact.cohorts?.large,
  });
}

function validateAppStartup(artifact, revision, identity) {
  if (!artifact) return failed(['editor app cold-start artifact is missing']);
  const violations = commonCandidateEnvelope(artifact, revision, 'app startup', identity);
  check(artifact?.suite === 'editor.app-cold-start', 'cold-start suite identity is invalid', violations);
  check(artifact?.sourceCandidate?.revision === revision, 'internal source revision does not match the candidate', violations);
  check(artifact?.sourceCandidate?.workingTreeDirty === false, 'internal source state is dirty', violations);
  check(artifact?.sourceCandidate?.gateStatus === 'passed', 'G03 production app candidate did not pass', violations);
  check(artifact?.configuration?.independentBrowserCohorts >= 3,
    'at least three independent browser cohorts are required', violations);
  check(artifact?.configuration?.browserProcessesPerApp >= 3,
    'each app requires at least three independent browser processes', violations);
  check(
    artifact?.configuration?.totalBrowserProcesses
      === artifact?.configuration?.browserProcessesPerApp * 2,
    'cold-start browser process accounting is incomplete',
    violations,
  );
  check(
    artifact?.configuration?.cachePolicy
      === 'fresh Chrome process and user-data directory per app per cohort',
    'cold-start evidence did not isolate browser cache/profile state per app',
    violations,
  );
  check(artifact?.gate?.status === 'passed', 'app cold-start gate did not pass', violations);
  for (const id of ['scene-editor', 'animation-editor']) {
    const app = artifact?.apps?.find(item => item.id === id);
    checkTiming(app?.timing, `${id}.coldStart`, violations);
    check(app?.samples >= 3, `${id} cold-start cohort is incomplete`, violations);
    check(app?.status === 'passed', `${id} cold-start budget did not pass`, violations);
    const isolatedRuns = artifact?.cohorts?.map(cohort => (
      cohort.apps?.find(item => item.id === id)
    ));
    check(isolatedRuns?.length >= 3 && isolatedRuns.every(run => (
      Number.isFinite(run?.coldStartMs)
      && nonEmpty(run?.browserEvidence?.product)
      && run?.browserEvidence?.nativeBackend === true
    )), `${id} does not have three native independent-browser runs`, violations);
    for (const run of isolatedRuns ?? []) {
      checkBrowserEnrollment(
        run?.browserEvidence?.product,
        identity?.profile?.enrollment?.browser,
        `${id}.coldStart`,
        violations,
      );
    }
  }
  return resultWithSummary(violations, artifact && Object.fromEntries(
    (artifact.apps ?? []).map(app => [app.id, {
      timing: app.timing,
      samples: app.samples,
      maxColdStartMs: app.maxColdStartMs,
      startupClosureGzipBytes: app.startupClosureGzipBytes,
    }]),
  ));
}

function validateEditorLargeScene(artifact, revision, identity) {
  if (!artifact) return failed(['editor large-scene artifact is missing']);
  const violations = commonCandidateEnvelope(artifact, revision, 'editor large scene', identity);
  check(artifact?.status === 'passed' && artifact?.gate?.passed === true, 'large-scene gate did not pass', violations);
  for (const count of [1000, 10000]) {
    const item = artifact?.counts?.[count];
    check(item?.entityCount === count, `${count}-entity case is missing`, violations);
    checkTimingMs(item?.metrics?.inputToPaint, `${count}.inputToPaint`, violations);
    checkTimingMs(item?.metrics?.hierarchyDrag, `${count}.hierarchyDrag`, violations);
    check(Number.isFinite(item?.metrics?.heapBytes), `${count}.heapBytes is missing`, violations);
  }
  return resultWithSummary(violations, artifact && Object.fromEntries(
    Object.entries(artifact.counts ?? {}).map(([count, item]) => [count, {
      inputToPaint: item.metrics?.inputToPaint,
      hierarchyDrag: item.metrics?.hierarchyDrag,
      domNodes: item.metrics?.domNodes,
      heapBytes: item.metrics?.heapBytes,
    }]),
  ));
}

function validateEditorMemory(artifact, revision, identity, budgetConfig) {
  if (!artifact) return failed(['editor memory artifact is missing']);
  const violations = commonCandidateEnvelope(artifact, revision, 'editor memory', identity);
  check(artifact?.headCommit === revision, 'internal head commit does not match the candidate', violations);
  if (!budgetConfig) {
    violations.push('current editor memory budget configuration is missing');
  } else {
    try {
      violations.push(...evaluateEditorMemoryArtifact(budgetConfig, artifact).violations);
    } catch (error) {
      violations.push(`editor memory budget re-evaluation failed: ${error.message}`);
    }
  }
  for (const id of ['entities-50k', 'long-edit', 'resource-replacement']) {
    const scenario = artifact?.scenarios?.find(item => item.id === id);
    check(Boolean(scenario), `${id} scenario is missing`, violations);
    for (const metric of [
      'heapDeltaBytes',
      'arrayBufferDeltaBytes',
      'rssDeltaBytes',
      'cleanupHeapResidualBytes',
      'cleanupArrayBufferResidualBytes',
    ]) check(Number.isFinite(scenario?.metrics?.[metric]), `${id}.${metric} is missing`, violations);
  }
  const replacement = artifact?.scenarios?.find(item => item.id === 'resource-replacement');
  check(replacement?.observed?.retainedModels === 1
    && replacement?.observed?.latestResourceRetained === true,
  'resource-replacement did not retain exactly the latest model', violations);
  return resultWithSummary(violations, artifact && Object.fromEntries(
    (artifact.scenarios ?? []).map(item => [item.id, item.metrics]),
  ));
}

function commonCandidateEnvelope(artifact, revision, label, identity) {
  const violations = [];
  check(Boolean(artifact), `${label} artifact is missing`, violations);
  if (!artifact) return violations;
  check(artifact.candidateEvidence?.kind === 'candidate', `${label} candidate envelope is missing`, violations);
  check(artifact.candidateEvidence?.profile === identity?.profileId,
    `${label} profile does not match the required candidate`, violations);
  check(artifact.candidateEvidence?.revision === revision, `${label} revision does not match ${revision}`, violations);
  check(artifact.candidateEvidence?.dirty === false, `${label} was measured from dirty source`, violations);
  check(artifact.candidateEvidence?.remoteSession === false, `${label} was measured over remote desktop`, violations);
  check(nonEmpty(artifact.candidateEvidence?.operatingSystem), `${label} OS fingerprint is missing`, violations);
  check(nonEmpty(artifact.candidateEvidence?.driver), `${label} driver fingerprint is missing`, violations);
  check(nonEmpty(artifact.candidateEvidence?.node), `${label} Node identity is missing`, violations);
  check(nonEmpty(artifact.candidateEvidence?.platform), `${label} platform identity is missing`, violations);
  check(includesEvery(
    artifact.candidateEvidence?.runnerLabels,
    identity?.profile?.enrollment?.runnerLabels,
  ), `${label} runner labels do not match the registered profile`, violations);
  if (identity?.profile?.enrollment?.driver) {
    check(artifact.candidateEvidence.driver === identity.profile.enrollment.driver,
      `${label} driver does not match the registered profile`, violations);
  }
  if (identity?.profile?.enrollment?.operatingSystem) {
    check(artifact.candidateEvidence.operatingSystem === identity.profile.enrollment.operatingSystem,
      `${label} OS does not match the registered profile`, violations);
  }
  return violations;
}

function summarizeGpuArtifact(artifact, suiteId) {
  const items = suiteId === 'render3d.real-frame'
    ? artifact?.results
    : suiteId === 'render3d.planar-reflection'
      ? artifact?.benchmarkResults
      : artifact?.cases;
  return {
    browser: artifact?.browser,
    adapter: artifact?.adapter,
    evidence: artifact?.evidence,
    configuration: artifact?.configuration,
    cases: (items ?? []).map(item => ({
      id: item.id,
      p50: item.timing?.p50 ?? item.gpu?.total?.p50,
      p95: item.timing?.p95 ?? item.gpu?.total?.p95,
      samples: item.timing?.sampleCount ?? item.timing?.samples
        ?? item.samples ?? item.gpu?.total?.sampleCount ?? null,
      noise: timingNoise(item.timing ?? item.gpu?.total),
      cohortStatistics: item.cohortStatistics ?? null,
      drawsPerFrame: item.metrics?.drawsPerFrame ?? null,
      renderPassesPerFrame: item.metrics?.renderPassesPerFrame ?? null,
      bufferUploadsPerFrame: item.metrics?.bufferUploadsPerFrame ?? null,
      uploadBytesPerFrame: item.metrics?.uploadBytesPerFrame ?? null,
      queueWait: item.queueWait ? { p50: item.queueWait.p50, p95: item.queueWait.p95 } : null,
      gpuTimestamp: item.gpuTimestamp?.status ?? (item.gpu ? 'available' : null),
    })),
    allocation: artifact?.allocationSampling ?? null,
  };
}

function timingNoise(timing) {
  if (Number.isFinite(timing?.relativeStandardDeviation)) {
    return { status: 'available', relativeStandardDeviation: timing.relativeStandardDeviation };
  }
  const samples = timing?.rawSamples;
  if (Array.isArray(samples) && samples.length > 0 && samples.every(Number.isFinite)) {
    const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
    const variance = samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length;
    return {
      status: 'available',
      relativeStandardDeviation: mean > 0 ? Math.sqrt(variance) / mean : 0,
    };
  }
  return {
    status: 'unavailable',
    reason: 'suite artifact exposes P50/P95 but not raw samples or variance for this case',
  };
}

function checkBrowserEnrollment(actual, registered, suiteId, violations) {
  check(nonEmpty(actual), `${suiteId}: browser fingerprint is missing`, violations);
  if (!registered) return;
  const expectedMajor = /Chrome\s+(\d+)/i.exec(registered)?.[1];
  if (expectedMajor) {
    check(new RegExp(`(?:Chrome|HeadlessChrome)/${expectedMajor}\\.`).test(actual),
      `${suiteId}: browser does not match reviewed ${registered}`, violations);
  }
}

function checkFresh(value, maxAgeHours, now, label, violations) {
  const timestamp = Date.parse(value ?? '');
  const ageHours = (now - timestamp) / 3_600_000;
  check(Number.isFinite(timestamp) && ageHours >= 0 && ageHours <= maxAgeHours,
    `${label} is stale or has an invalid timestamp`, violations);
}

function checkTiming(timing, label, violations) {
  check(Number.isFinite(timing?.p50), `${label}.p50 is missing`, violations);
  check(Number.isFinite(timing?.p95), `${label}.p95 is missing`, violations);
  check(Number.isInteger(timing?.sampleCount ?? timing?.samples), `${label} sample count is missing`, violations);
}

function checkTimingMs(timing, label, violations) {
  check(Number.isFinite(timing?.p50Ms), `${label}.p50Ms is missing`, violations);
  check(Number.isFinite(timing?.p95Ms), `${label}.p95Ms is missing`, violations);
  check(Number.isInteger(timing?.sampleCount), `${label} sample count is missing`, violations);
}

function includesEvery(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected)
    && expected.every(value => actual.includes(value));
}

function isSoftwareAdapter(value) {
  return /swiftshader|llvmpipe|software|warp|microsoft basic render/i.test(value ?? '');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function check(condition, message, violations) {
  if (!condition) violations.push(message);
}

function failed(violations) {
  return { status: 'failed', violations, summary: null };
}

function resultWithSummary(violations, summary) {
  return { status: violations.length === 0 ? 'passed' : 'failed', violations, summary };
}

function readArtifact(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
