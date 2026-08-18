import assert from 'node:assert/strict';
import test from 'node:test';
import { ParticleEmitter3D } from '../dist/components.js';
import { Entity, World } from '../dist/index.js';
import { Particle3DSystem } from '../dist/systems.js';

const activeData = emitter => Array.from(emitter.instanceData.subarray(0, emitter.activeParticles * 12));

test('ParticleEmitter3D is deterministic, fixed-capacity, and produces finite billboard data', () => {
  const options = {
    maxParticles: 32,
    emissionRate: 80,
    seed: 91,
    lifetime: [0.5, 1.5],
    speed: [1, 4],
    direction: [0, 1, 0],
    spread: 0.4,
    gravity: [0, -2, 0],
    shape: 'sphere',
    shapeRadius: 0.5,
  };
  const first = new ParticleEmitter3D(options).advance(0.5);
  const second = new ParticleEmitter3D(options).advance(0.5);
  assert.equal(first.activeParticles, 32);
  assert.deepEqual(activeData(first), activeData(second));
  assert.ok(activeData(first).every(Number.isFinite));
  first.emit(32);
  assert.equal(first.activeParticles, 32);
});

test('ParticleEmitter3D seek matches fixed stepping and reuses expired slots', () => {
  const options = {
    maxParticles: 64,
    emissionRate: 30,
    burst: 5,
    seed: 7,
    lifetime: 2,
    speed: [0.5, 1.5],
    angularVelocity: [-1, 1],
  };
  const stepped = new ParticleEmitter3D(options);
  for (let index = 0; index < 30; index++) stepped.advance(1 / 60);
  const sought = new ParticleEmitter3D(options).seek(0.5);
  assert.equal(sought.activeParticles, stepped.activeParticles);
  const expected = activeData(stepped);
  const actual = activeData(sought);
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) assert.ok(Math.abs(actual[index] - expected[index]) < 1e-5);

  const reusable = new ParticleEmitter3D({ maxParticles: 4, emissionRate: 0, lifetime: 0.05 });
  reusable.emit(4).advance(0.1).emit(4);
  assert.equal(reusable.activeParticles, 4);
});

test('Particle3DSystem advances active entities and clamps suspended-tab deltas', () => {
  const world = new World();
  const active = new ParticleEmitter3D({ maxParticles: 8, emissionRate: 10, lifetime: 10 });
  const disabled = new ParticleEmitter3D({ maxParticles: 8, emissionRate: 10, lifetime: 10 });
  const activeEntity = new Entity('active').addComponent(active);
  const disabledEntity = new Entity('disabled').addComponent(disabled);
  disabledEntity.disabled = true;
  world.addEntity(activeEntity).addEntity(disabledEntity);
  const system = new Particle3DSystem({ maxDeltaSeconds: 0.1 });
  world.addSystem(system);
  system.update(world, 0, 1000);
  assert.equal(active.simulationTime, 0.1);
  assert.equal(active.activeParticles, 1);
  assert.equal(disabled.simulationTime, 0);
});

test('ParticleEmitter3D validates unsafe spatial and sorting options', () => {
  assert.throws(() => new ParticleEmitter3D({ maxParticles: 0 }), /maxParticles/);
  assert.throws(() => new ParticleEmitter3D({ direction: [0, 0, 0] }), /direction/);
  assert.throws(() => new ParticleEmitter3D({ spread: Math.PI + 0.01 }), /spread/);
  assert.throws(() => new ParticleEmitter3D({ sortMode: 'front-to-back' }), /sortMode/);
  assert.throws(() => new ParticleEmitter3D().seek(-1), /seek seconds/);
});
