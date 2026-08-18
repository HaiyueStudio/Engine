import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectProductionComponents,
  createDependencySbom,
  findCredentialLeaks,
  validateAuditReport,
} from './release-supply-chain-policy.mjs';

test('production dependency policy rejects unlocked sources and unreviewed licenses', () => {
  const result = collectProductionComponents({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/good': { version: '1.0.0', license: 'MIT', resolved: 'https://registry.npmjs.org/good/-/good-1.0.0.tgz', integrity: `sha512-${'A'.repeat(84)}==` },
      'node_modules/bad': { version: '2.0.0', license: 'GPL-3.0-only', resolved: 'git+https://example.test/bad.git' },
      'node_modules/dev-only': { version: '1.0.0', dev: true },
    },
  }, () => null);
  assert.equal(result.components.length, 2);
  assert.ok(result.errors.some(error => error.includes('unapproved license GPL-3.0-only')));
  assert.ok(result.errors.some(error => error.includes('not locked to the npm registry')));
  assert.ok(result.errors.some(error => error.includes('must record registry resolution and integrity together')));
});

test('reviewed dual-license expressions select the compatible branch', () => {
  const result = collectProductionComponents({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/jszip': {
        version: '3.10.1',
        license: '(MIT OR GPL-3.0-or-later)',
        resolved: 'https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz',
        integrity: `sha512-${'B'.repeat(84)}==`,
      },
    },
  }, () => null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.components[0].selectedLicense, 'MIT');
});

test('high or critical production vulnerabilities block release', () => {
  assert.deepEqual(validateAuditReport({ metadata: { vulnerabilities: { high: 0, critical: 0 } } }).errors, []);
  assert.match(
    validateAuditReport({ metadata: { vulnerabilities: { high: 1, critical: 0 } } }).errors[0],
    /1 high production vulnerabilities/,
  );
});

test('credential scanner reports token content and credential filenames without returning contents', () => {
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const awsAccessKey = ['AK', 'IA', 'A'.repeat(16)].join('');
  const findings = findCredentialLeaks([
    { path: 'safe.txt', contents: Buffer.from('ordinary text') },
    { path: 'config/.env.production', contents: Buffer.from('placeholder') },
    { path: 'archive/.env.large', contents: null },
    { path: 'bad.txt', contents: Buffer.from(privateKey) },
    { path: 'aws.txt', contents: Buffer.from(`id=${awsAccessKey}`) },
    { path: 'encoded.txt', contents: Buffer.from(`${awsAccessKey}Z`) },
  ]);
  assert.deepEqual(findings, [
    { path: 'config/.env.production', kind: 'credential-filename' },
    { path: 'archive/.env.large', kind: 'credential-filename' },
    { path: 'bad.txt', kind: 'private-key' },
    { path: 'aws.txt', kind: 'aws-access-key' },
  ]);
});

test('dependency SBOM is deterministic for the same revision and lockfile', () => {
  const component = { type: 'library', name: 'a', version: '1.0.0', selectedLicense: 'MIT', purl: 'pkg:npm/a@1.0.0', integrity: 'sha512-a' };
  assert.deepEqual(
    createDependencySbom({ components: [component], lockfileSha256: 'a'.repeat(64), revision: 'b'.repeat(40) }),
    createDependencySbom({ components: [component], lockfileSha256: 'a'.repeat(64), revision: 'b'.repeat(40) }),
  );
});
