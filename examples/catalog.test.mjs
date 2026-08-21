import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createExampleCatalog,
  createExampleCatalogReport,
  loadExampleCatalog,
  loadExampleCatalogReport,
} from './catalog.js';
import { computeExampleSourceFingerprint } from './scripts/example-build-fingerprint.mjs';
import {
  SHARED_ENGINE_GLOBAL,
  SHARED_ENGINE_OUTPUT,
  SHARED_ENGINE_TARGET,
  sharedEngineEntrypoints,
  sharedEngineGlobal,
  sharedEngineLocalPackages,
} from './scripts/shared-engine-bundle.mjs';

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));

test('example shell is self-contained after the UI workspace split', async () => {
  const source = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ui\/dist|defineHaiyueUI|<ge-(?:tree|split)/u);
  assert.match(source, /class="example-tree"/u);
  assert.match(source, /function renderTree\(\)/u);
});

test('example catalog derives every group, label, order, and URL from manifest metadata', async () => {
  const catalog = createExampleCatalog(manifest);
  const entries = catalog.flatMap(group => group.children);
  assert.equal(catalog.length, manifest.catalog.groups.length);
  assert.equal(entries.length, manifest.entries.length);
  assert.equal(new Set(entries.map(entry => entry.id)).size, manifest.entries.length);
  assert.deepEqual(catalog.map(group => group.id), [
    'group-rendering',
    'group-materials',
    'group-cameras',
    'group-postprocess',
    'group-compute',
    'group-interaction',
    'group-physics',
    'group-assets-ui',
  ]);
  assert.deepEqual(catalog[0].children.slice(0, 3).map(entry => entry.id), [
    'mixed-scene',
    'render-pipeline',
    'blinn-phong',
  ]);
  assert.equal(entries.find(entry => entry.id === 'pbr-showcase').label, 'PBR Showcase');
  assert.equal(entries.find(entry => entry.id === 'gpu-driven-instancing').url, './gpu-driven-instancing/index.html');
  assert.equal(entries.find(entry => entry.id === 'gpu-driven-instancing').sourceUrl, './gpu-driven-instancing/main.ts');
  await Promise.all(entries.map(entry => readFile(new URL(entry.sourceUrl, import.meta.url), 'utf8')));
});

test('catalog loader fetches the manifest once and keeps its array API', async () => {
  const calls = [];
  const catalog = await loadExampleCatalog({
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return { ok: true, json: async () => structuredClone(manifest) };
    },
  });
  assert.equal(catalog.flatMap(group => group.children).length, manifest.entries.length);
  assert.deepEqual(calls, [['./manifest.json', { cache: 'no-store' }]]);
});

test('catalog isolates malformed examples and reports diagnostics without hiding valid examples', async () => {
  const invalid = structuredClone(manifest);
  invalid.entries[0].catalog = { group: 'missing', order: 0 };
  invalid.entries[1].entry = '../engine/src/index.ts';
  const duplicatePlacement = {
    id: 'duplicate-placement',
    title: 'Duplicate placement',
    entry: 'duplicate-placement/main.ts',
    catalog: structuredClone(invalid.entries[2].catalog),
  };
  invalid.entries.push(duplicatePlacement);

  const report = createExampleCatalogReport(invalid);
  const entries = report.catalog.flatMap(group => group.children);
  assert.equal(entries.length, manifest.entries.length - 2);
  assert.equal(report.acceptedEntryCount, manifest.entries.length - 2);
  assert.equal(report.skippedEntryCount, 3);
  assert.deepEqual(report.diagnostics.slice(0, 3).map(diagnostic => diagnostic.code), [
    'unknown-group',
    'invalid-entry',
    'duplicate-order',
  ]);
  assert.equal(entries.some(entry => entry.id === invalid.entries[0].id), false);
  assert.equal(entries.some(entry => entry.id === invalid.entries[1].id), false);
  assert.equal(entries.some(entry => entry.id === invalid.entries[2].id), true);
  assert.equal(entries.some(entry => entry.id === duplicatePlacement.id), false);

  const fetched = await loadExampleCatalogReport({
    fetchImpl: async () => ({ ok: true, json: async () => invalid }),
  });
  assert.equal(fetched.skippedEntryCount, 3);
});

