import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, release } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  candidateProfileRoot,
  PERFORMANCE_CANDIDATE_FILES,
} from './performance-candidate-policy.mjs';
import {
  loadPerformanceBudgetConfig,
  performanceCandidateEvidencePath,
  performanceEvidencePath,
} from './webgpu-performance-budget.mjs';
import { npmArgs, npmCommand } from './npm-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadPerformanceBudgetConfig(root);
const profileId = argumentValue('--profile') || process.env.WEBGPU_DEVICE_PROFILE;
if (!profileId || !config.profiles[profileId] || config.profiles[profileId].tier !== 'required') {
  throw new Error('--profile must name a required WebGPU performance profile.');
}
const profile = config.profiles[profileId];
if (!(profile.match?.nodePlatforms ?? []).includes(process.platform)) {
  throw new Error(`${profileId} cannot run on ${process.platform}.`);
}
const revision = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
if (dirty) {
  throw new Error('G04 candidate workloads require a clean revision; commit or stash source changes before collecting evidence.');
}
const profileRoot = resolve(root, candidateProfileRoot(config, profileId));
assertInsideCandidateRoot(profileRoot);
rmSync(profileRoot, { recursive: true, force: true });
mkdirSync(profileRoot, { recursive: true });

const operatingSystem = detectOperatingSystem();
const driver = detectDriver(operatingSystem);
if (!driver) {
  throw new Error('Unable to determine a physical display-driver fingerprint; set WEBGPU_DRIVER_FINGERPRINT on the local-console runner.');
}
const remoteSession = detectRemoteSession();
if (remoteSession) throw new Error('Remote desktop sessions cannot collect physical-device performance candidates.');
const runnerLabels = profile.enrollment.runnerLabels;
const candidateEnvironment = {
  ...process.env,
  WEBGPU_DEVICE_PROFILE: profileId,
  WEBGPU_PERFORMANCE_EVIDENCE_MODE: 'candidate',
  WEBGPU_OS_FINGERPRINT: operatingSystem,
  WEBGPU_DRIVER_FINGERPRINT: driver,
  WEBGPU_RUNNER_LABELS: runnerLabels.join(','),
  WEBGPU_REMOTE_SESSION: '0',
};
const formalDigests = captureFormalDigests();
const manifest = {
  schemaVersion: 1,
  goal: 'g04-performance-device-readiness',
  profile: profileId,
  revision,
  dirty,
  startedAt: new Date().toISOString(),
  environment: candidateEnvelope(),
  commands: [],
  formalBaselineUpdated: false,
  status: 'running',
};

try {
  run('full real-device renderer/reflection/AO candidate', npmCommand(), npmArgs([
    'run', 'verify:device-performance',
  ]), 3_600_000, candidateEnvironment);
  for (const [suiteId, source] of [
    ['render3d.real-frame', 'artifacts/webgpu/real-renderer-benchmark.json'],
    ['render3d.planar-reflection', 'artifacts/webgpu/planar-reflection.json'],
    ['ambient-occlusion.gpu-cost', 'artifacts/webgpu/ambient-occlusion-gpu-cost.json'],
  ]) {
    const target = resolve(root, performanceCandidateEvidencePath(profileId, suiteId));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, source), target);
  }
  assertFormalDigestsUnchanged(formalDigests);

  if (profileId === 'apple-integrated') await runAppleSharedCandidates();
  assertSourceUnchanged();
  assertFormalDigestsUnchanged(formalDigests);
  manifest.status = 'completed-awaiting-validator';
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  manifest.finishedAt = new Date().toISOString();
  manifest.formalBaselineUpdated = formalDigestsChanged(formalDigests);
  writeFileSync(resolve(profileRoot, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function runAppleSharedCandidates() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error(`Apple CPU full cohort requires Node.js >=22; received ${process.version}.`);
  }
  if (cpus()[0]?.model !== 'Apple M4 Pro') {
    throw new Error(`apple-m4-pro-fixed requires CPU "Apple M4 Pro"; received ${cpus()[0]?.model ?? 'unknown'}.`);
  }
  const cpuOutput = resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.cpu);
  const cpuRelative = relative(root, cpuOutput);
  run('Node 22+ CPU full three-round cohort', process.execPath, [
    'scripts/run-benchmarks.mjs',
    '--enforce',
    '--profile', 'full',
    '--output', cpuRelative,
    '--baseline', cpuRelative,
    '--runner-profile', profile.enrollment.cpuRunnerProfile,
  ], 36_000_000, candidateEnvironment);

  const readback = resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.readback);
  run('WebGPU readback/resource churn 1800 frames', npmCommand(), npmArgs([
    'run', 'verify:webgpu-readback:long',
  ]), 600_000, { ...candidateEnvironment, WEBGPU_GATE_OUTPUT: readback });
  decorateArtifact(readback);

  const gltf = resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.gltf);
  run('glTF first-visible-frame candidate', npmCommand(), npmArgs([
    'run', 'verify:gltf-asset',
  ]), 600_000, { ...candidateEnvironment, GLTF_ASSET_BASELINE_OUTPUT: gltf });
  decorateArtifact(gltf);

  runWithRestoredSourceFiles(
    ['examples/hya-corpus-dashboard/capabilities.json'],
    () => run('HYA network/parse/first-frame candidate', npmCommand(), npmArgs([
      'run', 'hya:dashboard', '--', '--candidate',
    ]), 1_800_000, candidateEnvironment),
  );
  copyAndDecorate(
    resolve(root, 'animation-spec/corpus/.cache/candidate-report.json'),
    resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.hya),
  );

  run('editor and AnimationEditor production cold-start candidate', process.execPath, [
    'scripts/inspect-release-artifacts.mjs',
  ], 1_800_000, candidateEnvironment);
  const appColdStart = resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.appStartup);
  run('editor and AnimationEditor three-cohort cold-start measurement', process.execPath, [
    'scripts/performance-app-cold-start.mjs',
    '--output', relative(root, appColdStart),
    '--cohorts', '3',
  ], 600_000, candidateEnvironment);
  decorateArtifact(appColdStart);

  run('50k and resource-replacement memory candidate', npmCommand(), npmArgs([
    'run', 'verify:editor-memory',
  ]), 600_000, candidateEnvironment);
  copyAndDecorate(
    resolve(root, 'artifacts/editor/editor-memory-budget.json'),
    resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.editorMemory),
  );

  const largeScene = resolve(profileRoot, PERFORMANCE_CANDIDATE_FILES.editorLargeScene);
  run('editor 1k/10k large-project interaction candidate', process.execPath, [
    'scripts/editor-e2e/largeScenePerformance.mjs',
    '--phase', 'after',
    '--output', relative(root, largeScene),
  ], 900_000, candidateEnvironment);
  decorateArtifact(largeScene);
}

