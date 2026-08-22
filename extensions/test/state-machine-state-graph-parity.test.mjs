import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStateMachineV2Modules, stateMachineV2Fixture } from './state-machine-v2-parity-fixture.mjs';

const { spec, runtime } = await loadStateMachineV2Modules();
const parsed = spec.parseHyaStateMachineV2(stateMachineV2Fixture());
const { HyaStateMachineRuntimeV2 } = runtime;

test('ordered state graph preserves entry, OR/AND, trigger commit, pause-when-exiting, duration and exit-time trace', () => {
  const port = invocationPort(), effects = effectPort(), machine = new HyaStateMachineRuntimeV2(parsed, 'main', completeOptions(port, { sideEffectPort: effects, nestedFactory: passiveNestedFactory() }));
  let pose = machine.evaluate(); assert.equal(machine.trace.layers[0].stateId, 'idle'); assert.equal(machine.trace.layers[1].stateId, 'blend'); assert.equal(pose.settled, true);
  machine.update(0.2); const before = machine.trace.layers[0].localTime; machine.setTrigger('go'); pose = machine.update(0.25);
  assert.equal(machine.trace.layers[0].transitionId, 'activate'); assert.equal(machine.trace.layers[0].localTime, before, 'source clock pauses while exiting');
  assert.equal(machine.getInput('go'), false, 'selected transition consumes trigger only after commit'); assert.ok(pose.effects.some(effect => effect.payload?.name === 'transition-start'));
  pose = machine.update(0.25); assert.equal(machine.trace.layers[0].stateId, 'active'); assert.equal(machine.trace.layers[0].transitionId, null); assert.ok(pose.effects.some(effect => effect.payload?.name === 'transition-complete'));
  machine.update(0.5); assert.equal(machine.trace.layers[0].stateId, 'nested', 'crossing exit time consumes the same update without a follow-up tick'); machine.update(0); assert.equal(machine.trace.layers[0].stateId, 'nested');
  assert.deepEqual(port.calls.filter(call => call === 'rollback'), []); machine.dispose(); machine.dispose(); assert.equal(machine.status, 'disposed');
});

test('custom condition port has deterministic begin/invoke/commit and rollback restores state and trigger inputs', () => {
  const port = invocationPort(); port.activate = true; const machine = new HyaStateMachineRuntimeV2(parsed, 'main', completeOptions(port));
  machine.update(0); assert.equal(machine.trace.layers[0].transitionId, 'activate', 'second OR group selects transition without trigger');
  assert.deepEqual(port.calls.slice(0, 3), ['begin', 'invoke:fixture-condition@1/activate', 'commit']); machine.reset(); port.calls.length = 0; port.throwOnInvoke = true;
  const before = structuredClone(machine.trace); assert.throws(() => machine.update(0.1), /condition failure/); assert.deepEqual(machine.trace, before); assert.deepEqual(port.calls, ['begin', 'invoke:fixture-condition@1/activate', 'rollback']);
  machine.setTrigger('go'); port.throwOnInvoke = false; machine.update(0.1); assert.equal(machine.getInput('go'), false);
});

