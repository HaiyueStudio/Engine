import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableReleasePath } from './release-path-policy.mjs';

const REQUIRED_COMMANDS = Object.freeze([
  'production dependency, license and credential audit',
  'build clean-checkout workspace dependency foundations',
  'fast release prerequisite gate',
  'deterministic public packages and app delivery',
  'build complete examples catalog',
  'build complete games catalog',
]);

const REQUIRED_APP_MANIFESTS = Object.freeze([
  'animation-editor',
  'hya-dashboard',
  'hya-viewer',
  'scene-editor',
  'voxel-pwa',
]);

export function validateReleaseRehearsalBundle({
  releaseManifest,
  rehearsal,
  provenance,
  sbom,
  releasePlan,
  checksumEntries,
  supplyChainReport,
  releaseNotes,
  releaseNotesSource,
  changelog,
  evidenceFiles = [],
  readArtifact,
}) {
  const errors = [];
  const expected = releaseManifest.artifacts.map(artifact => artifact.id).sort();
  const actual = (rehearsal.artifacts ?? []).map(artifact => artifact.id).sort();
  if (!sameList(actual, expected)) errors.push(`release artifact IDs differ: ${actual.join(', ')} !== ${expected.join(', ')}`);
  if (rehearsal.releaseVersion !== releaseManifest.releaseVersion) errors.push('release version does not match the frozen manifest');
  if (rehearsal.source?.dirty !== false) errors.push('rehearsal source must be a clean revision');
  if (!/^[0-9a-f]{40}$/u.test(rehearsal.source?.revision ?? '')) errors.push('rehearsal revision is missing');
  if (Number.parseInt(String(rehearsal.source?.node ?? '').replace(/^v/u, ''), 10) < 22) errors.push('rehearsal requires Node.js >=22');
  if (typeof rehearsal.source?.v8 !== 'string' || rehearsal.source.v8.length === 0) errors.push('rehearsal must bind exact V8 identity');
  if (rehearsal.source?.formalBaselineBefore !== rehearsal.source?.formalBaselineAfter) errors.push('formal baseline tree changed during rehearsal');
  if (rehearsal.formalBaselineUpdated !== false) errors.push('rehearsal must not claim a formal baseline update');
  if (rehearsal.externalPublishPerformed !== false) errors.push('rehearsal must not perform external publication');
  if (rehearsal.contentRouting?.pullRequestAndMain !== 'smoke'
    || rehearsal.contentRouting?.nightlyAndRelease !== 'full'
    || rehearsal.contentRouting?.manualTargetsAutomaticallySelected !== false) {
    errors.push('rehearsal content routing does not preserve smoke/full/manual policy');
  }
  if ((rehearsal.artifactCredentialFindings ?? []).length > 0) errors.push('release artifact credential scan has findings');

  const commandByLabel = new Map((rehearsal.commands ?? []).map(command => [command.label, command]));
  for (const label of REQUIRED_COMMANDS) {
    const command = commandByLabel.get(label);
    if (!command) errors.push(`rehearsal command evidence is missing: ${label}`);
    else if (command.status !== 0) errors.push(`rehearsal command did not pass: ${label}`);
  }

  validateSupplyChainBinding(rehearsal, supplyChainReport, errors);

  const manifestById = new Map(releaseManifest.artifacts.map(artifact => [artifact.id, artifact]));
  const subjectByName = new Map((provenance?.subject ?? []).map(subject => [subject.name, subject]));
  const sbomByRef = new Map((sbom?.components ?? []).map(component => [component['bom-ref'], component]));
  const artifactPaths = [];
  for (const artifact of rehearsal.artifacts ?? []) {
    const contract = manifestById.get(artifact.id);
    if (!contract) continue;
    artifactPaths.push(artifact.path);
    if (artifact.kind !== contract.kind) errors.push(`${artifact.id} kind differs from release manifest`);
    if (artifact.version !== contract.version) errors.push(`${artifact.id} version differs from release manifest`);
    if (artifact.publishChannel !== contract.publishChannel) errors.push(`${artifact.id} publish channel differs from release manifest`);
    if (artifact.rollbackUnit !== contract.rollbackUnit) errors.push(`${artifact.id} rollback unit differs from release manifest`);
    const contents = readArtifact(artifact.path);
    if (!contents) {
      errors.push(`${artifact.id} artifact is missing: ${artifact.path}`);
      continue;
    }
    const digest = sha256(contents);
    if (artifact.bytes !== contents.byteLength) errors.push(`${artifact.id} byte length does not match`);
    if (artifact.sha256 !== digest) errors.push(`${artifact.id} SHA-256 does not match`);
    if (checksumEntries.get(artifact.path) !== digest) errors.push(`${artifact.id} is missing or differs in SHA256SUMS`);
    if (subjectByName.get(artifact.path)?.digest?.sha256 !== digest) errors.push(`${artifact.id} provenance subject does not match`);
    const sbomHash = sbomByRef.get(`release-artifact:${artifact.id}`)?.hashes
      ?.find(hash => hash.alg === 'SHA-256')?.content;
    if (sbomHash !== digest) errors.push(`${artifact.id} SBOM hash does not match`);
  }
  const sortedArtifactPaths = artifactPaths.sort();
  if (!sameList([...checksumEntries.keys()].sort(), sortedArtifactPaths)) errors.push('SHA256SUMS contains missing or unexpected artifact paths');
  if (!sameList([...subjectByName.keys()].sort(), sortedArtifactPaths)) errors.push('provenance subjects contain missing or unexpected artifact paths');

  validateProvenance(rehearsal, provenance, errors);
  validateSbom(rehearsal, sbom, errors);
  validateReleaseInputs(releaseManifest, releasePlan, releaseNotes, releaseNotesSource, changelog, errors);
  validatePublicationAndRollback(releaseManifest, releasePlan, errors);
  validateRawEvidence(rehearsal, evidenceFiles, errors);
  return errors;
}

