import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = argumentValue('--profile') ?? process.env.WEBGPU_DEVICE_PROFILE;
if (!profile || !['apple-integrated', 'windows-integrated', 'windows-discrete'].includes(profile)) {
  throw new Error('--profile must name a required registered device profile.');
}
const outputRoot = resolve(root, 'artifacts/performance-candidates', profile);
const runManifestPath = resolve(outputRoot, 'run-manifest.json');
if (!existsSync(runManifestPath)) throw new Error(`Missing ${relative(root, runManifestPath)}.`);
const runManifest = JSON.parse(readFileSync(runManifestPath, 'utf8'));
const revision = git(['rev-parse', 'HEAD']);
const labels = (process.env.WEBGPU_RUNNER_LABELS ?? '').split(',').filter(Boolean);
const requiredLabels = ['self-hosted', 'haiyue-performance', profile];
const errors = [];
if (runManifest.profile !== profile) errors.push(`run manifest profile ${runManifest.profile} does not match ${profile}`);
if (runManifest.revision !== revision || runManifest.dirty !== false) errors.push('run manifest is not bound to this clean revision');
if (runManifest.environment?.node !== process.version) errors.push('run manifest Node identity does not match validator Node');
if (Number.parseInt(process.versions.node, 10) < 22) errors.push(`Node.js >=22 is required; received ${process.version}`);
if (!sameList(labels, requiredLabels)) errors.push(`runner labels must be exactly ${requiredLabels.join(',')}`);
if (!sameList(runManifest.environment?.runnerLabels ?? [], requiredLabels)) errors.push('run manifest runner labels do not match the required profile labels');
if (!runManifest.environment?.operatingSystem || !runManifest.environment?.driver) errors.push('run manifest is missing physical device OS/driver identity');
const artifacts = readdirSync(outputRoot)
  .filter(name => name.endsWith('.json') && name !== 'runtime-identity.json')
  .sort()
  .map(name => ({ name, sha256: createHash('sha256').update(readFileSync(resolve(outputRoot, name))).digest('hex') }));
const identity = {
  schemaVersion: 1,
  kind: 'required-device-runtime-identity',
  profile,
  revision,
  dirty: false,
  runtime: { node: process.version, v8: process.versions.v8 },
  runner: {
    labels,
    name: process.env.RUNNER_NAME ?? null,
    os: process.env.RUNNER_OS ?? null,
    arch: process.env.RUNNER_ARCH ?? null,
  },
  device: {
    operatingSystem: runManifest.environment?.operatingSystem ?? null,
    driver: runManifest.environment?.driver ?? null,
    platform: runManifest.environment?.platform ?? null,
  },
  workload: 'full',
  validator: 'scripts/check-release-performance-candidate.mjs',
  artifacts,
  gate: { status: errors.length === 0 ? 'passed' : 'failed', errors },
};
mkdirSync(outputRoot, { recursive: true });
writeFileSync(resolve(outputRoot, 'runtime-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
if (errors.length > 0) {
  for (const error of errors) console.error(`[device-identity] ${error}`);
  process.exit(1);
}
console.log(
  `[device-identity] profile=${profile}; workload=full; labels=${labels.join(',')}; `
  + `runner=${identity.runner.name ?? 'unnamed-self-hosted'}; device=${identity.device.driver}; `
  + `node=${process.version}; v8=${process.versions.v8}; validator=${identity.validator}; skipped=none.`,
);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim();
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
