import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileAnimationStateMachine,
  validateAnimationStateMachineDefinition,
} from '../dist-test/animation-state-machine/runtime/index.js';
import {
  createAnimation2DStateMachineController,
} from '../dist-test/animation/Animation2DStateMachine.js';

class Fake2DMixerPort {
  actions = [];

  createAction(clipId, options) {
    const action = {
      clipId,
      options,
      duration: clipId === 'idle' ? 2 : 1,
      playing: false,
      destroyed: false,
      weight: 0,
      time: 0,
      timeScale: 1,
    };
    this.actions.push(action);
    return action;
  }

  play(action) { action.playing = true; }
  stop(action) { action.playing = false; }
  fade() {}
  setWeight(action, weight) { action.weight = weight; }
  setTime(action, time) { action.time = time; }
  setTimeScale(action, timeScale) { action.timeScale = timeScale; }
  destroyAction(action) { action.destroyed = true; }
}

function sharedMachine() {
  return {
    format: 'haiyue-animation-state-machine@1',
    id: 'ui-button',
    name: 'UI Button',
    parameters: [
      { name: 'pressed', type: 'boolean', defaultValue: false },
    ],
    layers: [{
      id: 'base',
      name: 'Base',
      initialStateId: 'idle',
      mask: { include: ['root.transform', 'root.opacity'] },
      states: [
        {
          id: 'idle',
          name: 'Idle',
          motion: { kind: 'clip', clipId: 'idle' },
          loop: 'repeat',
        },
        {
          id: 'pressed',
          name: 'Pressed',
          motion: { kind: 'clip', clipId: 'pressed' },
          loop: 'once',
        },
      ],
      transitions: [{
        id: 'press',
        from: 'idle',
        to: 'pressed',
        conditions: [{
          parameter: 'pressed',
          operator: 'is-true',
        }],
        duration: 0.1,
      }],
    }],
  };
}

test('dimension-neutral compiler accepts the shared format', () => {
  const definition = sharedMachine();
  assert.deepEqual(validateAnimationStateMachineDefinition(definition), []);
  const compiled = compileAnimationStateMachine(definition);
  assert.equal(compiled.format, 'haiyue-animation-state-machine-compiled@1');
  assert.equal(compiled.layers[0].states[1].loop, 'once');
});

test('2D factory uses the shared controller and preserves mixer policy data', () => {
  const port = new Fake2DMixerPort();
  const controller = createAnimation2DStateMachineController(
    sharedMachine(),
    port,
  );
  assert.equal(port.actions.length, 1);
  assert.equal(port.actions[0].clipId, 'idle');
  assert.deepEqual(port.actions[0].options.mask, {
    include: ['root.transform', 'root.opacity'],
  });

  controller.setBoolean('pressed', true).update(0.05);
  assert.equal(controller.getLayerSnapshot('base').transitionId, 'press');
  assert.equal(port.actions.length, 2);
  assert.equal(port.actions[1].clipId, 'pressed');
  assert.equal(port.actions[1].options.loop, 'once');
  assert.equal(port.actions[0].weight, 0.5);
  assert.equal(port.actions[1].weight, 0.5);

  controller.update(0.05);
  assert.equal(controller.getLayerSnapshot('base').currentStateId, 'pressed');
  controller.destroy();
  assert.equal(port.actions.every(action => action.destroyed), true);
});
