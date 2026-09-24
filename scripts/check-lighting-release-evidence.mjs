import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLightingScalingResult } from './webgpu-gate/lighting-scaling-contract.mjs';
import { validateLightingReleaseEvidence } from './release-platform-policy.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = JSON.parse(readFileSync(resolve(root, 'artifacts/webgpu/lighting-scaling.json')));
const matrix = JSON.parse(readFileSync(resolve(root, 'config/release-matrix.json')));
const errors = [...validateLightingScalingResult(report), ...validateLightingReleaseEvidence(report, matrix, report.releaseEvidence)];
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (report.releaseEvidence?.mode !== 'formal') errors.push('diagnostic evidence cannot satisfy release');
if (report.releaseEvidence?.revision !== git(['rev-parse', 'HEAD']) || git(['status', '--porcelain'])) errors.push('formal lighting evidence must match this clean revision');
const age = Date.now() - Date.parse(report.releaseEvidence?.generatedAt);
if (!Number.isFinite(age) || age < -60_000 || age > 14 * 24 * 3600_000) errors.push('formal lighting evidence is missing a current timestamp');
if (report.execution?.validation?.errorCount !== 0 || report.execution?.ownerCleanup?.ownerResidual?.value !== 0
  || report.execution?.benchmarkSucceeded !== true || report.failureSummary?.unclassifiedFailureCount !== 0) errors.push('lighting correctness or resource cleanup failed');
if (errors.length) throw new Error(errors.join('\n'));
console.log(`[lighting-release] ${report.releaseEvidence.qualificationPath} native GPU evidence matches clean revision ${report.releaseEvidence.revision}.`);
