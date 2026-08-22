import assert from 'node:assert/strict';
import test from 'node:test';
import { dataBindingFixture, loadG07Modules, semanticsFixture } from './data-binding-parity-fixture.mjs';

const { data, runtime, semantics } = await loadG07Modules();
const dataDocument = data.parseHyaDataBinding(dataBindingFixture()), semanticsDocument = semantics.parseHyaSemantics(semanticsFixture());

test('semantic snapshot preserves roles labels values traits states and deterministic reading/navigation order', () => {
  const model = new runtime.DataBindingRuntime(dataDocument), bridge = semanticBridge(), actions = [], tree = new runtime.SemanticsRuntime(semanticsDocument, bindingPort(model), bridge, { invoke(target, action) { actions.push([target, action]); } });
  assert.deepEqual(tree.snapshot.readingOrder, ['semantic-root', 'semantic-heading', 'semantic-button', 'semantic-slider']); assert.deepEqual(tree.snapshot.navigationOrder, ['semantic-slider', 'semantic-button']); const button = tree.snapshot.nodes.find(node => node.id === 'semantic-button');
  assert.deepEqual({ role: button.role, label: button.label, value: button.value, hint: button.hint, traits: button.traits, actions: button.actions }, { role: 'button', label: 'global title', value: 2.345, hint: 'Activate', traits: ['button'], actions: ['tap', 'focus'] }); assert.deepEqual(button.capabilities, { expandable: false, selectable: true, checkable: false, toggleable: false, requirable: false, enablable: true, focusable: true }); assert.equal(button.state.hidden, false); assert.equal(button.state.disabled, false); assert.equal(tree.snapshot.nodes.find(node => node.id === 'semantic-heading').headingLevel, 2);
  bridge.emit('semantic-button', 'tap'); assert.deepEqual(actions, [['button', 'tap']]); tree.dispose(); model.dispose();
});

test('data advance drives dynamic tree updates, live announcements, hidden descendants and disabled actions', () => {
  const model = new runtime.DataBindingRuntime(dataDocument), bridge = semanticBridge(), actions = [], tree = new runtime.SemanticsRuntime(semanticsDocument, bindingPort(model), bridge, { invoke(target, action) { actions.push([target, action]); } });
  let transaction = model.beginTransaction(); model.set('root-global', ['title'], 'updated title', transaction); model.set('root-local', ['score'], 9, transaction); model.commit(transaction); model.advance(); assert.equal(tree.snapshot.nodes.find(node => node.id === 'semantic-button').label, 'updated title'); assert.deepEqual(tree.snapshot.announcements, [{ node: 'semantic-button', mode: 'polite', text: 'updated title 9' }]);
  transaction = model.beginTransaction(); model.set('root-local', ['enabled'], false, transaction); model.commit(transaction); model.advance(); assert.equal(tree.snapshot.nodes.find(node => node.id === 'semantic-button').state.disabled, true); assert.deepEqual(tree.snapshot.navigationOrder, ['semantic-slider']); assert.throws(() => tree.perform('semantic-button', 'tap'), error => error.code === 'E_SEMANTICS_RUNTIME_PORT');
  transaction = model.beginTransaction(); model.set('root-local', ['hidden'], true, transaction); model.commit(transaction); model.advance(); assert.equal(tree.snapshot.nodes.some(node => node.id === 'semantic-button'), false); tree.dispose(); model.dispose(); assert.deepEqual(actions, []);
});

test('reduced-motion policy distinguishes decorative and essential motion without deleting semantics', () => {
  const model = new runtime.DataBindingRuntime(dataDocument), tree = new runtime.SemanticsRuntime(semanticsDocument, bindingPort(model), semanticBridge(), { invoke() {} });
  assert.deepEqual(tree.resolveReducedMotion(false, false), { animate: true, durationScale: 1, disableParallax: false });
  assert.deepEqual(tree.resolveReducedMotion(true, false), { animate: false, durationScale: 0.2, disableParallax: true });
  assert.deepEqual(tree.resolveReducedMotion(true, true), { animate: true, durationScale: 0.2, disableParallax: true }); assert.equal(tree.snapshot.nodes.length, 4); tree.dispose(); model.dispose();
});

