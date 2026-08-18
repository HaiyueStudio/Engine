import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { rollup } from 'rollup';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import {
  matchesPackageGlob,
  validateEngineConsumerResult,
  validateEnginePackManifest,
} from './engine-package-policy.mjs';
import { npmArgs, npmCommand } from './npm-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(readFileSync(resolve(root, 'config/engine-package-budget.json'), 'utf8'));
const releaseMode = process.argv.includes('--release');
for (const argument of process.argv.slice(2)) {
  if (argument !== '--release') throw new Error(`Unknown public package verification argument "${argument}".`);
}

const temporaryRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'haiyue-public-packages-')));
const npmCacheRoot = resolve(tmpdir(), 'haiyue-g03-public-consumer-npm-cache-v1');
const reportPath = resolve(root, 'artifacts/release/public-packages.json');
const legacyReportPath = resolve(root, 'artifacts/release/engine-package.json');
const tarballOutputRoot = resolve(root, 'artifacts/release/npm');
const errors = [];
let animationSpecBuildEvidence = null;
let extensionsBuildEvidence = null;

try {
  animationSpecBuildEvidence = buildAnimationSpec();
  extensionsBuildEvidence = buildExtensions();
  rmSync(tarballOutputRoot, { recursive: true, force: true });
  mkdirSync(tarballOutputRoot, { recursive: true });

  const packedPackages = [];
  for (const [packageName, policy] of Object.entries(budget.publicPackages)) {
    const packed = packPublicPackage({ packageName, policy });
    packedPackages.push(packed);
    errors.push(...packed.errors);
  }

  const installed = installPackedConsumer(packedPackages);
  const enginePackage = packedPackages.find(entry => entry.name === '@haiyue/engine');
  if (!enginePackage) throw new Error('The public package policy does not contain @haiyue/engine.');
  const packageDirectories = new Map(packedPackages.map(entry => [
    entry.name,
    resolve(installed.root, 'node_modules', ...entry.name.split('/')),
  ]));

  const consumers = [];
  for (const [id, policy] of Object.entries(budget.consumers)) {
    const result = await bundleConsumer({ id, policy, installed, packageDirectories });
    consumers.push(withoutConsumerCode(result));
    errors.push(...validateEngineConsumerResult(result, policy));
  }
  for (const [id, policy] of Object.entries(budget.animationSpecConsumers)) {
    const result = await bundleConsumer({ id, policy, installed, packageDirectories });
    consumers.push(withoutConsumerCode(result));
    errors.push(...validateGenericConsumerResult(result, policy));
  }
  for (const [id, policy] of Object.entries(budget.extensionConsumers)) {
    const result = await bundleConsumer({ id, policy, installed, packageDirectories });
    consumers.push(withoutConsumerCode(result));
    errors.push(...validateGenericConsumerResult(result, policy));
  }

  const runtimeChecks = {
    node: runNodeRuntimeConsumer(installed),
    typescript: runTypeScriptConsumer(installed),
    exports: runAllExportsConsumer(installed, packedPackages),
    cli: runCliConsumer(installed),
  };
  for (const [id, check] of Object.entries(runtimeChecks)) {
    if (check.status !== 'passed') errors.push(`${id} consumer failed: ${check.detail}`);
  }

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sourceState: readSourceState(),
    mode: releaseMode ? 'release' : 'development',
    buildEvidence: { animationSpec: animationSpecBuildEvidence, extensions: extensionsBuildEvidence },
    packages: packedPackages.map(withoutPrivatePackFields),
    install: {
      manager: installed.manager,
      mode: installed.installMode,
      packageJsonSha256: sha256File(resolve(installed.root, 'package.json')),
      packages: packedPackages.map(entry => {
        const installedDirectory = packageDirectories.get(entry.name);
        const manifest = JSON.parse(readFileSync(resolve(installedDirectory, 'package.json'), 'utf8'));
        return {
          name: entry.name,
          version: manifest.version,
          realpath: normalizeTemporaryPath(realpathSync(installedDirectory)),
          packageJsonSha256: sha256File(resolve(installedDirectory, 'package.json')),
          provenanceMatched: manifest.name === entry.name && manifest.version === entry.version,
        };
      }),
    },
    consumers,
    runtimeChecks,
    budgets: budget,
    gate: {
      status: errors.length === 0 ? 'passed' : 'failed',
      errors,
    },
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  // Keep the historical report path for downstream readers while making its
  // schema explicitly identical to the all-public-package report.
  writeFileSync(legacyReportPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const entry of report.packages) {
    console.log(
      `[public-package] ${entry.name}@${entry.version}: ${entry.fileCount} files, `
      + `${entry.packedBytes}B packed, ${entry.unpackedBytes}B unpacked, sha256=${entry.sha256.slice(0, 12)}.`,
    );
  }
  for (const consumer of consumers) {
    console.log(
      `[public-package] ${consumer.id}: ${consumer.rawBytes}B raw, ${consumer.gzipBytes}B gzip, `
      + `${consumer.modules.length} modules, shaders=${consumer.generatedShaderArtifacts.join(',') || 'none'}.`,
    );
  }
  if (errors.length > 0) {
    console.error('[public-package] Failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      '[public-package] Deterministic npm tarballs, real npm install, browser bundles, Node, TypeScript, '
      + `exports, CLI and provenance passed; report=${relative(root, reportPath)}.`,
    );
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function packPublicPackage({ packageName, policy }) {
  const workspace = resolve(root, policy.workspace);
  const workspacePackageJson = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'));
  const sourceManifest = npmPackManifest({ cwd: workspace, destination: resolve(temporaryRoot, 'source-pack', slug(packageName)), dryRun: true });
  const staging = resolve(temporaryRoot, 'staging', slug(packageName));
  const sourceExcludedFiles = [];
  const stagingErrors = [];
  mkdirSync(staging, { recursive: true });

  for (const file of sourceManifest.files) {
    const forbiddenReason = forbiddenPublishedFileReason(file.path);
    const allowed = policy.allowedFilePatterns.some(pattern => matchesPackageGlob(file.path, pattern));
    if (forbiddenReason) {
      sourceExcludedFiles.push({ path: file.path, reason: forbiddenReason });
      continue;
    }
    if (!allowed) {
      stagingErrors.push(`${packageName} source npm pack candidate contains non-allowlisted ${file.path}`);
      continue;
    }
    const source = resolve(workspace, file.path);
    const destination = resolve(staging, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, file.mode ?? statSync(source).mode);
  }

  const firstDirectory = resolve(temporaryRoot, 'packed-a', slug(packageName));
  const secondDirectory = resolve(temporaryRoot, 'packed-b', slug(packageName));
  const firstManifest = npmPackManifest({ cwd: staging, destination: firstDirectory });
  const secondManifest = npmPackManifest({ cwd: staging, destination: secondDirectory });
  const firstTarball = resolve(firstDirectory, firstManifest.filename);
  const secondTarball = resolve(secondDirectory, secondManifest.filename);
  const firstSha256 = sha256File(firstTarball);
  const secondSha256 = sha256File(secondTarball);
  const outputTarball = resolve(tarballOutputRoot, firstManifest.filename);
  copyFileSync(firstTarball, outputTarball);

  const extractedDirectory = resolve(temporaryRoot, 'extracted', slug(packageName));
  mkdirSync(extractedDirectory, { recursive: true });
  const extract = spawnSync('tar', ['-xzf', firstTarball, '-C', extractedDirectory, '--strip-components=1'], { encoding: 'utf8' });
  assertCommand(extract, `${packageName} tar extract`);
  const manifestFiles = firstManifest.files.map(file => file.path).sort();
  const extractedFiles = listFiles(extractedDirectory);
  const packagedJson = JSON.parse(readFileSync(resolve(extractedDirectory, 'package.json'), 'utf8'));
  const errors = [...stagingErrors];
  if (firstSha256 !== secondSha256) errors.push(`${packageName} repeated npm pack hashes disagree`);
  if (JSON.stringify(manifestFiles) !== JSON.stringify(extractedFiles)) {
    errors.push(`${packageName} tarball contents disagree with npm pack manifest`);
  }
  if (statSync(firstTarball).size !== firstManifest.size) {
    errors.push(`${packageName} tarball bytes disagree with npm pack manifest`);
  }
  errors.push(...validatePublicPackageManifest({
    packageName,
    manifest: firstManifest,
    packageJson: packagedJson,
    policy,
  }));
  if (packageName === '@haiyue/engine') {
    errors.push(...validateEnginePackManifest({
      manifest: firstManifest,
      packageJson: packagedJson,
      budget,
      requirePublishMetadata: releaseMode,
    }).errors);
  }

  return {
    name: packagedJson.name,
    version: packagedJson.version,
    workspace: policy.workspace,
    filename: firstManifest.filename,
    artifact: relative(root, outputTarball),
    sha256: firstSha256,
    deterministicRepackSha256: secondSha256,
    packedBytes: firstManifest.size,
    unpackedBytes: firstManifest.unpackedSize,
    fileCount: manifestFiles.length,
    files: manifestFiles,
    exportTargets: collectPackageTargets(packagedJson),
    sourceExcludedFiles,
    stagingContentSha256: hashTree(staging),
    packageJsonSha256: sha256File(resolve(extractedDirectory, 'package.json')),
    errors,
    tarballPath: outputTarball,
    packageJson: packagedJson,
  };
}

function validatePublicPackageManifest({ packageName, manifest, packageJson, policy }) {
  const errors = [];
  const files = manifest.files.map(file => file.path).sort();
  if (packageJson.name !== packageName) errors.push(`${packageName} tarball declares name ${packageJson.name}`);
  if (packageJson.private !== false) errors.push(`${packageName} must declare private=false`);
  if (packageJson.type !== 'module') errors.push(`${packageName} must declare type=module`);
  if (packageJson.sideEffects !== false) errors.push(`${packageName} must declare sideEffects=false`);
  if (JSON.stringify(packageJson.files ?? []) !== JSON.stringify(policy.declaredFiles)) {
    errors.push(`${packageName} package files whitelist disagrees with the candidate budget`);
  }
  if (manifest.size > policy.maxPackedBytes) {
    errors.push(`${packageName} packed ${manifest.size}B exceeds ${policy.maxPackedBytes}B`);
  }
  if (manifest.unpackedSize > policy.maxUnpackedBytes) {
    errors.push(`${packageName} unpacked ${manifest.unpackedSize}B exceeds ${policy.maxUnpackedBytes}B`);
  }
  if (files.length > policy.maxFileCount) {
    errors.push(`${packageName} file count ${files.length} exceeds ${policy.maxFileCount}`);
  }
  for (const file of files) {
    if (!policy.allowedFilePatterns.some(pattern => matchesPackageGlob(file, pattern))) {
      errors.push(`${packageName} tarball contains non-allowlisted ${file}`);
    }
    const forbiddenReason = forbiddenPublishedFileReason(file);
    if (forbiddenReason) errors.push(`${packageName} tarball contains forbidden ${file} (${forbiddenReason})`);
  }
  const published = new Set(files);
  for (const target of collectPackageTargets(packageJson)) {
    if (!published.has(target)) errors.push(`${packageName} export target is missing: ${target}`);
  }
  for (const target of Object.values(packageJson.bin ?? {})) {
    const normalized = normalizeTarget(target);
    if (!published.has(normalized)) errors.push(`${packageName} bin target is missing: ${normalized}`);
    const packed = manifest.files.find(file => file.path === normalized);
    if (packed && process.platform !== 'win32' && (packed.mode & 0o111) === 0) {
      errors.push(`${packageName} bin target is not executable: ${normalized}`);
    }
  }
  for (const field of ['repository', 'license']) {
    if (!packageJson[field]) errors.push(`${packageName} is missing publish metadata ${field}`);
  }
  if (!packageJson.engines?.node) errors.push(`${packageName} is missing engines.node`);
  if (!files.some(file => /^readme(?:\.|$)/i.test(file))) errors.push(`${packageName} is missing README`);
  return errors;
}

function installPackedConsumer(packedPackages) {
  const consumerRoot = resolve(temporaryRoot, 'consumer');
  mkdirSync(consumerRoot, { recursive: true });
  const dependencies = Object.fromEntries(packedPackages.map(entry => [entry.name, `file:${entry.tarballPath}`]));
  const webGpuTypes = resolve(root, 'node_modules/@webgpu/types');
  if (statSync(webGpuTypes).isDirectory()) dependencies['@webgpu/types'] = `file:${webGpuTypes}`;
  writeFileSync(resolve(consumerRoot, 'package.json'), `${JSON.stringify({
    name: 'haiyue-packed-tarball-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2)}\n`);
  const installArguments = [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--install-strategy=hoisted',
  ];
  const environment = {
    ...process.env,
    npm_config_cache: npmCacheRoot,
    npm_config_fetch_retries: '4',
    npm_config_fetch_retry_maxtimeout: '120000',
  };
  let installMode = 'offline-cache';
  let result = spawnSync(npmCommand(), npmArgs([...installArguments, '--offline'], environment), {
    cwd: consumerRoot,
    encoding: 'utf8',
    env: environment,
    timeout: 180_000,
  });
  if (result.error || result.status !== 0) {
    installMode = 'network-fallback';
    rmSync(resolve(consumerRoot, 'node_modules'), { recursive: true, force: true });
    result = spawnSync(npmCommand(), npmArgs(installArguments, environment), {
      cwd: consumerRoot,
      encoding: 'utf8',
      env: environment,
      timeout: 600_000,
    });
  }
  assertCommand(result, 'real packed-tarball npm install');
  for (const entry of packedPackages) {
    const directory = resolve(consumerRoot, 'node_modules', ...entry.name.split('/'));
    const actual = realpathSync(directory);
    if (!isWithin(actual, consumerRoot)) throw new Error(`${entry.name} escaped the isolated consumer install.`);
    const installedPackage = JSON.parse(readFileSync(resolve(actual, 'package.json'), 'utf8'));
    if (installedPackage.name !== entry.name || installedPackage.version !== entry.version) {
      throw new Error(`${entry.name} installed provenance does not match ${entry.filename}.`);
    }
  }
  return { root: consumerRoot, manager: `npm/${npmVersion()}`, installMode };
}

async function bundleConsumer({ id, policy, installed, packageDirectories }) {
  const source = readFileSync(resolve(root, policy.fixture), 'utf8');
  const input = resolve(installed.root, 'fixtures', `${id}.mjs`);
  mkdirSync(dirname(input), { recursive: true });
  writeFileSync(input, source);
  const warnings = [];
  const bundle = await rollup({
    input,
    plugins: [nodeResolve({ browser: true }), commonjs()],
    onwarn(warning) {
      if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
      warnings.push({ code: warning.code, message: warning.message });
    },
  });
  try {
    const generated = await bundle.generate({ format: 'es', inlineDynamicImports: true, sourcemap: false });
    const chunks = generated.output.filter(output => output.type === 'chunk');
    const code = chunks.map(chunk => chunk.code).join('\n');
    const modules = [...new Set(chunks.flatMap(chunk => Object.keys(chunk.modules)))]
      .map(moduleId => normalizeModuleId(moduleId, packageDirectories, input))
      .sort();
    const generatedShaderArtifacts = modules
      .map(moduleId => moduleId.match(/^@haiyue\/engine\/dist\/internal\/([^/]*shader-artifact)\.js$/)?.[1])
      .filter(Boolean)
      .sort();
    return {
      id,
      fixture: policy.fixture,
      packageName: policy.packageName ?? '@haiyue/engine',
      rawBytes: Buffer.byteLength(code),
      gzipBytes: gzipSync(code, { level: 9 }).byteLength,
      exports: [...new Set(chunks.flatMap(chunk => chunk.exports))].sort(),
      imports: [...new Set(chunks.flatMap(chunk => chunk.imports))].sort(),
      dynamicImports: [...new Set(chunks.flatMap(chunk => chunk.dynamicImports))].sort(),
      modules,
      generatedShaderArtifacts,
      warnings,
      code,
    };
  } finally {
    await bundle.close();
  }
}

function validateGenericConsumerResult(result, policy) {
  const errors = [];
  if (result.gzipBytes > policy.maxGzipBytes) {
    errors.push(`${result.id} gzip ${result.gzipBytes}B exceeds ${policy.maxGzipBytes}B`);
  }
  for (const requiredExport of policy.requiredExports) {
    if (!result.exports.includes(requiredExport)) errors.push(`${result.id} is missing retained export ${requiredExport}`);
  }
  if (!result.modules.some(moduleId => moduleId.startsWith(`${policy.packageName}/dist/`))) {
    errors.push(`${result.id} did not resolve from the installed ${policy.packageName} tarball`);
  }
  const forbidden = ['@haiyue/shader-language', '@dimforge/rapier3d-compat', 'box2d.ts', 'AmbientOcclusionPass'];
  for (const marker of forbidden) {
    if (result.modules.some(moduleId => moduleId.includes(marker)) || result.code.includes(marker)) {
      errors.push(`${result.id} bundled unrelated ${marker}`);
    }
  }
  if (result.imports.length > 0 || result.dynamicImports.length > 0) {
    errors.push(`${result.id} emitted unresolved imports: ${[...result.imports, ...result.dynamicImports].join(', ')}`);
  }
  return errors;
}

function runNodeRuntimeConsumer(installed) {
  const source = resolve(root, 'scripts/fixtures/engine-consumers/node-runtime.mjs');
  const input = resolve(installed.root, 'node-runtime.mjs');
  copyFileSync(source, input);
  const result = spawnSync(process.execPath, [input], { cwd: installed.root, encoding: 'utf8', timeout: 30_000 });
  return commandCheck(result, 'Node ESM runtime');
}

function runTypeScriptConsumer(installed) {
  const source = resolve(root, 'scripts/fixtures/engine-consumers/typescript-consumer.ts');
  const input = resolve(installed.root, 'typescript-consumer.ts');
  copyFileSync(source, input);
  writeFileSync(resolve(installed.root, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ESNext', 'DOM', 'DOM.Iterable'],
      types: ['@webgpu/types'],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    files: ['./typescript-consumer.ts'],
  }, null, 2)}\n`);
  const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: installed.root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return commandCheck(result, 'TypeScript packed declarations');
}

function runAllExportsConsumer(installed, packages) {
  const specifiers = packages.flatMap(entry => Object.keys(entry.packageJson.exports ?? {}).map(subpath => (
    subpath === '.' ? entry.name : `${entry.name}/${subpath.replace(/^\.\//, '')}`
  )));
  const script = resolve(installed.root, 'all-exports.mjs');
  writeFileSync(script, `const specs = ${JSON.stringify(specifiers)};\nfor (const spec of specs) await import(spec);\nprocess.stdout.write(JSON.stringify({ status: 'passed', imports: specs.length }));\n`);
  const result = spawnSync(process.execPath, [script], { cwd: installed.root, encoding: 'utf8', timeout: 60_000 });
  return commandCheck(result, 'all public ESM exports');
}

