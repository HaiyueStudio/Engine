import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
import {loadStateMachineV2Modules, stateMachineV2Fixture} from './state-machine-v2-parity-fixture.mjs';
import {dataBindingFixture, interactionFixture, semanticsFixture, loadG07Modules} from './data-binding-parity-fixture.mjs';
import {productionFontFixture} from './text-production-font-fixture.mjs';

const [layoutModules, stateModules, dataModules] = await Promise.all([loadResponsiveLayoutModules(), loadStateMachineV2Modules(), loadG07Modules()]);
const {ProductionFrameTransaction, checkpointFrameStage, ProductionTransactionPort, stateFrameStage, ProductionStateController} = layoutModules.frameProduction;
const request = (sequence = 1) => ({sequence, deltaSeconds: .3, viewport: [150, 600], dpr: 1});
const empty = value => ({value, commit() {}, rollback() {}});
function journal(invoke = (...args) => args) {
  let active;
  const delivered = [], log = [];
  const host = {begin(id) {assert.equal(active, undefined); active = {id, values: []}; log.push(['begin', id]);},
    invoke(...args) {assert.ok(active); const value = invoke(...args); active.values.push(value); return value;},
    commit(id) {assert.equal(active.id, id); delivered.push(...active.values); active = undefined; log.push(['commit', id]);},
    rollback(id) {assert.equal(active.id, id); active = undefined; log.push(['rollback', id]);}};
  return {host, delivered, log, get active() {return active;}};
}
const lifecycle = {reset() {}, pause() {}, resume() {}, stop() {}, dispose() {}};
function machine(effects) {
  return new stateModules.runtime.HyaStateMachineRuntimeV2(stateModules.spec.parseHyaStateMachineV2(stateMachineV2Fixture()), 'main', {
    sideEffectPort: {...effects.port, ...lifecycle},
    ownershipPort: {begin() {}, transfer() {}, commit() {}, rollback() {}, reset() {}, dispose() {}},
    invocationPort: {begin() {}, invoke() {return false;}, commit() {}, rollback() {}},
  });
}

