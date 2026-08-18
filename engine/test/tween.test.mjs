import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Tween,
  TweenManager,
  TweenSystem,
  World,
  lerpFloat32Array,
} from '../dist/experimental.js';

test('Float32Array interpolation rejects mismatched input and output shapes', () => {
  assert.throws(
    () => lerpFloat32Array(new Float32Array(2), new Float32Array(3), 0.5),
    /different lengths/,
  );
  assert.throws(
    () => lerpFloat32Array(new Float32Array(2), new Float32Array(2), 0.5, new Float32Array(1)),
    /output length/,
  );
});

test('TweenManager applies global and per-group time scale', () => {
  const manager = new TweenManager();
  const target = { x: 0, y: 0 };
  manager.setTimeScale(0.5);
  manager.setGroupTimeScale('slow', 0.5);
  manager.create(target, { duration: 100, group: 'slow' }).to({ x: 100 });
  manager.create(target, { duration: 100 }).to({ y: 100 });

  manager.update(0, 100);

  assert.equal(target.x, 25);
  assert.equal(target.y, 50);
  assert.equal(manager.count, 2);
});

test('TweenManager can pause and resume groups independently', () => {
  const manager = new TweenManager();
  const target = { x: 0, y: 0 };
  manager.create(target, { duration: 100, group: 'paused' }).to({ x: 100 });
  manager.create(target, { duration: 100, group: 'active' }).to({ y: 100 });

  manager.pauseGroup('paused');
  manager.update(0, 50);
  assert.equal(target.x, 0);
  assert.equal(target.y, 50);

  manager.resumeGroup('paused');
  manager.update(50, 50);
  assert.equal(target.x, 50);
  assert.equal(target.y, 100);
});

test('TweenSequence runs tweens in order and removes itself when complete', () => {
  const manager = new TweenManager();
  const target = { x: 0, y: 0 };
  const sequence = manager.sequence();
  sequence.create(target, { duration: 100 }).to({ x: 10 });
  sequence.create(target, { duration: 100 }).to({ y: 20 });

  manager.update(0, 100);
  assert.equal(target.x, 10);
  assert.equal(target.y, 0);
  assert.equal(sequence.currentIndex, 1);
  assert.equal(manager.count, 1);

  manager.update(100, 50);
  assert.equal(target.x, 10);
  assert.equal(target.y, 10);
  assert.equal(manager.count, 1);

  manager.update(150, 50);
  assert.equal(target.y, 20);
  assert.equal(sequence.isCompleted, true);
  assert.equal(manager.count, 0);
});

test('TweenSystem updates a manager from World.update', () => {
  const world = new World('TweenSystemWorld');
  const manager = new TweenManager();
  const target = { value: 0 };
  manager.add(new Tween(target, { duration: 100, timeScale: 2 }).to({ value: 100 }));
  world.addSystem(new TweenSystem({ manager }));

  world.update(0, 25);

  assert.equal(target.value, 50);
  assert.equal(manager.count, 1);

  world.update(25, 25);

  assert.equal(target.value, 100);
  assert.equal(manager.count, 0);
});