function runCliConsumer(installed) {
  const cli = resolve(installed.root, 'node_modules/@haiyue/animation-spec/bin/hya-convert.mjs');
  if (process.platform === 'win32' && !existsSync(resolve(installed.root, 'node_modules/.bin/hya-convert.cmd'))) {
    return { status: 'failed', detail: 'hya-convert Windows command shim was not installed' };
  }
  const result = spawnSync(process.execPath, [cli, '--help'], { cwd: installed.root, encoding: 'utf8', timeout: 30_000 });
  const check = commandCheck(result, 'hya-convert CLI');
  if (check.status === 'passed' && !result.stdout.includes('Usage: hya-convert')) {
    return { status: 'failed', detail: 'hya-convert --help did not print usage' };
  }
  return check;
}

function commandCheck(result, label) {
  if (result.error) return { status: 'failed', detail: `${label}: ${result.error.message}` };
  if (result.status !== 0) {
    return { status: 'failed', detail: `${label}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}` };
  }
  return { status: 'passed', detail: (result.stdout || '').trim() || `${label} passed` };
}

function npmPackManifest({ cwd, destination, dryRun = false }) {
  mkdirSync(destination, { recursive: true });
  const args = ['pack', '--json', '--pack-destination', destination];
  if (dryRun) args.push('--dry-run');
  const result = spawnSync(npmCommand(), npmArgs(args), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCacheRoot },
    timeout: 120_000,
  });
  assertCommand(result, `npm pack ${relative(root, cwd)}`);
  const manifest = JSON.parse(result.stdout)[0];
  if (!manifest?.filename || !Array.isArray(manifest.files)) throw new Error(`npm pack returned an invalid manifest for ${cwd}.`);
  return manifest;
}

