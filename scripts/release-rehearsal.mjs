import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDeterministicTar, listScannableFiles } from './release-archive.mjs';
import { parseSha256Sums, sha256, validateReleaseRehearsalBundle } from './release-rehearsal-policy.mjs';
import { findCredentialLeaks, sha256File } from './release-supply-chain-policy.mjs';
import { npmArgs, npmCommand } from './npm-process.mjs';
import { releaseCatalogBuildTimeout } from './release-duration-policy.mjs';
import { portableReleasePath } from './release-path-policy.mjs';
import { releaseTemporaryBase } from './release-temp-path.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = process.argv.includes('--worker');
const candidateSnapshot = process.argv.includes('--candidate-snapshot');
let workerPhase = 'startup';
for (const argument of process.argv.slice(2)) {
  if (!['--worker', '--candidate-snapshot'].includes(argument)) throw new Error(`Unknown release rehearsal argument "${argument}".`);
}
if (worker && candidateSnapshot) throw new Error('--worker and --candidate-snapshot cannot be combined.');
assertNodeVersion();
assertNoPublishCredentials();

if (worker) {
  try {
    runWorker();
  } catch (error) {
    writeWorkerFailure(error);
    throw error;
  }
} else {
  runFromTemporaryCheckout(candidateSnapshot);
}

