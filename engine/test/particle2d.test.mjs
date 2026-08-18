import assert from 'node:assert/strict';
import test from 'node:test';
import { ParticleEmitter2D } from '../dist/components.js';
import { Entity, World } from '../dist/index.js';
import { Particle2DSystem } from '../dist/systems.js';

function snapshot(emitter) {
  return Array.from(emitter.instanceData.subarray(0, emitter.activeParticles * 8));
}

test('ParticleEmitter2D uses deterministic fixed-capacity SoA simulation', () => {
  const options = {
    maxParticles: 16,
    emissionRate: 10,
    burst: 3,
    seed: 42,
    lifetime: [1, 2],
    speed: [5, 10],
    angle: [-1, 1],
    startSize: [2, 4],
    endSize: [0, 1],
    shape: 'box',
    shapeSize: [20, 10],
  };
  const first = new ParticleEmitter2D(options).advance(0.5);
  const second = new ParticleEmitter2D(options).advance(0.5);
  assert.equal(first.activeParticles, 8);
  assert.deepEqual(snapshot(first), snapshot(second));
  assert.ok(snapshot(first).every(Number.isFinite));

  first.emit(16);
  assert.equal(first.activeParticles, first.maxParticles);
});

test('ParticleEmitter2D seek rebuilds the same state and dead slots are reused', () => {
  const options = {
    maxParticles: 32,
    emissionRate: 12,
    burst: 2,
    seed: 9,
    lifetime: 0.2,
    speed: 4,
    angle: 0.25,
    gravity: [0, -2],
    startSize: 3,
    endSize: 1,
  };
  const stepped = new ParticleEmitter2D(options);
  for (let index = 0; index < 30; index++) stepped.advance(1 / 60);
  const sought = new ParticleEmitter2D(options).seek(0.5);
  assert.equal(sought.activeParticles, stepped.activeParticles);
  assert.deepEqual(snapshot(sought), snapshot(stepped));

  sought.emitting = false;
  sought.advance(1);
  assert.equal(sought.activeParticles, 0);
  sought.emit(4);
  assert.equal(sought.activeParticles, 4);
});

test('Particle2DSystem clamps suspended-tab delta and skips disabled hierarchies', () => {
  const world = new World('particles');
  const active = new ParticleEmitter2D({ maxParticles: 8, emissionRate: 10, lifetime: 10 });
  const disabled = new ParticleEmitter2D({ maxParticles: 8, emissionRate: 10, lifetime: 10 });
  const activeEntity = new Entity('active').addComponent(active);
  const disabledEntity = new Entity('disabled').addComponent(disabled);
  disabledEntity.disabled = true;
  world.addEntity(activeEntity);
  world.addEntity(disabledEntity);
  world.addSystem(new Particle2DSystem({ maxDeltaSeconds: 0.1 }));

  world.update(0, 1000);
  assert.equal(active.simulationTime, 0.1);
  assert.equal(active.activeParticles, 1);
  assert.equal(disabled.simulationTime, 0);
});

test('ParticleEmitter2D rejects unsafe capacities and ranges', () => {
  assert.throws(() => new ParticleEmitter2D({ maxParticles: 0 }), /maxParticles/);
  assert.throws(() => new ParticleEmitter2D({ lifetime: [1, 0] }), /lifetime range/);
  assert.throws(() => new ParticleEmitter2D({ startColor: [1, 1, 1, 2] }), /startColor/);
  assert.throws(() => new ParticleEmitter2D().seek(-1), /seek seconds/);
});
