import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createReleaseGateChecks } from './release-gate-policy.mjs';
import { createEngineSlowChecks, validateEngineEntryBudget, includesGatePath, selectEngineRenderTargets } from './engine-release-policy.mjs';
import { createContentTargetPlan, loadContentManifests } from './content-gate-policy.mjs';
import { selectProductScreenshotCases, PRODUCT_SCREENSHOT_CASES } from './visual-regression/product-screenshot-policy.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(readFileSync(resolve(source, path)));
test('Engine API and release scope never read a missing or malformed sibling UI', () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'engine-release-isolation-'));
  const root = resolve(parent, 'Engine');
  try {
    for (const item of ['scripts/api-surface.mjs', 'config/public-api-capability-budgets.json', 'review/baselines/api-surface.json', 'review/api/verify-release-scope.mjs', 'review/api/release-manifest.json', 'config/release-matrix.json', 'package.json']) {
      mkdirSync(resolve(root, item, '..'), { recursive: true });
      cpSync(resolve(source, item), resolve(root, item));
    }
    for (const item of ['node_modules', 'engine', 'animation-spec', 'extensions', 'shader-language', 'examples']) symlinkSync(resolve(source, item), resolve(root, item), 'dir');
    const run = (file, args = []) => spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
    const missing = run('scripts/api-surface.mjs', ['--check']);
    // Existing Engine API drift must still fail, identically, regardless of UI state.
    assert.ok([0, 1].includes(missing.status));
    assert.doesNotMatch(missing.stderr, /ENOENT|@haiyue\/ui|SyntaxError/);
    mkdirSync(resolve(parent, 'UI'));
    writeFileSync(resolve(parent, 'UI/package.json'), '{ invalid UI metadata');
    const broken = run('scripts/api-surface.mjs', ['--check']);
    assert.equal(broken.status, missing.status);
    assert.equal(broken.stderr, missing.stderr);
    assert.equal(broken.stdout, missing.stdout);
    const scope = run('review/api/verify-release-scope.mjs');
    assert.equal(scope.status, 0, scope.stderr);
    const candidates = run('scripts/api-surface.mjs', ['--candidate']);
    assert.equal(candidates.status, 0, candidates.stderr);
    // Seed only the temporary fixture, then prove Engine API drift is rejected.
    cpSync(resolve(root, 'artifacts/api/api-surface-candidate.json'), resolve(root, 'review/baselines/api-surface.json'));
    assert.equal(run('scripts/api-surface.mjs', ['--check']).status, 0);
    const baseline = JSON.parse(readFileSync(resolve(root, 'review/baselines/api-surface.json')));
    baseline.packages['@haiyue/engine'].entrypoints['.'].exports.pop();
    writeFileSync(resolve(root, 'review/baselines/api-surface.json'), JSON.stringify(baseline, null, 2) + '\n');
    assert.equal(run('scripts/api-surface.mjs', ['--check']).status, 1);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('Engine package ownership contains exactly four local libraries', () => {
  const policy = read('config/engine-package-budget.json');
  assert.deepEqual(Object.keys(policy.publicPackages).sort(), ['@haiyue/animation-spec', '@haiyue/engine', '@haiyue/extensions', '@haiyue/shader-language']);
  for (const entry of Object.values(policy.publicPackages)) assert.ok(!entry.workspace.startsWith('..'));
  assert.equal(policy.uiConsumers, undefined);
});
test('Engine release modes retain package, scope, render and formal comparison gates', () => {
  for (const mode of ['artifact', 'local', 'global']) {
    const checks = createReleaseGateChecks(mode);
    assert.ok(checks.some(args => args.includes('scripts/verify-engine-package.mjs')));
    assert.ok(checks.some(args => args.includes('scripts/check-engine-entry-budget.mjs')));
    assert.doesNotMatch(JSON.stringify(checks), /build:editor|inspect-release-artifacts|studio/);
    if (mode !== 'artifact') {
      assert.ok(checks.some(args => args.includes('check:engine:fast')));
      assert.ok(checks.some(args => args.includes('check:engine:slow') && args.includes('--content-tier=full')));
      assert.ok(checks.some(args => args.includes('performance:compare:formal')));
    }
  }
});
test('Engine full slow plan retains every Engine smoke/full example and no product workload', () => {
  const plan = createContentTargetPlan('full', loadContentManifests(source, 'engine'));
  const manifest = read('examples/manifest.json');
  assert.deepEqual(plan.targets, manifest.entries.filter(entry => ['smoke','full'].includes(entry.ci)).map(entry => `example:${entry.id}`));
  const checks = createEngineSlowChecks(plan);
  assert.ok(checks.some(args => args.includes('verify:ambient-occlusion:performance')));
  assert.ok(checks.some(args => args.includes('verify:shader-language-stage14')));
  assert.ok(checks.some(args => args.includes('benchmark')));
  assert.doesNotMatch(JSON.stringify(checks), /editor|game:/);
  assert.throws(() => createEngineSlowChecks({ tier: 'full', targets: ['game:match-3'] }));
  assert.throws(() => loadContentManifests(source, 'typo'));
});
test('Engine screenshots retain all Engine cases; Studio retains the complete game', () => {
  assert.deepEqual(selectProductScreenshotCases('engine'), PRODUCT_SCREENSHOT_CASES.filter(entry => entry.fixture.startsWith('examples/')));
  assert.deepEqual(selectProductScreenshotCases('studio'), PRODUCT_SCREENSHOT_CASES);
  assert.throws(() => selectProductScreenshotCases('typo'));
});
test('entry byte budget still fails at its original threshold', () => {
  const maximum = read('config/release-matrix.json').gates.bundleSize.engineEntryBytes;
  validateEngineEntryBudget(maximum, maximum);
  assert.throws(() => validateEngineEntryBudget(maximum + 1, maximum), /exceeds/);
  assert.throws(() => validateEngineEntryBudget(NaN, maximum), /Invalid/);
});
test('Engine CPU suite keeps all Engine cases while Studio adds only its two Editor cases', async () => {
  const { createBenchmarkCases } = await import('./benchmark/suite.mjs');
  for (const profile of ['ci', 'full']) {
    const engine = createBenchmarkCases(profile, 'engine').map(entry => entry.id);
    const studio = createBenchmarkCases(profile, 'studio').map(entry => entry.id);
    assert.deepEqual(engine, studio.filter(id => !id.startsWith('editor.') && !id.startsWith('churn.editor-')));
    assert.equal(studio.length - engine.length, 2);
  }
});

test('structural gates keep local contracts while selecting Studio ownership explicitly', () => {
  for (const path of ['engine/src/gui/index.ts', 'extensions/src/gui.ts', 'examples/gui/main.ts', 'scripts/benchmark/suite.mjs']) assert.equal(includesGatePath(path, 'engine'), true);
  for (const path of ['ui/src/index.ts', 'editor/src/main.ts', 'voxelEditor/src/model.ts', 'AnimationEditor/src/main.ts', 'games/hello/main.ts']) {
    assert.equal(includesGatePath(path, 'engine'), false);
    assert.equal(includesGatePath(path, 'studio'), true);
  }
  assert.throws(() => includesGatePath('engine/src/index.ts', 'typo'));
});
test('Engine structural and documentation gates execute without any sibling repository', () => {
  const parent = mkdtempSync(resolve(tmpdir(), 'engine-contract-isolation-'));
  const root = resolve(parent, 'Engine');
  mkdirSync(resolve(root, 'scripts'), { recursive: true });
  try {
    for (const item of ['node_modules', 'engine', 'animation-spec', 'extensions', 'shader-language', 'examples', 'docs', 'review', 'config', '.github', 'performance-comparison', 'AGENTS.md', 'LICENSE', 'SECURITY.md', 'README.md', 'CHANGELOG.md', 'package.json', 'tsconfig.base.json']) {
      symlinkSync(resolve(source, item), resolve(root, item));
    }
    // Copy CLI entrypoints so import.meta.url belongs to the isolated checkout.
    // Read-only fixture assets and source trees can be linked without sibling repos.
    for (const entry of readdirSync(resolve(source, 'scripts'), { withFileTypes: true })) {
      if (entry.isDirectory()) symlinkSync(resolve(source, 'scripts', entry.name), resolve(root, 'scripts', entry.name), 'dir');
      else cpSync(resolve(source, 'scripts', entry.name), resolve(root, 'scripts', entry.name));
    }
    for (const file of ['check-stage3-contracts.mjs', 'check-stage4-lifecycle.mjs', 'check-scene-golden-path.mjs', 'check-responsibility-boundaries.mjs', 'check-stage7-observability.mjs', 'check-stage8-asset-script.mjs', 'check-stage9-render-product.mjs', 'check-docs.mjs']) {
      const result = spawnSync(process.execPath, [resolve(root, 'scripts', file), '--engine'], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, `${file}: ${result.stdout}\n${result.stderr}`);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('Engine lighting gate retains the reviewed content bytes without a Games checkout', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = readFileSync(resolve(source, 'scripts/fixtures/lighting-content/pad-simulator/scenes/billiards-3d-import.scene.json'));
  assert.equal(bytes.length, 363097);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '9e7f393aba90a91a1a84a42be9583ce627bfa2a0ee996c0b843d21f9514ba007');
  const runner = readFileSync(resolve(source, 'scripts/verify-webgpu-lighting-scaling-fixture.mjs'), 'utf8');
  assert.doesNotMatch(runner, /resolveStudioRepositoryPath|requireStudioRepository/);
  assert.match(runner, /scripts\/fixtures\/lighting-content/);
});

test('automatic rendering regression preserves every qualifying smoke/full case and excludes manual dashboards', () => {
  const manifest = read('examples/manifest.json');
  const targets = selectEngineRenderTargets(manifest);
  assert.deepEqual(targets, manifest.entries.filter(entry => ['smoke', 'full'].includes(entry.ci) && (
    entry.screenshot?.required || entry.capabilities.some(capability => ['render-pipeline', 'gui', '2d', 'ktx2-volume'].includes(capability))
  )));
  assert.ok(targets.some(entry => entry.id === 'ktx2-volume' && entry.ci === 'full'));
  assert.ok(targets.length > 0);
  assert.ok(targets.every(entry => entry.ci !== 'manual'));
  const manual = { id: 'manual', ci: 'manual', screenshot: { required: true }, capabilities: ['2d'] };
  const required = { ...manual, id: 'new-required', ci: 'full' };
  assert.deepEqual(selectEngineRenderTargets({ entries: [manual, required] }), [required]);
});