test('source and destination interruption policies preserve declaration order and anchor time', () => {
  const source = structuredClone(parsed), base = source.stateMachines[0].layers[0], activate = base.transitions.find(entry => entry.id === 'activate');
  activate.interruption = 'source'; base.transitions.splice(2, 0, { id: 'source-cancel', from: 'idle', to: 'nested', conditionGroups: [[{ kind: 'input', input: 'enabled', comparator: 'equal', value: false }]], duration: 0 });
  const machine = new HyaStateMachineRuntimeV2(source, 'main', completeOptions(invocationPort(), { nestedFactory: passiveNestedFactory() })); machine.setTrigger('go'); machine.update(0.1); assert.equal(machine.trace.layers[0].transitionId, 'activate');
  machine.setBoolean('enabled', false); machine.update(0); assert.equal(machine.trace.layers[0].stateId, 'nested'); assert.equal(machine.trace.layers[0].transitionId, null);
  const destination = structuredClone(parsed), destinationBase = destination.stateMachines[0].layers[0], destinationActivate = destinationBase.transitions.find(entry => entry.id === 'activate');
  destinationActivate.interruption = 'destination'; destinationBase.transitions.splice(2, 0, { id: 'destination-cancel', from: 'active', to: 'nested', conditionGroups: [[{ kind: 'input', input: 'enabled', comparator: 'equal', value: false }]], duration: 0 });
  const destinationMachine = new HyaStateMachineRuntimeV2(destination, 'main', completeOptions(invocationPort(), { nestedFactory: passiveNestedFactory() })); destinationMachine.setTrigger('go'); destinationMachine.update(0.1); destinationMachine.setBoolean('enabled', false); destinationMachine.update(0); assert.equal(destinationMachine.trace.layers[0].stateId, 'nested');
});

test('transition exitMotion executes the authored blend-state exit clip instead of the source motion', () => {
  const withExit = structuredClone(parsed), withoutExit = structuredClone(parsed); withExit.stateMachines[0].layers[0].transitions.find(entry => entry.id === 'activate').exitMotion = { kind: 'clip', clip: 'accent', playback: 'loop' };
  const run = source => { const port = invocationPort(), machine = new HyaStateMachineRuntimeV2(source, 'main', completeOptions(port)); machine.setTrigger('go'); const pose = machine.update(0.25); return pose.channels.find(entry => entry.channel.id === 'transform.x').value; };
  assert.ok(run(withExit) > run(withoutExit), 'exit motion contributes through the ordinary timeline sampler');
});

test('randomWeight uses seeded rollback-safe selection after side-effect failure', () => {
  const source = structuredClone(parsed), base = source.stateMachines[0].layers[0], entry = base.transitions.find(transition => transition.from === '@entry');
  base.transitions = [entry, { id: 'weighted', from: 'idle', to: 'active', conditionGroups: [], randomWeight: 0.5, duration: 0, effects: [{ channel: 'event.fire', phase: 'start', payload: { name: 'weighted' } }] }];
  const sideEffects = effectPort(), port = invocationPort(); sideEffects.fail = true; const machine = new HyaStateMachineRuntimeV2(source, 'main', completeOptions(port, { sideEffectPort: sideEffects, randomSeed: 7 }));
  assert.throws(() => machine.update(0), /weighted failure/); assert.equal(machine.trace.layers[0].stateId, 'idle');
  sideEffects.fail = false; machine.update(0); assert.equal(machine.trace.layers[0].stateId, 'active');
  const replayPort = invocationPort(), replay = new HyaStateMachineRuntimeV2(source, 'main', completeOptions(replayPort, { randomSeed: 7 })); replay.update(0); assert.equal(replay.trace.layers[0].stateId, 'active');
});

test('ordered layers, 1D and additive blend states preserve channel priority and masks', () => {
  const port = invocationPort(), machine = new HyaStateMachineRuntimeV2(parsed, 'main', completeOptions(port)); machine.setNumber('blend', 1);
  let pose = machine.update(0), values = Object.fromEntries(pose.channels.map(entry => [entry.channel.id, entry.value]));
  assert.equal(values['transform.x'], 1, 'half-weight additive overlay contributes accent x');
  assert.equal(values['text.value'], 'idle', 'overlay mask cannot write text channel');
  machine.setBoolean('enabled', false); pose = machine.update(0); values = Object.fromEntries(pose.channels.map(entry => [entry.channel.id, entry.value]));
  assert.equal(machine.trace.layers[1].stateId, 'add'); assert.ok(values['rig.angle'] > 0, 'additive child executes through the same mixer');
});

