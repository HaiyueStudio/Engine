import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = readJson('review/api/release-manifest.json');
const rootPackage = readJson('package.json');
const errors = [];

const expectedArtifacts = new Map([
  ['engine-npm', ['npm-package', 'engine', 'stable']],
  ['animation-spec-npm', ['npm-package', 'animation-spec', 'stable']],
  ['extensions-npm', ['npm-package', 'extensions', 'stable-focused-subpaths']],
  ['scene-editor-static', ['static-web-app', 'editor', 'stable']],
  ['animation-editor-static', ['static-web-app', 'AnimationEditor', 'stable']],
  ['voxel-editor-pwa', ['pwa', 'voxelEditor', 'stable']],
  ['voxel-editor-electron', ['electron-platform-set', 'voxelEditor', 'preview-unsigned']],
  ['examples-static-catalog', ['static-catalog', 'examples', 'supporting']],
  ['games-static-catalog', ['static-catalog', 'games', 'supporting']],
]);
const publicPackages = new Set(['@haiyue/engine', '@haiyue/animation-spec', '@haiyue/extensions']);
const privateWorkspaces = ['shader-language', 'ui', 'editor', 'AnimationEditor', 'voxelEditor', 'examples', 'games'];

check(manifest.schemaVersion === 1, 'release manifest schemaVersion must be 1');
check(manifest.releaseVersion === rootPackage.version, 'release version must match the root package version');
check(manifest.releaseMatrix === 'config/release-matrix.json', 'release manifest must reference the authoritative release matrix');
check(existsSync(resolve(root, manifest.releaseMatrix ?? '')), 'release matrix reference is missing');
check(manifest.featureFreeze?.status === 'active', 'feature freeze must remain active');
check(
  manifest.featureFreeze?.classification === 'refrozen-after-omitted-mature-capabilities',
  'feature freeze must retain the ADR 0071 correction classification',
);

const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
const ids = new Set();
const rollbackUnits = new Set();
for (const artifact of artifacts) {
  check(typeof artifact.id === 'string' && artifact.id.length > 0, 'release artifact has no id');
  check(!ids.has(artifact.id), `duplicate release artifact id: ${artifact.id}`);
  ids.add(artifact.id);
  const expected = expectedArtifacts.get(artifact.id);
  check(Boolean(expected), `unexpected release artifact: ${artifact.id}`);
  if (expected) {
    check(artifact.kind === expected[0], `${artifact.id} kind must be ${expected[0]}`);
    check(artifact.workspace === expected[1], `${artifact.id} workspace must be ${expected[1]}`);
    check(artifact.supportTier === expected[2], `${artifact.id} support tier must be ${expected[2]}`);
  }
  check(artifact.version === manifest.releaseVersion, `${artifact.id} version differs from the release version`);
  check(typeof artifact.entry === 'string' && artifact.entry.length > 0, `${artifact.id} has no entry`);
  check(typeof artifact.owner === 'string' && artifact.owner.length > 0, `${artifact.id} has no owner`);
  check(Array.isArray(artifact.verificationCommands) && artifact.verificationCommands.length > 0, `${artifact.id} has no verification command`);
  check(typeof artifact.publishChannel === 'string' && artifact.publishChannel.length > 0, `${artifact.id} has no publish channel`);
  check(typeof artifact.rollbackUnit === 'string' && artifact.rollbackUnit.length > 0, `${artifact.id} has no rollback unit`);
  check(!rollbackUnits.has(artifact.rollbackUnit), `${artifact.id} reuses rollback unit ${artifact.rollbackUnit}`);
  rollbackUnits.add(artifact.rollbackUnit);
}
for (const id of expectedArtifacts.keys()) check(ids.has(id), `release artifact is missing: ${id}`);

const npmArtifacts = artifacts.filter(artifact => artifact.kind === 'npm-package');
check(npmArtifacts.length === publicPackages.size, 'release manifest must contain exactly three public npm packages');
for (const artifact of npmArtifacts) {
  const pkg = readJson(`${artifact.workspace}/package.json`);
  check(publicPackages.has(artifact.packageName), `${artifact.id} is not an approved public package`);
  check(pkg.name === artifact.packageName, `${artifact.id} package name differs from workspace metadata`);
  check(pkg.version === artifact.version, `${artifact.id} package version differs from workspace metadata`);
  check(pkg.private === false, `${artifact.id} package must be public`);
  check(pkg.publishConfig?.access === 'public' && pkg.publishConfig?.tag === 'latest', `${artifact.id} publishConfig must be public/latest`);
  check(pkg.engines?.node === '>=22', `${artifact.id} engines.node must be >=22`);
  for (const field of ['license', 'repository', 'files', 'exports']) check(Boolean(pkg[field]), `${artifact.id} is missing package metadata ${field}`);
}
check(
  sameSet(new Set(npmArtifacts.map(artifact => artifact.packageName)), publicPackages),
  'release manifest public package set differs from the frozen three-package scope',
);

for (const workspace of privateWorkspaces) {
  const pkg = readJson(`${workspace}/package.json`);
  check(pkg.private === true, `${workspace} must remain a private workspace`);
  check(!npmArtifacts.some(artifact => artifact.workspace === workspace), `${workspace} must not be published as npm`);
}

if (errors.length > 0) {
  console.error('[release-scope] Contract violations:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('[release-scope] Three public npm packages and six app/catalog artifacts match the frozen 0.1.0 scope.');

function readJson(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) throw new Error(`Missing release-scope input: ${path}`);
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every(value => right.has(value));
}
