import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Render3DSystem } from '../dist/experimental.js';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function fixture(t) {
  const system = new Render3DSystem({ device: createAuditGpuDevice(), width: 64, height: 64, msaaSamples: 1 }, new Entity('camera'), { registerDefaultMaterialRenderers: false });
  t.after(() => system.destroy());
  return system._frameCoordinator;
}

test('frame resources order producers before consumers and expose concrete lifetimes', t => {
  const plan = fixture(t).viewPlan, calls = [];
  plan.importResources('previous').exportResources('display');
  plan.add('output', 'postprocess', () => calls.push('output'), { reads: ['color', 'normal'], writes: ['display'] });
  plan.add('normal', 'render', () => calls.push('normal'), { reads: ['materials'], writes: ['normal'] });
  plan.add('scene', 'render', () => calls.push('scene'), { reads: ['previous'], writes: ['color', 'materials'] });
  plan.execute();
  assert.deepEqual(calls, ['scene', 'normal', 'output']);
  assert.deepEqual(plan.snapshot[2].dependsOn, ['scene', 'normal']);
  assert.equal(plan.stats.dependencyCount, 3);
  assert.deepEqual(plan.resourceLifetimes.filter(r => r.name === 'color').map(r => [r.firstUse, r.lastUse]), [[0, 2]]);
  assert.equal(plan.resourceLifetimes.find(r => r.name === 'previous').transient, false);
  assert.equal(plan.resourceLifetimes.find(r => r.name === 'display').transient, false);
});

for (const [name, configure, message] of [
  ['missing producer', p => p.add('reader', 'render', () => {}, { reads: ['missing'] }), /without a producer or import/],
  ['two writers', p => p.add('a', 'render', () => {}, { writes: ['x'] }).add('b', 'render', () => {}, { writes: ['x'] }), /more than one writer/],
  ['unversioned mutation', p => p.importResources('x').add('a', 'render', () => {}, { writes: ['x'] }), /overwrites imported resource/],
  ['read-write alias', p => p.add('a', 'render', () => {}, { reads: ['x'], writes: ['x'] }), /same resource version/],
  ['dependency cycle', p => p.add('a', 'render', () => {}, { reads: ['y'], writes: ['x'] }).add('b', 'render', () => {}, { reads: ['x'], writes: ['y'] }), /dependency cycle/],
  ['unknown dependency', p => p.add('a', 'render', () => {}, { after: ['absent'] }), /missing pass/],
  ['duplicate name', p => p.add('a', 'render', () => {}).add('a', 'render', () => {}), /Duplicate pass/],
  ['missing export producer', p => p.exportResources('absent'), /has no producer/],
]) test(`frame resources reject ${name} before any action runs`, t => {
  const plan = fixture(t).viewPlan;
  let executed = false;
  plan.add('prepare', 'prepare', () => { executed = true; });
  configure(plan);
  assert.throws(() => plan.execute(), message);
  assert.equal(executed, false);
});

test('clear drops earlier view imports, writers and dependencies', t => {
  const plan = fixture(t).viewPlan;
  plan.importResources('other-view').add('a', 'render', () => {}, { reads: ['other-view'], writes: ['old-color'] }).execute();
  plan.clear().add('a', 'render', () => {}, { reads: ['old-color'] });
  assert.throws(() => plan.execute(), /without a producer/);
  plan.clear().add('fresh', 'render', () => {}, { writes: ['color'] }).execute();
  assert.deepEqual(plan.snapshot.map(p => p.name), ['fresh']);
  assert.deepEqual(plan.snapshot[0].dependsOn, []);
  assert.equal(plan.stats.resourceCount, 1);
});

test('view plan wires demanded auxiliary and history resources and omits unused auxiliary work', t => {
  const coordinator = fixture(t), calls = [];
  for (const key of Object.keys(coordinator._actions)) coordinator._actions[key] = () => calls.push(key);
  const execute = requirements => coordinator.executeView({}, {}, {}, 1, {}, [], requirements, { key: 'view' }, {}, new Float32Array(16), {}, new Float32Array(3), 0, 64, 64, 1);
  execute({ needsDepth: true, needsNormal: true, needsMotion: true, needsOutlineMask: true });
  const auxiliary = coordinator.snapshot.find(p => p.name === 'render-auxiliary-buffers');
  const post = coordinator.snapshot.at(-1);
  assert.ok(auxiliary.reads.includes('scene-depth'));
  assert.ok(auxiliary.reads.includes('prepared-materials'));
  for (const name of ['linear-depth', 'view-normal', 'motion', 'outline-mask', 'outline-visible-mask']) {
    assert.ok(auxiliary.writes.includes(name));
    assert.ok(post.reads.includes(name));
  }
  assert.ok(post.dependsOn.includes(auxiliary.name));
  const auxiliaryName = auxiliary.name;
  assert.deepEqual(calls.slice(-3), ['renderScene', 'renderAuxiliary', 'renderPostScene']);
  execute({});
  assert.ok(!coordinator.snapshot.some(p => p.name === auxiliaryName));
  assert.deepEqual(coordinator.snapshot.at(-1).reads, ['scene-linear-color', 'view-output:previous']);
});