test('nested component owns exposed inputs/events, settle state, dispose and recreate generations', () => {
  const port = invocationPort(), records = [], channel = parsed.channels.find(entry => entry.id === 'transform.x');
  const factory = { create(_definition, generation) { const record = { generation, inputs: {}, inputHistory: [], disposed: 0, reset: 0 }; records.push(record); return { setInput(name, value) { record.inputs[name] = value; record.inputHistory.push([name, value]); }, evaluate(time) { return { contributions: [{ channel, value: 20 + time, weight: 1 }], effects: [], settled: port.done }; }, reset() { record.reset++; }, pause() {}, resume() {}, stop() {}, dispose() { record.disposed++; } }; } };
  const machine = new HyaStateMachineRuntimeV2(parsed, 'main', completeOptions(port, { nestedFactory: factory })); machine.setTrigger('go'); machine.setTrigger('childFire'); machine.update(0.5); machine.update(0.5); machine.update(0);
  assert.equal(machine.trace.layers[0].stateId, 'nested'); let pose = machine.evaluate(); assert.equal(machine.nestedOwner.liveCount, 1); assert.equal(records[0].inputs.enabled, true); assert.ok(records[0].inputHistory.some(([name, value]) => name === 'fire' && value === true)); assert.equal(records[0].inputs.fire, false, 'nested trigger is consumed after its first committed evaluation'); assert.equal(machine.getInput('childFire'), false); assert.equal(pose.settled, false);
  port.done = true; pose = machine.evaluate(); assert.equal(machine.trace.layers[0].exited, true); assert.equal(records[0].disposed, 1); assert.equal(machine.nestedOwner.liveCount, 0);
  machine.reset(); port.done = false; machine.setTrigger('go'); machine.update(0.5); machine.update(0.5); machine.update(0); machine.evaluate(); assert.equal(records.length, 2); assert.ok(records[1].generation > records[0].generation);
  machine.dispose(); assert.equal(records[1].disposed, 1);
});

test('nested creation, existing instance state and pending disposal participate in runtime rollback', () => {
  const source = structuredClone(parsed), base = source.stateMachines[0].layers[0]; base.transitions.find(entry => entry.from === '@entry').to = 'nested';
  const records = [], channel = source.channels.find(entry => entry.id === 'transform.x'); let fail = true;
  const factory = { create(_definition, generation) { const record = { generation, disposed: 0, rollbacks: 0 }; records.push(record); return { setInput() {}, evaluate() { if (fail) throw new Error('nested failure'); return { contributions: [{ channel, value: 1, weight: 1 }], settled: true }; }, reset() {}, pause() {}, resume() {}, stop() {}, dispose() { record.disposed++; }, beginTransaction() {}, commitTransaction() {}, rollbackTransaction() { record.rollbacks++; } }; } };
  const nestedPort = invocationPort(), machine = new HyaStateMachineRuntimeV2(source, 'main', completeOptions(nestedPort, { nestedFactory: factory })); const before = structuredClone(machine.trace);
  assert.throws(() => machine.update(0), /nested failure/); assert.deepEqual(machine.trace, before); assert.equal(machine.nestedOwner.liveCount, 0); assert.equal(records[0].disposed, 1);
  fail = false; machine.update(0); assert.equal(machine.nestedOwner.liveCount, 1); assert.equal(records[1].generation, 2);
  fail = true; assert.throws(() => machine.update(0), /nested failure/); assert.equal(machine.nestedOwner.liveCount, 1); assert.equal(records[1].rollbacks, 1); assert.equal(records[1].disposed, 0);
});

test('pause, stop, resume, reset and seek have explicit replay semantics', () => {
  const port = invocationPort(), effects = effectPort(), machine = new HyaStateMachineRuntimeV2(parsed, 'main', completeOptions(port, { sideEffectPort: effects }));
  machine.update(0.3); const paused = structuredClone(machine.trace); machine.pause(); machine.setTrigger('go'); machine.update(1); assert.equal(machine.trace.layers[0].stateId, paused.layers[0].stateId); assert.equal(machine.trace.layers[0].localTime, paused.layers[0].localTime);
  machine.resume(); machine.update(0); assert.equal(machine.trace.layers[0].transitionId, 'activate');
  machine.stop(); const stopped = structuredClone(machine.trace); machine.update(10); assert.deepEqual(machine.trace, stopped); machine.resume(); assert.equal(machine.status, 'running');
  machine.reset(); const first = machine.seek(0.8), trace = structuredClone(machine.trace); const second = machine.seek(0.8); assert.deepEqual(machine.trace, trace); assert.deepEqual(second.channels, first.channels); assert.equal(machine.clock, 0.8);
  assert.ok(['pause', 'resume', 'reset', 'stop'].every(entry => effects.lifecycle.includes(entry)));
});

