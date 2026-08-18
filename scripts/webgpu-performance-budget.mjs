import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePerformanceEvidenceMode } from './performance-evidence-policy.mjs';

export const performanceBudgetConfigPath = 'config/webgpu-performance-budgets.json';

export function loadPerformanceBudgetConfig(root) {
  const config = JSON.parse(readFileSync(resolve(root, performanceBudgetConfigPath), 'utf8'));
  validateConfig(config);
  return config;
}

export function selectPerformanceProfile(config, environment, requestedProfile = '') {
  const adapterText = adapterFingerprint(environment.adapter);
  if (requestedProfile) {
    const profile = config.profiles[requestedProfile];
    if (!profile) throw new Error(`Unknown WEBGPU_DEVICE_PROFILE ${requestedProfile}.`);
    if (!matchesProfile(profile, environment.nodePlatform, adapterText)) {
      throw new Error(
        `WEBGPU_DEVICE_PROFILE ${requestedProfile} does not match ${environment.nodePlatform}/${adapterText || 'unknown adapter'}.`,
      );
    }
    return { id: requestedProfile, profile, adapterText };
  }
  for (const [id, profile] of Object.entries(config.profiles)) {
    if (matchesProfile(profile, environment.nodePlatform, adapterText)) return { id, profile, adapterText };
  }
  throw new Error(
    `No WebGPU performance profile matches ${environment.nodePlatform}/${adapterText || 'unknown adapter'}; set WEBGPU_DEVICE_PROFILE after enrolling the real device.`,
  );
}

