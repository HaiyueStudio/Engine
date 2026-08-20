import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createReleaseGateChecks,
  releaseGateSuccessLabel,
  resolveReleaseGateMode,
} from './release-gate-policy.mjs';
import {
  createContentTargetPlan,
  loadContentManifests,
  resolveContentTier,
} from './content-gate-policy.mjs';

const root = new URL('../', import.meta.url);
const manifests = loadContentManifests(fileURLToPath(root));

test('unqualified release gate is the strict global candidate gate', () => {
  assert.equal(resolveReleaseGateMode([]), 'global');
  assert.equal(resolveReleaseGateMode(['--full']), 'global');
  assert.equal(resolveReleaseGateMode(['--global']), 'global');
  assert.deepEqual(
    createReleaseGateChecks('global').at(-1),
    ['run', 'performance:compare:formal'],
  );
  assert.ok(!createReleaseGateChecks('global').some(args => args.includes('performance:evidence:check')));
  assert.equal(releaseGateSuccessLabel('global'), 'Global release candidate');
});

test('local candidate runs the same portable comparison contract', () => {
  assert.equal(resolveReleaseGateMode(['--local']), 'local');
  assert.deepEqual(
    createReleaseGateChecks('local').at(-1),
    ['run', 'performance:compare:formal'],
  );
  assert.ok(createReleaseGateChecks('local').some(args => (
    args[0] === 'exec:node'
    && args[1] === 'scripts/inspect-release-artifacts.mjs'
    && args[2] === '--release'
  )));
});