test('real data, two state machines, interaction, semantic snapshots and outlined text roll back on draw preparation failure', async () => {
  const {spec, runtime, textProduction, outlineProduction, layoutProduction} = layoutModules;
  const document = spec.parseResponsiveLayoutDocument(productionFontFixture().document);
  const assets = new runtime.LayoutAssetOwner(document, {policy: {mode: 'deny'}});
  const text = new textProduction.ProductionTextOwner(document, outlineProduction.createProductionOutlineFontPort(assets)); await text.prepare();
  const layout = new layoutProduction.ProductionLayoutOwner(document, text);
  const originalLayout = layout.evaluate({viewport: [240, 600], dpr: 1, time: 0});
  const converterHost = journal(request => request.value * 2), converter = new ProductionTransactionPort(converterHost.host);
  const data = new dataModules.runtime.DataBindingRuntime(dataModules.data.parseHyaDataBinding(dataBindingFixture()), {converterPort: converter.port});
  const actionHost = journal(), action = new ProductionTransactionPort(actionHost.host);
  const interaction = new dataModules.runtime.InteractionRuntime(dataModules.interaction.parseHyaInteraction(interactionFixture()), {actionPort: action.port});
  const semanticUpdates = [];
  const semantics = new dataModules.runtime.SemanticsRuntime(dataModules.semantics.parseHyaSemantics(semanticsFixture()),
    {read: id => data.readBinding(id, ['root-local'])}, {update() {}}, {invoke() {}});
  const originalSemantic = semantics.snapshot;
  const effectHosts = [journal(), journal()], effects = effectHosts.map(h => new ProductionTransactionPort(h.host)), machines = effects.map(machine);
  const observations = []; data.subscribe(batch => observations.push(batch));
  let fail = true, rendered;
  const frame = new ProductionFrameTransaction([
    converter.stage('converter-port'), action.stage('action-port'), ...effects.map((port, i) => port.stage('effect-port-' + i)),
    checkpointFrameStage('data-checkpoint', 'input-queue', data, () => ({})),
    checkpointFrameStage('interaction', 'input-queue', interaction, () => {interaction.focus('button'); return {value: interaction.trace};}),
    {id: 'data', phase: 'atomic-data', prepare() {
      data.runTransaction(id => {data.set('root-local', ['title'], 'AB', id); data.set('root-local', ['score'], 8, id); data.trigger('root-local', ['fire'], id);});
      assert.equal(data.readBinding('b-custom'), 16);
      const batch = data.advance(.3, 'prepare'); return {...empty(batch), publish: () => data.publishPreparedAdvance(batch)};
    }},
    stateFrameStage('state', machines, owner => owner.setNumber('blend', data.read('root-local', ['score']) / 10)),
    checkpointFrameStage('layout', 'text-layout', layout, context => ({value: layout.evaluate({viewport: context.request.viewport, dpr: context.request.dpr,
      time: machines[0].clock + context.request.deltaSeconds, strings: {value: data.read('root-local', ['title'])}})})),
    checkpointFrameStage('semantics', 'geometry-draw', semantics, () => {const value = semantics.update(); return {value, publish: () => semanticUpdates.push(value)};}),
    {id: 'draw', phase: 'geometry-draw', prepare(context) {
      const scene = context.values.get('layout'); assert.ok(scene.nodes.find(n => n.kind === 'text').text.runs[0].glyphs[0].paint.commands.length);
      assert.equal(observations.length, 0); assert.equal(semanticUpdates.length, 0);
      assert.equal(effectHosts.flatMap(h => h.delivered).length, 0);
      if (fail) throw Error('draw resources unavailable');
      return {...empty(scene), publish: () => {rendered = scene;}};
    }},
  ]);
  try {
    assert.throws(() => frame.advance(request()), /draw resources unavailable/);
    assert.equal(frame.lastReceipt, undefined); assert.equal(data.read('root-local', ['title']), 'local title'); assert.equal(data.read('root-local', ['fire']), false);
    assert.equal(interaction.trace.focused, null); assert.equal(semantics.snapshot, originalSemantic);
    assert.equal(layout.evaluate({viewport: [240, 600], dpr: 1, time: 0}), originalLayout);
    assert.deepEqual(machines.map(m => m.clock), [0, 0]); assert.deepEqual(machines.map(m => m.getInput('blend')), [0, 0]);
    assert.equal(converterHost.delivered.length + actionHost.delivered.length + observations.length + semanticUpdates.length, 0);
    fail = false; const receipt = frame.advance(request());
    assert.equal(data.read('root-local', ['title']), 'AB'); assert.equal(data.read('root-local', ['fire']), false); assert.equal(interaction.trace.focused, 'button');
    assert.deepEqual(machines.map(m => m.clock), [.3, .3]); assert.equal(observations.length, 1); assert.equal(semanticUpdates.length, 1);
    assert.equal(converterHost.delivered.length, 1); assert.ok(actionHost.delivered.length); assert.ok(effectHosts.every(h => h.delivered.length > 0));
    assert.equal(rendered, receipt.values.layout); assert.equal(rendered.revision, originalLayout.revision + 1);
    assert.equal(frame.advance(request()), receipt); assert.equal(observations.length, 1); assert.equal(semanticUpdates.length, 1);
    for (const host of effectHosts) assert.equal(new Set(host.delivered.map(([effect]) => effect.id)).size, host.delivered.length);
  } finally {frame.dispose(); machines.forEach(m => m.dispose()); semantics.dispose(); interaction.dispose(); data.dispose(); layout.dispose(); text.dispose(); assets.dispose();}
});

test('a second state preparation failure unwinds earlier machines and remains retryable', () => {
  const firstHost = journal(), secondHost = journal(), firstPort = new ProductionTransactionPort(firstHost.host), secondPort = new ProductionTransactionPort(secondHost.host);
  const first = machine(firstPort), second = machine(secondPort); let fail = true;
  const frame = new ProductionFrameTransaction([firstPort.stage('a-port'), secondPort.stage('b-port'), stateFrameStage('states', [first, second], (_owner, index) => {if (fail && index === 1) throw Error('input failure');})]);
  assert.throws(() => frame.advance(request()), /input failure/); assert.equal(first.clock, 0); assert.equal(firstHost.active, undefined); assert.equal(secondHost.active, undefined);
  fail = false; frame.advance(request()); assert.equal(first.clock, .3); assert.equal(second.clock, .3); frame.dispose(); first.dispose(); second.dispose();
});

