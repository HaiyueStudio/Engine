import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const toolingRoot = resolve(dirname(scriptPath), '..');
const DEFAULT_OUTPUT_ROOT = resolve(toolingRoot, 'artifacts/pages-release');
const OMITTED_ON_PAGES = Object.freeze([
  {
    id: 'hya-lottie-corpus-dashboard',
    reason: 'The manual corpus dashboard requires a local generated cache that is not a public release asset.',
  },
]);

export async function assemblePagesRelease(environment = process.env) {
  const sourceRoot = resolve(environment.PAGES_SOURCE_ROOT ?? toolingRoot);
  const outputRoot = resolve(environment.PAGES_OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT);
  assertInside(toolingRoot, outputRoot, 'Pages output');
  if (outputRoot === toolingRoot) throw new Error('Pages output cannot replace the tooling checkout.');

  const repositoryManifest = await readJson(resolve(sourceRoot, 'package.json'), 'repository package.json');
  const releaseTag = environment.PAGES_RELEASE_TAG ?? `v${repositoryManifest.version}`;
  const releaseVersion = normalizeReleaseVersion(releaseTag);
  const releaseRoot = resolve(outputRoot, 'releases', releaseVersion);
  const examplesRoot = resolve(sourceRoot, 'examples');
  const examplesManifestPath = resolve(examplesRoot, 'manifest.json');
  const examplesManifest = await readJson(examplesManifestPath, 'examples manifest');
  const omittedIds = new Set(OMITTED_ON_PAGES.map(entry => entry.id));
  const publicManifest = {
    ...examplesManifest,
    entries: examplesManifest.entries.filter(entry => !omittedIds.has(entry.id)),
  };

  await validateBuiltInputs(sourceRoot, examplesManifest);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });

  await copyTree(examplesRoot, resolve(releaseRoot, 'examples'), {
    include: shouldPublishExamplesPath,
  });
  await writeFile(
    resolve(releaseRoot, 'examples/manifest.json'),
    `${JSON.stringify(publicManifest, null, 2)}\n`,
    'utf8',
  );

  await copyTree(resolve(sourceRoot, 'engine/dist'), resolve(releaseRoot, 'engine/dist'), {
    include: shouldPublishRuntimePath,
  });
  await copyRequiredFile(
    resolve(sourceRoot, 'extensions/dist/gltf-worker-runtime.js'),
    resolve(releaseRoot, 'extensions/dist/gltf-worker-runtime.js'),
  );
  await copyTree(
    resolve(sourceRoot, 'extensions/test/fixtures/gltf'),
    resolve(releaseRoot, 'extensions/test/fixtures/gltf'),
  );
  await copyTree(
    resolve(sourceRoot, 'scripts/webgpu-gate/assets/gltf-corpus/medium-rigged-figure-draco'),
    resolve(releaseRoot, 'scripts/webgpu-gate/assets/gltf-corpus/medium-rigged-figure-draco'),
  );
  await copyRequiredFile(
    resolve(sourceRoot, 'node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js'),
    resolve(releaseRoot, 'node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js'),
  );
  await copyRequiredFile(
    resolve(sourceRoot, 'node_modules/draco3dgltf/draco_decoder_gltf.wasm'),
    resolve(releaseRoot, 'node_modules/draco3dgltf/draco_decoder_gltf.wasm'),
  );
  await copyTree(resolve(sourceRoot, 'animation-spec/viewer'), resolve(releaseRoot, 'animation-spec'));
  await copyTree(resolve(sourceRoot, 'animation-spec/samples'), resolve(releaseRoot, 'animation-spec/samples'));

  await writeFile(resolve(outputRoot, 'index.html'), redirectPage('./examples/', 'HaiYue Examples'), 'utf8');
  await mkdir(resolve(outputRoot, 'examples'), { recursive: true });
  await writeFile(
    resolve(outputRoot, 'examples/index.html'),
    redirectPage(`../releases/${releaseVersion}/examples/`, 'HaiYue Examples'),
    'utf8',
  );
  await writeFile(resolve(releaseRoot, 'index.html'), redirectPage('./examples/', 'HaiYue Examples'), 'utf8');

  const stats = await directoryStats(outputRoot);
  const report = {
    schemaVersion: 1,
    releaseTag,
    releaseVersion,
    entry: 'examples/',
    immutableEntry: `releases/${releaseVersion}/examples/`,
    sourceEntryCount: examplesManifest.entries.length,
    publishedEntryCount: publicManifest.entries.length,
    omitted: OMITTED_ON_PAGES,
    files: stats.files,
    bytes: stats.bytes,
  };
  await writeFile(resolve(outputRoot, 'pages-release.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `[pages] assembled ${report.publishedEntryCount} examples for ${releaseTag}; files=${stats.files}; bytes=${stats.bytes}; output=${outputRoot}`,
  );
  return { outputRoot, report };
}

async function validateBuiltInputs(sourceRoot, examplesManifest) {
  const required = [
    'examples/index.html',
    'examples/catalog.js',
    'examples/source-viewer/bundle.js',
    'examples/shared/engine.js',
    'engine/dist/geometry.js',
    'extensions/dist/gltf-worker-runtime.js',
    'animation-spec/viewer/index.html',
  ];
  for (const entry of examplesManifest.entries) {
    if (entry.id !== 'hya-samples') required.push(`examples/${entry.id}/bundle.js`);
  }
  for (const path of required) await requireFile(resolve(sourceRoot, path), path);
}

async function copyTree(source, destination, options = {}) {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory()) throw new Error(`Pages source directory is missing: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    const pathFromRoot = relative(source, sourcePath).replaceAll('\\', '/');
    if (options.include && !options.include(pathFromRoot, entry)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Pages inputs cannot contain symbolic links: ${sourcePath}`);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath, options);
    else if (entry.isFile()) await copyRequiredFile(sourcePath, destinationPath);
  }
}

async function copyRequiredFile(source, destination) {
  await requireFile(source, source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function requireFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`Required Pages input is missing: ${label}`);
  }
  if (!metadata.isFile()) throw new Error(`Required Pages input is not a file: ${label}`);
}

function shouldPublishExamplesPath(path, entry) {
  if (entry.isDirectory()) return !['.build-meta', 'node_modules'].includes(entry.name);
  return !path.endsWith('.map') && !path.endsWith('bundle.meta.json') && entry.name !== '.DS_Store';
}

function shouldPublishRuntimePath(path, entry) {
  if (entry.isDirectory()) return true;
  return extname(path) !== '.map' && !path.endsWith('.d.ts') && entry.name !== '.DS_Store';
}

function redirectPage(target, title) {
  const serializedTarget = JSON.stringify(target);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <script>location.replace(new URL(${serializedTarget}, location.href).href + location.search + location.hash);</script>
  </head>
  <body><a href="${target}">打开 ${title}</a></body>
</html>
`;
}

function normalizeReleaseVersion(releaseTag) {
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseTag)) {
    throw new Error(`PAGES_RELEASE_TAG must be a semantic version tag, received ${releaseTag}.`);
  }
  return releaseTag.replace(/^v/u, '');
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}.`, { cause: error });
  }
}

async function directoryStats(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await directoryStats(path);
      files += child.files;
      bytes += child.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await lstat(path)).size;
    }
  }
  return { files, bytes };
}

function assertInside(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside ${root}: ${candidate}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await assemblePagesRelease();
}