test('seeded random input/update/seek sequences replay byte-equivalent traces', () => {
  const operations = randomOperations(0x12345678, 200), replay = () => { const port = invocationPort(), machine = new HyaStateMachineRuntimeV2(parsed, 'main', completeOptions(port, { randomSeed: 7, nestedFactory: passiveNestedFactory() })); const traces = []; for (const operation of operations) { if (operation.kind === 'update') machine.update(operation.value); else if (operation.kind === 'seek') machine.seek(operation.value); else if (operation.kind === 'trigger') machine.setTrigger('go'); else if (operation.kind === 'boolean') machine.setBoolean('enabled', operation.value); else machine.setNumber('blend', operation.value); traces.push(machine.trace); } return traces; };
  assert.deepEqual(replay(), replay());
});

test('independent reducer and runtime produce the same model-based state trace', () => {
  const source = modelDocument(), machine = new HyaStateMachineRuntimeV2(source, 'model'), model = modelState(), operations = modelOperations(0x51f15e, 300);
  for (const operation of operations) {
    if (operation.kind === 'trigger') { machine.setTrigger('go'); model.trigger = true; }
    else if (operation.kind === 'back') { machine.setBoolean('back', operation.value); model.back = operation.value; }
    else if (operation.kind === 'reset') { machine.reset(); Object.assign(model, modelState()); }
    else { machine.update(operation.value); advanceModel(model, operation.value); }
    const trace = machine.trace.layers[0]; assert.deepEqual([trace.stateId, trace.transitionId, rounded(trace.localTime), machine.getInput('go')], [model.state, model.transition ? 'a-b' : null, rounded(model.localTime), model.trigger]);
  }
});

test('oracle-compatible trace projection matches the independently frozen state sequence', () => {
  const port = invocationPort(), machine = new HyaStateMachineRuntimeV2(parsed, 'main', completeOptions(port, { nestedFactory: passiveNestedFactory() })); const projection = [];
  const capture = () => projection.push(machine.trace.layers.map(layer => [layer.stateId, layer.transitionId, Number(layer.transitionProgress.toFixed(3)), layer.exited]));
  machine.update(0.2); capture(); machine.setTrigger('go'); machine.update(0.25); capture(); machine.update(0.25); capture(); machine.update(0.5); capture(); machine.update(0); capture();
  assert.deepEqual(projection, [
    [['idle', null, 0, false], ['blend', null, 0, false]],
    [['idle', 'activate', 0.5, false], ['blend', null, 0, false]],
    [['active', null, 0, false], ['blend', null, 0, false]],
    [['nested', null, 0, false], ['blend', null, 0, false]],
    [['nested', null, 0, false], ['blend', null, 0, false]],
  ]);
});