test('borrowed hosts use separate monotonic transactions and reject overlap without rolling back the other owner', () => {
  const host = journal(), a = new ProductionTransactionPort(host.host), b = new ProductionTransactionPort(host.host);
  const stageA = a.stage('a'), stageB = b.stage('b');
  const held = stageA.prepare({}); assert.throws(() => stageB.prepare({}), /already evaluating/); assert.equal(host.log.filter(e => e[0] === 'rollback').length, 0);
  a.port.begin(1); a.port.invoke('first'); a.port.commit(1); held.commit(); held.publish();
  const next = stageB.prepare({}); b.port.begin(1); b.port.invoke('second'); b.port.commit(1); next.commit(); next.publish();
  a.dispose(); b.dispose(); assert.deepEqual(host.delivered, [['first'], ['second']]); assert.deepEqual(host.log.filter(e => e[0] === 'begin').map(e => e[1]), [1, 2]);
  // Another owner can still use the borrowed host after both wrappers are disposed.
  host.host.begin(3); host.host.invoke('unrelated'); host.host.commit(3); assert.equal(host.delivered.length, 3);
});

test('publication errors do not resend a committed frame or skip other publishers, and callback reentry is rejected', () => {
  const errors = [], published = []; let frame;
  frame = new ProductionFrameTransaction([
    {id: 'observer', phase: 'atomic-data', prepare: () => ({...empty(), publish() {published.push('observer'); assert.throws(() => frame.advance(request(2)), /already active/); throw Error('subscriber failed');}})},
    {id: 'draw', phase: 'geometry-draw', prepare: () => ({...empty(), publish() {published.push('draw');}})},
  ], (error, stage) => errors.push([stage, error.message]));
  const receipt = frame.advance(request()); assert.deepEqual(published, ['observer', 'draw']); assert.equal(frame.stats.publicationErrors, 1);
  assert.equal(frame.advance(request()), receipt); assert.equal(errors.length, 1); assert.equal(published.length, 2); frame.dispose();
});

test('sequence validation and immutable requests prevent accidental replay or changed-input retry', () => {
  let calls = 0;
  const frame = new ProductionFrameTransaction([{id: 'draw', phase: 'geometry-draw', prepare(context) {calls++; assert.ok(Object.isFrozen(context.request.viewport)); return empty(context.request);}}]);
  frame.advance(request(3)); assert.throws(() => frame.advance(request(2)), /sequence/); assert.throws(() => frame.advance({...request(3), dpr: 2}), /sequence/);
  assert.throws(() => frame.advance({...request(4), deltaSeconds: Infinity})); assert.equal(calls, 1); frame.dispose();
});

test('an invalid logical commit fails closed and releases staged borrowed-host transactions', () => {
  const host = journal(), port = new ProductionTransactionPort(host.host);
  const frame = new ProductionFrameTransaction([port.stage('port'), {id: 'broken', phase: 'state-timeline', prepare() {port.port.begin(1); port.port.invoke('pending'); return {commit() {throw Error('commit violated');}, rollback() {}};}}]);
  assert.throws(() => frame.advance(request()), /commit violated/); assert.equal(frame.stats.broken, true); assert.equal(host.active, undefined); assert.equal(host.delivered.length, 0);
  assert.throws(() => frame.advance(request()), /not active/);
});

test('checkpoint preparation failures restore their own owner and checkpoint identities cannot cross owners', () => {
  const create = () => new dataModules.runtime.InteractionRuntime(dataModules.interaction.parseHyaInteraction(interactionFixture()));
  const a = create(), b = create(), token = a.captureFrame();
  assert.throws(() => a.captureFrame()); assert.throws(() => b.restoreFrame(token)); a.releaseFrame(token); assert.throws(() => a.restoreFrame(token));
  const stage = checkpointFrameStage('interaction', 'input-queue', a, () => {a.focus('root'); throw Error('route failed');});
  assert.throws(() => stage.prepare({}), /route failed/); assert.equal(a.trace.focused, null);
  const live = a.captureFrame(); a.dispose(); assert.throws(() => a.restoreFrame(live)); b.dispose();
});