function buildAnimationSpec() {
  const started = performance.now();
  const result = spawnSync(npmCommand(), npmArgs(['run', 'build', '-w', './animation-spec']), {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    timeout: 120_000,
  });
  assertCommand(result, 'Animation Spec one-shot production build');
  return {
    command: 'npm run build -w ./animation-spec',
    durationMs: performance.now() - started,
    maxDurationMs: 120_000,
    exited: true,
  };
}

function buildExtensions() {
  const started = performance.now();
  const result = spawnSync(npmCommand(), npmArgs(['run', 'build', '-w', './extensions']), {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    timeout: 120_000,
  });
  assertCommand(result, 'Extensions one-shot production build');
  return {
    command: 'npm run build -w ./extensions',
    durationMs: performance.now() - started,
    maxDurationMs: 120_000,
    exited: true,
  };
}

function normalizeModuleId(moduleId, packageDirectories, input) {
  if (moduleId === input) return `fixture/${basename(input)}`;
  for (const [packageName, packageDirectory] of packageDirectories) {
    if (isWithin(moduleId, packageDirectory)) {
      return `${packageName}/${relative(packageDirectory, moduleId).split(sep).join('/')}`;
    }
  }
  const nodeModules = `${sep}node_modules${sep}`;
  const offset = moduleId.lastIndexOf(nodeModules);
  if (offset >= 0) return `node_modules/${moduleId.slice(offset + nodeModules.length).split(sep).join('/')}`;
  return normalizeTemporaryPath(moduleId);
}

