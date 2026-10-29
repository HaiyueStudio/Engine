import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256, deferredRuntimeFingerprint } from './webgpu-gate/deferred-fixture-policy.mjs';
import { productionEvidenceInputs, studyEvidenceInputs, lightingContinuousEvidenceInputs } from './webgpu-gate/framegraph-evidence-inputs.mjs';
import { auditProductionReport } from './webgpu-gate/framegraph-production-artifact.mjs';
import { auditFrameGraphStudy } from './webgpu-gate/framegraph-study-artifact.mjs';
import { auditG05ContinuousReport } from './webgpu-gate/deferred-g05-continuous-artifact.mjs';
import { auditG09Preflight } from './webgpu-gate/framegraph-acceptance-policy.mjs';
import { loadFrameGraphQualification } from './webgpu-gate/framegraph-qualification.mjs';
import { buildDeferredFixture } from './webgpu-gate/deferred-fixture-builder.mjs';
import { ENGINE_021_EVIDENCE_KINDS, validateEngine021EvidenceBindings, validateEngine021CompiledEvidence,
  completeEngine021EvidenceAudit, validateEvidenceTargetVersion, ENGINE_021_READBACK_REUSE, ENGINE_021_PBR_REUSE, ENGINE_021_DOWNLOAD_REUSE } from './engine-021-evidence-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && !args[0].startsWith('--manifest=')) throw Error('Use --manifest=<artifacts/.../qualification.json>, or the default artifacts/engine-0.2.1/qualification.json');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const inside = (directory, path) => { const local = relative(directory, path); if (!local || local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local)) throw Error('Evidence path escapes its directory'); return path; };
async function reader(directory) {
  const base = await realpath(directory);
  return async name => readFile(inside(base, await realpath(inside(base, resolve(base, name)))));
}
const readArtifacts = await reader(resolve(root, 'artifacts'));
const manifestPath = args[0]?.slice(11) ?? 'artifacts/engine-0.2.1/qualification.json';
const manifestBytes = await readArtifacts(relative(resolve(root, 'artifacts'), resolve(root, manifestPath)));
const manifest = JSON.parse(manifestBytes);
const targetVersion=JSON.parse(await readFile(resolve(root,'package.json'))).version;
validateEvidenceTargetVersion(manifest,targetVersion);
const reports = {}, readers = {};
for (const kind of ENGINE_021_EVIDENCE_KINDS) {
  const binding = manifest.reports?.[kind];
  if (!binding?.file || !binding.sha256) throw Error(`Missing ${kind} report binding`);
  const bytes = await readArtifacts(relative(resolve(root, 'artifacts'), resolve(root, binding.file)));
  if (sha256(bytes) !== binding.sha256) throw Error(`${kind}: report bytes changed`);
  reports[kind] = JSON.parse(bytes);
  readers[kind] = await reader(dirname(resolve(root, binding.file)));
}
const productionConfig = JSON.parse(await readFile(resolve(root, 'config/framegraph-production-021.json')));
const lightingConfig = JSON.parse(await readFile(resolve(root, 'config/lighting-continuous-021.json')));
const lightingInputs = await lightingContinuousEvidenceInputs(root, lightingConfig);
const current = { targetVersion, revision: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']),
  runtime: await deferredRuntimeFingerprint(root), productionConfig, lightingConfig, qualification: await loadFrameGraphQualification(root),
  framegraphBaselineRevision: JSON.parse(await readFile(resolve(root, 'review/engine-0.2.1/g09/dependency-baseline.json'))).revision,
  inputs: { production: await productionEvidenceInputs(root), resources: await studyEvidenceInputs(root, 'resources'),
    ablation: await studyEvidenceInputs(root, 'ablation'), rooms: lightingInputs, instances: lightingInputs, forward: lightingInputs } };
current.reuseChanges = {};
current.readbackFixFiles = Object.fromEntries(await Promise.all(Object.keys(ENGINE_021_READBACK_REUSE.sourceFiles)
  .map(async path => [path, sha256(await readFile(resolve(root, path)))])));
current.pbrFixFiles = Object.fromEntries(await Promise.all(Object.keys(ENGINE_021_PBR_REUSE.sourceFiles)
  .map(async path => [path, sha256(await readFile(resolve(root, path)))])));
current.downloadFixFiles = Object.fromEntries(await Promise.all(Object.keys(ENGINE_021_DOWNLOAD_REUSE.sourceFiles)
  .map(async path => [path, sha256(await readFile(resolve(root, path)))])));
for (const revision of new Set(Object.values(reports).map(report => report.revision))) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Missing capture commit');
  git(['cat-file', '-e', `${revision}^{commit}`]);
  if (revision !== current.revision) current.reuseChanges[revision] = git([
    'diff', '--no-renames', '--name-only', '-z', revision, current.revision, '--',
  ]).split('\0').filter(Boolean).sort();
}
validateEngine021EvidenceBindings(manifest, reports, current);
const productionRegistration = JSON.parse(await readers.production(reports.production.registration.file));
if (productionRegistration.revision !== reports.production.revision || productionRegistration.dirty !== false) throw Error('Production registration is not bound to its clean capture revision');

