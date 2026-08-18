import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineErrorCode, EventEmitter } from '../dist/experimental.js';

test('EventEmitter orders listeners by priority and removes once listeners without wrappers', () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on('tick', () => calls.push('low'), { priority: -1 });
  emitter.once('tick', () => calls.push('once'), { priority: 5 });
  emitter.on('tick', () => calls.push('normal'));

  emitter.emit('tick');
  emitter.emit('tick');

  assert.deepEqual(calls, ['once', 'normal', 'low', 'normal', 'low']);
  assert.equal(emitter.listenerCount('tick'), 2);
});

test('EventEmitter handles on/off during emit without calling newly added listeners in the same emit', () => {
  const emitter = new EventEmitter();
  const calls = [];
  const removed = () => calls.push('removed');
  const added = () => calls.push('added');
  const mutator = () => {
    calls.push('mutator');
    emitter.off('event', removed);
    emitter.on('event', added);
  };
  emitter.on('event', mutator);
  emitter.on('event', removed);

  emitter.emit('event');
  emitter.emit('event');

  assert.deepEqual(calls, ['mutator', 'mutator', 'added']);
});

test('EventEmitter emit supports capture, target, bubble, and stopPropagation', () => {
  const root = new EventEmitter();
  const child = new EventEmitter();
  const calls = [];
  root.on('select', event => calls.push(`root:${event.eventPhase}`), { capture: true });
  child.on('select', event => {
    calls.push(`child:${event.eventPhase}`);
    event.stopPropagation();
  });
  root.on('select', event => calls.push(`root:${event.eventPhase}`));

  const event = child.emit('select', { path: [root, child], bubbles: true, detail: 42 });

  assert.deepEqual(calls, ['root:capture', 'child:target']);
  assert.equal(event.detail, 42);
  assert.equal(event.stopped, true);
  assert.equal(event.eventPhase, 'none');
  assert.equal(event.currentTarget, null);
});

test('EventEmitter reports malformed capture and bubble paths as structured engine errors', () => {
  const root = new EventEmitter();
  const child = new EventEmitter();
  const malformedPath = [root, undefined, child];
  const assertPathError = (error, phase) => error.code === EngineErrorCode.EventPathInvalid
    && error.path === 'event.path[1]'
    && error.context.eventType === 'select'
    && error.context.phase === phase
    && error.context.index === 1
    && error.context.pathLength === 3;

  assert.throws(
    () => child.emit('select', { path: malformedPath }),
    error => assertPathError(error, 'capture'),
  );
  assert.throws(
    () => child.emit('select', { path: malformedPath, capture: false, bubbles: true }),
    error => assertPathError(error, 'bubble'),
  );
});
