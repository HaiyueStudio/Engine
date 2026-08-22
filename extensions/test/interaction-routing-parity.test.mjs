import assert from 'node:assert/strict';
import test from 'node:test';
import { dataBindingFixture, interactionFixture, loadG07Modules } from './data-binding-parity-fixture.mjs';

const { data, interaction, runtime } = await loadG07Modules();
const dataDocument = data.parseHyaDataBinding(dataBindingFixture()), interactionDocument = interaction.parseHyaInteraction(interactionFixture());

test('transformed and clipped hit areas route capture target bubble with stable local coordinates', () => {
  const dataRuntime = new runtime.DataBindingRuntime(dataDocument), harness = createHarness(dataRuntime), input = new runtime.InteractionRuntime(interactionDocument, { actionPort: harness.port, geometryPort: geometryPort() }); harness.attach(input);
  assert.equal(input.hitTest([38, 15]), 'button'); assert.equal(input.hitTest([45, 15]), 'root', 'button is rejected outside its clip'); assert.equal(input.hitTest([150, 150]), 'custom-hit');
  input.dispatchPointer({ kind: 'move', pointerId: 1, point: [38, 15] }); input.dispatchPointer({ kind: 'down', pointerId: 1, point: [38, 15], button: 0 });
  const pointerActions = harness.delivered.filter(entry => entry.event.kind === 'pointer-down'); assert.deepEqual(pointerActions.map(entry => entry.event.phase), ['capture', 'target', 'target', 'target', 'target', 'bubble']);
  assert.deepEqual(pointerActions[0].event.localPoint, [38, 15]); assert.deepEqual(pointerActions[1].event.localPoint, [28, 5]); assert.equal(dataRuntime.read('root-local', ['score']), 42); assert.deepEqual(input.trace.captures, [{ pointer: 1, target: 'button' }]);
  input.dispatchPointer({ kind: 'up', pointerId: 1, point: [38, 15], button: 0 }); input.dispatchPointer({ kind: 'move', pointerId: 1, point: [150, 150] }); assert.ok(['pointer-enter', 'pointer-move', 'pointer-up', 'pointer-exit'].every(name => harness.reported.includes(name))); const captureIndex = harness.reported.indexOf('root-capture'), targetIndex = harness.reported.indexOf('button-down'), bubbleIndex = harness.reported.indexOf('root-bubble'); assert.ok(captureIndex < targetIndex && targetIndex < bubbleIndex); input.dispose(); dataRuntime.dispose();
});

test('capture keeps drag ownership outside geometry and multi-touch states remain independent', () => {
  const dataRuntime = new runtime.DataBindingRuntime(dataDocument), harness = createHarness(dataRuntime), input = new runtime.InteractionRuntime(interactionDocument, { actionPort: harness.port, geometryPort: geometryPort() }); harness.attach(input);
  input.dispatchPointer({ kind: 'down', pointerId: 1, point: [38, 15], button: 0 }); input.dispatchPointer({ kind: 'down', pointerId: 2, point: [5, 5], button: 0 }); input.dispatchPointer({ kind: 'move', pointerId: 1, point: [150, 150] }); input.dispatchPointer({ kind: 'up', pointerId: 1, point: [150, 150], button: 0 });
  assert.ok(harness.reported.includes('drag-start')); assert.ok(harness.reported.includes('drag')); assert.ok(harness.reported.includes('drag-end')); assert.equal(input.trace.captures.length, 0); assert.equal(input.trace.pointers, 2);
  input.dispatchPointer({ kind: 'up', pointerId: 2, point: [5, 5], button: 0 }); input.dispose(); dataRuntime.dispose();
});

test('click executes every neutral listener action family transactionally', () => {
  const dataRuntime = new runtime.DataBindingRuntime(dataDocument), harness = createHarness(dataRuntime), input = new runtime.InteractionRuntime(interactionDocument, { actionPort: harness.port }); harness.attach(input);
  input.dispatchPointer({ kind: 'down', pointerId: 1, point: [38, 15], button: 0 }); input.dispatchPointer({ kind: 'up', pointerId: 1, point: [38, 15], button: 0 });
  const kinds = harness.delivered.filter(entry => entry.event.kind === 'click').map(entry => entry.action.kind); assert.deepEqual(kinds, ['data-trigger', 'property-group', 'state-control', 'align-target', 'open-url', 'component-input', 'component-event', 'audio', 'semantic', 'custom']);
  assert.equal(dataRuntime.read('root-local', ['fire']), true); assert.deepEqual(dataRuntime.read('root-local', ['items']), ['item-1', 'item-2']); const observation = dataRuntime.advance(); assert.ok(observation.changes.some(change => change.kind === 'trigger')); assert.equal(dataRuntime.read('root-local', ['fire']), false);
  input.dispose(); dataRuntime.dispose();
});

test('keyboard gamepad focus navigation and semantic actions use the same nested route', () => {
  const dataRuntime = new runtime.DataBindingRuntime(dataDocument), harness = createHarness(dataRuntime), input = new runtime.InteractionRuntime(interactionDocument, { actionPort: harness.port }); harness.attach(input); input.focus('button');
  input.dispatchKeyboard({ key: 'Escape', phase: 'down' }); input.dispatchKeyboard({ key: 'Enter', phase: 'down' }); input.dispatchText('hello'); input.dispatchDataChange('b-score-raw', 5); input.dispatchGamepad({ index: 1, control: 'south', phase: 'down', value: 1 }); input.dispatchGamepad({ index: 0, control: 'south', phase: 'down', value: 1 }); input.dispatchSemanticAction('button', 'tap');
  assert.ok(['focus', 'keyboard', 'text-input', 'data-change', 'gamepad', 'semantic-tap'].every(name => harness.reported.includes(name))); assert.equal(input.focusNext(), 'knob'); assert.ok(harness.reported.includes('blur')); input.dispatchSemanticAction('knob', 'increase'); input.dispatchSemanticAction('knob', 'decrease'); assert.ok(['semantic-increase', 'semantic-decrease'].every(name => harness.reported.includes(name))); assert.equal(input.focusNext(true), 'button'); input.dispose(); dataRuntime.dispose();
});