// Correctness uses package fixtures as well as private runtimes. Recheck their bound bytes.
const readRoot = await reader(root), correctness = reports.correctness;
const harnessPaths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'scripts/webgpu-gate', 'scripts/benchmark',
  'scripts/verify-framegraph-acceptance.mjs', 'config/release-matrix.json', 'config/framegraph-acceptance-021.json']).split('\0').filter(Boolean).sort();
if (JSON.stringify(correctness.harness.map(file => file.path)) !== JSON.stringify(harnessPaths)) throw Error('Correctness harness coverage differs');
for (const file of [...correctness.harness, ...correctness.auxiliaryDist.files]) {
  if (sha256(await readRoot(file.path)) !== file.sha256) throw Error(`Correctness source/package bytes changed: ${file.path}`);
}
for (const [prefix, build] of [['artifacts/engine-0.2.1/g09', correctness.build], ['artifacts/engine-0.2.1/g09/a0-built', correctness.baseline]]) {
  const readBuild = await reader(resolve(root, prefix));
  for (const file of build.outputs) if (sha256(await readBuild(file.file)) !== file.sha256) throw Error('Correctness runtime bytes changed');
}
const audits = {};
audits.correctness = await auditG09Preflight(correctness, async binding => {
  const bytes = await readers.correctness(binding.file);
  if (sha256(bytes) !== binding.sha256) throw Error('Correctness raw bytes changed');
  return JSON.parse(bytes);
});
audits.production = await auditProductionReport(reports.production, readers.production);
for (const kind of ['resources', 'ablation']) audits[kind] = await auditFrameGraphStudy(reports[kind], readers[kind]);
const budget = await readFile(resolve(root, lightingConfig.frozenBudget.path));
for (const kind of ['rooms', 'instances', 'forward']) audits[kind] = await auditG05ContinuousReport(reports[kind], readers[kind], budget);
const result = completeEngine021EvidenceAudit(audits, reports, targetVersion);
// Rebuild candidate executable chunks instead of trusting archived build summaries.
// Four entries cover all seven reports; common is shared by correctness and G05.
const auditDirectory = resolve(dirname(resolve(root, manifestPath)), `qualification-audit-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(auditDirectory);
const builds = {}, rebuilds = {};
for (const [kind, filename] of Object.entries({ common: 'deferred-reference-runtime.mjs', production: 'framegraph-production-fixture.mjs',
  resources: 'framegraph-resource-study-fixture.mjs', ablation: 'framegraph-ablation-study-fixture.mjs' })) {
  const outputDirectory = resolve(auditDirectory, kind);
  await mkdir(outputDirectory);
  builds[kind] = await buildDeferredFixture({ sourceRoot: root, outputDirectory, entry: resolve(root, 'scripts/webgpu-gate', filename) });
  rebuilds[kind] = { directory: relative(root, outputDirectory).replaceAll('\\', '/'), outputs: builds[kind] };
}
validateEngine021CompiledEvidence(reports, builds);
if (git(['rev-parse', 'HEAD']) !== current.revision || git(['status', '--porcelain'])) throw Error('Candidate changed during evidence audit');
const policyFiles = ['scripts/engine-021-evidence-policy.mjs', 'scripts/check-engine-021-evidence.mjs'];
const evidence = { ...result, schemaVersion: 2, contractId: 'engine-021-evidence-v2', targetVersion, assessedAt: new Date().toISOString(),
  acceptanceRevision: current.revision, dirty: false, manifest: manifestPath, manifestSha256: sha256(manifestBytes),
  policy: { adr: ['0126', '0127', ...(manifest.reuseDecision ? ['0129'] : []), ...([ENGINE_021_PBR_REUSE.decision, ENGINE_021_DOWNLOAD_REUSE.decision].includes(manifest.reuseDecision) ? ['0130'] : []), ...(manifest.reuseDecision === ENGINE_021_DOWNLOAD_REUSE.decision ? ['0131'] : [])], files: await Promise.all(policyFiles.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) }))) },
  ...(manifest.reuseDecision ? { reuseDecision: manifest.reuseDecision, readbackFixFiles: current.readbackFixFiles, ...([ENGINE_021_PBR_REUSE.decision, ENGINE_021_DOWNLOAD_REUSE.decision].includes(manifest.reuseDecision) ? { pbrFixFiles: current.pbrFixFiles } : {}), ...(manifest.reuseDecision === ENGINE_021_DOWNLOAD_REUSE.decision ? { downloadFixFiles: current.downloadFixFiles } : {}) } : {}),
  bindings: Object.fromEntries(ENGINE_021_EVIDENCE_KINDS.map(kind => [kind, { ...manifest.reports[kind],
    captureRevision: reports[kind].revision, acceptanceRevision: current.revision, originalStatus: reports[kind].status,
    acceptanceStatus: 'passed', reused: reports[kind].revision !== current.revision }])),
  reuseChanges: current.reuseChanges, rebuilds };
await writeFile(resolve(auditDirectory, 'report.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(evidence, null, 2));
