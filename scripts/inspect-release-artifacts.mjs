import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmArgs, npmCommand } from './npm-process.mjs';
import { gzipSync } from 'node:zlib';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseMode = process.argv.includes('--release');
for (const argument of process.argv.slice(2)) {
  if (argument !== '--release') throw new Error(`Unknown release artifact inspection argument "${argument}".`);
}
const matrix = JSON.parse(readFileSync(resolve(root, 'config/release-matrix.json'), 'utf8'));
const appArtifactRoot = resolve(root, 'artifacts/release/apps');
const electronArtifactRoot = resolve(appArtifactRoot, 'voxel-electron');
const candidatePath = resolve(root, 'artifacts/release/g03-package-app-candidate.json');
const errors = [];
const commandEvidence = [];
let browserEvidence = null;
let deterministicBuilds = [];
let appManifests = [];
let electronEvidence = null;

try {
  runChecked('public package tarball consumers', process.execPath, [
    'scripts/verify-engine-package.mjs',
    ...(releaseMode ? ['--release'] : []),
  ], 720_000);
  validateExportTargets();
  validateEngineEntryBudget();
  validateBuildScriptResponsibilities();

  const buildRounds = [];
  for (let round = 1; round <= 2; round += 1) buildRounds.push(runAppBuildRound(round));
  deterministicBuilds = compareBuildRounds(buildRounds);

  const electronOutputRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-voxel-electron-'));
  try {
    runChecked(
      'Voxel Electron unpacked package',
      npmCommand(),
      npmArgs([
        'run', 'electron:pack', '-w', './voxelEditor', '--',
        `--config.directories.output=${electronOutputRoot}`,
      ]),
      360_000,
    );
    runChecked(
      'Voxel Electron artifact verification',
      process.execPath,
      ['voxelEditor/scripts/verify-release-app.mjs', '--require-electron'],
      60_000,
      { ...process.env, VOXEL_ELECTRON_OUTPUT_ROOT: electronOutputRoot },
    );
    syncVerifiedElectronArtifact(electronOutputRoot, electronArtifactRoot);
  } finally {
    rmSync(electronOutputRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  const finalVoxel = readAppManifest('voxel-pwa');
  const deterministicVoxel = deterministicBuilds.find(entry => entry.id === 'voxel-pwa-electron');
  if (deterministicVoxel && deterministicVoxel.contentSha256 !== finalVoxel.pwaContentSha256) {
    errors.push('Voxel Electron packaging rebuilt a renderer that differs from the deterministic PWA candidate');
  }
  electronEvidence = finalVoxel.electron;

  appManifests = [
    readAppManifest('scene-editor'),
    readAppManifest('animation-editor'),
    readAppManifest('hya-viewer'),
    readAppManifest('hya-dashboard'),
    finalVoxel,
  ];
  browserEvidence = await runBasePathBrowserSmoke(appManifests);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

const publicPackageReportPath = resolve(root, 'artifacts/release/public-packages.json');
const publicPackageReport = existsSync(publicPackageReportPath)
  ? JSON.parse(readFileSync(publicPackageReportPath, 'utf8'))
  : null;
if (!publicPackageReport) errors.push('Public package report was not generated');
else if (publicPackageReport.gate?.status !== 'passed') errors.push('Public package report is not passed');

const sourceState = readSourceState();
const candidate = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  goal: 'g03-package-app-consumer-delivery',
  candidateState: errors.length === 0
    ? 'g03-passed-g07-clean-replay-required'
    : 'g03-failed',
  formalBaselineUpdated: false,
  sourceState,
  publicPackages: publicPackageReport?.packages ?? [],
  appManifests: appManifests.map(summarizeAppManifest),
  deterministicBuilds,
  buildExitEvidence: commandEvidence,
  basePathBrowserSmoke: browserEvidence,
  voxelElectron: electronEvidence,
  handoff: {
    g04: 'Reuse the recorded app gzip/startup/build-exit measurements; no G03 budget is a device-performance baseline.',
    g06: 'Rebuild the recorded Electron platform set on signed/release runners; G03 verifies the current host unpacked artifact only.',
    g07: 'Replay release:artifact:check from a clean checkout at the frozen integration revision, then bind the generated tarball/app hashes.',
  },
  gate: { status: errors.length === 0 ? 'passed' : 'failed', errors },
};
mkdirSync(dirname(candidatePath), { recursive: true });
writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

if (errors.length > 0) {
  console.error('[release-artifacts] Failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(
  '[release-artifacts] Public tarballs, real consumers, deterministic clean app builds, nested base-path HTTP/worker '
  + `smoke and current-host Electron package passed; candidate=${relative(root, candidatePath)}.`,
);

function runAppBuildRound(round) {
  console.log(`\n[release-artifacts] deterministic app build round ${round}/2`);
  injectStaleHash('editor/dist/chunks/g03-stale-OLDHASH.js');
  runChecked(`Scene Editor production build round ${round}`, npmCommand(), npmArgs(['run', 'build', '-w', './editor']), 120_000);
  assertStaleRemoved('editor/dist/chunks/g03-stale-OLDHASH.js');
  runChecked(`Scene Editor artifact round ${round}`, process.execPath, ['editor/scripts/build-release-app.mjs'], 60_000);

  injectStaleHash('AnimationEditor/dist/chunks/DesignerTaskCoordinator-OLDHASH.js');
  runChecked(`AnimationEditor production build round ${round}`, npmCommand(), npmArgs(['run', 'build', '-w', './AnimationEditor']), 120_000);
  assertStaleRemoved('AnimationEditor/dist/chunks/DesignerTaskCoordinator-OLDHASH.js');
  runChecked(`AnimationEditor artifact round ${round}`, process.execPath, ['AnimationEditor/scripts/build-release-app.mjs'], 60_000);

  runChecked(
    `HYA viewer/dashboard production build round ${round}`,
    process.execPath,
    ['scripts/build-target.mjs', 'example:animation-spec', 'example:hya-corpus-dashboard'],
    180_000,
  );
  assembleHyaApps();

  injectStaleHash('voxelEditor/dist/chunks/g03-stale-OLDHASH.js');
  runChecked(`Voxel PWA production build round ${round}`, npmCommand(), npmArgs(['run', 'build:app', '-w', './voxelEditor']), 180_000);
  assertStaleRemoved('voxelEditor/dist/chunks/g03-stale-OLDHASH.js');
  runChecked(`Voxel PWA artifact round ${round}`, process.execPath, ['voxelEditor/scripts/verify-release-app.mjs'], 60_000);

  const manifests = [
    readAppManifest('scene-editor'),
    readAppManifest('animation-editor'),
    readAppManifest('hya-viewer'),
    readAppManifest('hya-dashboard'),
    readAppManifest('voxel-pwa'),
  ];
  validateEditorReport(manifests[0]);
  return manifests.map(manifest => ({
    id: manifest.id,
    contentSha256: manifest.contentSha256 ?? manifest.pwaContentSha256,
    fileCount: manifest.files.length,
    rawBytes: manifest.rawBytes ?? manifest.pwaBytes,
    gzipBytes: manifest.gzipBytes ?? manifest.javaScriptGzipBytes,
  }));
}

function compareBuildRounds(rounds) {
  const [first, second] = rounds;
  if (!first || !second) throw new Error('Two deterministic build rounds are required.');
  const results = [];
  for (const candidate of first) {
    const repeated = second.find(entry => entry.id === candidate.id);
    if (!repeated) {
      errors.push(`Deterministic rebuild omitted ${candidate.id}`);
      continue;
    }
    const matched = candidate.contentSha256 === repeated.contentSha256;
    if (!matched) errors.push(`${candidate.id} repeated clean build hash changed`);
    results.push({ ...candidate, repeatedContentSha256: repeated.contentSha256, matched });
  }
  return results;
}

function assembleHyaApps() {
  const viewerRoot = resolve(appArtifactRoot, 'hya-viewer');
  rmSync(viewerRoot, { recursive: true, force: true });
  copyPaths([
    ['examples/animation-spec/index.html', 'examples/animation-spec/index.html'],
    ['examples/animation-spec/bundle.js', 'examples/animation-spec/bundle.js'],
    ['examples/example-fullscreen.css', 'examples/example-fullscreen.css'],
  ], viewerRoot);
  writeStaticManifest(viewerRoot, {
    id: 'hya-viewer',
    entry: 'examples/animation-spec/index.html',
    workers: [],
    maxJavaScriptGzipBytes: 750_000,
  });

  const dashboardRoot = resolve(appArtifactRoot, 'hya-dashboard');
  rmSync(dashboardRoot, { recursive: true, force: true });
  copyPaths([
    ['examples/hya-corpus-dashboard/index.html', 'examples/hya-corpus-dashboard/index.html'],
    ['examples/hya-corpus-dashboard/styles.css', 'examples/hya-corpus-dashboard/styles.css'],
    ['examples/hya-corpus-dashboard/bundle.js', 'examples/hya-corpus-dashboard/bundle.js'],
    ['examples/hya-corpus-dashboard/report.json', 'examples/hya-corpus-dashboard/report.json'],
    ['examples/hya-corpus-dashboard/capabilities.json', 'examples/hya-corpus-dashboard/capabilities.json'],
  ], dashboardRoot);
  const report = JSON.parse(readFileSync(resolve(root, 'examples/hya-corpus-dashboard/report.json'), 'utf8'));
  const localReferences = [...new Set(report.samples.flatMap(sample => (
    (sample.frames ?? []).map(frame => frame.referenceUrl).filter(url => url.startsWith('/'))
  )))];
  for (const url of localReferences) {
    copyPaths([[url.slice(1), url.slice(1)]], dashboardRoot);
  }
  writeStaticManifest(dashboardRoot, {
    id: 'hya-dashboard',
    entry: 'examples/hya-corpus-dashboard/index.html',
    workers: [],
    maxJavaScriptGzipBytes: 700_000,
    localReferenceCount: localReferences.length,
  });
}

function writeStaticManifest(outputRoot, metadata) {
  const files = listFiles(outputRoot).filter(path => path !== 'release-manifest.json');
  const entries = files.map(path => {
    const contents = readFileSync(resolve(outputRoot, path));
    return {
      path,
      bytes: contents.byteLength,
      gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
      sha256: sha256(contents),
    };
  });
  const javaScriptGzipBytes = entries
    .filter(entry => entry.path.endsWith('.js'))
    .reduce((total, entry) => total + entry.gzipBytes, 0);
  if (javaScriptGzipBytes > metadata.maxJavaScriptGzipBytes) {
    throw new Error(`${metadata.id} JavaScript gzip ${javaScriptGzipBytes}B exceeds ${metadata.maxJavaScriptGzipBytes}B`);
  }
  const content = createHash('sha256');
  for (const entry of entries) {
    content.update(entry.path);
    content.update(readFileSync(resolve(outputRoot, entry.path)));
  }
  const manifest = {
    schemaVersion: 1,
    ...metadata,
    contentSha256: content.digest('hex'),
    rawBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    gzipBytes: entries.reduce((total, entry) => total + entry.gzipBytes, 0),
    javaScriptGzipBytes,
    files: entries,
  };
  writeFileSync(resolve(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[${metadata.id}-release] ${entries.length} files, ${javaScriptGzipBytes}B JS gzip, ${manifest.contentSha256.slice(0, 12)}.`);
}

async function runBasePathBrowserSmoke(manifests) {
  const smokeRoot = resolve(root, 'artifacts/release/base-path-http');
  const nestedRoot = resolve(smokeRoot, 'nested/g03');
  rmSync(smokeRoot, { recursive: true, force: true });
  mkdirSync(nestedRoot, { recursive: true });
  const specs = manifests.map(manifest => {
    const directory = artifactDirectoryFor(manifest.id);
    const target = resolve(nestedRoot, manifest.id);
    cpSync(directory, target, { recursive: true });
    return {
      id: manifest.id,
      base: `./nested/g03/${manifest.id}/`,
      entry: manifest.entry ?? manifest.entries?.[0],
      files: manifest.files.map(file => file.path),
      workers: (manifest.workers ?? []).filter(path => path !== 'service-worker.js'),
      maxColdStartMs: manifest.id === 'hya-dashboard' ? 10_000 : 15_000,
    };
  });
  writeFileSync(resolve(smokeRoot, 'index.html'), basePathFixture(specs));
  const result = await runChromeWebGpuFixture({
    root: smokeRoot,
    fixture: 'index.html',
    timeoutMs: 120_000,
  });
  if ((result.apps ?? []).some(app => app.coldStartMs > app.maxColdStartMs)) {
    throw new Error('Nested base-path browser cold-start budget was exceeded');
  }
  return result;
}

function basePathFixture(specs) {
  const serialized = JSON.stringify(specs).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>G03 base path smoke</title>
<div id="progress">starting</div><pre id="result"></pre>
<script type="module">
const specs = ${serialized};
const results = [];
const progress = document.querySelector('#progress');
const result = document.querySelector('#result');
const timeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms))]);
try {
  for (const spec of specs) {
    progress.textContent = 'loading ' + spec.id;
    const started = performance.now();
    const entryUrl = new URL(spec.base + spec.entry, location.href);
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.src = entryUrl.href;
    await timeout(new Promise((resolve, reject) => {
      iframe.addEventListener('load', resolve, { once: true });
      iframe.addEventListener('error', () => reject(new Error(spec.id + ' iframe failed')), { once: true });
      document.body.append(iframe);
    }), spec.maxColdStartMs, spec.id + ' cold start');
    const coldStartMs = performance.now() - started;
    const fetched = [];
    for (const path of spec.files) {
      const url = new URL(spec.base + path, location.href);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(spec.id + ' failed HTTP ' + response.status + ' for ' + path);
      fetched.push({ path, bytes: (await response.arrayBuffer()).byteLength });
    }
    for (const path of spec.workers) {
      const url = new URL(spec.base + path, location.href);
      await timeout(new Promise((resolve, reject) => {
        const worker = new Worker(url, { type: 'module', name: 'g03-' + spec.id });
        const timer = setTimeout(() => { worker.terminate(); resolve(); }, 350);
        worker.addEventListener('error', event => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(spec.id + ' worker failed: ' + path + ': ' + event.message));
        }, { once: true });
      }), 3000, spec.id + ' worker ' + path);
    }
    iframe.remove();
    results.push({ id: spec.id, entry: entryUrl.pathname, coldStartMs, maxColdStartMs: spec.maxColdStartMs, fetched });
  }
  result.dataset.status = 'passed';
  result.textContent = JSON.stringify({ schemaVersion: 1, status: 'passed', basePath: '/nested/g03/', apps: results });
} catch (error) {
  result.dataset.status = 'failed';
  result.textContent = JSON.stringify({ schemaVersion: 1, status: 'failed', error: error instanceof Error ? error.message : String(error), apps: results });
}
</script>`;
}

function validateExportTargets() {
  for (const workspace of ['engine', 'animation-spec', 'extensions']) {
    const pkg = JSON.parse(readFileSync(resolve(root, workspace, 'package.json'), 'utf8'));
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      for (const field of ['types', 'import']) {
        const path = resolve(root, workspace, target[field]);
        if (!existsSync(path)) errors.push(`${workspace} export ${subpath} missing ${field}: ${target[field]}`);
      }
    }
  }
}

function validateEngineEntryBudget() {
  const engineEntry = resolve(root, 'engine/dist/index.js');
  if (!existsSync(engineEntry)) errors.push('engine entry is missing');
  else if (statSync(engineEntry).size > matrix.gates.bundleSize.engineEntryBytes) {
    errors.push(`engine entry ${statSync(engineEntry).size}B exceeds ${matrix.gates.bundleSize.engineEntryBytes}B`);
  }
}

function validateEditorReport(manifest) {
  const editorBudget = JSON.parse(readFileSync(resolve(root, 'editor/bundle-budget.json'), 'utf8'));
  if (editorBudget.maxStartupClosureGzipBytes !== matrix.gates.bundleSize.editorStartupClosureGzipBytes) {
    errors.push('editor startup gzip budget disagrees with config/release-matrix.json');
  }
  if (manifest.startupClosureGzipBytes > matrix.gates.bundleSize.editorStartupClosureGzipBytes) {
    errors.push(`editor startup gzip ${manifest.startupClosureGzipBytes}B exceeds ${matrix.gates.bundleSize.editorStartupClosureGzipBytes}B`);
  }
}

function validateBuildScriptResponsibilities() {
  for (const workspace of ['editor', 'AnimationEditor', 'voxelEditor']) {
    const pkg = JSON.parse(readFileSync(resolve(root, workspace, 'package.json'), 'utf8'));
    if (/--watch|\bserve\b/.test(pkg.scripts?.build ?? '')) {
      errors.push(`${workspace} production build owns watch/server responsibility`);
    }
    if (!pkg.scripts?.dev || !/(?:watch|dev\.mjs)/.test(pkg.scripts.dev)) {
      errors.push(`${workspace} does not keep dev/watch responsibility in its dev script`);
    }
  }
}

function runChecked(label, command, args, timeoutMs, environment = process.env) {
  const started = performance.now();
  console.log(`\n[release-artifacts] ${label}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: timeoutMs, env: environment });
  const durationMs = performance.now() - started;
  commandEvidence.push({ label, command, args, durationMs, maxDurationMs: timeoutMs, exited: !result.error, status: result.status });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited ${result.status}`);
}

function injectStaleHash(path) {
  const absolute = resolve(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, 'throw new Error("stale build artifact");\n');
}

function assertStaleRemoved(path) {
  if (existsSync(resolve(root, path))) throw new Error(`Production build did not clean stale hash artifact ${path}`);
}

function copyPaths(paths, outputRoot) {
  for (const [source, destination] of paths) {
    const target = resolve(outputRoot, destination);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(root, source), target);
  }
}

function readAppManifest(directory) {
  const path = resolve(appArtifactRoot, directory, 'release-manifest.json');
  if (!existsSync(path)) throw new Error(`Missing app release manifest ${relative(root, path)}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if ((manifest.errors ?? []).length > 0) throw new Error(`${manifest.id} release manifest contains errors`);
  return manifest;
}

function artifactDirectoryFor(id) {
  if (id === 'voxel-pwa-electron') return resolve(appArtifactRoot, 'voxel-pwa');
  return resolve(appArtifactRoot, id);
}

function summarizeAppManifest(manifest) {
  return {
    id: manifest.id,
    entry: manifest.entry ?? manifest.entries?.[0],
    contentSha256: manifest.contentSha256 ?? manifest.pwaContentSha256,
    fileCount: manifest.files.length,
    rawBytes: manifest.rawBytes ?? manifest.pwaBytes,
    gzipBytes: manifest.gzipBytes ?? manifest.javaScriptGzipBytes,
    workers: manifest.workers ?? [],
  };
}

function readSourceState() {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : 'unknown',
    workingTreeDirty: status.status !== 0 || status.stdout.trim().length > 0,
  };
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

function syncVerifiedElectronArtifact(sourceRoot, targetRoot) {
  const preserved = new Set();
  try {
    rmSync(targetRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    for (const path of listFiles(targetRoot)) {
      const sourcePath = resolve(sourceRoot, path);
      const targetPath = resolve(targetRoot, path);
      if (!existsSync(sourcePath)
        || statSync(sourcePath).size !== statSync(targetPath).size
        || sha256(readFileSync(sourcePath)) !== sha256(readFileSync(targetPath))) {
        throw new Error(`Locked Electron artifact differs from the verified package: ${path}`);
      }
      preserved.add(path);
    }
    console.warn(
      `[release-artifacts] Preserving ${preserved.size} locked Electron file(s); `
      + 'each matches the newly verified package byte-for-byte.',
    );
  }
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter(source) {
      const path = relative(sourceRoot, source).replaceAll('\\', '/');
      return path.length === 0 || !preserved.has(path);
    },
  });
  const sourceFiles = listFiles(sourceRoot);
  const targetFiles = listFiles(targetRoot);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) {
    throw new Error('Persisted Electron artifact file inventory differs from the verified package');
  }
  for (const path of sourceFiles) {
    if (sha256(readFileSync(resolve(sourceRoot, path))) !== sha256(readFileSync(resolve(targetRoot, path)))) {
      throw new Error(`Persisted Electron artifact differs from the verified package: ${path}`);
    }
  }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}
