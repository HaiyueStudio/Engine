import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity, World, DirectionalLight } from '../dist/index.js';
import { PointLight } from '../dist/lighting.js';
import { Transform3D, Geometry3D, BlinnPhongMaterial, InstancedMesh3DRenderer, getSceneRenderEnvironment,
  BlinnPhongRenderer, disposeSceneFrameGpuArena } from '../dist/experimental.js';
import { InstancedPbrMaterial } from '../dist/material.js';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function view(x = 0) {
  const data = new Float32Array(68);
  data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, 0, 1]);
  data[48] = x;
  return { frameId: 1, phaseRevision: 1, cameraEntityId: x + 1, data };
}
function point(world, intensity, x = 0, range = 1) {
  const light = new PointLight({ intensity, range });
  const entity = new Entity().addComponent(new Transform3D().setTranslation(x, 0, .5)).addComponent(light);
  world.add(entity);
  return { light, entity };
}
function begin(world) { world.frameData.begin(world, null, 1, .016); }
function select(world, camera) { return getSceneRenderEnvironment(world.frameData, world, camera); }

test('view admission finds bright late lights, rejects irrelevant ranges, and keeps independent lists', () => {
  const world = new World(), a = view(), b = view(100);
  for (let i = 0; i < 8; i++) point(world, 1);
  point(world, 5);
  point(world, 10, 100);
  point(world, 999, 500);
  point(world, 0);
  point(world, 100, 0, 0);
  point(world, NaN);
  const disabled = point(world, 1000); disabled.entity.disabled = true;
  begin(world);
  const first = select(world, a), second = select(world, b);
  assert.equal(first.pbrLights.length, 8);
  assert.ok(first.pbrLights.some(light => light.intensity === 5));
  assert.ok(first.pbrLights.every(light => light.position[0] === 0));
  assert.deepEqual(second.pbrLights.map(light => light.intensity), [10]);
  assert.deepEqual(first.lightSelection, {
    candidateCount: 14, rejectedCount: 3, outsideViewCount: 2,
    eligibleCount: 9, selectedCount: 8, overflowCount: 1, replacementCount: 0,
  });
  assert.equal(select(world, a), first);
  assert.equal(first.pbrLights.at(-1).intensity, 5, 'another view does not mutate this view');
});

test('point influence intersects the frustum even when its center is outside, and distance alone does not decide rank', () => {
  const world = new World();
  for (let i = 0; i < 8; i++) point(world, .01);
  point(world, 20, 2, 1.2); // Center is offscreen but its light reaches visible surfaces.
  point(world, 1000, 50, 1); // No influence on this view despite its brightness.
  begin(world);
  const result = select(world, view());
  assert.ok(result.pbrLights.some(light => light.intensity === 20));
  assert.ok(result.pbrLights.every(light => light.intensity !== 1000));
  assert.equal(result.lightSelection.overflowCount, 1);
});

test('hysteresis suppresses near-equal switches, admits a clear winner, and ignores offscreen edits in lighting revisions', () => {
  const world = new World(), camera = view();
  for (let i = 0; i < 8; i++) point(world, 1);
  const challenger = point(world, 1), outside = point(world, 30, 100);
  begin(world);
  let result = select(world, camera), revision = result.lightingRevision;
  challenger.light.intensity = 1.05;
  world.frameData.advancePhase();
  result = select(world, camera);
  assert.equal(result.lightingRevision, revision);
  assert.equal(result.lightSelection.replacementCount, 0);
  challenger.light.intensity = 1.2;
  world.frameData.advancePhase();
  result = select(world, camera);
  assert.ok(result.pbrLights.some(light => light.intensity === 1.2));
  assert.equal(result.lightSelection.replacementCount, 1);
  assert.notEqual(result.lightingRevision, revision);
  revision = result.lightingRevision;
  outside.light.intensity = 99;
  world.frameData.advancePhase();
  assert.equal(select(world, camera).lightingRevision, revision);
});

test('shadow budget selects useful directionals and reserves the same layer indices in every view', () => {
  const world = new World();
  const suns = [1, .1, 5, 2, 0].map(intensity => {
    const light = new DirectionalLight({ intensity, castShadow: true });
    world.add(new Entity().addComponent(light));
    return light;
  });
  point(world, 100); point(world, 100, 100);
  begin(world);
  for (const camera of [view(), view(100)]) {
    const result = select(world, camera);
    assert.deepEqual(result.shadowLights, [suns[0], suns[2], suns[3]]);
    assert.deepEqual(result.pbrLights.slice(0, 3).map(light => light.intensity), [1, 5, 2]);
    assert.equal(result.pbrLights.filter(light => light.type === 1).length, 4);
  }
});

