import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluatePerformanceBudget,
  createPerformanceSourceFingerprint,
  loadPerformanceBudgetConfig,
  performanceEvidencePath,
  selectPerformanceProfile,
} from './webgpu-performance-budget.mjs';
import { resolveLocalPerformanceProfileId } from './webgpu-performance-profile-selection.mjs';
import { validateGpuPerformanceCandidate } from './performance-candidate-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadPerformanceBudgetConfig(root);
const local = process.argv.includes('--local');
const requestedProfile = argumentValue('--profile')
  || (local ? process.env.WEBGPU_DEVICE_PROFILE ?? '' : '');
const allowDirty = process.argv.includes('--allow-dirty');
const allowUnenrolled = process.argv.includes('--allow-unenrolled');
const expectedRevision = process.env.PERFORMANCE_EVIDENCE_REVISION || git(['rev-parse', 'HEAD']);
const now = Date.now();
const benchmarkRoot = process.env.WEBGPU_BENCHMARK_ROOT ? resolve(process.env.WEBGPU_BENCHMARK_ROOT) : root;
const sourceFingerprint = createPerformanceSourceFingerprint(root, benchmarkRoot);
const violations = [];
let profiles;
try {
  if (requestedProfile) {
    profiles = [[requestedProfile, config.profiles[requestedProfile]]];
  } else if (local) {
    const profileId = resolveLocalPerformanceProfileId(config, process.platform);
    profiles = [[profileId, config.profiles[profileId]]];
  } else {
    profiles = Object.entries(config.profiles).filter(([, profile]) => profile.tier === 'required');
  }
} catch (error) {
  console.error(`[webgpu-performance-evidence] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

for (const [profileId, profile] of profiles) {
  if (!profile) {
    violations.push(`unknown profile ${profileId}`);
    continue;
  }
  if (!profile.enrolled && !allowUnenrolled) {
    violations.push(`${profileId} has product ceilings but no reviewed real-device enrollment`);
  }
  for (const suiteId of Object.keys(config.suites)) {
    const path = resolve(root, performanceEvidencePath(profileId, suiteId));
    if (!existsSync(path)) {
      violations.push(`${profileId}/${suiteId} evidence is missing (${relative(root, path)})`);
      continue;
    }
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      violations.push(`${profileId}/${suiteId} evidence is invalid JSON: ${error.message}`);
      continue;
    }
    if (artifact.evidence?.profile !== profileId) violations.push(`${profileId}/${suiteId} has the wrong profile identity`);
    if (artifact.evidence?.schemaVersion !== 2 || artifact.evidence?.kind !== 'formal') {
      violations.push(`${profileId}/${suiteId} is not schema-2 formal evidence`);
    }
    if (!artifact.evidence?.driver || !artifact.evidence?.operatingSystem) {
      violations.push(`${profileId}/${suiteId} has incomplete driver/OS identity`);
    }
    if (artifact.evidence?.remoteSession) {
      violations.push(`${profileId}/${suiteId} was measured over a remote desktop session`);
    }
    const requiredLabels = profile.enrollment?.runnerLabels ?? [];
    if (!requiredLabels.every(label => artifact.evidence?.runnerLabels?.includes(label))) {
      violations.push(`${profileId}/${suiteId} does not carry the registered runner labels`);
    }
    if (/swiftshader|llvmpipe|software|warp|microsoft basic render/i.test(artifact.evidence?.adapterFingerprint ?? '')) {
      violations.push(`${profileId}/${suiteId} used a software adapter`);
    }
    if (profile.enrollment?.adapterFingerprint
      && artifact.evidence?.adapterFingerprint !== profile.enrollment.adapterFingerprint) {
      violations.push(`${profileId}/${suiteId} adapter does not match the reviewed enrollment`);
    }
    if (profile.enrollment?.driver && artifact.evidence?.driver !== profile.enrollment.driver) {
      violations.push(`${profileId}/${suiteId} driver does not match the reviewed enrollment`);
    }
    if (profile.enrollment?.operatingSystem
      && artifact.evidence?.operatingSystem !== profile.enrollment.operatingSystem) {
      violations.push(`${profileId}/${suiteId} OS does not match the reviewed enrollment`);
    }
    const browserMajor = /Chrome\s+(\d+)/i.exec(profile.enrollment?.browser ?? '')?.[1];
    if (browserMajor && !new RegExp(`(?:Chrome|HeadlessChrome)/${browserMajor}\\.`).test(artifact.browser ?? '')) {
      violations.push(`${profileId}/${suiteId} browser does not match the reviewed enrollment`);
    }
    if (artifact.performanceBudget?.status !== 'passed') violations.push(`${profileId}/${suiteId} did not pass its performance budget`);
    if (artifact.gate?.status !== 'passed') violations.push(`${profileId}/${suiteId} did not pass its WebGPU correctness gate`);
    try {
      selectPerformanceProfile(config, {
        nodePlatform: artifact.evidence?.nodePlatform,
        adapter: artifact.adapter,
      }, profileId);
    } catch (error) {
      violations.push(`${profileId}/${suiteId} adapter identity is invalid: ${error.message}`);
    }
    try {
      const reevaluated = evaluatePerformanceBudget(config, profileId, suiteId, 'full', artifact);
      if (reevaluated.status !== 'passed') {
        violations.push(`${profileId}/${suiteId} fails the current checked-in budget (${reevaluated.violations.length} violation(s))`);
      }
    } catch (error) {
      violations.push(`${profileId}/${suiteId} could not be re-evaluated: ${error.message}`);
    }
    const strictValidation = validateGpuPerformanceCandidate({
      artifact,
      config,
      profileId,
      suiteId,
      revision: expectedRevision,
      sourceFingerprint,
      now,
      evidenceKind: 'formal',
    });
    for (const violation of strictValidation.violations) {
      violations.push(`${profileId}/${violation}`);
    }
    if (artifact.evidence?.sourceFingerprint !== sourceFingerprint) {
      violations.push(`${profileId}/${suiteId} executable input fingerprint does not match the current build`);
    }
    if (artifact.evidence?.revision !== expectedRevision
      && !(allowDirty && artifact.evidence?.sourceFingerprint === sourceFingerprint)) {
      violations.push(`${profileId}/${suiteId} revision ${artifact.evidence?.revision ?? 'missing'} != ${expectedRevision}`);
    }
    if (artifact.evidence?.dirty && !allowDirty) violations.push(`${profileId}/${suiteId} was measured from a dirty worktree`);
    if (artifact.mode !== 'full') {
      violations.push(`${profileId}/${suiteId} is smoke evidence; release requires the full workload`);
    }
    const generatedAt = Date.parse(artifact.evidence?.generatedAt ?? '');
    const ageHours = (now - generatedAt) / 3_600_000;
    if (!Number.isFinite(generatedAt) || ageHours < 0 || ageHours > config.evidenceMaxAgeHours) {
      violations.push(`${profileId}/${suiteId} evidence is stale or has an invalid timestamp`);
    }
  }
}

if (violations.length) {
  console.error('[webgpu-performance-evidence] Failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}
console.log(`[webgpu-performance-evidence] ${profiles.length} profile(s), ${profiles.length * Object.keys(config.suites).length} full real-device artifacts passed.`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