function collectPackageTargets(packageJson) {
  const targets = new Set();
  for (const field of ['main', 'module', 'types']) {
    if (typeof packageJson[field] === 'string') targets.add(normalizeTarget(packageJson[field]));
  }
  for (const target of Object.values(packageJson.exports ?? {})) {
    if (typeof target === 'string') targets.add(normalizeTarget(target));
    else for (const value of Object.values(target ?? {})) if (typeof value === 'string') targets.add(normalizeTarget(value));
  }
  for (const target of Object.values(packageJson.bin ?? {})) {
    if (typeof target === 'string') targets.add(normalizeTarget(target));
  }
  return [...targets].sort();
}

function forbiddenPublishedFileReason(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.map')) return 'source-map';
  if (path === '.DS_Store') return 'system-file';
  if (path.startsWith('.claude/')) return 'private-agent-config';
  if (path.startsWith('devLog/') || path.startsWith('devlog/')) return 'development-log';
  if (path.startsWith('src/') || path.includes('/src/')) return 'source';
  if (path.startsWith('test/') || path.startsWith('tests/') || path.includes('/test/')) return 'test';
  if (/(^|\/)(?:\.env(?:\.|$)|.*(?:secret|credential|private[-_]?key).*)/i.test(path)) return 'secret';
  if (/\.(?:pem|p12|pfx|key)$/i.test(lower)) return 'secret-key';
  return null;
}

function hashTree(directory) {
  const hash = createHash('sha256');
  for (const file of listFiles(directory)) {
    hash.update(file);
    hash.update(readFileSync(resolve(directory, file)));
  }
  return hash.digest('hex');
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
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(resolve(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function withoutPrivatePackFields(entry) {
  const { errors: _errors, tarballPath: _tarballPath, packageJson: _packageJson, ...publicEntry } = entry;
  return publicEntry;
}

function withoutConsumerCode(result) {
  const { code: _code, ...serializable } = result;
  return serializable;
}

function normalizeTarget(path) {
  return path.startsWith('./') ? path.slice(2) : path;
}

function normalizeTemporaryPath(path) {
  return path.split(temporaryRoot).join('<temporary-root>');
}

function isWithin(path, directory) {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(`..${sep}`));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function slug(value) {
  return value.replace(/^@/, '').replaceAll('/', '-');
}

function assertCommand(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim()}`);
}

function npmVersion() {
  const result = spawnSync(npmCommand(), npmArgs(['--version']), {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}