export function evaluatePerformanceBudget(config, profileId, suiteId, mode, artifact) {
  const profile = config.profiles[profileId];
  const suite = config.suites[suiteId];
  if (!profile) throw new Error(`Unknown performance profile ${profileId}.`);
  if (!suite) throw new Error(`Unknown performance suite ${suiteId}.`);
  const budgets = profile.budgets?.[suiteId];
  if (!budgets) throw new Error(`Performance profile ${profileId} has no ${suiteId} budget.`);
  const results = artifact.results ?? artifact.benchmarkResults ?? artifact.cases ?? [];
  const minimumSamples = suite.minimumSamples?.[mode];
  const budgetChannels = suite.budgetChannels ?? ['timing'];
  const checks = [];
  const violations = [];

  for (const rule of suite.rules.filter(candidate => candidate.modes.includes(mode))) {
    const matches = results.filter(result => matchesRule(result, rule.match));
    if (matches.length !== rule.expectedCount) {
      violations.push({
        rule: rule.id,
        reason: 'case-count',
        actual: matches.length,
        expected: rule.expectedCount,
      });
      continue;
    }
    const ruleBudget = budgets[rule.id];
    for (const result of matches) {
      const samples = result.samples
        ?? result.gpu?.total?.sampleCount
        ?? artifact.configuration?.samples
        ?? artifact.configuration?.sampleCount
        ?? null;
      for (const channel of budgetChannels) {
        const maxP95Ms = resolveChannelBudget(ruleBudget, channel);
        if (!Number.isFinite(maxP95Ms)) {
          violations.push({
            rule: rule.id,
            caseId: result.id,
            channel,
            reason: 'budget-missing',
          });
          continue;
        }
        const p95Ms = channel === 'timing'
          ? result.timing?.p95 ?? result.frameMs
          : readPath(result, channel)?.p95;
        const check = {
          rule: rule.id,
          caseId: result.id,
          channel,
          p95Ms,
          maxP95Ms,
          samples,
          headroomMs: Number.isFinite(p95Ms) ? maxP95Ms - p95Ms : null,
        };
        checks.push(check);
        if (!Number.isFinite(p95Ms)) {
          violations.push({ ...check, reason: 'timing-missing' });
        } else if (p95Ms > maxP95Ms) {
          violations.push({ ...check, reason: 'p95-exceeded' });
        }
      }
      if (!Number.isInteger(samples) || !Number.isInteger(minimumSamples) || samples < minimumSamples) {
        violations.push({
          rule: rule.id,
          caseId: result.id,
          reason: 'samples-insufficient',
          samples,
          minimumSamples,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    config: performanceBudgetConfigPath,
    profile: profileId,
    profileTier: profile.tier,
    profileEnrolled: profile.enrolled,
    profileSource: profile.source,
    suite: suiteId,
    mode,
    status: violations.length === 0 ? 'passed' : 'failed',
    checks,
    violations,
  };
}

export function shouldEnforceDevicePerformanceBudgets(environment = process.env) {
  return environment.WEBGPU_ENFORCE_DEVICE_PERFORMANCE_BUDGETS === '1';
}

export function performanceEvidencePath(profileId, suiteId) {
  const name = {
    'render3d.real-frame': 'real-renderer',
    'render3d.planar-reflection': 'planar-reflection',
    'ambient-occlusion.gpu-cost': 'ambient-occlusion',
  }[suiteId];
  if (!name) throw new Error(`Performance suite ${suiteId} has no evidence filename.`);
  return `artifacts/webgpu/performance/${profileId}/${name}.json`;
}

export function performanceCandidateEvidencePath(profileId, suiteId) {
  const formal = performanceEvidencePath(profileId, suiteId);
  return formal.replace('artifacts/webgpu/performance/', 'artifacts/performance-candidates/');
}

export function createPerformanceEvidence(root, selected, budget, artifact, sourceFingerprint) {
  const evidenceMode = resolvePerformanceEvidenceMode(budget.mode);
  return {
    schemaVersion: 2,
    kind: evidenceMode,
    profile: selected.id,
    profileTier: selected.profile.tier,
    profileEnrolled: selected.profile.enrolled,
    nodePlatform: process.platform,
    adapterFingerprint: selected.adapterText,
    adapter: artifact.adapter ?? {},
    browser: artifact.browser ?? '',
    operatingSystem: process.env.WEBGPU_OS_FINGERPRINT
      || `${process.platform}-${process.arch} ${release()}`,
    driver: process.env.WEBGPU_DRIVER_FINGERPRINT || null,
    runnerLabels: splitLabels(process.env.WEBGPU_RUNNER_LABELS),
    remoteSession: process.env.WEBGPU_REMOTE_SESSION === '1',
    revision: git(root, ['rev-parse', 'HEAD']) || null,
    dirty: git(root, ['status', '--porcelain']).length > 0,
    generatedAt: artifact.generatedAt ?? new Date().toISOString(),
    budgetStatus: budget.status,
    budgetConfig: performanceBudgetConfigPath,
    sourceFingerprint,
  };
}

export function createPerformanceSourceFingerprint(root, benchmarkRoot = root) {
  const policyFiles = [
    performanceBudgetConfigPath,
    'config/rollup.shared.js',
    'scripts/webgpu-performance-budget.mjs',
    'scripts/performance-evidence-policy.mjs',
    'scripts/performance-candidate-policy.mjs',
    'scripts/run-webgpu-device-performance.mjs',
    'scripts/run-release-performance-candidate.mjs',
    'scripts/check-release-performance-candidate.mjs',
    'scripts/check-webgpu-performance-evidence.mjs',
    'scripts/performance-app-cold-start.mjs',
    'scripts/planar-reflection-pixel-baseline.mjs',
    'scripts/verify-webgpu-planar-reflection.mjs',
    'scripts/verify-webgpu-real-renderer-benchmark.mjs',
    'scripts/verify-ambient-occlusion-gpu-cost.mjs',
    'scripts/validate-ambient-occlusion-gpu-cost.mjs',
    'scripts/benchmark/ambient-occlusion-cost-model.mjs',
  ].flatMap(path => collectFingerprintFiles(root, path));
  const executableFiles = [
    'scripts/benchmark',
    'scripts/webgpu-gate',
    'engine/dist',
    'node_modules/wgpu-matrix/dist/3.x/wgpu-matrix.module.js',
  ].flatMap(path => collectFingerprintFiles(benchmarkRoot, path));
  const hash = createHash('sha256');
  for (const path of [...new Set(policyFiles)].sort()) {
    hash.update(`policy:${relative(root, path)}`);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  for (const path of [...new Set(executableFiles)].sort()) {
    hash.update(`executable:${relative(benchmarkRoot, path)}`);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function adapterFingerprint(adapter = {}) {
  return [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();
}

function matchesProfile(profile, nodePlatform, adapterText) {
  const platforms = profile.match?.nodePlatforms ?? [];
  if (!platforms.includes(nodePlatform)) return false;
  const patterns = profile.match?.adapterPatterns ?? [];
  return patterns.length > 0 && patterns.every(pattern => new RegExp(pattern, 'i').test(adapterText));
}

function matchesRule(result, match) {
  return Object.entries(match).every(([key, expected]) => result[key] === expected);
}

function validateConfig(config) {
  if (config.schemaVersion !== 1 || !config.suites || !config.profiles) {
    throw new Error(`${performanceBudgetConfigPath} has an invalid schema.`);
  }
  if (!config.candidateEvidence
    || config.candidateEvidence.root !== 'artifacts/performance-candidates'
    || config.candidateEvidence.workload !== 'full'
    || config.candidateEvidence.requiredTimingCohorts < 3
    || config.candidateEvidence.requiredCpuCohorts < 3
    || config.candidateEvidence.requiredReadbackFrames !== 1800
    || config.candidateEvidence.remoteSessionAllowed !== false
    || config.candidateEvidence.softwareAdapterAllowed !== false) {
    throw new Error(`${performanceBudgetConfigPath} has an invalid candidate-evidence policy.`);
  }
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    if (!['required', 'extended', 'control'].includes(profile.tier)) {
      throw new Error(`${profileId} has an invalid performance tier.`);
    }
    validateEnrollment(profileId, profile);
    for (const [suiteId, suite] of Object.entries(config.suites)) {
      const budgets = profile.budgets?.[suiteId];
      if (!budgets) throw new Error(`${profileId} has no ${suiteId} budgets.`);
      for (const rule of suite.rules) {
        for (const channel of suite.budgetChannels ?? ['timing']) {
          const value = resolveChannelBudget(budgets[rule.id], channel);
          if (!Number.isFinite(value) || value <= 0) {
            throw new Error(
              `${profileId}/${suiteId}/${rule.id}/${channel} has no positive P95 budget.`,
            );
          }
        }
      }
    }
  }
}

function validateEnrollment(profileId, profile) {
  if (profile.tier !== 'required') return;
  const enrollment = profile.enrollment;
  if (!enrollment || !['enrolled', 'pending-real-device'].includes(enrollment.status)) {
    throw new Error(`${profileId} has no valid real-device enrollment status.`);
  }
  const requiredLabels = enrollment.runnerLabels;
  if (!Array.isArray(requiredLabels) || requiredLabels.length < 3) {
    throw new Error(`${profileId} has no complete self-hosted runner label set.`);
  }
  if (profile.enrolled !== (enrollment.status === 'enrolled')) {
    throw new Error(`${profileId} enrollment status disagrees with enrolled.`);
  }
  if (enrollment.status === 'enrolled') {
    for (const field of ['adapterFingerprint', 'browser', 'driver', 'operatingSystem']) {
      if (typeof enrollment[field] !== 'string' || enrollment[field].trim().length === 0) {
        throw new Error(`${profileId} enrolled device is missing ${field}.`);
      }
    }
  } else if (!Array.isArray(enrollment.steps) || enrollment.steps.length < 3) {
    throw new Error(`${profileId} pending enrollment needs exact registration steps.`);
  }
}

function resolveChannelBudget(ruleBudget, channel) {
  if (typeof ruleBudget === 'number') {
    return channel === 'timing' ? ruleBudget : undefined;
  }
  return ruleBudget?.[channel];
}

function readPath(value, path) {
  return path.split('.').reduce((current, segment) => current?.[segment], value);
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function splitLabels(value = '') {
  return value.split(',').map(label => label.trim()).filter(Boolean);
}

function collectFingerprintFiles(root, path) {
  const absolute = resolve(root, path);
  const stats = statSync(absolute);
  if (stats.isFile()) return [absolute];
  const result = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) result.push(...collectFingerprintFiles(root, relative(root, child)));
    else if (/\.(?:html|js|json|mjs|wgsl)$/.test(entry.name)) result.push(child);
  }
  return result;
}