test('entity query order does not override importance or stable equal-score ties', () => {
  const world = new World();
  for (let i = 0; i < 9; i++) point(world, i === 8 ? 10 : 1, i * .001);
  const query = world.iterQueryCandidates.bind(world);
  world.iterQueryCandidates = input => [...query(input)].reverse();
  begin(world);
  assert.deepEqual(select(world, view()).pbrLights.map(light => light.position[0]),
    [0, .001, .002, .003, .004, .005, .006, .008].map(Math.fround));
});

test('light GPU records isolate views and same-submit mutations; growth and removed views retire safely', async t => {
  const writes = [], submitted = [];
  const device = createAuditGpuDevice({ behaviors: { 'queue.writeBuffer': ({ args, defaultImplementation }) => {
    if (args[0].label === 'BlinnPhongRenderer.lights') writes.push({ buffer: args[0], offset: args[1], data: Array.from(new Float32Array(args[2], args[3], args[4] / 4)) });
    return defaultImplementation();
  } } });
  const renderer = new BlinnPhongRenderer(); renderer.prepare({ device });
  t.after(() => { renderer.destroy(); disposeSceneFrameGpuArena(device); });
  const lights = intensity => [{ type: 0, color: [1, 1, 1], intensity, direction: [0, -1, 0], position: [0, 0, 0], range: 1 }];
  const context = () => ({ device, encoder: device.createCommandEncoder(), afterSubmit: callback => submitted.push(callback) });
  const a = view(), b = view(100), firstContext = context();
  renderer.updateCamera(a, firstContext); renderer.updateLights(lights(1));
  const firstOffset = renderer._lightUniforms.dynamicOffset[0];
  renderer.updateCamera(b, firstContext); renderer.updateLights(lights(2));
  assert.notEqual(renderer._lightUniforms.dynamicOffset[0], firstOffset);
  renderer.updateCamera(a, firstContext); renderer.updateLights(lights(3));
  assert.notEqual(renderer._lightUniforms.dynamicOffset[0], firstOffset, 'same encoder cannot overwrite an already referenced record');
  assert.deepEqual(writes.map(write => write.data[11]), [1, 2, 3]);
  const oldBuffer = renderer._lightUniforms.buffer;
  for (let i = 0; i < 36; i++) {
    renderer.updateCamera(view(i + 200), firstContext); renderer.updateLights(lights(i + 4));
  }
  assert.notEqual(renderer._lightUniforms.buffer, oldBuffer);
  assert.equal(oldBuffer.destroyed, false, 'growth retains the encoded generation until submission completes');
  for (const callback of submitted.splice(0)) callback(device.queue);
  await device.queue.onSubmittedWorkDone();
  assert.equal(oldBuffer.destroyed, true);
  for (let i = 0; i < 123; i++) {
    renderer.updateCamera(a, context()); renderer.updateLights(lights(1));
  }
  assert.equal(renderer._lightUniforms.viewCount, 1);
  const writeCount = writes.length;
  renderer.updateCamera(a, context()); renderer.updateLights(lights(1));
  assert.equal(writes.length, writeCount, 'unchanged light bytes are not uploaded again');
  for (const callback of submitted.splice(0)) callback(device.queue);
  await device.queue.onSubmittedWorkDone();
});

test('low-level renderers preserve lights set once before subsequent camera updates', t => {
  const device = createAuditGpuDevice();
  const engine = { device, format: 'bgra8unorm', getDepthFormat: () => 'depth24plus' };
  const blinn = new BlinnPhongRenderer(), instanced = new InstancedMesh3DRenderer();
  blinn.prepare(engine); instanced.prepare(engine);
  t.after(() => { blinn.destroy(); instanced.destroy(); disposeSceneFrameGpuArena(device); });
  const lights = [{ type: 0, color: [1, 1, 1], intensity: .5, direction: [0, -1, 0], position: [0, 0, 0], range: 1 }];
  blinn.updateLights(lights); instanced.updateLighting(lights, null, 1);
  const geometry = new Geometry3D({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) });
  const blinnMaterial = new BlinnPhongMaterial(), instancedMaterial = new InstancedPbrMaterial(1);
  for (const camera of [view(), view(100)]) {
    const context = { device, encoder: device.createCommandEncoder() };
    blinn.updateCamera(camera, context); instanced.updateCamera(camera, context);
    const pass = context.encoder.beginRenderPass({ colorAttachments: [] });
    blinn.render(pass, 1, geometry, blinnMaterial, instancedMaterial.transforms);
    instanced.render(pass, 2, geometry, instancedMaterial);
    for (const renderer of [blinn, instanced]) {
      assert.equal(renderer._lightUniforms._slot.data[11], .5);
      assert.notEqual(renderer._lightUniforms.dynamicOffset[0], 0, 'the selected camera reads a view record');
    }
    pass.end();
  }
});