function invocationPort() { return { calls: [], activate: false, done: false, throwOnInvoke: false, begin() { this.calls.push('begin'); }, invoke(request) { this.calls.push(`invoke:${request.protocol}/${request.port}`); if (this.throwOnInvoke) throw new Error('condition failure'); if (request.port === 'activate') return this.activate; if (request.port === 'done') return this.done; return false; }, commit() { this.calls.push('commit'); }, rollback() { this.calls.push('rollback'); } }; }
function effectPort() { return { delivered: [], pending: [], lifecycle: [], fail: false, begin() { this.pending = []; }, invoke(effect) { if (this.fail) throw new Error('weighted failure'); this.pending.push(effect); }, commit() { this.delivered.push(...this.pending); this.pending = []; }, rollback() { this.pending = []; }, reset() { this.lifecycle.push('reset'); this.pending = []; }, pause() { this.lifecycle.push('pause'); }, resume() { this.lifecycle.push('resume'); }, stop() { this.lifecycle.push('stop'); }, dispose() { this.lifecycle.push('dispose'); this.pending = []; } }; }
function ownershipPort() { return { pending: [], begin() { this.pending = []; }, transfer(change) { this.pending.push(change); }, commit() { this.pending = []; }, rollback() { this.pending = []; }, reset() {}, dispose() {} }; }
function completeOptions(invocation, extra = {}) { return { invocationPort: invocation, sideEffectPort: effectPort(), ownershipPort: ownershipPort(), ...extra }; }
function passiveNestedFactory() { return { create() { return { setInput() {}, evaluate() { return { contributions: [], effects: [], settled: true }; }, reset() {}, pause() {}, resume() {}, stop() {}, dispose() {} }; } }; }
function randomOperations(seed, count) { let state = seed >>> 0; const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; }; return Array.from({ length: count }, () => { const kind = Math.floor(random() * 5); if (kind === 0) return { kind: 'update', value: random() * 0.1 }; if (kind === 1) return { kind: 'seek', value: random() * 1.5 }; if (kind === 2) return { kind: 'trigger' }; if (kind === 3) return { kind: 'boolean', value: random() > 0.5 }; return { kind: 'number', value: random() }; }); }
function modelDocument() { return { channels: [], clips: [{ id: 'a', duration: 1, tracks: [] }, { id: 'b', duration: 1, tracks: [] }], stateMachines: [{ id: 'model', inputs: [{ id: 'go', type: 'trigger' }, { id: 'back', type: 'boolean', defaultValue: false }], layers: [{ id: 'base', order: 0, states: [{ id: 'a', motion: { kind: 'clip', clip: 'a' } }, { id: 'b', motion: { kind: 'clip', clip: 'b' } }], transitions: [{ id: 'entry', from: '@entry', to: 'a', conditionGroups: [], duration: 0 }, { id: 'a-b', from: 'a', to: 'b', conditionGroups: [[{ kind: 'trigger', input: 'go' }]], duration: 0.2 }, { id: 'b-a', from: 'b', to: 'a', conditionGroups: [[{ kind: 'input', input: 'back', comparator: 'equal', value: true }]], duration: 0 }] }] }] }; }
function modelState() { return { state: 'a', localTime: 0, transition: false, elapsed: 0, destinationTime: 0, trigger: false, back: false }; }
function advanceModel(model, delta) { let remaining = delta, guard = 0; while (guard++ < 16) { if (model.transition) { const step = Math.min(remaining, 0.2 - model.elapsed); model.elapsed += step; model.localTime += step; model.destinationTime += step; remaining -= step; if (model.elapsed >= 0.2 - 1e-12) { model.state = 'b'; model.localTime = model.destinationTime; model.transition = false; continue; } return; } if (model.state === 'a' && model.trigger) { model.trigger = false; model.transition = true; model.elapsed = 0; model.destinationTime = 0; continue; } if (model.state === 'b' && model.back) { model.state = 'a'; model.localTime = 0; continue; } model.localTime += remaining; return; } throw new Error('model transition guard'); }
function modelOperations(seed, count) { let state = seed >>> 0; const random = () => { state = Math.imul(state, 1664525) + 1013904223 >>> 0; return state / 0x1_0000_0000; }; return Array.from({ length: count }, () => { const kind = Math.floor(random() * 4); if (kind === 0) return { kind: 'trigger' }; if (kind === 1) return { kind: 'back', value: random() > 0.5 }; if (kind === 2) return { kind: 'reset' }; return { kind: 'update', value: random() * 0.5 }; }); }
function rounded(value) { return Number(value.toFixed(9)); }