function controllerSetup(extra = {}) {
  const events = journal(), transfers = journal();
  const effects = new ProductionTransactionPort(events.host), ownership = new ProductionTransactionPort(transfers.host);
  const source = stateModules.spec.parseHyaStateMachineV2(stateMachineV2Fixture());
  const controller = new ProductionStateController(source, 'main', {randomSeed: 1234,
    sideEffectPort: {...effects.port, ...lifecycle},
    ownershipPort: {...ownership.port, transfer: change => ownership.port.invoke(change), reset() {}, dispose() {}},
    invocationPort: {begin() {}, invoke() {return false;}, commit() {}, rollback() {}},
  }, {generation: 7, part: 'state-part', instance: 'card:one'});
  let fail = false;
  const stages = [effects.stage('effects'), ownership.stage('ownership'), stateFrameStage('state', [controller], extra.bind),
    {id: 'draw', phase: 'geometry-draw', prepare() {if (fail) throw Error('draw rejected seek'); return empty();}}];
  const frame = new ProductionFrameTransaction(stages);
  return {controller, frame, events, transfers, source, set fail(value) {fail = value;},
    advance(sequence, deltaSeconds = .3) {return frame.advance({...request(sequence), deltaSeconds});}, dispose() {frame.dispose(); controller.dispose();}};
}

test('paused seek rebuilds a real pose with current non-trigger inputs and publishes no crossed effects', () => {
  const env = controllerSetup(), {controller} = env;
  try {
    env.advance(1, .1); controller.pause(); controller.setNumber('blend', .8); controller.setTrigger('go');
    const beforeEvents = env.events.delivered.length; controller.seek(1.3);
    assert.equal(controller.clock, .1); env.advance(2);
    assert.equal(controller.status, 'paused'); assert.equal(controller.clock, 1.3); assert.equal(controller.epoch, 1);
    assert.equal(controller.getInput('go'), false); assert.equal(controller.getInput('blend'), .8);
    assert.equal(controller.lastPose.effects.length, 0); assert.equal(env.events.delivered.length, beforeEvents);
    const oracle = new stateModules.runtime.HyaStateMachineRuntimeV2(env.source, 'main', {randomSeed: 1234,
      sideEffectPort: {begin() {}, invoke() {}, commit() {}, rollback() {}, ...lifecycle},
      ownershipPort: {begin() {}, transfer() {}, commit() {}, rollback() {}, reset() {}, dispose() {}},
      invocationPort: {begin() {}, invoke() {return false;}, commit() {}, rollback() {}},
    });
    oracle.setNumber('blend', .8); const expected = oracle.update(1.3); assert.deepEqual(controller.lastPose.channels, expected.channels); oracle.dispose();
    const clock = controller.clock; env.advance(3, 20); assert.equal(controller.clock, clock); assert.equal(controller.status, 'paused');
  } finally {env.dispose();}
});

test('seek is tentative through drawing and retry commits one new epoch while retaining the old paused pose on failure', () => {
  const env = controllerSetup(), {controller} = env;
  try {
    env.advance(1, .3); controller.pause(); const before = controller.lastPose, beforeEvents = env.events.delivered.length;
    controller.seek(.8); env.fail = true; assert.throws(() => env.advance(2), /draw rejected seek/);
    assert.equal(controller.lastPose, before); assert.equal(controller.clock, .3); assert.equal(controller.epoch, 0); assert.equal(controller.status, 'paused');
    assert.equal(env.events.delivered.length, beforeEvents); env.fail = false; env.advance(2);
    assert.equal(controller.clock, .8); assert.equal(controller.epoch, 1); assert.equal(controller.status, 'paused'); assert.equal(env.events.delivered.length, beforeEvents);
  } finally {env.dispose();}
});

