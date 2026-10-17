import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureConsumerLoading, validateConsumerLoading, validateConsumerLoadingPolicy } from './engine-package-loading-policy.mjs';
import {
  matchesPackageGlob,
  collectPublicTypeEntrypoints,
  validateExtensionConsumerCoverage,
  validatePackageByteBudget,
  validateCapabilityPackageBudgetConfig,
  validateEngineConsumerResult,
  validateEnginePackManifest,
} from './engine-package-policy.mjs';

test('split consumer measures static transitive closure and deferred chunks independently', () => {
  const chunk = (fileName, isEntry, imports, dynamicImports, modules) => ({
    fileName, isEntry, imports, dynamicImports, modules: Object.fromEntries(modules.map(name => [name, {}])),
    code: `export const name = ${JSON.stringify(fileName)};`,
  });
  const chunks = [
    chunk('entry.js', true, ['shared.js'], ['font.js'], ['animation']),
    chunk('shared.js', false, ['entry.js'], [], ['common']),
    chunk('font.js', false, ['shared.js'], [], ['opentype']),
  ];
  const policy = { schemaVersion: 1, maxInitialGzipBytes: 200, maxTotalGzipBytes: 300, deferredModuleMarkers: ['opentype'] };
  const result = measureConsumerLoading(chunks);
  assert.deepEqual(result.initialFiles, ['entry.js', 'shared.js']);
  assert.equal(result.deferredGzipBytes, result.files[2].gzipBytes);
  assert.deepEqual(validateConsumerLoading(result, policy, 300), []);
  for (const [mutate, message] of [
    [value => value.files[1].imports.push('font.js'), 'eager capability'],
    [value => value.files[2].dynamicImports.push('missing.js'), 'unresolved chunk'],
    [value => { value.files[0].dynamicImports = []; }, 'unreachable emitted'],
    [value => { value.initialGzipBytes = 1; }, 'byte totals'],
    [value => { value.files[2].modules = []; }, 'missing deferred capability'],
    [value => { value.files[1].gzipBytes = -1; }, 'invalid chunk byte'],
    [value => { value.files[1].modules = null; }, 'invalid split chunk'],
  ]) {
    const candidate = structuredClone(result); mutate(candidate);
    assert.ok(validateConsumerLoading(candidate, policy, 300).some(error => error.includes(message)), message);
  }
  assert.ok(validateConsumerLoading(result, { ...policy, maxInitialGzipBytes: 1 }, 300).some(error => error.includes('initial gzip')));
  assert.ok(validateConsumerLoading(result, { ...policy, maxInitialGzipBytes: 1, maxTotalGzipBytes: 2 }, 300).some(error => error.includes('total gzip')));
  assert.ok(validateConsumerLoadingPolicy({ ...policy, maxTotalGzipBytes: 301 }, 300).length);
  assert.ok(validateConsumerLoadingPolicy({ ...policy, deferredModuleMarkers: [] }, 300).length);
  assert.ok(validateConsumerLoadingPolicy(policy, undefined).length);
  assert.deepEqual(validateConsumerLoading(null, policy, 300), ['missing split consumer loading evidence']);
});

