import test from 'node:test';
import assert from 'node:assert/strict';
import {loadStateMachineV2Modules, stateMachineV2Fixture} from './state-machine-v2-parity-fixture.mjs';
const {runtime, spec} = await loadStateMachineV2Modules();
const document = () => spec.parseHyaStateMachineV2(stateMachineV2Fixture());
function ports() {
  const log = [], pending = new Map(), events = [];
  const sideEffectPort = {begin(id) {pending.set(id, []); log.push(['begin', id]);}, invoke(event) {pending.get([...pending.keys()].at(-1)).push(event);}, commit(id) {events.push(...pending.get(id)); pending.delete(id); log.push(['commit', id]);}, rollback(id) {pending.delete(id); log.push(['rollback', id]);}, reset() {pending.clear();}, pause() {}, resume() {}, stop() {}, dispose() {pending.clear();}};
  const ownershipPort = {begin() {}, transfer() {}, commit() {}, rollback() {}, reset() {}, dispose() {}};
  const invocationPort = {begin() {}, invoke() {return false;}, commit() {}, rollback() {}};
  return {log, pending, events, options: {sideEffectPort, ownershipPort, invocationPort}};
}
test('prepared state/pose does not commit side effects, ownership, clock or lastPose before the frame boundary', () => {
  const port = ports(), owner = new runtime.HyaStateMachineRuntimeV2(document(), 'main', port.options), before = owner.trace;
  const pose = owner.prepareFrame(.3); assert.ok(pose.channels.length); assert.equal(owner.clock, 0); assert.equal(owner.lastPose.sequence, 0);
  assert.equal(port.events.length, 0); assert.equal(port.log.filter(e => e[0] === 'commit').length, 0);
  owner.rollbackPreparedFrame(pose); assert.deepEqual(owner.trace, before); assert.equal(port.pending.size, 0); assert.equal(owner.mixer.deliveredEffectCount, 0); owner.dispose();
});
test('two prepared machines roll back together after a later layout failure and retry without duplicate effects', () => {
  const a = ports(), b = ports(), first = new runtime.HyaStateMachineRuntimeV2(document(), 'main', a.options), second = new runtime.HyaStateMachineRuntimeV2(document(), 'main', b.options);
  const pa = first.prepareFrame(.3), pb = second.prepareFrame(.3);
  second.rollbackPreparedFrame(pb); first.rollbackPreparedFrame(pa); assert.equal(first.clock, 0); assert.equal(second.clock, 0); assert.equal(a.events.length + b.events.length, 0);
  const retryA = first.prepareFrame(.3), retryB = second.prepareFrame(.3); assert.deepEqual(retryA, pa); assert.deepEqual(retryB, pb);
  first.commitPreparedFrame(retryA); second.commitPreparedFrame(retryB); assert.equal(first.clock, .3); assert.equal(second.clock, .3);
  assert.equal(new Set(a.events.map(e => e.id)).size, a.events.length); assert.ok(a.events.length > 0);
  first.dispose(); second.dispose();
});
test('inputs applied inside preparation restore with transitions and trigger histories on downstream failure', () => {
  const port = ports(), owner = new runtime.HyaStateMachineRuntimeV2(document(), 'main', port.options), before = owner.trace;
  const pose = owner.prepareFrame(.2, () => {owner.setTrigger('go'); owner.setNumber('blend', .8);});
  assert.equal(owner.trace.layers[0].transitionId, 'activate'); owner.rollbackPreparedFrame(pose);
  assert.equal(owner.getInput('go'), false); assert.equal(owner.getInput('blend'), 0); assert.deepEqual(owner.trace, before);
  const next = owner.prepareFrame(.2, () => owner.setTrigger('go')); owner.commitPreparedFrame(next); assert.equal(owner.clock, .2); owner.dispose();
});
test('prepared identities are owner-bound and immutable until commit/cancel; disposal retires staged effects', () => {
  const a = ports(), b = ports(), first = new runtime.HyaStateMachineRuntimeV2(document(), 'main', a.options), second = new runtime.HyaStateMachineRuntimeV2(document(), 'main', b.options);
  const pose = first.prepareFrame(.3);
  assert.throws(() => second.commitPreparedFrame(pose), /identity/); assert.throws(() => first.commitPreparedFrame({...pose}), /identity/);
  for (const action of [() => first.update(0), () => first.pause(), () => first.stop(), () => first.reset(), () => first.setTrigger('go'), () => first.mixer.submitEffect(pose.effects[0])]) assert.throws(action);
  first.dispose(); first.dispose(); assert.equal(a.pending.size, 0); assert.equal(a.events.length, 0); assert.equal(first.status, 'disposed'); second.dispose();
});
test('new and retained nested instances join the same frame transaction and old optional legacy hooks remain optional', () => {
  const source = stateMachineV2Fixture(); source.stateMachines[0].layers[0].transitions[0].to = 'nested';
  let creates = 0, releases = 0; const children = [];
  const factory = {create() {creates++; let value = 0, saved;
    const instance = {get value() {return value;}, setInput() {}, evaluate() {assert.notEqual(saved, undefined); value++; return {contributions: [], settled: true};}, beginTransaction() {saved = value;}, commitTransaction() {assert.notEqual(saved, undefined); saved = undefined;}, rollbackTransaction() {value = saved; saved = undefined;}, reset() {}, pause() {}, resume() {}, stop() {}, dispose() {releases++;}};
    children.push(instance); return instance;}};
  const port = ports(), owner = new runtime.HyaStateMachineRuntimeV2(spec.parseHyaStateMachineV2(source), 'main', {...port.options, nestedFactory: factory});
  let pose = owner.prepareFrame(.1); assert.equal(creates, 1); owner.rollbackPreparedFrame(pose); assert.equal(releases, 1); assert.equal(owner.nestedOwner.liveCount, 0);
  pose = owner.prepareFrame(.1); owner.commitPreparedFrame(pose); assert.equal(children[1].value, 1);
  pose = owner.prepareFrame(.1); assert.equal(children[1].value, 2); owner.rollbackPreparedFrame(pose); assert.equal(children[1].value, 1); owner.dispose(); assert.equal(releases, 2);
  let missingReleases = 0; const noHooks = {create() {return {setInput() {}, evaluate() {return {contributions: [], settled: true};}, reset() {}, pause() {}, resume() {}, stop() {}, dispose() {missingReleases++;}};}};
  const strict = new runtime.HyaStateMachineRuntimeV2(spec.parseHyaStateMachineV2(source), 'main', {...ports().options, nestedFactory: noHooks});
  assert.throws(() => strict.prepareFrame(.1), /transactional nested/); assert.equal(missingReleases, 1); strict.dispose();
  const legacy = new runtime.HyaStateMachineRuntimeV2(spec.parseHyaStateMachineV2(source), 'main', {...ports().options, nestedFactory: noHooks}); assert.doesNotThrow(() => legacy.update(.1)); legacy.dispose();
});
test('disposal during a staged host effect cannot resurrect the state controller', () => {
  const port = ports(); let owner;
  port.options.sideEffectPort.invoke = () => owner.dispose();
  owner = new runtime.HyaStateMachineRuntimeV2(document(), 'main', port.options);
  assert.throws(() => owner.prepareFrame(.3)); assert.equal(owner.status, 'disposed'); assert.equal(owner.nestedOwner.liveCount, 0);
});
