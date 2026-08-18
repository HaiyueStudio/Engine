import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const ALLOWED_LICENSES = new Map([
  ['0BSD', '0BSD'],
  ['Apache-2.0', 'Apache-2.0'],
  ['BSD-3-Clause', 'BSD-3-Clause'],
  ['ISC', 'ISC'],
  ['MIT', 'MIT'],
  ['Unlicense', 'Unlicense'],
  ['Zlib', 'Zlib'],
  ['(MIT AND Zlib)', '(MIT AND Zlib)'],
  ['(MIT OR GPL-3.0-or-later)', 'MIT'],
]);

const LICENSE_OVERRIDES = Object.freeze({
  'json-bignum@0.0.3': 'MIT',
});

export function collectProductionComponents(lockfile, readWorkspaceManifest) {
  if (lockfile?.lockfileVersion !== 3 || typeof lockfile.packages !== 'object') {
    throw new Error('Supply-chain audit requires an npm lockfileVersion 3 package-lock.json.');
  }
  const components = [];
  const errors = [];
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (!path || entry.dev === true || entry.link === true) continue;
    const workspace = !path.startsWith('node_modules/');
    const manifest = workspace ? readWorkspaceManifest(path) : null;
    const name = manifest?.name ?? packageNameFromLockPath(path);
    const version = entry.version ?? manifest?.version;
    const declaredLicense = entry.license
      ?? manifest?.license
      ?? LICENSE_OVERRIDES[`${name}@${version}`]
      ?? null;
    const selectedLicense = ALLOWED_LICENSES.get(declaredLicense) ?? null;
    if (!name || !version) errors.push(`${path} is missing a package name or version`);
    if (!declaredLicense) errors.push(`${name}@${version} has no reviewed license declaration`);
    else if (!selectedLicense) errors.push(`${name}@${version} uses unapproved license ${declaredLicense}`);
    if (!workspace && entry.resolved && !/^https:\/\/registry\.npmjs\.org\//u.test(entry.resolved)) {
      errors.push(`${name}@${version} is not locked to the npm registry`);
    }
    if (!workspace && entry.integrity && !/^sha512-[A-Za-z0-9+/]+=*$/u.test(entry.integrity)) {
      errors.push(`${name}@${version} has invalid sha512 lockfile integrity`);
    }
    if (!workspace && Boolean(entry.resolved) !== Boolean(entry.integrity)) {
      errors.push(`${name}@${version} must record registry resolution and integrity together`);
    }
    components.push({
      type: 'library',
      name,
      version,
      workspace,
      path,
      declaredLicense,
      selectedLicense,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      lockEvidence: entry.integrity ? 'exact-version-registry-integrity' : 'exact-version',
      purl: npmPurl(name, version),
    });
  }
  components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return { components, errors };
}

export function validateAuditReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return { errors: ['npm audit did not return JSON'] };
  const vulnerabilities = report.metadata?.vulnerabilities;
  if (!vulnerabilities) errors.push('npm audit report is missing metadata.vulnerabilities');
  for (const severity of ['high', 'critical']) {
    if (!Number.isInteger(vulnerabilities?.[severity])) errors.push(`npm audit is missing ${severity} count`);
    else if (vulnerabilities[severity] > 0) errors.push(`npm audit found ${vulnerabilities[severity]} ${severity} production vulnerabilities`);
  }
  return { errors };
}

export function findCredentialLeaks(files) {
  const findings = [];
  const contentPatterns = [
    ['private-key', new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join(''), 'u')],
    ['github-token', new RegExp(['gh', '[pousr]_', '[A-Za-z0-9]{36,}'].join(''), 'u')],
    ['npm-token', new RegExp(['npm', '_', '[A-Za-z0-9]{36,}'].join(''), 'u')],
    ['aws-access-key', new RegExp(['(?<![A-Za-z0-9])', 'AK', 'IA', '[0-9A-Z]{16}', '(?![A-Za-z0-9])'].join(''), 'u')],
  ];
  for (const file of files) {
    const name = basename(file.path);
    if (/^\.env(?:\..+)?$/iu.test(name) || /\.(?:pem|key|p12|pfx)$/iu.test(name)) {
      findings.push({ path: file.path, kind: 'credential-filename' });
      continue;
    }
    if (!file.contents || file.contents.includes(0)) continue;
    const text = file.contents.toString('utf8');
    for (const [kind, pattern] of contentPatterns) {
      if (pattern.test(text)) findings.push({ path: file.path, kind });
    }
  }
  return findings;
}

export function createDependencySbom({ components, lockfileSha256, revision }) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${stableUuid(`${revision}:${lockfileSha256}`)}`,
    version: 1,
    metadata: {
      component: { type: 'application', name: 'haiyue-monorepo', version: '0.1.0' },
      properties: [
        { name: 'haiyue:revision', value: revision },
        { name: 'haiyue:package-lock:sha256', value: lockfileSha256 },
      ],
    },
    components: components.map(component => ({
      type: component.type,
      'bom-ref': component.purl,
      name: component.name,
      version: component.version,
      purl: component.purl,
      licenses: [{ license: { id: component.selectedLicense } }],
      properties: [
        { name: 'haiyue:lock-evidence', value: component.lockEvidence },
        ...(component.integrity ? [{ name: 'npm:integrity', value: component.integrity }] : []),
      ],
    })),
  };
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

function packageNameFromLockPath(path) {
  if (!path.startsWith('node_modules/')) return path;
  const remainder = path.slice('node_modules/'.length);
  const parts = remainder.split('/node_modules/');
  return parts.at(-1);
}

function npmPurl(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

function stableUuid(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
