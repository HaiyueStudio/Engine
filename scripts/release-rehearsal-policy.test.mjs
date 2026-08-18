import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseCatalogBuildTimeout } from './release-duration-policy.mjs';
import { portableReleasePath } from './release-path-policy.mjs';
import { parseSha256Sums, sha256, validateReleaseRehearsalBundle } from './release-rehearsal-policy.mjs';
import { releaseTemporaryBase } from './release-temp-path.mjs';

const COMMAND_LABELS = [
  'production dependency, license and credential audit',
  'build clean-checkout workspace dependency foundations',
  'fast release prerequisite gate',
  'deterministic public packages and app delivery',
  'build complete examples catalog',
  'build complete games catalog',
];

test('complete rehearsal bundle binds manifest, hash, provenance, SBOM, release notes, raw evidence and rollback', () => {
  const fixture = completeFixture();
  assert.deepEqual(validate(fixture), []);
});

test('policy rejects publication, changed baseline and incomplete rollback', () => {
  const fixture = completeFixture();
  fixture.rehearsal.externalPublishPerformed = true;
  fixture.rehearsal.source.formalBaselineAfter = 'changed';
  fixture.releasePlan.publicationActions[0].executed = true;
  fixture.releasePlan.publicationActions.find(action => action.type === 'github-release').protectedEnvironmentRequired = null;
  fixture.releasePlan.rollback = [];
  const errors = validate(fixture);
  assert.ok(errors.includes('formal baseline tree changed during rehearsal'));
  assert.ok(errors.includes('rehearsal must not perform external publication'));
  assert.ok(errors.includes('publication action is executed or lacks explicit authorization'));
  assert.ok(errors.includes('GitHub Release dry-run is not bound to its protected environment'));
  assert.ok(errors.includes('rollback checklist does not cover every release manifest unit'));
});

test('policy rejects a forged SBOM hash, changed release notes, and missing raw audit evidence', () => {
  const fixture = completeFixture();
  fixture.sbom.components.find(component => component['bom-ref'] === 'release-artifact:engine-npm').hashes[0].content = '0'.repeat(64);
  fixture.releaseNotes = Buffer.from('different notes');
  fixture.evidenceFiles = fixture.evidenceFiles.filter(path => !path.endsWith('/npm-audit-production.json'));
  const errors = validate(fixture);
  assert.ok(errors.includes('engine-npm SBOM hash does not match'));
  assert.ok(errors.includes('bundled release notes differ from the checked-in release-note candidate'));
  assert.ok(errors.some(error => error.includes('npm-audit-production.json')));
});

test('policy rejects supply-chain or provenance evidence from another revision', () => {
  const fixture = completeFixture();
  fixture.supplyChainReport.source.revision = 'f'.repeat(40);
  fixture.provenance.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'e'.repeat(40);
  const errors = validate(fixture);
  assert.ok(errors.includes('supply-chain report is not bound to the clean rehearsal revision'));
  assert.ok(errors.includes('provenance revision does not match rehearsal'));
});

test('G06 candidate status never claims formal promotion or external publication', () => {
  const status = JSON.parse(readFileSync(new URL('./release-g06-candidate-status.json', import.meta.url), 'utf8'));
  assert.equal(status.goal, 'g06-ci-supply-chain-release-rehearsal');
  assert.equal(status.formalBaselineUpdated, false);
  assert.equal(status.milestoneStatusUpdated, false);
  assert.equal(status.externalPublishPerformed, false);
  assert.match(status.handoff.g07Required, /frozen clean HEAD/);
});