export function validateReleaseRehearsalDirectory(repositoryRoot, bundleDirectory = 'artifacts/release/rehearsal') {
  const root = resolve(repositoryRoot);
  const bundleRoot = resolve(root, bundleDirectory);
  assertInside(root, bundleRoot, 'rehearsal bundle');
  const reportPath = resolve(bundleRoot, 'report.json');
  const rehearsal = readJson(reportPath, 'rehearsal report');
  const releaseManifest = readJson(resolve(root, 'review/api/release-manifest.json'), 'release manifest');
  const evidence = rehearsal.evidence ?? {};
  const bundlePath = portableReleasePath(relative(root, bundleRoot));
  const expectedEvidence = {
    checksumPath: `${bundlePath}/SHA256SUMS`,
    provenancePath: `${bundlePath}/provenance.intoto.json`,
    sbomPath: `${bundlePath}/release.cdx.json`,
    releaseNotesPath: `${bundlePath}/release-notes.md`,
    releasePlanPath: `${bundlePath}/release-plan.json`,
    supplyChainReportPath: `${bundlePath}/supply-chain/report.json`,
    rawEvidenceRoot: `${bundlePath}/evidence`,
  };
  const errors = [];
  for (const [key, value] of Object.entries(expectedEvidence)) {
    if (evidence[key] !== value) errors.push(`${key} does not identify the canonical rehearsal bundle input`);
  }

  const readEvidence = (path, label) => {
    if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} path is missing from report.json.`);
    const absolute = resolve(root, path);
    assertInside(bundleRoot, absolute, label);
    if (!existsSync(absolute)) throw new Error(`${label} is missing: ${path}.`);
    return readFileSync(absolute);
  };
  const checksumText = readEvidence(evidence.checksumPath, 'SHA256SUMS').toString('utf8');
  const provenance = JSON.parse(readEvidence(evidence.provenancePath, 'provenance').toString('utf8'));
  const sbom = JSON.parse(readEvidence(evidence.sbomPath, 'release SBOM').toString('utf8'));
  const releasePlan = JSON.parse(readEvidence(evidence.releasePlanPath, 'release plan').toString('utf8'));
  const supplyChainReport = JSON.parse(readEvidence(evidence.supplyChainReportPath, 'supply-chain report').toString('utf8'));
  const releaseNotes = readEvidence(evidence.releaseNotesPath, 'release notes');
  const releaseNotesSourcePath = resolve(root, `docs/engine-guide/release-notes-${releaseManifest.releaseVersion}.md`);
  const releaseNotesSource = existsSync(releaseNotesSourcePath) ? readFileSync(releaseNotesSourcePath) : null;
  const changelog = existsSync(resolve(root, 'CHANGELOG.md')) ? readFileSync(resolve(root, 'CHANGELOG.md')) : null;
  const evidenceFiles = listFiles(bundleRoot).map(path => portableReleasePath(relative(root, resolve(bundleRoot, path))));
  errors.push(...validateReleaseRehearsalBundle({
    releaseManifest,
    rehearsal,
    provenance,
    sbom,
    releasePlan,
    checksumEntries: parseSha256Sums(checksumText),
    supplyChainReport,
    releaseNotes,
    releaseNotesSource,
    changelog,
    evidenceFiles,
    readArtifact: path => {
      const absolute = resolve(root, path);
      if (!isInside(bundleRoot, absolute) || !existsSync(absolute)) return null;
      return readFileSync(absolute);
    },
  }));
  if (rehearsal.gate?.status !== 'passed' || (rehearsal.gate?.errors ?? []).length > 0) {
    errors.push('rehearsal report does not contain a passed internal gate');
  }
  validateRawReports(root, evidence, errors);
  return { errors: [...new Set(errors)], rehearsal, releaseManifest };
}

export function parseSha256Sums(contents) {
  const entries = new Map();
  for (const line of contents.trim().split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    if (entries.has(match[2])) throw new Error(`Duplicate SHA256SUMS path: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function validateSupplyChainBinding(rehearsal, report, errors) {
  if (report?.gate?.status !== 'passed') errors.push('supply-chain gate did not pass');
  if (report?.source?.revision !== rehearsal.source?.revision || report?.source?.dirty !== false) errors.push('supply-chain report is not bound to the clean rehearsal revision');
  if (report?.source?.node !== rehearsal.source?.node || report?.source?.v8 !== rehearsal.source?.v8) errors.push('supply-chain runtime identity differs from rehearsal runtime');
  if (report?.source?.packageLockSha256 !== rehearsal.source?.packageLockSha256) errors.push('supply-chain package-lock digest differs from rehearsal input');
  const counts = report?.dependencyAudit?.vulnerabilityCounts;
  if (counts?.high !== 0 || counts?.critical !== 0) errors.push('supply-chain report contains high or critical production vulnerabilities');
  if ((report?.credentialScan?.findings ?? []).length > 0) errors.push('tracked credential scan has findings');
  if ((report?.dependencyAudit?.components ?? []).some(component => !component.selectedLicense || !component.lockEvidence)) {
    errors.push('supply-chain component is missing reviewed license or lock evidence');
  }
}

function validateProvenance(rehearsal, provenance, errors) {
  if (provenance?._type !== 'https://in-toto.io/Statement/v1') errors.push('provenance is not an in-toto Statement v1');
  if (provenance?.predicateType !== 'https://slsa.dev/provenance/v1') errors.push('provenance predicate is not SLSA provenance v1');
  const predicate = provenance?.predicate;
  if (predicate?.runDetails?.metadata?.invocationId !== rehearsal.id) errors.push('provenance invocation does not match rehearsal');
  if (predicate?.runDetails?.builder?.id !== '.github/workflows/ci-release-rehearsal.yml') errors.push('provenance builder does not identify the release workflow');
  const external = predicate?.buildDefinition?.externalParameters;
  if (external?.releaseVersion !== rehearsal.releaseVersion || external?.contentTier !== 'full' || external?.publish !== false) {
    errors.push('provenance external parameters do not bind full no-publish rehearsal inputs');
  }
  const dependencies = new Map((predicate?.buildDefinition?.resolvedDependencies ?? []).map(item => [item.uri, item.digest]));
  if (dependencies.get('git+https://github.com/HypnosNova/HaiYue.git')?.gitCommit !== rehearsal.source?.revision) errors.push('provenance revision does not match rehearsal');
  if (dependencies.get('file:package-lock.json')?.sha256 !== rehearsal.source?.packageLockSha256) errors.push('provenance package-lock digest does not match rehearsal');
  if (dependencies.get('file:review/api/release-manifest.json')?.sha256 !== rehearsal.source?.releaseManifestSha256) errors.push('provenance release-manifest digest does not match rehearsal');
  const runtime = (predicate?.runDetails?.byproducts ?? []).find(item => item.name === 'runtime')?.value;
  if (runtime?.node !== rehearsal.source?.node || runtime?.v8 !== rehearsal.source?.v8 || runtime?.npm !== rehearsal.source?.npm) {
    errors.push('provenance runtime identity does not match rehearsal');
  }
}

function validateSbom(rehearsal, sbom, errors) {
  if (sbom?.bomFormat !== 'CycloneDX' || sbom?.specVersion !== '1.5') errors.push('release SBOM is not CycloneDX 1.5');
  const properties = new Map((sbom?.metadata?.properties ?? []).map(item => [item.name, item.value]));
  if (properties.get('haiyue:release-manifest') !== 'review/api/release-manifest.json') errors.push('release SBOM does not bind the frozen manifest');
  const dependencyRefs = (sbom?.components ?? []).filter(component => component.type === 'library');
  if (dependencyRefs.length === 0) errors.push('release SBOM contains no production dependency components');
  if (!/^[0-9a-f-]{36}$/u.test(String(sbom?.serialNumber ?? '').replace(/^urn:uuid:/u, ''))) errors.push('release SBOM serial number is invalid');
  if (!rehearsal.source?.packageLockSha256) errors.push('rehearsal package-lock digest is missing');
}

function validateReleaseInputs(releaseManifest, plan, notes, notesSource, changelog, errors) {
  const version = releaseManifest.releaseVersion;
  if (plan?.version !== version || plan?.tag !== `v${version}`) errors.push('release plan version/tag does not match the frozen manifest');
  const inputs = plan?.validatedInputs;
  if (inputs?.rootVersion !== version || inputs?.changelog !== 'CHANGELOG.md'
    || inputs?.releaseNotes !== `docs/engine-guide/release-notes-${version}.md`) {
    errors.push('release plan version/changelog/release-note inputs do not match the frozen release');
  }
  const expectedPackages = releaseManifest.artifacts
    .filter(item => item.kind === 'npm-package')
    .map(item => `${item.packageName}@${item.version}`).sort();
  const actualPackages = (inputs?.publicPackageVersions ?? []).map(item => `${item.name}@${item.version}`).sort();
  if (!sameList(actualPackages, expectedPackages)) errors.push('release plan public package versions differ from release manifest');
  if (!notes || !notesSource || !Buffer.from(notes).equals(Buffer.from(notesSource))) errors.push('bundled release notes differ from the checked-in release-note candidate');
  else if (!Buffer.from(notes).toString('utf8').includes(version)) errors.push('bundled release notes do not identify the release version');
  const changelogText = changelog ? Buffer.from(changelog).toString('utf8') : '';
  if (!new RegExp(`^## (?:\\[)?${escapeRegex(version)}(?:\\])?(?:\\s|$)`, 'mu').test(changelogText)) errors.push('CHANGELOG.md does not contain the release version');
}

function validatePublicationAndRollback(releaseManifest, plan, errors) {
  const actions = plan?.publicationActions ?? [];
  if (actions.some(action => action.executed !== false || action.authorizationRequired !== true)) errors.push('publication action is executed or lacks explicit authorization');
  const expectedKeys = [
    'signed-tag:',
    ...releaseManifest.artifacts.filter(item => item.kind === 'npm-package').map(item => `npm-publish:${item.id}`),
    'github-release:',
    ...releaseManifest.artifacts.filter(item => item.kind !== 'npm-package').map(item => `${item.kind === 'electron-platform-set' ? 'github-release-attachment' : 'immutable-static-deployment'}:${item.id}`),
  ].sort();
  const actionKeys = actions.map(action => `${action.type}:${action.artifact ?? ''}`).sort();
  if (!sameList(actionKeys, expectedKeys)) errors.push('release plan does not cover exact tag/npm/GitHub/app publication actions');
  const tag = actions.find(action => action.type === 'signed-tag');
  if (!sameList(tag?.command ?? [], ['git', 'tag', '-s', plan.tag])) errors.push('signed-tag dry-run command is incomplete');
  const github = actions.find(action => action.type === 'github-release');
  if (!sameList(github?.command ?? [], ['gh', 'release', 'create', plan.tag, '--verify-tag'])) errors.push('GitHub Release dry-run command is incomplete');
  if (github?.protectedEnvironmentRequired !== 'github-release') errors.push('GitHub Release dry-run is not bound to its protected environment');
  for (const action of actions.filter(item => item.type === 'npm-publish')) {
    if (!sameList(action.command ?? [], ['npm', 'publish', '--access', 'public', '--tag', 'latest']) || action.protectedEnvironmentRequired !== 'npm-publish') {
      errors.push(`${action.artifact} npm publication dry-run is incomplete`);
    }
  }
  for (const artifact of releaseManifest.artifacts.filter(item => item.kind !== 'npm-package')) {
    const action = actions.find(item => item.artifact === artifact.id);
    const expectedEnvironment = artifact.kind === 'electron-platform-set' ? 'release-signing' : 'static-production';
    if (action?.protectedEnvironmentRequired !== expectedEnvironment) errors.push(`${artifact.id} publication dry-run is not bound to ${expectedEnvironment}`);
  }
  if (!Array.isArray(plan?.failureRecovery) || plan.failureRecovery.length < 3) errors.push('failure recovery checklist is incomplete');
  const rollbackUnits = (plan?.rollback ?? []).map(item => item.unit).sort();
  const expectedRollbackUnits = releaseManifest.artifacts.map(artifact => artifact.rollbackUnit).sort();
  if (!sameList(rollbackUnits, expectedRollbackUnits)) errors.push('rollback checklist does not cover every release manifest unit');
  if ((plan?.rollback ?? []).some(item => !Array.isArray(item.steps) || item.steps.length === 0)) errors.push('rollback checklist contains an empty recovery procedure');
}

function validateRawEvidence(rehearsal, evidenceFiles, errors) {
  const root = rehearsal.evidence?.rawEvidenceRoot;
  const supplyRoot = dirname(rehearsal.evidence?.supplyChainReportPath ?? '');
  const required = [
    `${root}/g03-package-app-candidate.json`,
    `${root}/public-packages.json`,
    ...REQUIRED_APP_MANIFESTS.map(name => `${root}/app-manifests/${name}.json`),
    `${supplyRoot}/npm-audit-production.json`,
    `${supplyRoot}/dependencies.cdx.json`,
  ];
  const available = new Set(evidenceFiles);
  for (const path of required) if (!available.has(path)) errors.push(`required raw evidence is missing: ${path}`);
}

function validateRawReports(root, evidence, errors) {
  const rawRoot = resolve(root, evidence.rawEvidenceRoot ?? '');
  if (!isInside(root, rawRoot)) {
    errors.push('raw evidence root escapes the repository');
    return;
  }
  for (const name of ['g03-package-app-candidate.json', 'public-packages.json']) {
    const path = resolve(rawRoot, name);
    if (!existsSync(path)) continue;
    const report = readJson(path, name);
    if (report.gate?.status !== 'passed' || (report.gate?.errors ?? []).length > 0) errors.push(`${name} raw evidence gate did not pass`);
  }
  for (const name of REQUIRED_APP_MANIFESTS) {
    const path = resolve(rawRoot, 'app-manifests', `${name}.json`);
    if (!existsSync(path)) continue;
    const report = readJson(path, `${name} app manifest`);
    if ((report.errors ?? []).length > 0) errors.push(`${name} app manifest contains build errors`);
  }
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}.`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(resolve(directory, entry.name), path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function assertInside(parent, child, label) {
  if (!isInside(parent, child)) throw new Error(`${label} must remain inside ${parent}.`);
}

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function runCli() {
  const allowed = new Set(['--bundle']);
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!allowed.has(process.argv[index]) || !process.argv[index + 1]) throw new Error(`Unknown or incomplete rehearsal policy argument "${process.argv[index]}".`);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = validateReleaseRehearsalDirectory(root, argumentValue('--bundle') ?? 'artifacts/release/rehearsal');
  if (result.errors.length > 0) {
    console.error('[release-rehearsal-policy] failed:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[release-rehearsal-policy] passed; tier=full; targets=${result.rehearsal.artifacts.map(item => item.id).join(',')}; `
    + `runner=${result.rehearsal.source.platform}; device=not-claimed; `
    + `device-reason=required physical-device evidence uses separate exact-label jobs; `
    + `manual=skipped; manual-reason=operator-only targets are excluded from automatic tiers; `
    + `node=${result.rehearsal.source.node}; v8=${result.rehearsal.source.v8}; validator=scripts/release-rehearsal-policy.mjs.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