test('action failure rolls back data, capture and reentrant queue state', () => {
  const dataRuntime = new runtime.DataBindingRuntime(dataDocument), before = dataRuntime.read('root-local', ['score']), harness = createHarness(dataRuntime); harness.failKind = 'data-set'; const input = new runtime.InteractionRuntime(interactionDocument, { actionPort: harness.port }); harness.attach(input);
  assert.throws(() => input.dispatchPointer({ kind: 'down', pointerId: 1, point: [38, 15], button: 0 }), /action failure/); assert.equal(dataRuntime.read('root-local', ['score']), before); assert.equal(input.trace.captures.length, 0); assert.equal(harness.rollbacks, 1); input.dispose(); dataRuntime.dispose();
});

test('reentrant recursion, event storms and pointer counts stop at explicit budgets', () => {
  const recursive = interactionFixture(); recursive.limits.maxEventRecursion = 2; recursive.listeners.find(listener => listener.id === 'reported').actions = [{ kind: 'report-event', name: 'again' }]; const parsedRecursive = interaction.parseHyaInteraction(recursive), dataRuntime = new runtime.DataBindingRuntime(dataDocument), harness = createHarness(dataRuntime), input = new runtime.InteractionRuntime(parsedRecursive, { actionPort: harness.port }); harness.attach(input);
  assert.throws(() => input.enqueueReportedEvent('start', null, 'button'), error => error.code === 'E_INTERACTION_RUNTIME_LIMIT'); input.dispose(); dataRuntime.dispose();
  const storm = interactionFixture(); storm.limits.maxEventQueue = 1; const stormInput = new runtime.InteractionRuntime(interaction.parseHyaInteraction(storm), { actionPort: noOpPort(), geometryPort: geometryPort() }); assert.throws(() => stormInput.dispatchPointer({ kind: 'move', pointerId: 1, point: [38, 15] }), error => error.code === 'E_INTERACTION_RUNTIME_LIMIT'); stormInput.dispose();
  const pointer = interactionFixture(); pointer.limits.maxPointers = 1; const pointerInput = new runtime.InteractionRuntime(interaction.parseHyaInteraction(pointer), { actionPort: noOpPort(), geometryPort: geometryPort() }); pointerInput.dispatchPointer({ kind: 'move', pointerId: 1, point: [5, 5] }); assert.throws(() => pointerInput.dispatchPointer({ kind: 'move', pointerId: 2, point: [5, 5] }), error => error.code === 'E_INTERACTION_RUNTIME_LIMIT'); pointerInput.dispose();
});

test('oracle-compatible input projection is byte-stable for pointer focus data and event traces', () => {
  const run = () => { const dataRuntime = new runtime.DataBindingRuntime(dataDocument), harness = createHarness(dataRuntime), input = new runtime.InteractionRuntime(interactionDocument, { actionPort: harness.port }); harness.attach(input); input.dispatchPointer({ kind: 'move', pointerId: 1, point: [38, 15] }); input.dispatchPointer({ kind: 'down', pointerId: 1, point: [38, 15], button: 0 }); input.dispatchPointer({ kind: 'up', pointerId: 1, point: [38, 15], button: 0 }); input.dispatchKeyboard({ key: 'Enter', phase: 'down' }); const projection = { trace: input.trace, score: dataRuntime.read('root-local', ['score']), items: dataRuntime.read('root-local', ['items']), events: harness.reported, actionKinds: harness.delivered.map(entry => entry.action.kind) }; input.dispose(); dataRuntime.dispose(); return projection; };
  assert.deepEqual(run(), run());
});

function createHarness(dataRuntime) { const harness = { delivered: [], reported: [], pending: [], transaction: 0, rollbacks: 0, failKind: null, input: null, attach(input) { this.input = input; } }; harness.port = { begin() { harness.transaction = dataRuntime.beginTransaction(); harness.pending = []; }, invoke(action, event) { harness.pending.push({ action, event }); if (action.kind === 'report-event') { harness.reported.push(action.name); harness.input.enqueueReportedEvent(action.name, action.payload ?? null, event.target); } else if (action.kind === 'data-set') dataRuntime.writeBinding(action.binding, action.value, harness.transaction); else if (action.kind === 'data-trigger') dataRuntime.writeBinding(action.binding, true, harness.transaction); else if (action.kind === 'property-group') dataRuntime.applyGroup(action.group, 'root-local', harness.transaction); if (harness.failKind === action.kind) throw new Error('action failure'); }, commit() { dataRuntime.commit(harness.transaction); harness.delivered.push(...harness.pending); harness.pending = []; }, rollback() { dataRuntime.rollback(harness.transaction); harness.pending = []; harness.rollbacks++; }, dispose() {} }; return harness; }
function geometryPort() { return { containsGeometry(_port, _target, point) { return point[0] >= 100 && point[1] >= 100; } }; }
function noOpPort() { return { begin() {}, invoke() {}, commit() {}, rollback() {}, dispose() {} }; }