test('rebind unsubscribes stale observers and host actions while dispose is idempotent', () => {
  const first = new runtime.DataBindingRuntime(dataDocument), second = new runtime.DataBindingRuntime(dataDocument), firstBridge = semanticBridge(), secondBridge = semanticBridge(), tree = new runtime.SemanticsRuntime(semanticsDocument, bindingPort(first), firstBridge, { invoke() {} }); assert.equal(first.stats.observers, 1); assert.equal(firstBridge.stats.listeners, 1);
  tree.rebind(bindingPort(second), secondBridge); assert.equal(first.stats.observers, 0); assert.equal(firstBridge.stats.listeners, 0); assert.equal(firstBridge.stats.disposed, 1); assert.equal(second.stats.observers, 1); const revisions = secondBridge.snapshots.length;
  const transaction = first.beginTransaction(); first.set('root-global', ['title'], 'stale', transaction); first.commit(transaction); first.advance(); assert.equal(secondBridge.snapshots.length, revisions, 'stale observer cannot write after rebind');
  tree.dispose(); tree.dispose(); assert.equal(second.stats.observers, 0); assert.equal(secondBridge.stats.listeners, 0); assert.equal(secondBridge.stats.disposed, 1); first.dispose(); second.dispose();
});

test('host bridge failures roll back subscriptions and semantic snapshot ownership', () => {
  const model = new runtime.DataBindingRuntime(dataDocument), failed = semanticBridge(); failed.failUpdate = true; assert.throws(() => new runtime.SemanticsRuntime(semanticsDocument, bindingPort(model), failed, { invoke() {} }), /bridge failure/); assert.equal(model.stats.observers, 0); assert.equal(failed.stats.listeners, 0); assert.equal(failed.stats.disposed, 1);
  const stable = semanticBridge(), tree = new runtime.SemanticsRuntime(semanticsDocument, bindingPort(model), stable, { invoke() {} }), before = tree.snapshot, replacement = semanticBridge(); replacement.failUpdate = true; assert.throws(() => tree.rebind(bindingPort(model), replacement), /bridge failure/); assert.equal(tree.snapshot, before); assert.equal(model.stats.observers, 1); assert.equal(stable.stats.listeners, 1); assert.equal(replacement.stats.listeners, 0); assert.equal(replacement.stats.disposed, 1); tree.dispose(); model.dispose();
});

test('oracle-compatible semantic and action projection matches an independently frozen trace', () => {
  const model = new runtime.DataBindingRuntime(dataDocument), bridge = semanticBridge(), actions = [], tree = new runtime.SemanticsRuntime(semanticsDocument, bindingPort(model), bridge, { invoke(target, action) { actions.push([target, action]); } }), projection = [];
  const capture = () => projection.push({ nodes: tree.snapshot.nodes.map(node => [node.id, node.role, node.label ?? null, node.value ?? null, !!node.state.disabled]), reading: tree.snapshot.readingOrder, navigation: tree.snapshot.navigationOrder, announcements: tree.snapshot.announcements }); capture();
  let transaction = model.beginTransaction(); model.set('root-global', ['title'], 'Ready', transaction); model.commit(transaction); model.advance(); capture(); bridge.emit('semantic-button', 'focus'); assert.deepEqual(actions, [['button', 'focus']]);
  assert.deepEqual(projection, [
    { nodes: [['semantic-root', 'group', 'Demo', null, false], ['semantic-heading', 'heading', 'Status', null, false], ['semantic-button', 'button', 'global title', 2.345, false], ['semantic-slider', 'slider', 'Volume', 2.345, false]], reading: ['semantic-root', 'semantic-heading', 'semantic-button', 'semantic-slider'], navigation: ['semantic-slider', 'semantic-button'], announcements: [] },
    { nodes: [['semantic-root', 'group', 'Demo', null, false], ['semantic-heading', 'heading', 'Status', null, false], ['semantic-button', 'button', 'Ready', 2.345, false], ['semantic-slider', 'slider', 'Volume', 2.345, false]], reading: ['semantic-root', 'semantic-heading', 'semantic-button', 'semantic-slider'], navigation: ['semantic-slider', 'semantic-button'], announcements: [{ node: 'semantic-button', mode: 'polite', text: 'Ready 2.345' }] },
  ]); tree.dispose(); model.dispose();
});

function bindingPort(model) { return { read(binding) { return model.readBinding(binding); }, subscribe(listener) { return model.subscribe(listener); } }; }
function semanticBridge() { const listeners = new Set(), stats = { listeners: 0, disposed: 0 }, bridge = { snapshots: [], stats, failUpdate: false, update(snapshot) { if (this.failUpdate) throw new Error('bridge failure'); this.snapshots.push(snapshot); }, subscribeActions(listener) { listeners.add(listener); stats.listeners = listeners.size; let active = true; return { unsubscribe() { if (!active) return; active = false; listeners.delete(listener); stats.listeners = listeners.size; } }; }, emit(node, action) { for (const listener of [...listeners]) listener(node, action); }, dispose() { stats.disposed++; listeners.clear(); stats.listeners = 0; } }; return bridge; }
