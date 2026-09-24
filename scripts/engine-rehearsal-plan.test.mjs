import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngineRehearsalPlan, validateEngineRehearsalManifest, ENGINE_FOUNDATIONS } from './engine-rehearsal-plan.mjs';
import { validateEngineRehearsalExecution } from './release-rehearsal-policy.mjs';
import { stageEngineExamples } from './engine-release-catalog.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'review/api/release-manifest.json')));
function put(root, path, value = 'fixture') { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value)); }
function fixture(run) {
  const dir = mkdtempSync(resolve(tmpdir(), 'engine-rehearsal-plan-'));
  try {
    put(dir, 'review/api/release-manifest.json', manifest);
    const entries = ['smoke', 'full', 'manual'].map(ci => ({ id: ci, entry: `${ci}/index.html`, ci, assets: [] }));
    put(dir, 'examples/manifest.json', { kind: 'examples', entries });
    return run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('isolated Engine plan selects four foundations, five artifacts and full without manual targets', () => fixture(dir => {
  const plan = createEngineRehearsalPlan(dir);
  assert.deepEqual(ENGINE_FOUNDATIONS, ['shader-language', 'engine', 'animation-spec', 'extensions']);
  assert.equal(plan.artifactIds.length, 5);
  assert.deepEqual(plan.content.targets, ['example:smoke', 'example:full']);
  assert.doesNotMatch(JSON.stringify(plan.commands), /check:fast|build:games|inspect-release-artifacts|build:editor/);
  assert.equal(plan.commands.at(-1).environment.EXAMPLE_FILTER, 'smoke,full');
  assert.equal(plan.commands.at(-1).environment.EXAMPLE_SKIP_SOURCE_VIEWER, '0');
  assert.ok(plan.commands.some(step => step.args.includes('--release')));
  assert.ok(plan.commands.some(step => step.args.includes('scripts/check-engine-entry-budget.mjs')));
}));
test('manifest rejects missing, duplicate, mismatched and Studio artifacts', () => {
  for (const transform of [m => m.artifacts.pop(), m => m.artifacts.push(m.artifacts[0]),
    m => m.artifacts[0].workspace = '../UI', m => m.artifacts[0].packageName = '@haiyue/ui',
    m => m.artifacts[0].version = '0.1.0']) {
    const bad = structuredClone(manifest); transform(bad); assert.throws(() => validateEngineRehearsalManifest(bad));
  }
});
test('plan CLI runs from a checkout with no dependencies, products or evidence and has no side effects', () => fixture(dir => {
  for (const name of ['release-rehearsal.mjs', 'release-rehearsal-policy.mjs', 'release-supply-chain-policy.mjs', 'release-archive.mjs', 'release-temp-path.mjs', 'release-path-policy.mjs', 'release-duration-policy.mjs', 'npm-process.mjs', 'engine-rehearsal-plan.mjs', 'engine-release-catalog.mjs', 'content-gate-policy.mjs']) {
    mkdirSync(resolve(dir, 'scripts'), { recursive: true }); cpSync(resolve(root, 'scripts', name), resolve(dir, 'scripts', name));
  }
  const result = spawnSync(process.execPath, ['scripts/release-rehearsal.mjs', '--plan'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).scope, 'engine');
  assert.equal(existsSync(resolve(dir, 'artifacts')), false);
}));
test('catalog archives selected examples and runtime assets, rejecting missing builds and manual selection', () => fixture(dir => {
  for (const path of ['examples/index.html', 'examples/catalog.js', 'examples/source-viewer/bundle.js', 'examples/shared/engine.js',
    'examples/smoke/index.html', 'examples/smoke/bundle.js', 'examples/full/index.html', 'examples/full/bundle.js',
    'engine/dist/geometry.js', 'extensions/dist/gltf-worker-runtime.js', 'extensions/test/fixtures/gltf/scene.gltf',
    'scripts/webgpu-gate/assets/gltf-corpus/medium-rigged-figure-draco/scene.gltf',
    'node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js', 'node_modules/draco3dgltf/draco_decoder_gltf.wasm',
    'animation-spec/samples/sample.hya', 'animation-spec/viewer/index.html']) put(dir, path);
  const targets = ['example:smoke', 'example:full'];
  const destination = resolve(dir, 'artifacts/catalog');
  stageEngineExamples(dir, destination, targets);
  assert.deepEqual(JSON.parse(readFileSync(resolve(destination, 'examples/manifest.json'))).entries.map(e => e.ci), ['smoke', 'full']);
  assert.equal(existsSync(resolve(destination, 'examples/manual')), false);
  assert.equal(existsSync(resolve(destination, 'engine/dist/geometry.js')), true);
  assert.equal(existsSync(resolve(destination, 'animation-spec/index.html')), true);
  assert.throws(() => stageEngineExamples(dir, destination, [...targets, 'example:manual']), /full Engine manifest/);
  rmSync(resolve(dir, 'examples/full/bundle.js'));
  assert.throws(() => stageEngineExamples(dir, resolve(dir, 'artifacts/missing'), targets), /missing built/);
}));

test('rehearsal rejects Studio commands, omitted targets, skipped source viewer and changed command order', () => fixture(dir => {
  const plan = createEngineRehearsalPlan(dir);
  const report = { contentTargets: plan.content.targets, commands: plan.commands.map(step => ({
    label: step.label, command: [step.executable, ...step.args], ...(step.environment ? { environment: step.environment } : {}),
  })) };
  assert.deepEqual(validateEngineRehearsalExecution(report, plan), []);
  for (const change of [r => r.contentTargets.pop(), r => r.commands[2].command = ['npm', 'run', 'check:fast'],
    r => r.commands.at(-1).environment.EXAMPLE_SKIP_SOURCE_VIEWER = '1', r => r.commands.reverse(),
    r => r.commands.push({ label: 'Studio', command: ['npm', 'run', 'build:games'] })]) {
    const bad = structuredClone(report); change(bad); assert.ok(validateEngineRehearsalExecution(bad, plan).length);
  }
}));
