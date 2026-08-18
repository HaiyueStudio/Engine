import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import ts from 'typescript';
import { runChromeWebGpuFixture } from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tarball = resolve(root, 'artifacts/release/npm/haiyue-engine-0.1.0.tgz');
if (!existsSync(tarball)) {
  throw new Error('Run npm run verify:engine-package before the packed consumer walkthrough.');
}

const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-g05-clean-consumer-'));
try {
  writeFileSync(resolve(temporaryRoot, 'package.json'), `${JSON.stringify({
    name: 'haiyue-g05-clean-consumer',
    private: true,
    type: 'module',
    dependencies: { '@haiyue/engine': `file:${tarball}` },
  }, null, 2)}\n`);
  run('npm', [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--install-strategy=hoisted',
  ], {
    npm_config_cache: resolve(tmpdir(), 'haiyue-g03-public-consumer-npm-cache-v1'),
  });

  const installedManifest = JSON.parse(readFileSync(
    resolve(temporaryRoot, 'node_modules/@haiyue/engine/package.json'),
    'utf8',
  ));
  assert.equal(installedManifest.name, '@haiyue/engine');
  assert.equal(installedManifest.version, '0.1.0');

  const applicationRoot = resolve(temporaryRoot, 'app');
  mkdirSync(applicationRoot, { recursive: true });
  cpSync(resolve(root, 'examples/consumer-walkthrough/index.html'), resolve(applicationRoot, 'index.html'), {
    recursive: false,
  });
  cpSync(resolve(root, 'examples/example-fullscreen.css'), resolve(temporaryRoot, 'example-fullscreen.css'));
  cpSync(
    resolve(root, 'animation-spec/samples/assets/sprite1.png'),
    resolve(applicationRoot, 'checker.png'),
  );

  const source = readFileSync(resolve(root, 'examples/consumer-walkthrough/main.ts'), 'utf8')
    .replace(
      "new URL('../../animation-spec/samples/assets/sprite1.png', import.meta.url).href",
      "new URL('./checker.png', window.location.href).href",
    );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    fileName: 'main.ts',
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, []);
  const input = resolve(temporaryRoot, 'main.mjs');
  writeFileSync(input, transpiled.outputText);

  const bundle = await rollup({
    input,
    plugins: [nodeResolve({ browser: true })],
    onwarn(warning) {
      if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
    },
  });
  try {
    await bundle.write({ file: resolve(applicationRoot, 'bundle.js'), format: 'es', sourcemap: false });
  } finally {
    await bundle.close();
  }

  const result = await runChromeWebGpuFixture({
    root: temporaryRoot,
    fixture: 'app/index.html',
    query: { regression: 1 },
    timeoutMs: 60_000,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.installed, true);
  assert.equal(result.rendered, true);
  assert.equal(result.assetLoaded, true);
  assert.equal(result.animated, true);
  assert.equal(result.disposed, true);
  assert.equal(result.browserEvidence.nativeBackend, true);
  assert.equal(result.browserDiagnostics.unclassifiedFailureCount, 0);
  for (const required of ['app/index.html', 'app/bundle.js', 'app/checker.png']) {
    assert.ok(result.httpProvenance.files.some(file => file.sourcePath === required));
  }

  console.log(JSON.stringify({
    status: 'passed',
    installed: `${installedManifest.name}@${installedManifest.version}`,
    browser: result.browserEvidence.product,
    backend: result.browserEvidence.angleBackend,
    renderedFrames: result.renderedFrames,
    assetLoaded: result.assetLoaded,
    animated: result.animated,
    disposed: result.disposed,
    httpFiles: result.httpProvenance.files.map(file => file.sourcePath),
  }, null, 2));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: temporaryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnvironment },
    timeout: 180_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
}
