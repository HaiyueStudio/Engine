import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReachablePackageDeclarations } from './package-declaration-graph.mjs';

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [requestedWorkspace, requestedBundleDirectory] = process.argv.slice(2);
if (!requestedWorkspace || !requestedBundleDirectory || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/install-bundled-declarations.mjs <workspace> <bundle-directory>');
}

const workspace = confinedExistingDirectory(repositoryRoot, requestedWorkspace, 'package workspace');
const distRoot = confinedExistingDirectory(workspace, 'dist', 'package dist');
const bundleRoot = confinedExistingDirectory(workspace, requestedBundleDirectory, 'declaration bundle');
if (relative(workspace, distRoot) !== 'dist') throw new Error(`Refusing generated declaration root: ${distRoot}`);
if (relative(workspace, bundleRoot) !== requestedBundleDirectory) {
  throw new Error(`Refusing declaration bundle root: ${bundleRoot}`);
}

const packageJson = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'));
const expectedTargets = collectPublicTypeTargets(packageJson);
const bundledFiles = listFiles(bundleRoot).filter(path => path.endsWith('.d.ts'));
const bundledDeclarations = Object.fromEntries(bundledFiles.map(path => [
  `dist/${toPortablePath(relative(bundleRoot, path))}`,
  readFileSync(path, 'utf8'),
]));
const bundledTargets = new Set(Object.keys(bundledDeclarations));
for (const target of expectedTargets) {
  if (!bundledTargets.has(target)) throw new Error(`Bundled declaration target is missing: ${target}`);
}
const reachableTargets = collectReachablePackageDeclarations({ packageJson, declarations: bundledDeclarations });
if (reachableTargets.size !== bundledTargets.size) {
  throw new Error(`Bundled declarations contain unreachable targets: ${[...bundledTargets].filter(path => !reachableTargets.has(path)).join(', ')}`);
}

for (const path of listFiles(distRoot)) {
  if (path.endsWith('.d.ts') || path.endsWith('.d.ts.map')) rmSync(path);
}
for (const source of bundledFiles) {
  const destination = resolve(distRoot, relative(bundleRoot, source));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
rmSync(bundleRoot, { recursive: true });

console.log(`[package-declarations] ${packageJson.name}: installed ${bundledFiles.length} bundled public declarations.`);

function confinedExistingDirectory(parent, child, label) {
  const target = realpathSync(resolve(parent, child));
  const targetRelative = relative(parent, target);
  if (!targetRelative || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
    throw new Error(`Refusing ${label} outside ${parent}: ${target}`);
  }
  return target;
}

function collectPublicTypeTargets(manifest) {
  const targets = new Set();
  if (typeof manifest.types === 'string') targets.add(normalizeTarget(manifest.types));
  for (const target of Object.values(manifest.exports ?? {})) {
    if (target && typeof target === 'object' && typeof target.types === 'string') {
      targets.add(normalizeTarget(target.types));
    }
  }
  return targets;
}

function normalizeTarget(path) {
  return toPortablePath(path.startsWith('./') ? path.slice(2) : path);
}

function listFiles(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function toPortablePath(path) {
  return path.split(sep).join('/');
}
