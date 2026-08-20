import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  matchesPackageGlob,
  validateCapabilityPackageBudgetConfig,
  validateEngineConsumerResult,
  validateEnginePackManifest,
} from './engine-package-policy.mjs';

test('package capacity is reviewed capability plus explicit growth reserve', () => {
  const budget = JSON.parse(readFileSync(new URL('../config/engine-package-budget.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateCapabilityPackageBudgetConfig(budget), []);
  assert.equal(budget.publicPackages['@haiyue/engine'].capacity.reviewed.fileCount, 549);
  assert.ok(budget.publicPackages['@haiyue/engine'].maxFileCount > 549);
  assert.ok(budget.publicPackages['@haiyue/animation-spec'].maxFileCount > 31);
});

test('package globs include nested release files without admitting source maps', () => {
  assert.equal(matchesPackageGlob('dist/index.js', 'dist/**/*.js'), true);
  assert.equal(matchesPackageGlob('dist/physics/backend.js', 'dist/**/*.js'), true);
  assert.equal(matchesPackageGlob('dist/index.d.ts', 'dist/**/*.d.ts'), true);
  assert.equal(matchesPackageGlob('dist/index.js.map', 'dist/**/*.js'), false);
  assert.equal(matchesPackageGlob('src/index.ts', 'dist/**/*.d.ts'), false);
});

test('public package manifests expose dist-only targets and never publish source trees', () => {
  const workspaces = [
    ['engine', new URL('../engine/package.json', import.meta.url)],
    ['animation-spec', new URL('../animation-spec/package.json', import.meta.url)],
    ['shader-language', new URL('../shader-language/package.json', import.meta.url)],
    ['extensions', new URL('../extensions/package.json', import.meta.url)],
    ['ui', new URL('../../UI/package.json', import.meta.url)],
  ];
  for (const [workspace, manifestUrl] of workspaces) {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    assert.ok(!(manifest.files ?? []).some(value => value.includes('src')), `${workspace} files`);
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target === 'string') {
        assert.ok(!target.includes('/src/'), `${workspace} ${subpath} string target`);
        continue;
      }
      assert.equal(target?.source, undefined, `${workspace} ${subpath} source condition`);
      assert.match(target?.types ?? '', /^\.\/dist\//u, `${workspace} ${subpath} types`);
      assert.match(target?.import ?? '', /^\.\/dist\//u, `${workspace} ${subpath} import`);
    }
  }
});

test('pack policy rejects forbidden files and missing export targets', () => {
  const result = validateEnginePackManifest({
    manifest: {
      size: 10,
      unpackedSize: 20,
      files: [{ path: 'package.json' }, { path: 'dist/index.js' }, { path: 'src/index.ts' }],
    },
    packageJson: {
      main: 'dist/index.js',
      module: 'dist/index.js',
      types: 'dist/index.d.ts',
      sideEffects: false,
      files: ['README.md', 'LICENSE', 'dist/**/*.js', 'dist/**/*.d.ts'],
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    },
    budget: {
      tarball: {
        maxPackedBytes: 100,
        maxUnpackedBytes: 100,
        maxFileCount: 10,
        filesWhitelist: ['README.md', 'LICENSE', 'dist/**/*.js', 'dist/**/*.d.ts'],
        allowedFilePatterns: ['package.json', 'README.md', 'LICENSE', 'dist/**/*.js', 'dist/**/*.d.ts'],
      },
    },
  });
  assert.ok(result.errors.some(error => error.includes('src/index.ts')));
  assert.ok(result.errors.some(error => error.includes('dist/index.d.ts')));
  assert.deepEqual(result.pendingProjectInputs, ['repository', 'license', 'README', 'engines.node']);
});

test('release package policy turns unresolved publication inputs into hard errors', () => {
  const result = validateEnginePackManifest({
    manifest: {
      size: 10,
      unpackedSize: 20,
      files: [
        { path: 'package.json' },
        { path: 'README.md' },
        { path: 'LICENSE' },
        { path: 'dist/index.js' },
        { path: 'dist/index.d.ts' },
      ],
    },
    packageJson: {
      main: 'dist/index.js',
      module: 'dist/index.js',
      types: 'dist/index.d.ts',
      sideEffects: false,
      files: ['README.md', 'LICENSE', 'dist/**/*.js', 'dist/**/*.d.ts'],
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    },
    budget: {
      tarball: {
        maxPackedBytes: 100,
        maxUnpackedBytes: 100,
        maxFileCount: 10,
        filesWhitelist: ['README.md', 'LICENSE', 'dist/**/*.js', 'dist/**/*.d.ts'],
        allowedFilePatterns: ['package.json', 'README.md', 'LICENSE', 'dist/**/*.js', 'dist/**/*.d.ts'],
      },
    },
    requirePublishMetadata: true,
  });
  assert.deepEqual(result.pendingProjectInputs, ['repository', 'license', 'engines.node']);
  assert.ok(result.errors.some(error => (
    error === 'engine publish metadata is incomplete: repository, license, engines.node'
  )));
});

test('consumer policy blocks heavy physics, AO, unrelated shaders, and gzip excess', () => {
  const errors = validateEngineConsumerResult({
    id: 'fxaa-only',
    gzipBytes: 101,
    exports: ['FxaaPass'],
    modules: [
      '@haiyue/engine/dist/postprocess.js',
      'node_modules/@dimforge/rapier3d-compat/rapier.js',
    ],
    code: 'class AmbientOcclusionPass {}',
    generatedShaderArtifacts: ['compute-shader-artifact'],
    imports: [],
    dynamicImports: [],
  }, {
    maxGzipBytes: 100,
    requiredExports: ['FxaaPass'],
    allowedGeneratedShaderArtifacts: ['postprocess-shader-artifact'],
  });
  assert.equal(errors.length, 4);
});