test('release rehearsal selects a long Windows temporary path independently of os.tmpdir', () => {
  assert.equal(releaseTemporaryBase({
    platform: 'win32',
    home: 'C:\\Users\\Administrator',
    systemTemp: 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp',
  }), resolve('C:\\Users\\Administrator', 'AppData', 'Local', 'Temp'));
  assert.equal(releaseTemporaryBase({
    platform: 'linux',
    home: '/home/test',
    systemTemp: '/tmp/custom',
  }), '/tmp/custom');
  const source = readFileSync(new URL('./release-rehearsal.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /realpathSync\s*\(\s*mkdtempSync/);
  assert.match(source, /releaseTemporaryBase\s*\(\s*\)/);
});

test('clean checkouts preserve canonical LF bytes for release fixtures', () => {
  const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.cmd text eol=crlf$/m);
  assert.match(attributes, /^\*\.bat text eol=crlf$/m);
});

test('release catalog timeout scales with the complete manifest', () => {
  assert.equal(releaseCatalogBuildTimeout(84), 3_780_000);
  assert.equal(releaseCatalogBuildTimeout(17), 1_200_000);
  assert.throws(() => releaseCatalogBuildTimeout(0), /positive safe integer/);
});

test('release rehearsal preserves phase-bound worker failure evidence', () => {
  const source = readFileSync(new URL('./release-rehearsal.mjs', import.meta.url), 'utf8');
  assert.match(source, /phase:\s*workerPhase/);
  assert.match(source, /artifacts\/release\/rehearsal-failure/);
  assert.match(source, /preserveWorkerFailure\(checkout\)/);
});

test('release rehearsal consumes the verified Electron release artifact', () => {
  const inspector = readFileSync(new URL('./inspect-release-artifacts.mjs', import.meta.url), 'utf8');
  const rehearsal = readFileSync(new URL('./release-rehearsal.mjs', import.meta.url), 'utf8');
  assert.match(inspector, /electronArtifactRoot\s*=\s*resolve\(appArtifactRoot, 'voxel-electron'\)/);
  assert.match(inspector, /syncVerifiedElectronArtifact\(electronOutputRoot, electronArtifactRoot\)/);
  assert.match(inspector, /Locked Electron artifact differs from the verified package/);
  assert.match(inspector, /Persisted Electron artifact differs from the verified package/);
  assert.match(rehearsal, /artifacts\/release\/apps\/voxel-electron/);
  assert.doesNotMatch(rehearsal, /voxelEditor\/release-electron/);
});

test('release metadata uses platform-independent logical paths', () => {
  assert.equal(
    portableReleasePath('artifacts\\release\\rehearsal\\evidence'),
    'artifacts/release/rehearsal/evidence',
  );
  assert.equal(portableReleasePath('artifacts/release/rehearsal'), 'artifacts/release/rehearsal');
});

function completeFixture() {
  const version = '0.1.0';
  const revision = 'a'.repeat(40);
  const packageLockSha256 = 'b'.repeat(64);
  const releaseManifestSha256 = 'c'.repeat(64);
  const contents = Buffer.from('candidate');
  const digest = sha256(contents);
  const contract = {
    id: 'engine-npm',
    kind: 'npm-package',
    packageName: '@haiyue/engine',
    version,
    publishChannel: 'npm/latest',
    rollbackUnit: 'npm-package-version:@haiyue/engine@0.1.0',
  };
  const artifact = {
    id: contract.id,
    kind: contract.kind,
    version,
    publishChannel: contract.publishChannel,
    rollbackUnit: contract.rollbackUnit,
    path: 'artifacts/release/rehearsal/artifacts/engine.tgz',
    bytes: contents.byteLength,
    sha256: digest,
  };
  const evidenceRoot = 'artifacts/release/rehearsal/evidence';
  const supplyRoot = 'artifacts/release/rehearsal/supply-chain';
  const rehearsal = {
    id: 'g06-test',
    releaseVersion: version,
    formalBaselineUpdated: false,
    externalPublishPerformed: false,
    artifactCredentialFindings: [],
    artifacts: [artifact],
    commands: COMMAND_LABELS.map(label => ({ label, status: 0 })),
    contentRouting: {
      pullRequestAndMain: 'smoke',
      nightlyAndRelease: 'full',
      manualTargetsAutomaticallySelected: false,
    },
    evidence: {
      rawEvidenceRoot: evidenceRoot,
      supplyChainReportPath: `${supplyRoot}/report.json`,
    },
    source: {
      revision,
      dirty: false,
      node: 'v24.8.0',
      v8: '13.6.233.10-node.24',
      npm: '11.6.0',
      packageLockSha256,
      releaseManifestSha256,
      formalBaselineBefore: 'baseline',
      formalBaselineAfter: 'baseline',
    },
  };
  const releaseManifest = { releaseVersion: version, artifacts: [contract] };
  const provenance = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: artifact.path, digest: { sha256: digest } }],
    predicate: {
      buildDefinition: {
        externalParameters: { releaseVersion: version, contentTier: 'full', publish: false },
        resolvedDependencies: [
          { uri: 'git+https://github.com/HypnosNova/HaiYue.git', digest: { gitCommit: revision } },
          { uri: 'file:package-lock.json', digest: { sha256: packageLockSha256 } },
          { uri: 'file:review/api/release-manifest.json', digest: { sha256: releaseManifestSha256 } },
        ],
      },
      runDetails: {
        builder: { id: '.github/workflows/ci-release-rehearsal.yml' },
        metadata: { invocationId: rehearsal.id },
        byproducts: [{ name: 'runtime', value: { node: rehearsal.source.node, v8: rehearsal.source.v8, npm: rehearsal.source.npm } }],
      },
    },
  };
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: 'urn:uuid:11111111-1111-5111-a111-111111111111',
    metadata: { properties: [{ name: 'haiyue:release-manifest', value: 'review/api/release-manifest.json' }] },
    components: [
      { type: 'library', 'bom-ref': 'pkg:npm/a@1.0.0' },
      { type: 'file', 'bom-ref': 'release-artifact:engine-npm', hashes: [{ alg: 'SHA-256', content: digest }] },
    ],
  };
  const releasePlan = {
    version,
    tag: `v${version}`,
    validatedInputs: {
      rootVersion: version,
      changelog: 'CHANGELOG.md',
      releaseNotes: `docs/engine-guide/release-notes-${version}.md`,
      publicPackageVersions: [{ name: contract.packageName, version }],
    },
    publicationActions: [
      { type: 'signed-tag', command: ['git', 'tag', '-s', `v${version}`], executed: false, authorizationRequired: true },
      { type: 'npm-publish', artifact: contract.id, command: ['npm', 'publish', '--access', 'public', '--tag', 'latest'], executed: false, authorizationRequired: true, protectedEnvironmentRequired: 'npm-publish' },
      { type: 'github-release', command: ['gh', 'release', 'create', `v${version}`, '--verify-tag'], executed: false, authorizationRequired: true, protectedEnvironmentRequired: 'github-release' },
    ],
    failureRecovery: ['abort', 'preserve', 'rerun'],
    rollback: [{ unit: contract.rollbackUnit, steps: ['deprecate and supersede'] }],
  };
  const releaseNotes = Buffer.from(`# HaiYue ${version}\n`);
  const evidenceFiles = [
    `${evidenceRoot}/g03-package-app-candidate.json`,
    `${evidenceRoot}/public-packages.json`,
    ...['animation-editor', 'hya-dashboard', 'hya-viewer', 'scene-editor', 'voxel-pwa']
      .map(name => `${evidenceRoot}/app-manifests/${name}.json`),
    `${supplyRoot}/npm-audit-production.json`,
    `${supplyRoot}/dependencies.cdx.json`,
  ];
  return {
    releaseManifest,
    rehearsal,
    provenance,
    sbom,
    releasePlan,
    checksumEntries: parseSha256Sums(`${digest}  ${artifact.path}\n`),
    supplyChainReport: {
      source: {
        revision,
        dirty: false,
        node: rehearsal.source.node,
        v8: rehearsal.source.v8,
        packageLockSha256,
      },
      dependencyAudit: {
        vulnerabilityCounts: { high: 0, critical: 0 },
        components: [{ selectedLicense: 'MIT', lockEvidence: 'exact-version' }],
      },
      credentialScan: { findings: [] },
      gate: { status: 'passed' },
    },
    releaseNotes,
    releaseNotesSource: Buffer.from(releaseNotes),
    changelog: Buffer.from(`## [${version}]\n`),
    evidenceFiles,
    readArtifact: path => path === artifact.path ? contents : null,
  };
}

function validate(fixture) {
  return validateReleaseRehearsalBundle(fixture);
}
