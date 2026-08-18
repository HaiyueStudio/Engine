import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(examplesDir, '..');
const INPUT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.mjs', '.ts', '.tsx', '.wgsl',
]);
const IGNORED_DIRECTORIES = new Set([
  '.cache', '.git', 'artifacts', 'dist', 'dist-test', 'node_modules',
]);
const IGNORED_FILES = new Set([
  'bundle.js', 'bundle.js.map', 'bundle.meta.json',
]);
const SOURCE_ROOTS = [
  resolve(root, 'engine/src'),
  resolve(root, 'animation-spec/src'),
  resolve(root, 'extensions/src'),
  examplesDir,
];
const CONFIG_FILES = [
  resolve(root, 'package.json'),
  resolve(root, 'package-lock.json'),
  resolve(root, 'config/rollup.shared.js'),
  resolve(root, 'scripts/rollup-plugin-wgsl.js'),
];

/** Hashes every workspace source/config input that can affect an example bundle. */
export async function computeExampleSourceFingerprint() {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) await collectFiles(sourceRoot, files);
  for (const path of CONFIG_FILES) {
    if (await isRegularFile(path)) files.push(path);
  }
  files.sort();
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(root, path).split(sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return Object.freeze({ hash: hash.digest('hex'), inputCount: files.length });
}

export async function writeExampleBuildMetadata({
  outputFile,
  target,
  sourceFingerprint,
  inputCount,
}) {
  const bundle = await readFile(outputFile);
  const metadata = {
    schemaVersion: 1,
    target,
    sourceFingerprint,
    inputCount,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    bundleBytes: bundle.byteLength,
  };
  const path = resolve(dirname(outputFile), 'bundle.meta.json');
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function verifyExampleBuildFreshness({
  targets,
  fingerprint,
}) {
  const currentFingerprint = fingerprint ?? await computeExampleSourceFingerprint();
  const failures = [];
  for (const target of targets) {
    const directory = target === 'source-viewer'
      ? resolve(examplesDir, 'source-viewer')
      : resolve(examplesDir, target);
    const bundlePath = resolve(directory, 'bundle.js');
    const metadataPath = resolve(directory, 'bundle.meta.json');
    let metadata;
    let bundle;
    try {
      [metadata, bundle] = await Promise.all([
        readFile(metadataPath, 'utf8').then(JSON.parse),
        readFile(bundlePath),
      ]);
    } catch {
      failures.push(`${target}: bundle.js or bundle.meta.json is missing`);
      continue;
    }
    const bundleHash = createHash('sha256').update(bundle).digest('hex');
    if (metadata.schemaVersion !== 1 || metadata.target !== target) {
      failures.push(`${target}: build metadata identity is invalid`);
    } else if (metadata.sourceFingerprint !== currentFingerprint.hash) {
      failures.push(`${target}: bundle was built from stale workspace sources`);
    } else if (metadata.bundleSha256 !== bundleHash || metadata.bundleBytes !== bundle.byteLength) {
      failures.push(`${target}: bundle bytes do not match build metadata`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Example build freshness failed:\n- ${failures.join('\n- ')}`);
  }
  return { targetCount: targets.length, sourceFingerprint: currentFingerprint.hash };
}

async function collectFiles(directory, result) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_FILES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await collectFiles(path, result);
      continue;
    }
    if (!entry.isFile() || !hasInputExtension(entry.name)) continue;
    result.push(path);
  }
}

function hasInputExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && INPUT_EXTENSIONS.has(name.slice(dot));
}

async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