function runFromTemporaryCheckout(snapshot) {
  const sourceRevision = git(root, ['rev-parse', 'HEAD']);
  const sourceDirty = git(root, ['status', '--porcelain']).length > 0;
  if (sourceDirty && !snapshot) {
    throw new Error('Release rehearsal requires a clean source checkout; use --candidate-snapshot only for a local uncommitted G06 verification.');
  }
  const temporaryBase = releaseTemporaryBase();
  mkdirSync(temporaryBase, { recursive: true });
  const temporaryRoot = mkdtempSync(resolve(temporaryBase, 'haiyue-release-rehearsal-'));
  const checkout = resolve(temporaryRoot, 'checkout');
  const rehearsalNpmCache = resolve(temporaryBase, 'haiyue-g06-release-rehearsal-npm-cache-v1');
  mkdirSync(rehearsalNpmCache, { recursive: true });
  console.log(`[release-rehearsal] source=${sourceRevision}; candidate-snapshot=${snapshot}; temporary-checkout=${checkout}.`);
  try {
    runChecked(temporaryRoot, 'clone clean local candidate', 'git', ['clone', '--quiet', '--no-hardlinks', '--local', root, checkout], 300_000);
    runChecked(checkout, 'detach exact source revision', 'git', ['checkout', '--quiet', '--detach', sourceRevision], 60_000);
    if (process.platform === 'win32') {
      runChecked(checkout, 'normalize Windows Git file-mode detection', 'git', ['config', 'core.filemode', 'false'], 60_000);
    }
    if (snapshot) applyCandidateSnapshot(checkout, sourceRevision);
    if (git(checkout, ['status', '--porcelain']).length > 0) throw new Error('Temporary release checkout is not clean.');
    runChecked(checkout, 'install locked dependencies', npmCommand(), npmArgs([
      'ci', '--cache', rehearsalNpmCache,
    ]), 1_200_000);
    normalizeWindowsWorkspaceBin(checkout);
    refreshGitIndex(checkout);
    const postInstallStatus = git(checkout, ['status', '--porcelain']);
    if (postInstallStatus) {
      const postInstallDiff = git(checkout, ['diff', '--', 'animation-spec/bin/hya-convert.mjs']);
      throw new Error(
        `Locked dependency installation changed the clean checkout:\n${postInstallStatus}`
        + `${postInstallDiff ? `\n${postInstallDiff}` : ''}`,
      );
    }
    const environment = sanitizedEnvironment({
      HAIYUE_REHEARSAL_PARENT_MODE: snapshot ? 'candidate-snapshot' : 'clean-head',
      HAIYUE_REHEARSAL_BASE_REVISION: sourceRevision,
    });
    try {
      runChecked(checkout, 'execute no-publish rehearsal worker', process.execPath, ['scripts/release-rehearsal.mjs', '--worker'], 7_200_000, environment);
    } catch (error) {
      preserveWorkerFailure(checkout);
      throw error;
    }
    runChecked(checkout, 'independently validate assembled rehearsal bundle', process.execPath, [
      'scripts/release-rehearsal-policy.mjs', '--bundle', 'artifacts/release/rehearsal',
    ], 300_000, environment);
    const sourceOutput = resolve(checkout, 'artifacts/release/rehearsal');
    if (!existsSync(resolve(sourceOutput, 'report.json'))) throw new Error('Rehearsal worker did not emit report.json.');
    const destination = resolve(root, 'artifacts/release/rehearsal');
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(sourceOutput, destination, { recursive: true });
    const report = JSON.parse(readFileSync(resolve(destination, 'report.json'), 'utf8'));
    if (report.gate?.status !== 'passed') throw new Error('Copied release rehearsal report is not passed.');
    console.log(
      `[release-rehearsal] passed from clean temporary checkout; artifacts=${report.artifacts.length}; `
      + `revision=${report.source.revision}; report=${relative(root, resolve(destination, 'report.json'))}.`,
    );
  } finally {
    rmSync(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

function applyCandidateSnapshot(checkout, baseRevision) {
  const changedTracked = gitNull(root, ['diff', '--name-only', '-z', baseRevision, '--'])
    .filter(isG06CandidatePath);
  const changedUntracked = gitNull(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .filter(isG06CandidatePath);
  const excluded = [
    ...gitNull(root, ['diff', '--name-only', '-z', baseRevision, '--']).filter(path => !isG06CandidatePath(path)),
    ...gitNull(root, ['ls-files', '--others', '--exclude-standard', '-z']).filter(path => !isG06CandidatePath(path)),
  ];
  if (excluded.length > 0) {
    console.log(`[release-rehearsal] candidate snapshot excludes unrelated paths: ${excluded.join(', ')}.`);
  }
  const patch = changedTracked.length > 0
    ? spawnSync('git', ['diff', '--binary', baseRevision, '--', ...changedTracked], { cwd: root, encoding: 'buffer' })
    : { status: 0, stdout: Buffer.alloc(0) };
  if (patch.status !== 0) throw new Error('Unable to create candidate snapshot patch.');
  if (patch.stdout.byteLength > 0) {
    const apply = spawnSync('git', ['apply', '--binary', '-'], { cwd: checkout, input: patch.stdout, encoding: 'buffer' });
    if (apply.status !== 0) throw new Error(`Unable to apply candidate snapshot patch: ${apply.stderr.toString('utf8')}`);
  }
  for (const path of changedUntracked) {
    const source = resolve(root, path);
    const destination = resolve(checkout, path);
    assertInside(checkout, destination);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  runChecked(checkout, 'stage local candidate snapshot', 'git', ['add', '-A'], 60_000);
  if (!git(checkout, ['status', '--porcelain'])) return;
  const commitEnvironment = sanitizedEnvironment({
    GIT_AUTHOR_NAME: 'HaiYue release rehearsal',
    GIT_AUTHOR_EMAIL: 'release-rehearsal@invalid.local',
    GIT_COMMITTER_NAME: 'HaiYue release rehearsal',
    GIT_COMMITTER_EMAIL: 'release-rehearsal@invalid.local',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  });
  runChecked(checkout, 'commit deterministic local candidate snapshot', 'git', ['commit', '--quiet', '-m', 'G06 local candidate snapshot'], 60_000, commitEnvironment);
}

function isG06CandidatePath(path) {
  return path.startsWith('.github/workflows/')
    || path.startsWith('scripts/release-')
    || path === 'package-lock.json'
    || path === 'SECURITY.md'
    || path === 'docs/for-ai/release-process.md';
}

function runWorker() {
  workerPhase = 'verify clean worker revision';
  normalizeWindowsWorkspaceBin(root);
  refreshGitIndex(root);
  const workerStatus = git(root, ['status', '--porcelain']);
  if (workerStatus) throw new Error(`Release rehearsal worker requires a clean revision:\n${workerStatus}`);
  const startedAt = new Date().toISOString();
  const releaseManifestPath = resolve(root, 'review/api/release-manifest.json');
  const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
  const version = releaseManifest.releaseVersion;
  validateVersionInputs(releaseManifest);
  const outputRoot = resolve(root, 'artifacts/release/rehearsal');
  const artifactRoot = resolve(outputRoot, 'artifacts');
  const evidenceRoot = resolve(outputRoot, 'evidence');
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  const baselineBefore = hashTree(resolve(root, 'review/baselines'));
  const commands = [];

  run('production dependency, license and credential audit', process.execPath, [
    'scripts/release-supply-chain.mjs', '--output', 'artifacts/release/rehearsal/supply-chain',
  ], 600_000, commands);
  run('build clean-checkout workspace dependency foundations', process.execPath, [
    'scripts/release-ci-bootstrap.mjs',
  ], 1_200_000, commands);
  run('fast release prerequisite gate', npmCommand(), npmArgs(['run', 'check:fast']), 1_800_000, commands);
  run('deterministic public packages and app delivery', process.execPath, [
    'scripts/inspect-release-artifacts.mjs', '--release',
  ], 2_400_000, commands);
  run(
    'build complete examples catalog',
    npmCommand(),
    npmArgs(['run', 'build:examples']),
    catalogBuildTimeout('examples'),
    commands,
  );
  run(
    'build complete games catalog',
    npmCommand(),
    npmArgs(['run', 'build:games']),
    catalogBuildTimeout('games'),
    commands,
  );

  workerPhase = 'assemble release archives';
  const temporaryBase = releaseTemporaryBase();
  mkdirSync(temporaryBase, { recursive: true });
  const stagingRoot = mkdtempSync(resolve(temporaryBase, 'haiyue-release-staging-'));
  let artifactRecords;
  let artifactCredentialFindings;
  try {
    const archiveInputs = prepareArchiveInputs(stagingRoot, releaseManifest);
    artifactCredentialFindings = deduplicateFindings(findCredentialLeaks(listScannableFiles(
      archiveInputs.flatMap(input => input.roots),
    )));
    if (artifactCredentialFindings.length > 0) {
      throw new Error(`Credential scan rejected release inputs: ${artifactCredentialFindings.map(finding => finding.path).join(', ')}`);
    }
    artifactRecords = buildReleaseArtifacts(releaseManifest, archiveInputs, artifactRoot);
  } finally {
    rmSync(stagingRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }

  workerPhase = 'preserve raw evidence and create release metadata';
  preserveRawEvidence(evidenceRoot);
  const releaseNotesSource = resolve(root, `docs/engine-guide/release-notes-${version}.md`);
  const releaseNotesPath = resolve(outputRoot, 'release-notes.md');
  cpSync(releaseNotesSource, releaseNotesPath);
  const checksumPath = resolve(outputRoot, 'SHA256SUMS');
  const checksumText = artifactRecords.map(artifact => `${artifact.sha256}  ${artifact.path}`).sort().join('\n') + '\n';
  writeFileSync(checksumPath, checksumText);

  const supplyChainReport = JSON.parse(readFileSync(resolve(outputRoot, 'supply-chain/report.json'), 'utf8'));
  const dependencySbom = JSON.parse(readFileSync(resolve(outputRoot, 'supply-chain/dependencies.cdx.json'), 'utf8'));
  const revision = git(root, ['rev-parse', 'HEAD']);
  const invocationId = `g06-${revision.slice(0, 12)}-${version}`;
  const releasePlan = createReleasePlan(releaseManifest, releaseNotesSource);
  const releasePlanPath = resolve(outputRoot, 'release-plan.json');
  writeFileSync(releasePlanPath, `${JSON.stringify(releasePlan, null, 2)}\n`);
  const sbom = createReleaseSbom(dependencySbom, artifactRecords, releaseManifest);
  const sbomPath = resolve(outputRoot, 'release.cdx.json');
  writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  const provenance = createProvenance({ invocationId, revision, releaseManifest, artifactRecords, commands });
  const provenancePath = resolve(outputRoot, 'provenance.intoto.json');
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  const baselineAfter = hashTree(resolve(root, 'review/baselines'));
  const sourceDirty = git(root, ['status', '--porcelain']).length > 0;
  const report = {
    schemaVersion: 1,
    id: invocationId,
    goal: 'g06-ci-supply-chain-release-rehearsal',
    candidateState: 'rehearsal-passed-g07-clean-replay-required',
    generatedAt: new Date().toISOString(),
    startedAt,
    releaseVersion: version,
    candidateTag: `v${version}`,
    candidateTagPresent: git(root, ['tag', '--points-at', 'HEAD']).split('\n').includes(`v${version}`),
    executionMode: process.env.HAIYUE_REHEARSAL_PARENT_MODE ?? 'clean-worker',
    baseRevision: process.env.HAIYUE_REHEARSAL_BASE_REVISION ?? revision,
    externalPublishPerformed: false,
    formalBaselineUpdated: false,
    source: {
      revision,
      dirty: sourceDirty,
      node: process.version,
      v8: process.versions.v8,
      npm: npmVersion(),
      platform: `${process.platform}-${process.arch}`,
      packageLockSha256: sha256File(resolve(root, 'package-lock.json')),
      releaseManifestSha256: sha256File(releaseManifestPath),
      formalBaselineBefore: baselineBefore,
      formalBaselineAfter: baselineAfter,
    },
    contentRouting: {
      pullRequestAndMain: 'smoke',
      nightlyAndRelease: 'full',
      manualTargetsAutomaticallySelected: false,
    },
    commands,
    artifacts: artifactRecords,
    artifactCredentialFindings,
    evidence: {
      checksumPath: portableReleasePath(relative(root, checksumPath)),
      provenancePath: portableReleasePath(relative(root, provenancePath)),
      sbomPath: portableReleasePath(relative(root, sbomPath)),
      releaseNotesPath: portableReleasePath(relative(root, releaseNotesPath)),
      releasePlanPath: portableReleasePath(relative(root, releasePlanPath)),
      supplyChainReportPath: portableReleasePath(relative(root, resolve(outputRoot, 'supply-chain/report.json'))),
      rawEvidenceRoot: portableReleasePath(relative(root, evidenceRoot)),
    },
    gate: { status: 'validating', errors: [] },
  };
  workerPhase = 'validate assembled release bundle';
  const validationErrors = validateReleaseRehearsalBundle({
    releaseManifest,
    rehearsal: report,
    provenance,
    sbom,
    releasePlan,
    checksumEntries: parseSha256Sums(checksumText),
    supplyChainReport,
    releaseNotes: readFileSync(releaseNotesPath),
    releaseNotesSource: readFileSync(releaseNotesSource),
    changelog: readFileSync(resolve(root, 'CHANGELOG.md')),
    evidenceFiles: listFiles(outputRoot).map(path => portableReleasePath(relative(root, resolve(outputRoot, path)))),
    readArtifact: path => {
      const absolute = resolve(root, path);
      return existsSync(absolute) ? readFileSync(absolute) : null;
    },
  });
  if (sourceDirty) validationErrors.push('release commands changed tracked source files');
  report.gate = { status: validationErrors.length === 0 ? 'passed' : 'failed', errors: validationErrors };
  const reportPath = resolve(outputRoot, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (validationErrors.length > 0) {
    for (const error of validationErrors) console.error(`[release-rehearsal] ${error}`);
    process.exit(1);
  }
  console.log(
    `[release-rehearsal] no-publish worker passed; tier=full; artifacts=${artifactRecords.map(item => item.id).join(',')}; `
    + `node=${process.version}; v8=${process.versions.v8}; validator=scripts/release-rehearsal-policy.mjs; report=${relative(root, reportPath)}.`,
  );
}

function refreshGitIndex(directory) {
  // npm links workspace bins by touching their targets. On Windows this can
  // leave Git's stat cache stale even though the blob and executable contract
  // are unchanged. Refresh still reports real content/untracked changes to the
  // following status check.
  if (process.platform === 'win32') {
    spawnSync('git', ['config', 'core.filemode', 'false'], { cwd: directory, encoding: 'utf8' });
  }
  spawnSync('git', ['update-index', '-q', '--refresh'], { cwd: directory, encoding: 'utf8' });
}

function normalizeWindowsWorkspaceBin(directory) {
  if (process.platform !== 'win32') return;
  const path = 'animation-spec/bin/hya-convert.mjs';
  const expected = git(directory, ['rev-parse', `HEAD:${path}`]);
  const actual = git(directory, ['hash-object', '--', path]);
  if (actual !== expected) {
    throw new Error(`npm ci changed the frozen ${path} contents (${actual} !== ${expected}).`);
  }
  const result = spawnSync('git', ['checkout-index', '--force', '--', path], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Could not normalize Windows workspace bin metadata: ${result.stderr.trim()}`);
}

function prepareArchiveInputs(stagingRoot, releaseManifest) {
  const catalogs = new Map();
  for (const kind of ['examples', 'games']) catalogs.set(kind, stageCatalog(kind, resolve(stagingRoot, `${kind}-catalog`)));
  const electronRoot = resolve(root, 'artifacts/release/apps/voxel-electron');
  const electronEntries = readdirSync(electronRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({ source: resolve(electronRoot, entry.name), prefix: entry.name }));
  if (electronEntries.length === 0) throw new Error('Voxel Electron rehearsal has no current-host platform directory.');
  const inputs = [
    { id: 'scene-editor-static', filename: `haiyue-scene-editor-${releaseManifest.releaseVersion}.tar`, roots: [{ source: resolve(root, 'artifacts/release/apps/scene-editor'), prefix: 'editor' }] },
    { id: 'animation-editor-static', filename: `haiyue-animation-editor-${releaseManifest.releaseVersion}.tar`, roots: [{ source: resolve(root, 'artifacts/release/apps/animation-editor'), prefix: 'AnimationEditor' }] },
    { id: 'voxel-editor-pwa', filename: `haiyue-voxel-editor-pwa-${releaseManifest.releaseVersion}.tar`, roots: [{ source: resolve(root, 'artifacts/release/apps/voxel-pwa'), prefix: 'voxelEditor/app-dist' }] },
    { id: 'voxel-editor-electron', filename: `haiyue-voxel-editor-electron-${process.platform}-${process.arch}-${releaseManifest.releaseVersion}.tar`, roots: electronEntries },
    { id: 'examples-static-catalog', filename: `haiyue-examples-${releaseManifest.releaseVersion}.tar`, roots: catalogs.get('examples') },
    { id: 'games-static-catalog', filename: `haiyue-games-${releaseManifest.releaseVersion}.tar`, roots: catalogs.get('games') },
  ];
  return inputs;
}

function stageCatalog(kind, destination) {
  const sourceRoot = resolve(root, kind);
  const manifest = JSON.parse(readFileSync(resolve(sourceRoot, 'manifest.json'), 'utf8'));
  const directories = new Set(manifest.entries.map(entry => dirname(entry.entry)));
  mkdirSync(resolve(destination, kind), { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(resolve(sourceRoot, entry.name), resolve(destination, kind, entry.name));
  }
  for (const directory of [...directories].sort()) {
    const source = resolve(sourceRoot, directory);
    const target = resolve(destination, kind, directory);
    cpSync(source, target, { recursive: true });
    for (const required of ['index.html', 'bundle.js']) {
      if (!existsSync(resolve(target, required))) throw new Error(`${kind}:${directory} is missing built ${required}.`);
    }
  }
  for (const asset of new Set(manifest.entries.flatMap(entry => entry.assets ?? []))) {
    const source = resolve(sourceRoot, asset);
    assertInside(root, source);
    if (!existsSync(source)) throw new Error(`${kind} catalog asset is missing: ${asset}.`);
    const target = resolve(destination, relative(root, source));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  return readdirSync(destination, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ source: resolve(destination, entry.name), prefix: entry.name }));
}

function buildReleaseArtifacts(releaseManifest, archiveInputs, artifactRoot) {
  const contractById = new Map(releaseManifest.artifacts.map(artifact => [artifact.id, artifact]));
  const records = [];
  for (const contract of releaseManifest.artifacts.filter(artifact => artifact.kind === 'npm-package')) {
    const filename = `${contract.packageName.replace(/^@/, '').replaceAll('/', '-')}-${contract.version}.tgz`;
    const source = resolve(root, 'artifacts/release/npm', filename);
    const target = resolve(artifactRoot, filename);
    if (!existsSync(source)) throw new Error(`${contract.id} tarball is missing.`);
    cpSync(source, target);
    records.push(recordArtifact(contract, target));
  }
  for (const input of archiveInputs) {
    const contract = contractById.get(input.id);
    if (!contract) throw new Error(`Archive input ${input.id} is not in the release manifest.`);
    const output = resolve(artifactRoot, input.filename);
    createDeterministicTar(output, input.roots);
    records.push(recordArtifact(contract, output, input.id === 'voxel-editor-electron'
      ? { candidatePlatforms: [`${process.platform}-${process.arch}`], signing: 'unsigned-preview' }
      : {}));
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

function recordArtifact(contract, absolutePath, extra = {}) {
  const contents = readFileSync(absolutePath);
  return {
    id: contract.id,
    kind: contract.kind,
    version: contract.version,
    publishChannel: contract.publishChannel,
    rollbackUnit: contract.rollbackUnit,
    path: portableReleasePath(relative(root, absolutePath)),
    bytes: contents.byteLength,
    sha256: sha256(contents),
    ...extra,
  };
}

function preserveRawEvidence(evidenceRoot) {
  for (const path of [
    'artifacts/release/g03-package-app-candidate.json',
    'artifacts/release/public-packages.json',
  ]) {
    const source = resolve(root, path);
    if (!existsSync(source)) throw new Error(`Required raw evidence is missing: ${path}.`);
    cpSync(source, resolve(evidenceRoot, basename(path)));
  }
  const appEvidenceRoot = resolve(evidenceRoot, 'app-manifests');
  mkdirSync(appEvidenceRoot, { recursive: true });
  for (const directory of ['scene-editor', 'animation-editor', 'voxel-pwa', 'hya-viewer', 'hya-dashboard']) {
    const source = resolve(root, 'artifacts/release/apps', directory, 'release-manifest.json');
    cpSync(source, resolve(appEvidenceRoot, `${directory}.json`));
  }
}

function createReleasePlan(releaseManifest, releaseNotesPath) {
  const version = releaseManifest.releaseVersion;
  const tag = `v${version}`;
  return {
    schemaVersion: 1,
    mode: 'dry-run-no-external-side-effects',
    version,
    tag,
    validatedInputs: {
      rootVersion: version,
      publicPackageVersions: releaseManifest.artifacts.filter(item => item.kind === 'npm-package').map(item => ({ name: item.packageName, version: item.version })),
      changelog: 'CHANGELOG.md',
      releaseNotes: portableReleasePath(relative(root, releaseNotesPath)),
    },
    publicationActions: [
      { type: 'signed-tag', command: ['git', 'tag', '-s', tag], executed: false, authorizationRequired: true },
      ...releaseManifest.artifacts.filter(item => item.kind === 'npm-package').map(item => ({
        type: 'npm-publish', artifact: item.id, command: ['npm', 'publish', '--access', 'public', '--tag', 'latest'], executed: false, protectedEnvironmentRequired: 'npm-publish', authorizationRequired: true,
      })),
      { type: 'github-release', command: ['gh', 'release', 'create', tag, '--verify-tag'], executed: false, protectedEnvironmentRequired: 'github-release', authorizationRequired: true },
      ...releaseManifest.artifacts.filter(item => item.kind !== 'npm-package').map(item => ({
        type: item.kind === 'electron-platform-set' ? 'github-release-attachment' : 'immutable-static-deployment',
        artifact: item.id,
        executed: false,
        protectedEnvironmentRequired: item.kind === 'electron-platform-set' ? 'release-signing' : 'static-production',
        authorizationRequired: true,
      })),
    ],
    failureRecovery: [
      'Abort before any external action when a checksum, provenance, SBOM, release-note, credential, or gate validation fails.',
      'Keep immutable candidate artifacts and raw evidence for diagnosis; never rewrite a published version or accepted evidence in place.',
      'Resume only from a new clean frozen revision and rerun the complete rehearsal and required browser/hardware validators.',
    ],
    rollback: releaseManifest.artifacts.map(artifact => ({
      artifact: artifact.id,
      unit: artifact.rollbackUnit,
      steps: rollbackSteps(artifact),
    })),
  };
}

function rollbackSteps(artifact) {
  if (artifact.kind === 'npm-package') return [
    'Before publish, abort without consuming the immutable package version.',
    'After publish, deprecate the affected version and publish a corrected patch; never overwrite the published tarball.',
  ];
  if (artifact.kind === 'electron-platform-set') return [
    'Withdraw the affected unsigned preview attachment and preserve its checksum in the incident record.',
    'Build a corrected platform set from a new version and rerun signing/notarization only in the protected environment.',
  ];
  return [
    'Switch the public alias back to the previously accepted immutable deployment.',
    'Preserve the rejected deployment and evidence, then deploy a corrected new version from a clean revision.',
  ];
}

function createReleaseSbom(dependencySbom, artifacts, releaseManifest) {
  const contracts = new Map(releaseManifest.artifacts.map(item => [item.id, item]));
  return {
    ...dependencySbom,
    metadata: {
      ...dependencySbom.metadata,
      properties: [
        ...(dependencySbom.metadata?.properties ?? []),
        { name: 'haiyue:release-manifest', value: 'review/api/release-manifest.json' },
      ],
    },
    components: [
      ...(dependencySbom.components ?? []),
      ...artifacts.map(artifact => ({
        type: 'file',
        'bom-ref': `release-artifact:${artifact.id}`,
        name: artifact.id,
        version: artifact.version,
        hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
        properties: [
          { name: 'haiyue:path', value: artifact.path },
          { name: 'haiyue:publish-channel', value: contracts.get(artifact.id).publishChannel },
          { name: 'haiyue:rollback-unit', value: contracts.get(artifact.id).rollbackUnit },
        ],
      })),
    ],
  };
}

function createProvenance({ invocationId, revision, releaseManifest, artifactRecords, commands }) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: artifactRecords.map(artifact => ({ name: artifact.path, digest: { sha256: artifact.sha256 } })),
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://haiyue.dev/build-types/first-public-release-rehearsal/v1',
        externalParameters: { releaseVersion: releaseManifest.releaseVersion, contentTier: 'full', publish: false },
        internalParameters: { commands: commands.map(command => command.command) },
        resolvedDependencies: [
          { uri: 'git+https://github.com/HypnosNova/HaiYue.git', digest: { gitCommit: revision } },
          { uri: 'file:package-lock.json', digest: { sha256: sha256File(resolve(root, 'package-lock.json')) } },
          { uri: 'file:review/api/release-manifest.json', digest: { sha256: sha256File(resolve(root, 'review/api/release-manifest.json')) } },
        ],
      },
      runDetails: {
        builder: { id: '.github/workflows/ci-release-rehearsal.yml' },
        metadata: { invocationId },
        byproducts: [{ name: 'runtime', value: { node: process.version, v8: process.versions.v8, npm: npmVersion() } }],
      },
    },
  };
}

function validateVersionInputs(releaseManifest) {
  const version = releaseManifest.releaseVersion;
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (rootPackage.version !== version) throw new Error(`Root version ${rootPackage.version} does not match release ${version}.`);
  for (const artifact of releaseManifest.artifacts.filter(item => item.kind === 'npm-package')) {
    const manifest = JSON.parse(readFileSync(resolve(root, artifact.workspace, 'package.json'), 'utf8'));
    if (manifest.version !== artifact.version || manifest.name !== artifact.packageName) throw new Error(`${artifact.id} package metadata differs from release manifest.`);
  }
  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const notesPath = resolve(root, `docs/engine-guide/release-notes-${version}.md`);
  if (!new RegExp(`^## (?:\\[)?${escapeRegex(version)}(?:\\])?(?:\\s|$)`, 'mu').test(changelog)) throw new Error(`CHANGELOG.md is missing ${version}.`);
  if (!existsSync(notesPath) || !readFileSync(notesPath, 'utf8').includes(version)) throw new Error(`Release notes for ${version} are missing.`);
}

function run(label, command, args, timeoutMs, commands) {
  workerPhase = label;
  const startedAt = new Date().toISOString();
  console.log(`\n[release-rehearsal] ${label}: ${command} ${args.join(' ')}`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    timeout: timeoutMs,
    env: sanitizedEnvironment(),
  });
  commands.push({
    label,
    command: [command, ...args],
    startedAt,
    durationMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited ${result.status}.`);
}

function writeWorkerFailure(error) {
  try {
    const outputRoot = resolve(root, 'artifacts/release/rehearsal');
    mkdirSync(outputRoot, { recursive: true });
    const report = {
      schemaVersion: 1,
      phase: workerPhase,
      generatedAt: new Date().toISOString(),
      revision: git(root, ['rev-parse', 'HEAD']),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
    };
    writeFileSync(resolve(outputRoot, 'failure.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[release-rehearsal] failure evidence written for phase "${workerPhase}".`);
  } catch (writeError) {
    console.error(`[release-rehearsal] could not write failure evidence: ${writeError?.message ?? writeError}`);
  }
}

function preserveWorkerFailure(checkout) {
  const source = resolve(checkout, 'artifacts/release/rehearsal');
  if (!existsSync(resolve(source, 'failure.json'))) return;
  const destination = resolve(root, 'artifacts/release/rehearsal-failure');
  rmSync(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  console.error(`[release-rehearsal] preserved worker failure at ${relative(root, resolve(destination, 'failure.json'))}.`);
}

function runChecked(cwd, label, command, args, timeoutMs, env = sanitizedEnvironment()) {
  console.log(`[release-rehearsal] ${label}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: timeoutMs, env });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited ${result.status}.`);
}

function catalogBuildTimeout(workspace) {
  const manifest = JSON.parse(readFileSync(resolve(root, workspace, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.entries)) {
    throw new TypeError(`${workspace}/manifest.json must contain an entries array.`);
  }
  return releaseCatalogBuildTimeout(manifest.entries.length);
}

function hashTree(directory) {
  const hash = createHash('sha256');
  if (!existsSync(directory)) return hash.digest('hex');
  for (const path of listFiles(directory)) {
    hash.update(path);
    hash.update(readFileSync(resolve(directory, path)));
  }
  return hash.digest('hex');
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

function deduplicateFindings(findings) {
  return [...new Map(findings.map(finding => [`${finding.kind}:${finding.path}`, finding])).values()];
}

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node, 10);
  if (!Number.isInteger(major) || major < 22) throw new Error(`Release rehearsal requires Node.js >=22; received ${process.version}.`);
}

function assertNoPublishCredentials() {
  const forbidden = ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GH_TOKEN', 'COSIGN_PRIVATE_KEY', 'SIGNING_KEY'];
  const present = forbidden.filter(name => process.env[name]);
  if (present.length > 0) throw new Error(`No-publish rehearsal refuses publish/signing credentials in its environment: ${present.join(', ')}.`);
}

function sanitizedEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GH_TOKEN', 'COSIGN_PRIVATE_KEY', 'SIGNING_KEY']) delete env[name];
  return env;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitNull(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed.`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function npmVersion() {
  const result = spawnSync(npmCommand(), npmArgs(['--version']), { cwd: root, encoding: 'utf8', env: sanitizedEnvironment() });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function assertInside(parent, child) {
  const path = relative(parent, child);
  if (path.startsWith('..') || path.startsWith('/') || path === '') throw new Error(`Path escapes expected root: ${child}.`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
