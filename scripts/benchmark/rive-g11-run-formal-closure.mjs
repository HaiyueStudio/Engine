import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from '../hya-corpus/rive-corpus-contract.mjs';
import { resolveProductionAdapterEnvironment, verifyProductionAdapterEnvironment } from '../hya-corpus/rive-production-adapter-bridge.mjs';
import { validateRiveG11Candidate } from './rive-g11-candidate-contract.mjs';
import { validateRiveG11EvidenceIndex } from './rive-g11-evidence-index-contract.mjs';
import { captureRepositoryIdentity, formalRepositoryIdentityViolations } from '../formal-evidence/repository-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = safePath(argument('--out') ?? 'review/candidates/rive-g11-formal-closure-attempt.json');
const candidatePath = safePath(argument('--candidate') ?? 'review/candidates/rive-g11-candidate.json');
const indexPath = safePath(argument('--evidence-index') ?? 'review/candidates/rive-g11-evidence-index.json');
const manifestPath = safePath('animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const repositoryStart = captureRepositoryIdentity(root);
const manifestBytes = readFileSync(manifestPath); const manifest = JSON.parse(manifestBytes);
const census = JSON.parse(readFileSync(safePath(manifest.census.path), 'utf8'));
const workloadPlanBytes = readFileSync(safePath(manifest.workloadPlan.path)); const workloadPlan = JSON.parse(workloadPlanBytes);
const candidateBytes = readFileSync(candidatePath); const candidate = JSON.parse(candidateBytes);
const indexBytes = readFileSync(indexPath); const index = JSON.parse(indexBytes);
const revision = repositoryStart.revision; const dirty = repositoryStart.dirty;
const artifactBytesByPath = new Map(); const tracesByPath = new Map();
const selectedIndexRelativePath = relative(root, indexPath).split('\\').join('/');
artifactBytesByPath.set(selectedIndexRelativePath, indexBytes);
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
  expectedWorkloadPlanSha256: hash(workloadPlanBytes), artifactBytesByPath, manifest, workloadPlan,
});
const candidateContractValidation = validateRiveG11Candidate(candidate, {
  formal: true, expectedEngineRevision: revision, expectedManifestSha256: hash(manifestBytes),
  manifest, tracesByPath, workloadPlan, artifactBytesByPath,
});
const candidateBindingViolations = candidate?.evidenceIndex?.path === selectedIndexRelativePath ? [] : [
  `selected evidence index differs from candidate binding: expected ${String(candidate?.evidenceIndex?.path)}, received ${selectedIndexRelativePath}`,
];
const candidateValidation = candidateBindingViolations.length === 0 ? candidateContractValidation : {
  ...candidateContractValidation,
  status: 'failed',
  violations: [...candidateContractValidation.violations, ...candidateBindingViolations],
};
const environmentViolations = [];
const productionHosts = [];
let productionEnvironment = process.env;
try { productionEnvironment = resolveProductionAdapterEnvironment(process.env); }
catch (error) { environmentViolations.push(`production host configuration failed: ${bounded(error)}`); }
if (Number(process.versions.node.split('.')[0]) < 22) environmentViolations.push(`Node.js 22 or later required; observed ${process.version}`);
for (const [kind, commandName, descriptorName] of [
  ['capability', 'RIVE_CAPABILITY_EVALUATOR_COMMAND', 'RIVE_CAPABILITY_EVALUATOR_DESCRIPTOR_JSON'],
  ['official', 'RIVE_OFFICIAL_CAPTURE_COMMAND', 'RIVE_OFFICIAL_CAPTURE_DESCRIPTOR_JSON'],
  ['hya', 'RIVE_HYA_CAPTURE_COMMAND', 'RIVE_HYA_CAPTURE_DESCRIPTOR_JSON'],
]) {
  if (!productionEnvironment[commandName]) environmentViolations.push(`${commandName} is not configured`);
  if (!productionEnvironment[descriptorName]) environmentViolations.push(`${descriptorName} is not configured`);
  if (productionEnvironment[commandName] && productionEnvironment[descriptorName]) {
    try { productionHosts.push(await verifyProductionAdapterEnvironment(kind, productionEnvironment)); }
    catch (error) { environmentViolations.push(`${kind} production host preflight failed: ${bounded(error)}`); }
  }
}
environmentViolations.push(...formalRepositoryIdentityViolations(repositoryStart, captureRepositoryIdentity(root), { label: 'Engine' }));
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
    environment: { status: environmentViolations.length === 0 ? 'passed' : 'failed', productionHosts, violations: environmentViolations },
    corpus: corpusValidation,
    evidenceIndex: indexValidation,
    candidate: candidateValidation,
  },
  violations,
};
mkdirSync(dirname(outputPath), { recursive: true });
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
  for (const item of [
    value.diagnosticFindings?.officialInputAdmission,
    value.diagnosticFindings?.runtimeInventory,
    value.diagnosticFindings?.oracleRepositoryInventory,
    value.diagnosticFindings?.officialLoadMatrix,
    value.diagnosticFindings?.edgeLoadMatrix,
  ]) if (item?.path) output.add(item.path);
  return output;
}
function safePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new Error(`Path must be relative POSIX: ${String(value)}`);
  const path = resolve(root, value); if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Path escapes Engine root: ${value}`); return path;
}
function argument(name) { return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function reference(path, bytes) { return { path, sha256: hash(bytes), byteLength: bytes.byteLength }; }
function bounded(value) { return String(value instanceof Error ? value.message : value).replace(/[\r\n]+/gu, ' ').slice(0, 1024); }