function decorateArtifact(path) {
  if (!existsSync(path)) throw new Error(`Candidate command did not emit ${relative(root, path)}.`);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  artifact.candidateEvidence = candidateEnvelope();
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

function copyAndDecorate(source, target) {
  if (!existsSync(source)) throw new Error(`Candidate command did not emit ${relative(root, source)}.`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  decorateArtifact(target);
}

function candidateEnvelope() {
  return {
    schemaVersion: 1,
    kind: 'candidate',
    profile: profileId,
    revision,
    dirty: false,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    operatingSystem,
    driver,
    runnerLabels,
    remoteSession,
  };
}

function run(label, command, args, timeout, env) {
  console.log(`[performance-candidate] ${label}`);
  const startedAt = Date.now();
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', timeout });
  manifest.commands.push({
    label,
    command: [command, ...args],
    durationMs: Date.now() - startedAt,
    status: result.status,
    signal: result.signal,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function runWithRestoredSourceFiles(paths, operation) {
  const snapshots = paths.map(path => {
    const absolute = resolve(root, path);
    return { absolute, existed: existsSync(absolute), bytes: existsSync(absolute) ? readFileSync(absolute) : null };
  });
  try {
    return operation();
  } finally {
    for (const snapshot of snapshots) {
      if (snapshot.existed) writeFileSync(snapshot.absolute, snapshot.bytes);
      else rmSync(snapshot.absolute, { force: true });
    }
  }
}

function captureFormalDigests() {
  return Object.fromEntries(Object.keys(config.suites).map(suiteId => {
    const path = resolve(root, performanceEvidencePath(profileId, suiteId));
    return [path, fileDigest(path)];
  }));
}

function assertFormalDigestsUnchanged(before) {
  if (!formalDigestsChanged(before)) return;
  for (const [path, digest] of Object.entries(before)) {
    if (fileDigest(path) !== digest) throw new Error(
      `G04 candidate run modified formal evidence path ${relative(root, path)}.`,
    );
  }
}

function formalDigestsChanged(before) {
  return Object.entries(before).some(([path, digest]) => fileDigest(path) !== digest);
}

function fileDigest(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertSourceUnchanged() {
  if (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain']).length > 0) {
    throw new Error('Source changed during candidate collection; discard the evidence and retry.');
  }
}

function detectOperatingSystem() {
  if (process.env.WEBGPU_OS_FINGERPRINT) return process.env.WEBGPU_OS_FINGERPRINT;
  if (process.platform === 'darwin') {
    const product = commandOutput('sw_vers', ['-productVersion']);
    const build = commandOutput('sw_vers', ['-buildVersion']);
    if (product && build) return `macOS ${product} (${build}), ${process.arch}`;
  }
  if (process.platform === 'win32') {
    const value = commandOutput('powershell.exe', [
      '-NoProfile', '-Command',
      '[System.Environment]::OSVersion.VersionString + "; " + $env:PROCESSOR_ARCHITECTURE',
    ]);
    if (value) return value;
  }
  return `${process.platform}-${process.arch} ${release()}`;
}

function detectDriver(operatingSystem) {
  if (process.env.WEBGPU_DRIVER_FINGERPRINT) return process.env.WEBGPU_DRIVER_FINGERPRINT;
  if (process.platform === 'darwin') {
    const display = commandOutput('system_profiler', ['SPDisplaysDataType']);
    const chipset = /Chipset Model:\s*(.+)/.exec(display)?.[1]?.trim();
    const metal = /Metal:\s*(.+)/.exec(display)?.[1]?.trim();
    return chipset && metal ? `${chipset}; Metal ${metal}; ${operatingSystem}` : '';
  }
  if (process.platform === 'win32') {
    return commandOutput('powershell.exe', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress',
    ]);
  }
  return '';
}

function detectRemoteSession() {
  if (process.env.WEBGPU_REMOTE_SESSION === '1') return true;
  if (process.platform !== 'win32') return false;
  return /^(?:rdp|ica)/i.test(process.env.SESSIONNAME ?? '');
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : '';
}

function assertInsideCandidateRoot(path) {
  const expected = resolve(root, config.candidateEvidence.root, profileId);
  if (path !== expected) throw new Error(`Refusing to clear unexpected candidate path ${path}.`);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