test('portable release gates do not require a fixed CPU runner identity', () => {
  const releaseGate = readFileSync(new URL('./release-gate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(releaseGate, /CPU_BENCHMARK_RUNNER_PROFILE/);
  for (const mode of ['local', 'global']) {
    assert.ok(!createReleaseGateChecks(mode).some(args => (
      args.includes('scripts/release-gate-cpu-benchmark.mjs')
    )));
  }
});

test('artifact mode remains an explicit fast packaging check', () => {
  assert.equal(resolveReleaseGateMode(['--artifact']), 'artifact');
  const checks = createReleaseGateChecks('artifact');
  assert.ok(checks.some(args => args.includes('render-product:check')));
  assert.ok(!checks.some(args => args.includes('check:slow')));
  assert.ok(!checks.some(args => args.includes('performance:evidence:check')));
  assert.ok(!checks.some(args => args.includes('performance:compare:formal')));
  assert.ok(!checks.some(args => args.includes('release-gate-cpu-benchmark.mjs')));
  assert.deepEqual(
    checks.find(args => args.includes('scripts/inspect-release-artifacts.mjs')),
    ['exec:node', 'scripts/inspect-release-artifacts.mjs'],
  );
});

test('conflicting release gate modes are rejected', () => {
  assert.throws(
    () => resolveReleaseGateMode(['--artifact', '--local']),
    /exactly one release gate mode/,
  );
});

test('editor large-scene browser gate is mandatory in slow and full correctness modes', () => {
  const slowRunner = readFileSync(new URL('./run-slow-checks.mjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(slowRunner, /\['run', 'verify:editor-large-scene:built'\]/);
  assert.equal(
    packageJson.scripts['verify:editor-large-scene:built'],
    'node scripts/editor-e2e/largeScenePerformance.mjs --phase after',
  );
  const largeSceneVerifier = readFileSync(new URL('./editor-e2e/largeScenePerformance.mjs', import.meta.url), 'utf8');
  assert.match(largeSceneVerifier, /performanceBudgetRole/);
  assert.match(largeSceneVerifier, /diagnostic-only/);
  assert.match(largeSceneVerifier, /--enforce-performance/);
  for (const mode of ['local', 'global']) {
    const checks = createReleaseGateChecks(mode);
    assert.ok(checks.some(args => (
      args[0] === 'run'
      && args[1] === 'check:slow'
      && args.includes('--content-tier=full')
    )));
    assert.ok(!checks.some(args => args[1] === 'verify:editor-large-scene'));
  }
});

test('editor memory budgets cover 50k entities, long edits, and resource replacement in slow mode', () => {
  const slowRunner = readFileSync(new URL('./run-slow-checks.mjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const budget = JSON.parse(readFileSync(new URL('../config/editor-memory-budgets.json', import.meta.url), 'utf8'));
  assert.match(slowRunner, /\['run', 'verify:editor-memory'\]/);
  assert.match(packageJson.scripts['verify:editor-memory'], /verify-editor-memory-budgets\.mjs$/);
  assert.deepEqual(Object.keys(budget.scenarios), [
    'entities-50k',
    'long-edit',
    'resource-replacement',
  ]);
  assert.equal(budget.scenarios['entities-50k'].parameters.entityCount, 50_000);
  assert.equal(budget.scenarios['long-edit'].parameters.operationCount, 20_000);
  assert.equal(budget.scenarios['resource-replacement'].parameters.replacementCount, 10_000);
});

test('slow correctness runs CPU absolute budgets as diagnostics', () => {
  const slowRunner = readFileSync(new URL('./run-slow-checks.mjs', import.meta.url), 'utf8');
  assert.match(slowRunner, /\['run', 'benchmark'\]/);
  assert.doesNotMatch(slowRunner, /\['run', 'benchmark:enforce'\]/);
});

test('AO device performance uses smoke budgets on PR paths and full budgets on release paths', () => {
  const slowRunner = readFileSync(new URL('./run-slow-checks.mjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(slowRunner, /contentTier === 'full'[\s\S]*verify:ambient-occlusion:performance[\s\S]*verify:ambient-occlusion:performance:smoke/);
  assert.match(
    packageJson.scripts['verify:ambient-occlusion:performance'],
    /verify-ambient-occlusion-gpu-cost\.mjs$/,
  );
  assert.match(
    packageJson.scripts['verify:ambient-occlusion:performance:smoke'],
    /verify-ambient-occlusion-gpu-cost\.mjs --smoke$/,
  );
  for (const mode of ['local', 'global']) {
    assert.ok(createReleaseGateChecks(mode).some(args => (
      args[0] === 'run'
      && args[1] === 'check:slow'
      && args.at(-1) === '--content-tier=full'
    )));
  }
});

test('Shader Language Stage 14 uses one explicit DAG in slow and release paths', () => {
  const slowRunner = readFileSync(new URL('./run-slow-checks.mjs', import.meta.url), 'utf8');
  const dagRunner = readFileSync(new URL('./verify-shader-language-stage14-dag.mjs', import.meta.url), 'utf8');
  const browserDag = readFileSync(new URL('./shader-language-browser-dag.mjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['verify:shader-language-stage14'],
    'node scripts/verify-shader-language-stage14-dag.mjs',
  );
  assert.match(slowRunner, /\['run', 'verify:shader-language-stage14'\]/);
  assert.equal((dagRunner.match(/node\('build:shader-language'/g) ?? []).length, 1);
  assert.equal((dagRunner.match(/node\('build:engine'/g) ?? []).length, 1);
  assert.equal((dagRunner.match(/node\('build:extensions'/g) ?? []).length, 1);
  assert.equal((dagRunner.match(/node\('generate:production'/g) ?? []).length, 1);
  assert.doesNotMatch(dagRunner, /npm\('run', 'verify:shader-language-stage/);
  assert.match(dagRunner, /SHADER_LANGUAGE_BROWSER_DAG\.map/);
  assert.equal((browserDag.match(/browserCase\(/g) ?? []).length - 1, 13);
});

test('local and global candidates consume smoke plus full manifest content', () => {
  for (const mode of ['local', 'global']) {
    assert.ok(createReleaseGateChecks(mode).some(args => (
      args[0] === 'run'
      && args[1] === 'check:slow'
      && args.at(-1) === '--content-tier=full'
    )));
  }
  assert.ok(!createReleaseGateChecks('artifact').some(args => args[1] === 'check:slow'));
});

test('content tier CLI defaults to smoke and rejects ambiguous or unknown input', () => {
  assert.equal(resolveContentTier([]), 'smoke');
  assert.equal(resolveContentTier(['--content-tier=full']), 'full');
  assert.equal(resolveContentTier(['--content-tier', 'smoke']), 'smoke');
  assert.throws(() => resolveContentTier(['--content-tier=manual']), /expected smoke or full/);
  assert.throws(() => resolveContentTier(['--content-tier=full', '--content-tier=smoke']), /exactly once/);
  assert.throws(() => resolveContentTier(['--typo=full']), /Unknown check:slow argument/);
});

test('real manifests produce 50 smoke targets and 61 smoke-plus-full targets', () => {
  const smoke = createContentTargetPlan('smoke', manifests);
  const full = createContentTargetPlan('full', manifests);
  assert.equal(smoke.targets.length, 50);
  assert.deepEqual(smoke.selectedCounts, { smoke: 50, full: 0, manual: 0 });
  assert.equal(full.targets.length, 61);
  assert.deepEqual(full.selectedCounts, { smoke: 50, full: 11, manual: 0 });
  assert.equal(full.manifestCounts.manual, 47);

  const expectedSmoke = manifestTargets(entry => entry.ci === 'smoke');
  const expectedFull = manifestTargets(entry => entry.ci === 'smoke' || entry.ci === 'full');
  assert.deepEqual(smoke.targets, expectedSmoke);
  assert.deepEqual(full.targets, expectedFull);
  const manual = new Set(manifestTargets(entry => entry.ci === 'manual'));
  assert.ok(full.targets.every(target => !manual.has(target)));
});

test('a newly added full entry is consumed without a second static target list', () => {
  const fixture = [{
    kind: 'examples',
    prefix: 'example',
    manifest: { kind: 'examples', entries: [
      { id: 'existing', ci: 'smoke' },
      { id: 'new-capability', ci: 'full' },
      { id: 'operator-only', ci: 'manual' },
    ] },
  }];
  assert.deepEqual(createContentTargetPlan('smoke', fixture).targets, ['example:existing']);
  assert.deepEqual(
    createContentTargetPlan('full', fixture).targets,
    ['example:existing', 'example:new-capability'],
  );
});

test('CI routes pull requests and main pushes to smoke, and scheduled runs to full', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-slow.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  assert.match(workflow, /content_tier:[\s\S]*options:[\s\S]*- smoke[\s\S]*- full/);
  assert.match(workflow, /github\.event_name == 'schedule' && 'full'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.content_tier \|\| 'smoke'/);
  assert.match(workflow, /npm run check:slow -- --content-tier="\$\{CONTENT_TIER\}"/);
});

function manifestTargets(predicate) {
  return manifests.flatMap(({ manifest, prefix }) => manifest.entries
    .filter(predicate)
    .map(entry => `${prefix}:${entry.id}`));
}
