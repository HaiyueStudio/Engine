import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from '../hya-corpus/rive-corpus-contract.mjs';
import { validateRiveG11Candidate } from './rive-g11-candidate-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const formal = process.argv.includes('--formal');
const artifactArgument = process.argv.find(value => value.startsWith('--artifact='));
const artifactPath = resolve(
  root,
  artifactArgument?.slice('--artifact='.length) ?? 'review/candidates/rive-g11-candidate.json',
);
const candidate = JSON.parse(readFileSync(artifactPath, 'utf8'));
const manifestPath = resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const census = JSON.parse(readFileSync(resolve(root, manifest.census.path), 'utf8'));
const workloadPlan = JSON.parse(readFileSync(safePath(manifest.workloadPlan.path), 'utf8'));
const corpusValidation = validateRiveCorpusManifest(manifest, census, { formal, root });
const traces = new Map();
const artifactBytesByPath = new Map();
for (const reference of candidate.traceArtifacts ?? []) {
  const bytes = readFileSync(safePath(reference.path));
  const trace = JSON.parse(bytes.toString('utf8'));
  traces.set(reference.path, trace);
  artifactBytesByPath.set(reference.path, bytes);
  for (const path of traceArtifactPaths(trace)) artifactBytesByPath.set(path, readFileSync(safePath(path)));
}
for (const path of candidateEvidencePaths(candidate)) artifactBytesByPath.set(path, readFileSync(safePath(path)));
const validation = validateRiveG11Candidate(candidate, {
  formal,
  expectedEngineRevision: formal
    ? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : null,
  expectedManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  manifest,
  tracesByPath: traces,
  workloadPlan,
  artifactBytesByPath,
});
if (corpusValidation.status !== 'passed' || validation.status !== 'passed') {
  const violations = [
    ...corpusValidation.violations.map(value => `corpus: ${value}`),
    ...validation.violations.map(value => `candidate: ${value}`),
  ];
  throw new Error(`Rive G11 candidate validation failed (${validation.mode}):\n- ${violations.join('\n- ')}`);
}
console.log(`[rive-g11] ${validation.mode} contract passed for ${relative(root, artifactPath)}; evidence status=${candidate.status}.`);

function traceArtifactPaths(trace) {
  const output = new Set();
  if (trace?.scenarioArtifact?.path) output.add(trace.scenarioArtifact.path);
  for (const capture of [trace?.official, trace?.hya]) for (const item of Object.values(capture?.channels ?? {})) if (item?.path) output.add(item.path);
  for (const comparison of Object.values(trace?.comparison?.channels ?? {})) if (comparison?.artifact?.path) output.add(comparison.artifact.path);
  return output;
}

function candidateEvidencePaths(value) {
  const output = new Set();
  for (const device of value.devices ?? []) for (const browser of device.browsers ?? []) if (browser?.evidence?.path) output.add(browser.evidence.path);
  for (const result of value.security?.cases ?? []) if (result?.status === 'passed' && result?.evidence?.path) output.add(result.evidence.path);
  for (const scan of value.browserClosure?.scans ?? []) if (scan?.status !== 'not-run' && scan?.evidence?.path) output.add(scan.evidence.path);
  return output;
}

function safePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z]:/u.test(relativePath)) throw new Error(`Artifact path must be relative POSIX: ${String(relativePath)}`);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Artifact path escapes repository root: ${relativePath}`);
  return path;
}
