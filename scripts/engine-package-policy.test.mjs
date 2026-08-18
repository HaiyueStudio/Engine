import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesPackageGlob,
  validateEngineConsumerResult,
  validateEnginePackManifest,
} from './engine-package-policy.mjs';

test('package globs include nested release files without admitting source maps', () => {
  assert.equal(matchesPackageGlob('dist/index.js', 'dist/**/*.js'), true);
  assert.equal(matchesPackageGlob('dist/physics/backend.js', 'dist/**/*.js'), true);
  assert.equal(matchesPackageGlob('dist/index.d.ts', 'dist/**/*.d.ts'), true);
  assert.equal(matchesPackageGlob('dist/index.js.map', 'dist/**/*.js'), false);
  assert.equal(matchesPackageGlob('src/index.ts', 'dist/**/*.d.ts'), false);
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
