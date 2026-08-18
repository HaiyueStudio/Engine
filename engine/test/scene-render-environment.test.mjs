import test from 'node:test';
import assert from 'node:assert/strict';
import { Fog, PointLight } from '../dist/lighting.js';
import {
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  World,
} from '../dist/index.js';
import { getSceneRenderEnvironment } from '../dist/experimental.js';

test('scene render environment consumes component indexes once per frame and selects the first enabled Fog', () => {
  const world = new World('Environment');
  const disabledRoot = new Entity('Disabled root');
  disabledRoot.disabled = true;
  disabledRoot.addChild(new Entity('Disabled fog').addComponent(new Fog({ distanceStart: 1 })));
  world.add(disabledRoot);

  const fog = new Fog({ distanceStart: 5 });
  world.add(new Entity('Fog').addComponent(fog));
  const secondFog = new Fog({ distanceStart: 12 });
  world.add(new Entity('Second fog').addComponent(secondFog));
  const environmentLight = new EnvironmentLight({ intensity: 1.5 });
  world.add(new Entity('Environment light').addComponent(environmentLight));

  const point = new PointLight({ range: 24 });
  const pointEntity = new Entity('Point')
    .addComponent(new CartesianTransform3D({ position: [3, 4, 5] }))
    .addComponent(point);
  world.add(pointEntity);
  const shadowLight = new DirectionalLight({ direction: [1, -2, 0], castShadow: true });
  world.add(new Entity('Sun').addComponent(shadowLight));

  let indexReads = 0;
  const iterQueryCandidates = world.iterQueryCandidates.bind(world);
  world.iterQueryCandidates = query => {
    indexReads++;
    return iterQueryCandidates(query);
  };

  world.frameData.begin(world, null, 1, 0.016);
  const entityValues = world.entities.values;
  world.entities.values = () => { throw new Error('environment must not scan World.entities'); };
  let first;
  let shared;
  try {
    first = getSceneRenderEnvironment(world.frameData, world);
    shared = getSceneRenderEnvironment(world.frameData, world);
  } finally {
    world.entities.values = entityValues;
  }

  assert.equal(shared, first);
  assert.equal(indexReads, 3);
  assert.equal(first.fog, fog);
  assert.equal(first.environmentLight, environmentLight);
  assert.equal(first.shadowLight, shadowLight);
  const firstLightingRevision = first.lightingRevision;
  assert.deepEqual(first.pbrLights.map(light => light.type), [1, 2]);
  assert.deepEqual(first.pbrLights[1].position, [3, 4, 5]);

  fog.disabled = true;
  assert.equal(getSceneRenderEnvironment(world.frameData, world).fog, fog);
  assert.equal(indexReads, 3);

  world.frameData.advancePhase();
  const next = getSceneRenderEnvironment(world.frameData, world);
  assert.notEqual(next, first);
  assert.equal(next.frameId, first.frameId, 'environment invalidation must not create a logical frame');
  assert.notEqual(next.phaseRevision, first.phaseRevision);
  assert.equal(next.lightingRevision, firstLightingRevision, 'Fog-only changes do not invalidate PBR scene lighting');
  assert.equal(next.fog, secondFog);
  assert.equal(indexReads, 6);

  point.intensity = 3;
  world.frameData.advancePhase();
  const changedLight = getSceneRenderEnvironment(world.frameData, world);
  assert.notEqual(changedLight.lightingRevision, next.lightingRevision);

  pointEntity.getComponent(CartesianTransform3D).setPosition(4, 4, 5);
  world.frameData.advancePhase();
  const movedPoint = getSceneRenderEnvironment(world.frameData, world);
  assert.notEqual(movedPoint.lightingRevision, changedLight.lightingRevision);

  environmentLight.intensity = 2;
  world.frameData.advancePhase();
  const changedEnvironment = getSceneRenderEnvironment(world.frameData, world);
  assert.notEqual(changedEnvironment.lightingRevision, movedPoint.lightingRevision);

  environmentLight.rotation = Math.PI / 2;
  world.frameData.advancePhase();
  const rotatedEnvironment = getSceneRenderEnvironment(world.frameData, world);
  assert.notEqual(rotatedEnvironment.lightingRevision, changedEnvironment.lightingRevision);
});

test('scene render environment applies one disabled and light-limit rule to all renderers', () => {
  const world = new World('Light limit');
  const disabled = new Entity('Disabled light').addComponent(new PointLight({ intensity: 100 }));
  disabled.disabled = true;
  world.add(disabled);

  const shadowLight = new DirectionalLight({ castShadow: true });
  world.add(new Entity('Shadow light').addComponent(shadowLight));
  for (let i = 0; i < 12; i++) world.add(new Entity(`Point ${i}`).addComponent(new PointLight({ intensity: i + 1 })));

  world.frameData.begin(world, null, 1, 0.016);
  const snapshot = getSceneRenderEnvironment(world.frameData, world);

  assert.equal(snapshot.pbrLights.length, 8);
  assert.equal(snapshot.pbrLights[0].type, 1);
  assert.equal(snapshot.pbrLights.some(light => light.intensity === 100), false);
});

test('scene render environment prioritizes three shadow-casting directional lights in matching PBR slots', () => {
  const world = new World('Multi shadow lights');
  const lights = [
    new DirectionalLight({ direction: [-1, -1, 0], castShadow: true }),
    new DirectionalLight({ direction: [1, -1, 0], castShadow: true }),
    new DirectionalLight({ direction: [0, -1, -1], castShadow: true }),
    new DirectionalLight({ direction: [0, -1, 1], castShadow: true }),
  ];
  for (let index = 0; index < lights.length; index++) {
    world.add(new Entity(`Shadow light ${index}`).addComponent(lights[index]));
  }

  world.frameData.begin(world, null, 1, 0.016);
  const snapshot = getSceneRenderEnvironment(world.frameData, world);

  assert.deepEqual(snapshot.shadowLights, lights.slice(0, 3));
  assert.equal(snapshot.shadowLight, lights[0]);
  assert.deepEqual(
    snapshot.pbrLights.slice(0, 4).map(light => light.direction),
    lights.map(light => light.direction),
    'the fourth directional light remains lit but is outside the shadow capacity',
  );
});