test('byte capacity retains reviewed reserve while file counts are observations', () => {
  const budget = JSON.parse(readFileSync(new URL('../config/engine-package-budget.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateCapabilityPackageBudgetConfig(budget), []);
  for (const policy of Object.values(budget.publicPackages)) {
    assert.equal(policy.maxFileCount, undefined);
    assert.ok(policy.capacity.reviewed.fileCount > 0);
  }
  const unreviewedIncrease = structuredClone(budget);
  unreviewedIncrease.publicPackages['@haiyue/extensions'].maxUnpackedBytes += 1;
  assert.ok(validateCapabilityPackageBudgetConfig(unreviewedIncrease)
    .some(error => error.includes('maxUnpackedBytes must equal')));
  const fileLimit = structuredClone(budget);
  fileLimit.publicPackages['@haiyue/extensions'].maxFileCount = 200;
  assert.ok(validateCapabilityPackageBudgetConfig(fileLimit).some(error => error.includes('observations, not limits')));
});

test('package globs include nested release files without admitting source maps', () => {
  assert.equal(matchesPackageGlob('dist/index.js', 'dist/**/*.js'), true);
  assert.equal(matchesPackageGlob('dist/physics/backend.js', 'dist/**/*.js'), true);
  assert.equal(matchesPackageGlob('dist/index.d.ts', 'dist/**/*.d.ts'), true);
  assert.equal(matchesPackageGlob('dist/index.js.map', 'dist/**/*.js'), false);
  assert.equal(matchesPackageGlob('src/index.ts', 'dist/**/*.d.ts'), false);
});

test('additional valid modules do not fail packaging but byte excess still does', () => {
  const budget = JSON.parse(readFileSync(new URL('../config/engine-package-budget.json', import.meta.url), 'utf8'));
  const packageJson = { sideEffects: false, files: budget.tarball.filesWhitelist };
  const manifest = {
    size: budget.tarball.maxPackedBytes,
    unpackedSize: budget.tarball.maxUnpackedBytes,
    files: Array.from({ length: 1000 }, (_, index) => ({ path: `dist/item-${index}.d.ts` })),
  };
  const errors = candidate => validateEnginePackManifest({ manifest: candidate, packageJson, budget }).errors;
  assert.deepEqual(errors(manifest), []);
  for (const [field, message] of [['size', 'tarball packed'], ['unpackedSize', 'tarball unpacked']]) {
    const candidate = structuredClone(manifest);
    candidate[field]++;
    assert.equal(errors(candidate).length, 1);
    assert.ok(errors(candidate)[0].startsWith(message));
  }
  manifest.files.push({ path: 'dist/over-budget.d.ts' });
  assert.deepEqual(errors(manifest), []);
  const extensionPolicy = budget.publicPackages['@haiyue/extensions'];
  assert.deepEqual(validatePackageByteBudget({ size: 10, unpackedSize: 20, files: manifest.files }, extensionPolicy, 'extensions'), []);
  assert.equal(validatePackageByteBudget({ size: extensionPolicy.maxPackedBytes + 1, unpackedSize: 20 }, extensionPolicy, 'extensions').length, 1);
});

test('every admitted stable extension requires a real focused consumer and public types', () => {
  const packageJson = { name: '@haiyue/extensions', exports: { './i18n': { import: './dist/i18n.js', types: './dist/i18n.d.ts' } } };
  const capabilities = { packages: { [packageJson.name]: { groups: [{ stability: 'stable', entrypoints: { './i18n': 19 } }] } } };
  const consumers = { localized: { packageName: packageJson.name, entrypoint: './i18n', requiredExports: ['I18n'] } };
  const fixtures = { localized: "export { I18n } from '@haiyue/extensions/i18n';" };
  const valid = { packageJson, capabilities, consumers, fixtures };
  assert.deepEqual(validateExtensionConsumerCoverage(valid), []);
  assert.match(validateExtensionConsumerCoverage({ ...valid, consumers: {} }).join('\n'), /lacks a focused packed consumer/);
  assert.match(validateExtensionConsumerCoverage({ ...valid, fixtures: { localized: "export { I18n } from '../extensions/src/i18n';" } }).join('\n'), /must import its declared capability/);
  assert.match(validateExtensionConsumerCoverage({ ...valid, fixtures: { localized: "// export { I18n } from '@haiyue/extensions/i18n';\nexport const I18n = 0;" } }).join('\n'), /must import its declared capability/);
  const noExports = structuredClone(valid);
  noExports.consumers.localized.requiredExports = [];
  assert.match(validateExtensionConsumerCoverage(noExports).join('\n'), /must retain at least one runtime export/);
  const missingTypes = structuredClone(valid);
  delete missingTypes.packageJson.exports['./i18n'].types;
  assert.match(validateExtensionConsumerCoverage(missingTypes).join('\n'), /lacks a public runtime or declaration/);
  const addition = structuredClone(valid);
  addition.capabilities.packages[packageJson.name].groups[0].entrypoints['./narrative'] = 19;
  assert.equal(validateExtensionConsumerCoverage(addition).length, 2);
});

test('the current stable extension surface has real focused packed consumers', () => {
  const budget = JSON.parse(readFileSync(new URL('../config/engine-package-budget.json', import.meta.url), 'utf8'));
  const packageJson = JSON.parse(readFileSync(new URL('../extensions/package.json', import.meta.url), 'utf8'));
  const capabilities = JSON.parse(readFileSync(new URL('../config/public-api-capability-budgets.json', import.meta.url), 'utf8'));
  const fixtures = Object.fromEntries(Object.entries(budget.extensionConsumers).map(([id, policy]) =>
    [id, readFileSync(new URL('../' + policy.fixture, import.meta.url), 'utf8')]));
  const current = { packageJson, capabilities, consumers: budget.extensionConsumers, fixtures };
  assert.deepEqual(validateExtensionConsumerCoverage(current), []);
  const missing = structuredClone(current);
  delete missing.consumers['extensions-achievements'];
  assert.ok(validateExtensionConsumerCoverage(missing).some(error => error.includes('/achievements lacks a focused packed consumer')));
});

test('packed declaration checks include all public packages, not only engine', () => {
  assert.deepEqual(collectPublicTypeEntrypoints([
    { name: '@haiyue/engine', exports: { '.': { types: './dist/index.d.ts' } } },
    { name: '@haiyue/extensions', exports: { './i18n': { types: './dist/i18n.d.ts' }, './experimental/test': { types: './dist/test.d.ts' } } },
  ]), ['@haiyue/engine', '@haiyue/extensions/i18n', '@haiyue/extensions/experimental/test']);
});

test('public package manifests expose dist-only targets and never publish source trees', () => {
  const workspaces = [
    ['engine', new URL('../engine/package.json', import.meta.url)],
    ['animation-spec', new URL('../animation-spec/package.json', import.meta.url)],
    ['shader-language', new URL('../shader-language/package.json', import.meta.url)],
    ['extensions', new URL('../extensions/package.json', import.meta.url)],
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
