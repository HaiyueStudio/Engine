import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from '../hya-corpus/rive-corpus-contract.mjs';
import { validateRiveG11Candidate } from './rive-g11-candidate-contract.mjs';
import { validateRiveG11EvidenceIndex } from './rive-g11-evidence-index-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = safePath(argument('--out') ?? 'review/candidates/rive-g11-formal-closure-attempt.json');
const candidatePath = safePath(argument('--candidate') ?? 'review/candidates/rive-g11-candidate.json');
const indexPath = safePath(argument('--evidence-index') ?? 'review/candidates/rive-g11-evidence-index.json');
const manifestPath = safePath('animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const manifestBytes = readFileSync(manifestPath); const manifest = JSON.parse(manifestBytes);
const census = JSON.parse(readFileSync(safePath(manifest.census.path), 'utf8'));
const workloadPlanBytes = readFileSync(safePath(manifest.workloadPlan.path)); const workloadPlan = JSON.parse(workloadPlanBytes);
const candidateBytes = readFileSync(candidatePath); const candidate = JSON.parse(candidateBytes);
const indexBytes = readFileSync(indexPath); const index = JSON.parse(indexBytes);
const revision = git(['rev-parse', 'HEAD']); const dirty = git(['status', '--porcelain']).length > 0;
const artifactBytesByPath = new Map(); const tracesByPath = new Map();
for (const reference of candidate.traceArtifacts ?? []) {
  const bytes = readFileSync(safePath(reference.path)); const trace = JSON.parse(bytes);
  artifactBytesByPath.set(reference.path, bytes); tracesByPath.set(reference.path, trace);
  for (const path of traceArtifactPaths(trace)) artifactBytesByPath.set(path, readFileSync(safePath(path)));
  for (const capture of [trace.official, trace.hya]) {
    const pixels = capture?.channels?.pixels; if (!pixels?.path) continue;
    const channel = JSON.parse(artifactBytesByPath.get(pixels.path));
    for (const sample of channel.samples ?? []) if (sample?.value?.rgba?.path) {
      artifactBytesByPath.set(sample.value.rgba.path, readFileSync(safePath(sample.value.rgba.path)));
    }
  }
}
for (const path of candidateEvidencePaths(candidate)) artifactBytesByPath.set(path, readFileSync(safePath(path)));
const corpusValidation = validateRiveCorpusManifest(manifest, census, { formal: true, root });
const indexValidation = validateRiveG11EvidenceIndex(index, {
  formal: true, expectedEngineRevision: revision, expectedManifestSha256: hash(manifestBytes),
  expectedWorkloadPlanSha256: hash(workloadPlanBytes), artifactBytesByPath,
});
const candidateValidation = validateRiveG11Candidate(candidate, {
  formal: true, expectedEngineRevision: revision, expectedManifestSha256: hash(manifestBytes),
  manifest, tracesByPath, workloadPlan, artifactBytesByPath,
});
const environmentViolations = [];
if (!/^v22\./u.test(process.version)) environmentViolations.push(`Node.js 22 required; observed ${process.version}`);
if (dirty) environmentViolations.push('Engine worktree is dirty');
for (const name of [
  'RIVE_CAPABILITY_EVALUATOR_COMMAND', 'RIVE_CAPABILITY_EVALUATOR_DESCRIPTOR_JSON',
  'RIVE_OFFICIAL_CAPTURE_COMMAND', 'RIVE_OFFICIAL_CAPTURE_DESCRIPTOR_JSON',
  'RIVE_HYA_CAPTURE_COMMAND', 'RIVE_HYA_CAPTURE_DESCRIPTOR_JSON',
]) if (!process.env[name]) environmentViolations.push(`${name} is not configured`);
const violations = [
  ...environmentViolations.map(value => `environment: ${value}`),
  ...corpusValidation.violations.map(value => `corpus: ${value}`),
  ...indexValidation.violations.map(value => `evidence-index: ${value}`),
  ...candidateValidation.violations.map(value => `candidate: ${value}`),
];
const report = {
  schemaVersion: 1,
  kind: 'haiyue-rive-g11-formal-closure-attempt',
  status: violations.length === 0 ? 'passed' : 'blocked',
  formalEvidence: violations.length === 0,
  generatedAt: new Date().toISOString(),
  engineRevision: revision,
  engineDirty: dirty,
  nodeVersion: process.version,
  tupleId: manifest.compatibilityTuple.id,
  candidate: reference(relative(root, candidatePath).split('\\').join('/'), candidateBytes),
  evidenceIndex: reference(relative(root, indexPath).split('\\').join('/'), indexBytes),
  validations: {
    environment: { status: environmentViolations.length === 0 ? 'passed' : 'failed', violations: environmentViolations },
    corpus: corpusValidation,
    evidenceIndex: indexValidation,
    candidate: candidateValidation,
  },
  violations,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[rive-g11] formal closure ${report.status}; violations=${violations.length}; report=${relative(root, outputPath)}.`);
if (violations.length > 0) process.exitCode = 1;

function traceArtifactPaths(trace) {
  const output = new Set(); if (trace?.scenarioArtifact?.path) output.add(trace.scenarioArtifact.path);
  for (const capture of [trace?.official, trace?.hya]) for (const item of Object.values(capture?.channels ?? {})) if (item?.path) output.add(item.path);
  for (const item of Object.values(trace?.comparison?.channels ?? {})) if (item?.artifact?.path) output.add(item.artifact.path);
  return output;
}
function candidateEvidencePaths(value) {
  const output = new Set();
  for (const device of value.devices ?? []) for (const browser of device.browsers ?? []) if (browser?.evidence?.path) output.add(browser.evidence.path);
  for (const item of value.security?.cases ?? []) if (item?.status === 'passed' && item?.evidence?.path) output.add(item.evidence.path);
  for (const item of value.browserClosure?.scans ?? []) if (item?.status !== 'not-run' && item?.evidence?.path) output.add(item.evidence.path);
  return output;
}
function safePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new Error(`Path must be relative POSIX: ${String(value)}`);
  const path = resolve(root, value); if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Path escapes Engine root: ${value}`); return path;
}
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function git(args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function reference(path, bytes) { return { path, sha256: hash(bytes), byteLength: bytes.byteLength }; }

