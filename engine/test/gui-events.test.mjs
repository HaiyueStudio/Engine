import assert from 'node:assert/strict';
import test from 'node:test';
import { GuiElement } from '../dist/experimental.js';

function pointerEvent(type, target) {
  const nativeEvent = {
    button: 0,
    buttons: 1,
    pointerId: 1,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  const event = {
    type,
    target,
    currentTarget: target,
    x: 16,
    y: 12,
    localX: 4,
    localY: 5,
    button: 0,
    buttons: 1,
    pointerId: 1,
    nativeEvent,
    stopped: false,
    defaultPrevented: false,
    stopPropagation() {
      this.stopped = true;
    },
    preventDefault() {
      this.defaultPrevented = true;
      nativeEvent.preventDefault();
    },
  };
  return event;
}

test('GuiElement emits enhanced pointer events with capture and bubble path', () => {
  const root = new GuiElement({ id: 'root' });
  const parent = root.add(new GuiElement({ id: 'parent' }));
  const child = parent.add(new GuiElement({
    id: 'child',
    onClick: event => {
      calls.push(`option:${event.target.id}`);
    },
  }));
  const calls = [];

  root.on('click', event => calls.push(`root:${event.eventPhase}:${event.currentTarget.id}`), { capture: true });
  parent.on('click', event => calls.push(`parent:${event.eventPhase}:${event.currentTarget.id}`));
  child.on('click', event => calls.push(`child:${event.eventPhase}:${event.currentTarget.id}`));

  child.handleClick(pointerEvent('click', child));

  assert.deepEqual(calls, [
    'option:child',
    'root:capture:root',
    'child:target:child',
    'parent:bubble:parent',
  ]);
});

test('GuiElement enhanced events bridge preventDefault and stopPropagation', () => {
  const root = new GuiElement({ id: 'root' });
  const child = root.add(new GuiElement({ id: 'child' }));
  const event = pointerEvent('pointerdown', child);
  let bubbled = false;

  child.on('pointerdown', engineEvent => {
    engineEvent.preventDefault();
    engineEvent.stopPropagation();
  });
  root.on('pointerdown', () => {
    bubbled = true;
  });

  child.handlePointerDown(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.nativeEvent.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.equal(bubbled, false);
});