test('subsequent forward crossings deliver once in each seek epoch with player, part and instance identities', () => {
  const env = controllerSetup(), {controller} = env;
  try {
    controller.seek(.4); env.advance(1); assert.equal(env.events.delivered.length, 0);
    env.advance(2, .2); const first = env.events.delivered.map(([event]) => event); assert.ok(first.some(event => event.channel.id === 'audio.play'));
    assert.ok(first.every(event => {const token = JSON.parse(event.id); return token[0] === 7 && token[1] === 1 && token[2] === 'state-part' && token[3] === 'card:one';}));
    const count = env.events.delivered.length; env.advance(2, .2); assert.equal(env.events.delivered.length, count);
    controller.seek(.4); env.advance(3); assert.equal(env.events.delivered.length, count); env.advance(4, .2);
    const all = env.events.delivered.map(([event]) => event); assert.equal(new Set(all.map(event => event.id)).size, all.length);
    assert.ok(all.slice(count).every(event => JSON.parse(event.id)[1] === 2));
  } finally {env.dispose();}
});

test('stopped seek reaches the requested pose and remains stopped; stop returns to initial pose at a frame boundary', () => {
  const env = controllerSetup(), {controller} = env;
  try {
    env.advance(1); controller.stop(); controller.seek(.7); env.advance(2);
    assert.equal(controller.clock, .7); assert.equal(controller.status, 'stopped'); assert.equal(controller.lastPose.effects.length, 0);
    env.advance(3, 10); assert.equal(controller.clock, .7); assert.equal(controller.status, 'stopped');
    controller.stop(); env.advance(4); assert.equal(controller.clock, 0); assert.equal(controller.status, 'stopped');
    controller.resume(); env.advance(5, .1); assert.equal(controller.clock, .1); assert.equal(controller.status, 'running');
  } finally {env.dispose();}
});

test('resource ownership across a silent rebuild names the committed previous asset instead of the schema default', () => {
  const env = controllerSetup(), {controller} = env;
  try {
    controller.seek(1.2); env.advance(1); const first = env.transfers.delivered.map(([change]) => change).find(change => change.channel.id === 'resource.asset');
    assert.equal(first.previous, 'a'); assert.equal(first.next, 'b'); const count = env.transfers.delivered.length;
    controller.seek(.2); env.advance(2); const next = env.transfers.delivered.slice(count).map(([change]) => change).find(change => change.channel.id === 'resource.asset');
    assert.equal(next.previous, 'b'); assert.equal(next.next, 'a'); assert.equal(env.events.delivered.length, 0);
  } finally {env.dispose();}
});

test('controller transport and disposal do not reset, pause, stop or dispose borrowed host ports', () => {
  const calls = [], source = stateModules.spec.parseHyaStateMachineV2(stateMachineV2Fixture());
  const controller = new ProductionStateController(source, 'main', {sideEffectPort: {begin() {}, invoke() {}, commit() {}, rollback() {},
    ...Object.fromEntries(['reset', 'pause', 'resume', 'stop', 'dispose'].map(name => [name, () => calls.push(name)]))},
    ownershipPort: {begin() {}, transfer() {}, commit() {}, rollback() {}, reset() {calls.push('ownership reset');}, dispose() {calls.push('ownership dispose');}},
    invocationPort: {begin() {}, invoke() {return false;}, commit() {}, rollback() {}},
  });
  controller.pause(); controller.resume(); controller.seek(.3); const pose = controller.prepareFrame(0); controller.commitPreparedFrame(pose); controller.publishPreparedFrame();
  controller.stop(); controller.dispose(); controller.dispose(); assert.deepEqual(calls, []); assert.throws(() => controller.prepareFrame(0), /disposed/);
});