test('catalog omits groups emptied by invalid examples but keeps manifest structure errors fatal', () => {
  const isolated = structuredClone(manifest);
  const groupId = isolated.entries[0].catalog.group;
  for (const entry of isolated.entries) {
    if (entry.catalog.group === groupId) entry.catalog.group = 'missing';
  }
  const report = createExampleCatalogReport(isolated);
  assert.equal(report.catalog.some(group => group.id === `group-${groupId}`), false);
  assert.equal(report.diagnostics.some(diagnostic => diagnostic.code === 'empty-group'), true);

  const invalidHeader = structuredClone(manifest);
  invalidHeader.schemaVersion = 2;
  assert.throws(() => createExampleCatalog(invalidHeader), /Invalid examples manifest header/);

  const invalidGroups = structuredClone(manifest);
  invalidGroups.catalog.groups[1].order = invalidGroups.catalog.groups[0].order;
  assert.throws(() => createExampleCatalog(invalidGroups), /Invalid or duplicate catalog group/);
});

test('every example loads one shared Engine bundle before its own bundle', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../engine/package.json', import.meta.url), 'utf8'));
  const expectedPackageIds = Object.keys(packageJson.exports).map(exportPath => (
    exportPath === '.' ? packageJson.name : `${packageJson.name}/${exportPath.slice(2)}`
  ));
  assert.equal(SHARED_ENGINE_TARGET, 'shared-engine');
  assert.equal(SHARED_ENGINE_OUTPUT, 'shared/engine.js');
  assert.deepEqual(sharedEngineEntrypoints.map(entry => entry.packageId), expectedPackageIds);
  assert.equal(new Set(sharedEngineEntrypoints.map(entry => entry.property)).size, sharedEngineEntrypoints.length);
  for (const entry of sharedEngineEntrypoints) {
    assert.equal(sharedEngineGlobal(entry.packageId), `${SHARED_ENGINE_GLOBAL}.${entry.property}`);
    assert.equal(sharedEngineLocalPackages[entry.packageId], entry.input);
    assert.match(entry.input.replaceAll('\\', '/'), /\/engine\/src\/.+\.ts$/u);
  }

  await Promise.all(manifest.entries.map(async entry => {
    const html = await readFile(new URL(`./${entry.id}/index.html`, import.meta.url), 'utf8');
    const sharedIndex = html.indexOf('<script src="../shared/engine.js"></script>');
    const exampleIndex = html.search(/<script[^>]+src="\.\/bundle\.js(?:\?[^"}]*)?"/u);
    if (exampleIndex < 0) {
      assert.equal(entry.id, 'hya-samples', `${entry.id} must load its own bundle`);
      assert.match(html, /animation-spec/u, 'the redirect-only HYA catalog entry must keep its explicit destination');
      return;
    }
    assert.ok(sharedIndex >= 0, `${entry.id} must load the shared Engine bundle`);
    assert.ok(exampleIndex > sharedIndex, `${entry.id} must load its own bundle after the shared Engine bundle`);
  }));
});

test('example builds are content-addressed and dev watches every producing workspace', async () => {
  const [first, second, rollup, buildScript, watchScript, packageJson] = await Promise.all([
    computeExampleSourceFingerprint(),
    computeExampleSourceFingerprint(),
    readFile(new URL('./rollup.config.js', import.meta.url), 'utf8'),
    readFile(new URL('./scripts/build-examples.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./scripts/watch-examples.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(first.hash, second.hash);
  assert.ok(first.inputCount > manifest.entries.length);
  assert.match(rollup, /exampleBuildMetadata\('source-viewer'\)/);
  assert.match(rollup, /exampleBuildMetadata\(entry\.id\)/);
  assert.match(rollup, /exampleBuildMetadata\(SHARED_ENGINE_TARGET\)/);
  assert.match(rollup, /isSharedEngineImport/);
  assert.match(buildScript, /verifyExampleBuildFreshness/);
  assert.match(buildScript, /runRollupOnce/);
  assert.match(buildScript, /EXAMPLE_SHELL_ONLY/);
  assert.match(buildScript, /EXAMPLE_SKIP_SOURCE_VIEWER/);
  assert.match(buildScript, /EXAMPLE_SHARED_ONLY/);
  assert.match(buildScript, /EXAMPLE_SKIP_SHARED_ENGINE/);
  assert.doesNotMatch(buildScript, /from 'node:child_process'/);
  assert.doesNotMatch(buildScript, /bundleCreated|stopAfterCreateTimer/);
  assert.match(watchScript, /rollup\.worker\.config\.js/);
  assert.match(watchScript, /'\.\/extensions'/);
  assert.match(watchScript, /watch\('extensions'/);
  assert.match(watchScript, /watch\('extensions-worker'/);
  assert.doesNotMatch(watchScript, /'\.\/components'|resolve\(root, 'components'\)/);
  assert.doesNotMatch(watchScript, /build-examples\.mjs/);
  assert.deepEqual(packageJson.scripts.dev, 'node scripts/watch-examples.mjs');
  assert.deepEqual(packageJson.scripts['freshness:check'], 'node scripts/check-build-freshness.mjs');
});