test('two real controllers share one host frame while keeping local transaction numbers and event identities independent', () => {
  const host = journal(), effects = new ProductionTransactionPort(host.host);
  const source = stateModules.spec.parseHyaStateMachineV2(stateMachineV2Fixture());
  const controllers = ['one', 'two'].map(instance => new ProductionStateController(source, 'main', {
    sideEffectPort: {...effects.createPort(), ...lifecycle},
    ownershipPort: {begin() {}, transfer() {}, commit() {}, rollback() {}, reset() {}, dispose() {}},
    invocationPort: {begin() {}, invoke() {return false;}, commit() {}, rollback() {}},
  }, {generation: 1, part: 'state', instance}));
  const frame = new ProductionFrameTransaction([effects.stage('shared-host'), stateFrameStage('states', controllers)]);
  try {
    frame.advance(request()); assert.equal(host.log.filter(entry => entry[0] === 'begin').length, 1);
    assert.equal(host.log.filter(entry => entry[0] === 'commit').length, 1); assert.equal(host.delivered.length, 2);
    assert.equal(new Set(host.delivered.map(([event]) => event.id)).size, 2);
    assert.deepEqual(host.delivered.map(([event]) => JSON.parse(event.id)[3]).sort(), ['one', 'two']);
  } finally {frame.dispose(); controllers.forEach(controller => controller.dispose());}
});

test('local port ownership cannot be borrowed from another active runtime namespace', () => {
  const host = journal(), bridge = new ProductionTransactionPort(host.host), a = bridge.createPort(), b = bridge.createPort();
  const step = bridge.stage('port').prepare({}); a.begin(1);
  assert.throws(() => b.invoke('stolen'), /live local/); assert.throws(() => b.commit(1), /identity/);
  b.begin(1); a.invoke('a'); b.invoke('b'); a.commit(1); b.commit(1); step.commit(); step.finalize(); step.publish();
  assert.deepEqual(host.delivered, [['a'], ['b']]); bridge.dispose();
});

test('an unclosed local host transaction is an internal commit failure, never an apparent successful receipt', () => {
  const host = journal(), bridge = new ProductionTransactionPort(host.host);
  const frame = new ProductionFrameTransaction([bridge.stage('port'), {id: 'invalid-owner', phase: 'atomic-data', prepare() {
    bridge.port.begin(1); bridge.port.invoke('pending'); return empty();
  }}]);
  assert.throws(() => frame.advance(request()), /incomplete local/); assert.equal(frame.stats.broken, true);
  assert.equal(frame.lastReceipt, undefined); assert.equal(host.delivered.length, 0); assert.equal(host.active, undefined);
});

test('nested generations never repeat across silent rebuilds, rollback or players sharing one borrowed factory', () => {
  const source = stateMachineV2Fixture(); source.stateMachines[0].layers[0].transitions[0].to = 'nested';
  const generations = [], disposed = [];
  const factory = {create(_component, generation) {generations.push(generation); return {
    setInput() {}, evaluate() {return {contributions: [], settled: true};}, beginTransaction() {}, commitTransaction() {}, rollbackTransaction() {},
    reset() {}, pause() {}, resume() {}, stop() {}, dispose() {disposed.push(generation);},
  };}};
  const controllers = [0, 1].map(index => new ProductionStateController(stateModules.spec.parseHyaStateMachineV2(source), 'main', {
    nestedFactory: factory, sideEffectPort: {begin() {}, invoke() {}, commit() {}, rollback() {}, ...lifecycle},
    ownershipPort: {begin() {}, transfer() {}, commit() {}, rollback() {}, reset() {}, dispose() {}},
    invocationPort: {begin() {}, invoke() {return false;}, commit() {}, rollback() {}},
  }, {generation: index, part: 'state', instance: String(index)}));
  try {
    for (const owner of controllers) {
      owner.seek(.1); let pose = owner.prepareFrame(0); owner.commitPreparedFrame(pose); owner.publishPreparedFrame();
      owner.seek(.2); pose = owner.prepareFrame(0); owner.rollbackPreparedFrame(pose);
      pose = owner.prepareFrame(0); owner.commitPreparedFrame(pose); owner.publishPreparedFrame();
    }
    assert.equal(new Set(generations).size, 6); assert.deepEqual(generations, [1, 2, 3, 4, 5, 6]);
  } finally {controllers.forEach(owner => owner.dispose());}
  assert.deepEqual(disposed.sort((a, b) => a - b), generations);
});
