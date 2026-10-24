import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
import {dataBindingFixture, loadG07Modules} from './data-binding-parity-fixture.mjs';
import {productionFontFixture} from './text-production-font-fixture.mjs';
import {loadStateMachineV2Modules, stateMachineV2Fixture} from './state-machine-v2-parity-fixture.mjs';
const [layout, data, state] = await Promise.all([loadResponsiveLayoutModules(), loadG07Modules(), loadStateMachineV2Modules()]);
const {ProductionDataOwner, ProductionFrameTransaction, ProductionCompositionOwner} = layout.frameProduction;
const request = (sequence, deltaSeconds = .3) => ({sequence, deltaSeconds, viewport: [150, 600], dpr: 1});
const empty = () => ({commit() {}, rollback() {}});

function dataEnvironment(options = {}) {
  const errors = [], owner = new ProductionDataOwner(data.data.parseHyaDataBinding(dataBindingFixture()), {diagnostic: error => errors.push(error), ...options});
  let fail = false;
  const frame = new ProductionFrameTransaction([...owner.stages('data'), {id: 'geometry', phase: 'geometry-draw', prepare() {if (fail) throw Error('geometry unavailable'); return empty();}}]);
  return {owner, frame, errors, set fail(value) {fail = value;}, dispose() {frame.dispose(); owner.dispose();}};
}

test('queued data writers execute once, preserve value snapshots, and survive downstream rollback without notifying observers', () => {
  const env = dataEnvironment(); let calls = 0, writer; const observations = [], value = [0, 1, 0, 1];
  env.owner.subscribe(changes => observations.push(changes));
  try {
    env.owner.run(write => {calls++; writer = write; write.set('root-local', ['color'], value); write.trigger('root-local', ['fire']);}); value[0] = 1;
    assert.throws(() => writer.set('root-local', ['score'], 2), /expired/); assert.equal(env.owner.read('root-local', ['fire']), false);
    env.fail = true; assert.throws(() => env.frame.advance(request(1)), /geometry unavailable/);
    assert.equal(calls, 1); assert.equal(observations.length, 0); assert.equal(env.owner.stats.pending, 1); assert.equal(env.owner.read('root-local', ['fire']), false);
    env.fail = false; const frame = env.frame.advance(request(1)); assert.equal(calls, 1); assert.equal(observations.length, 1); assert.equal(env.owner.stats.pending, 0);
    assert.deepEqual([...env.owner.read('root-local', ['color'])], [0, 1, 0, 1]); assert.equal(env.owner.read('root-local', ['fire']), false);
    assert.ok(Object.isFrozen(observations[0])); assert.ok(Object.isFrozen(observations[0][0].value));
    assert.equal(env.frame.advance(request(1)), frame); assert.equal(observations.length, 1);
  } finally {env.dispose();}
});

test('observer writes queue the next frame and a throwing observer cannot skip peers or resend the current batch', () => {
  const env = dataEnvironment(), values = [];
  env.owner.subscribe(() => {env.owner.run(write => write.set('root-local', ['score'], 10)); throw Error('observer failed');});
  env.owner.subscribe(() => values.push(env.owner.read('root-local', ['score'])));
  try {
    env.owner.run(write => write.set('root-local', ['score'], 4)); env.frame.advance(request(1));
    assert.deepEqual(values, [4]); assert.equal(env.owner.read('root-local', ['score']), 4); assert.equal(env.owner.stats.pending, 1); assert.equal(env.errors.length, 1);
    env.frame.advance(request(1)); assert.deepEqual(values, [4]); env.frame.advance(request(2)); assert.deepEqual(values, [4, 10]);
  } finally {env.dispose();}
});

test('invalid collected transactions restore prior trigger state and do not poison later valid transactions', () => {
  const env = dataEnvironment();
  try {
    env.owner.run(write => {write.trigger('root-local', ['fire']); write.set('root-local', ['score'], 'invalid');});
    env.owner.run(write => write.set('root-local', ['score'], 6)); const receipt = env.frame.advance(request(1));
    assert.equal(env.owner.read('root-local', ['score']), 6); assert.equal(env.owner.read('root-local', ['fire']), false);
    assert.equal(receipt.values.data.changes.length, 1); assert.equal(receipt.values.data.changes[0].kind, 'set'); assert.equal(env.errors.length, 1); assert.equal(env.owner.stats.pending, 0);
  } finally {env.dispose();}
});

test('prepared binding reads memoize edge converters per instance while public reads reject half-prepared state', () => {
  const owner = new ProductionDataOwner(data.data.parseHyaDataBinding(dataBindingFixture())); let observed;
  const frame = new ProductionFrameTransaction([...owner.stages('data'), {id: 'state', phase: 'state-timeline', prepare() {
    assert.throws(() => owner.read('root-local', ['score']), /during frame preparation/);
    assert.throws(() => owner.run(() => {}), /during frame preparation/);
    const first = owner.readBindingPrepared('b-edge'), next = owner.readBindingPrepared('b-edge'); assert.equal(first, next); observed = first; return empty();
  }}]);
  try {
    assert.equal(owner.readBinding('b-edge'), false); owner.run(write => write.set('root-local', ['enabled'], false)); frame.advance(request(1));
    assert.equal(observed, true); assert.equal(owner.readBinding('b-edge'), true); assert.equal(owner.readBinding('b-edge'), true);
  } finally {frame.dispose(); owner.dispose();}
});

test('custom converter transactions are deferred across the frame; public committed reads share a bounded per-frame cache', () => {
  let pending, calls = 0, commits = 0, rollbacks = 0;
  const converter = {begin() {pending = [];}, invoke(request) {calls++; pending.push(request.value); return request.value * 2;}, commit() {commits++; pending = undefined;}, rollback() {rollbacks++; pending = undefined;}};
  const owner = new ProductionDataOwner(data.data.parseHyaDataBinding(dataBindingFixture()), {converter}); let fail = true;
  const frame = new ProductionFrameTransaction([...owner.stages('data'), {id: 'layout', phase: 'text-layout', prepare() {
    const a = owner.readBindingPrepared('b-custom'), b = owner.readBindingPrepared('b-custom'); assert.equal(a, b); assert.ok(pending); if (fail) throw Error('text failed'); return empty();
  }}]);
  try {
    assert.equal(owner.readBinding('b-custom'), 4.69); assert.equal(owner.readBinding('b-custom'), 4.69); assert.equal(calls, 1); assert.equal(commits, 1);
    assert.throws(() => frame.advance(request(1)), /text failed/); assert.equal(rollbacks, 1); assert.equal(commits, 1);
    fail = false; frame.advance(request(1)); assert.equal(commits, 2); const count = calls; assert.equal(owner.readBinding('b-custom'), 4.69); assert.equal(calls, count);
  } finally {frame.dispose(); owner.dispose();}
});

test('queued data rejects hidden/accessor/symbol/cyclic metadata without executing getters, and cannot resurrect after callback disposal', () => {
  const env = dataEnvironment(); let reads = 0;
  try {
    const hidden = {}; Object.defineProperty(hidden, 'secret', {value: 1}); const accessor = {}; Object.defineProperty(accessor, 'value', {enumerable: true, get() {reads++; return 1;}});
    const symbol = {[Symbol('x')]: 1}, cyclic = {}; cyclic.self = cyclic;
    for (const value of [hidden, accessor, symbol, cyclic]) assert.throws(() => env.owner.run(write => write.set('root-local', ['color'], value)));
    assert.equal(reads, 0); assert.equal(env.owner.stats.pending, 0);
    assert.throws(() => env.owner.run(write => {env.owner.dispose(); write.set('root-local', ['score'], 5);}), /disposed/); assert.equal(env.owner.stats.pending, 0);
  } finally {env.dispose();}
});

async function compositionSetup({secondData = false, withState = true, mutate = () => {}} = {}) {
  const font = productionFontFixture(), source = font.document, itemBlock = structuredClone(source.textBlocks[0]); itemBlock.id = 'item-label'; source.textBlocks.push(itemBlock);
  const item = source.artboards[0]; item.id = 'item'; item.nodes[1].text = 'item-label'; item.nodes[1].style.width = {unit: 'fill'};
  source.artboards = [{id: 'main', width: 150, height: 600, root: 'root', nodes: [
    {id: 'root', kind: 'container', style: {direction: 'column'}},
    {id: 'title', parent: 'root', kind: 'text', text: 'label', style: {width: {unit: 'fill'}, height: {unit: 'hug'}}},
    {id: 'list', parent: 'root', kind: 'list', style: {width: {unit: 'fill'}, height: {unit: 'point', value: 240}}, list: {dataPort: 'rows', templateArtboard: 'item', direction: 'column', itemExtent: 120, virtualize: true}},
  ]}, item];
  const layoutDocument = layout.spec.parseResponsiveLayoutDocument(source), assets = new layout.runtime.LayoutAssetOwner(layoutDocument, {policy: {mode: 'deny'}});
  const dataSource = dataBindingFixture(); dataSource.instances.find(value => value.id === 'root-local').values.title = 'A'; dataSource.instances.find(value => value.id === 'item-1').values.name = 'A'; dataSource.instances.find(value => value.id === 'item-2').values.name = 'B';
  dataSource.bindings = [
    {id: 'title', target: 'title', targetPath: ['strings', 'value'], source: {mode: 'explicit', instance: 'root-local', path: ['title']}, direction: 'two-way'},
    {id: 'rows', target: 'rows', targetPath: ['items'], source: {mode: 'explicit', instance: 'root-local', path: ['items']}, direction: 'two-way'},
    {id: 'row-name', target: 'item-label', targetPath: ['strings', 'value'], source: {mode: 'auto', model: 'Item', path: ['name']}, direction: 'two-way'},
    ...(withState ? [{id: 'go', target: 'go', targetPath: ['value'], source: {mode: 'explicit', instance: 'root-local', path: ['fire']}, direction: 'read'}] : []),
  ];
  // The unused fixture converters remain format-valid; provide its declared custom protocol for strict preflight.
  const converter = {protocols: new Set(['haiyue.converter.fixture@1']), begin() {}, invoke(request) {return request.value * 2;}, commit() {}, rollback() {}};
  const stateSource = stateMachineV2Fixture(); stateSource.components = []; stateSource.stateMachines[0].layers[0].states = stateSource.stateMachines[0].layers[0].states.filter(value => value.id !== 'nested'); stateSource.stateMachines[0].layers[0].transitions = stateSource.stateMachines[0].layers[0].transitions.filter(value => !['nest', 'leave-nested'].includes(value.id));
  const stateDocument = state.spec.parseHyaStateMachineV2(stateSource);
  const definition = {parts: [
    {id: 'data', kind: 'data', dependencies: ['layout', ...(withState ? ['state'] : [])], document: data.data.parseHyaDataBinding(dataSource), options: {converter}},
    {id: 'layout', kind: 'layout', dependencies: [], document: layoutDocument, fonts: layout.outlineProduction.createProductionOutlineFontPort(assets)},
    ...(withState ? [{id: 'state', kind: 'state', dependencies: [], document: stateDocument, roots: ['main'],
      conditions: {protocols: new Set(['fixture-condition@1', 'fixture-observable@1']), begin() {}, invoke() {return false;}, commit() {}, rollback() {}},
      ownership: {begin() {}, transfer() {}, commit() {}, rollback() {}, reset() {}, dispose() {}}}] : []),
  ], targets: [
    {id: 'title', part: 'layout', kind: 'text-block', address: ['label']},
    {id: 'rows', part: 'layout', kind: 'layout-node', address: ['main', 'list']},
    {id: 'item-label', part: 'layout', kind: 'text-block', address: ['item-label']},
    ...(withState ? [{id: 'go', part: 'state', kind: 'state-input', address: ['main', 'go']}] : []),
  ]};
  if (secondData) {const second = dataBindingFixture(); second.bindings = []; definition.parts.push({id: 'second', kind: 'data', dependencies: [], document: data.data.parseHyaDataBinding(second), options: {converter}});}
  mutate(definition);
  const errors = [], events = [], observations = []; let fail = false;
  const owner = await ProductionCompositionOwner.create(definition, {invalidate() {}, diagnostic: (error, id) => errors.push({error, id}), events: value => events.push(...value),
    draw(frame) {assert.throws(() => owner.read({part: 'data', id: 'root-local'}, ['score']), /during frame preparation/); if (fail) throw Error('drawing not ready'); return empty();}});
  owner.subscribe(changes => observations.push(changes));
  return {owner, errors, events, observations, assets, definition, set fail(value) {fail = value;}, dispose() {owner.dispose(); assets.dispose();}};
}

test('one composition owns queued data, trigger/state sampling and real-font per-row layout through a single draw boundary', async () => {
  const env = await compositionSetup(); let callbacks = 0;
  try {
    env.owner.run(write => {callbacks++; write.set('root-local', ['items'], ['item-1', 'item-2']); write.set('root-local', ['title'], 'AB'); write.trigger('root-local', ['fire']);});
    env.fail = true; assert.throws(() => env.owner.advance(request(1)), /drawing not ready/); assert.equal(env.owner.lastFrame, undefined);
    assert.equal(env.owner.read('root-local', ['title']), 'A'); assert.equal(env.events.length, 0); assert.equal(env.observations.length, 0); assert.equal(callbacks, 1);
    env.fail = false; const frame = env.owner.advance(request(1)); assert.equal(callbacks, 1); assert.equal(env.observations.length, 1); assert.ok(env.events.length);
    const texts = frame.layouts.layout.nodes.filter(value => value.kind === 'text');
    assert.deepEqual(texts.map(value => value.text.runs.flatMap(run => run.glyphs.map(glyph => glyph.sequence)).join('')), ['AB', 'A', 'B']);
    assert.ok(texts.every(value => value.text.runs[0].glyphs[0].paint.commands.length)); assert.equal(frame.states.state.length, 1);
    assert.equal(env.owner.read('root-local', ['fire']), false); const count = env.events.length; assert.equal(env.owner.advance(request(1)), frame); assert.equal(env.events.length, count);
  } finally {env.dispose();}
});

test('model list reorder keeps row identity and swaps only the scoped data/model association', async () => {
  const env = await compositionSetup({withState: false});
  try {
    env.owner.run(write => write.set('root-local', ['items'], ['item-1', 'item-2'])); const first = env.owner.advance(request(1));
    const rows = first.layouts.layout.nodes.filter(value => value.artboard === 'item' && value.kind === 'text');
    env.owner.run(write => {write.move('root-local', ['items'], 0, 1); write.set('item-1', ['name'], 'AB');}); const next = env.owner.advance(request(2));
    const after = next.layouts.layout.nodes.filter(value => value.artboard === 'item' && value.kind === 'text');
    assert.deepEqual(after.map(value => value.instance), [rows[1].instance, rows[0].instance]);
    assert.deepEqual(after.map(value => value.text.runs.flatMap(run => run.glyphs.map(glyph => glyph.sequence)).join('')), ['B', 'AB']);
  } finally {env.dispose();}
});

test('cross-part invalid transactions roll every touched original data runtime back and do not poison subsequent work', async () => {
  const env = await compositionSetup({secondData: true, withState: false});
  const a = {part: 'data', id: 'root-local'}, b = {part: 'second', id: 'root-local'};
  try {
    assert.throws(() => env.owner.read('root-local', ['score']), /ambiguous/);
    env.owner.run(write => {write.set(a, ['score'], 50); write.set(b, ['score'], 'invalid');});
    const first = env.owner.advance(request(1)); assert.equal(first.changes.length, 0); assert.equal(env.owner.read(a, ['score']), 2.345); assert.equal(env.owner.read(b, ['score']), 2.345); assert.equal(env.errors.length, 1);
    const id = env.owner.run(write => {write.set(a, ['score'], 4); write.set(b, ['score'], 8);}); const next = env.owner.advance(request(2));
    assert.deepEqual(next.changes.map(change => [change.part, change.transaction, change.value]), [['data', id, 4], ['second', id, 8]]); assert.equal(env.observations.length, 1);
  } finally {env.dispose();}
});

test('composed observers queue writes for the next frame and peers still receive one immutable batch', async () => {
  const env = await compositionSetup({withState: false}); const values = [];
  try {
    env.owner.subscribe(() => {env.owner.run(write => write.set('root-local', ['title'], 'B')); throw Error('observer failure');});
    env.owner.subscribe(changes => {assert.ok(Object.isFrozen(changes)); values.push(env.owner.read('root-local', ['title']));});
    env.owner.run(write => write.set('root-local', ['title'], 'AB')); env.owner.advance(request(1)); assert.deepEqual(values, ['AB']);
    env.owner.advance(request(1)); assert.deepEqual(values, ['AB']); env.owner.advance(request(2)); assert.deepEqual(values, ['AB', 'B']);
  } finally {env.dispose();}
});

test('missing binding/host protocols are rejected before any font acquisition', async () => {
  let acquisitions = 0;
  await assert.rejects(compositionSetup({mutate(definition) {
    definition.parts.find(part => part.kind === 'layout').fonts = {async acquire() {acquisitions++; throw Error('must not acquire');}};
    definition.parts.find(part => part.kind === 'data').options = undefined;
  }}), /protocol/); assert.equal(acquisitions, 0);
});

test('property groups require an explicit model instance and retain one cross-part transaction identity', async () => {
  const env = await compositionSetup({withState: false});
  try {
    const id = env.owner.run(write => write.group('activate', 'root-local')); const frame = env.owner.advance(request(1));
    assert.equal(env.owner.read('root-local', ['enabled']), true); assert.deepEqual([...env.owner.read('root-local', ['items'])], ['item-1', 'item-2']);
    assert.ok(frame.changes.every(change => change.transaction === id)); assert.equal(frame.changes.filter(change => change.kind === 'trigger').length, 1);
  } finally {env.dispose();}
});

test('scoped list selections, cursors and RTL styles use the same per-instance real glyph geometry', async () => {
  const env = await compositionSetup({withState: false, mutate(definition) {
    const part = definition.parts.find(part => part.kind === 'data'), source = structuredClone(part.document);
    source.models.find(model => model.id === 'Item').properties.push({id: 'selection', kind: 'list', item: {kind: 'integer'}, defaultValue: [0, 0]}, {id: 'cursor', kind: 'integer', defaultValue: 0}, {id: 'direction', kind: 'string', defaultValue: 'ltr'});
    Object.assign(source.instances.find(instance => instance.id === 'item-1').values, {name: 'אב', selection: [0, 1], cursor: 1, direction: 'rtl'});
    Object.assign(source.instances.find(instance => instance.id === 'item-2').values, {name: 'AB', selection: [0, 0], cursor: 0});
    for (const [id, field, path] of [['selection', 'selection', ['selections', 'selection']], ['cursor', 'cursor', ['cursors', 'cursor']], ['direction', 'direction', ['styles', 'body', 'direction']]])
      source.bindings.push({id, target: 'item-label', targetPath: path, source: {mode: 'auto', model: 'Item', path: [field]}, direction: 'two-way'});
    part.document = data.data.parseHyaDataBinding(source);
  }});
  try {
    env.owner.run(write => write.set('root-local', ['items'], ['item-1', 'item-2'])); const frame = env.owner.advance(request(1));
    const rows = frame.layouts.layout.nodes.filter(node => node.kind === 'text' && node.artboard === 'item');
    assert.deepEqual(rows.map(node => node.text.runs.flatMap(run => run.glyphs.map(glyph => glyph.sequence)).join('')), ['בא', 'AB']);
    assert.equal(rows[0].text.controls.some(control => control.kind === 'selection'), true); assert.equal(rows[1].text.controls.some(control => control.kind === 'selection'), false);
    assert.notEqual(rows[0].text.controls.find(control => control.kind === 'cursor').rect[0], rows[1].text.controls.find(control => control.kind === 'cursor').rect[0]);
  } finally {env.dispose();}
});

test('compiled metadata is immutable and later caller edits do not replace a target or document', async () => {
  const env = await compositionSetup({withState: false});
  try {
    assert.ok(Object.isFrozen(env.owner.definition)); assert.ok(Object.isFrozen(env.owner.definition.parts[0].document));
    env.definition.targets[0].address[0] = 'missing'; env.definition.parts[0].document = {};
    const frame = env.owner.advance(request(1)); assert.ok(frame.layouts.layout.nodes.some(node => node.kind === 'text'));
  } finally {env.dispose();}
});

test('static real-font layout updates only instance times on a clock-only frame and performs zero extra box solving', async () => {
  const source = layout.spec.parseResponsiveLayoutDocument(productionFontFixture().document), assets = new layout.runtime.LayoutAssetOwner(source, {policy: {mode: 'deny'}});
  const text = new layout.textProduction.ProductionTextOwner(source, layout.outlineProduction.createProductionOutlineFontPort(assets)); await text.prepare();
  const owner = new layout.layoutProduction.ProductionLayoutOwner(source, text);
  try {
    const first = owner.evaluate({viewport: [150, 600], dpr: 1, time: 0}), shapes = owner.stats.shapes;
    const next = owner.evaluate({viewport: [150, 600], dpr: 1, time: .1});
    assert.equal(owner.stats.layoutPasses, 0); assert.equal(owner.stats.shapes, shapes); assert.equal(next.nodes, first.nodes); assert.deepEqual([...next.instances[0].times], [.1]);
    assert.throws(() => owner.evaluate({viewport: [150, 600], dpr: 1, time: .1, bindingRevision: 'private'}), /unknown layout request member/);
  } finally {owner.dispose(); text.dispose(); assets.dispose();}
});

test('aborted composition preparation releases a late font handle exactly once and never closes the borrowed host', async () => {
  let releaseGate, released = 0, acquisitions = 0;
  const gate = new Promise(resolve => releaseGate = resolve), signal = new AbortController();
  const definition = {parts: [{id: 'layout', kind: 'layout', dependencies: [], document: layout.spec.parseResponsiveLayoutDocument(productionFontFixture().document),
    fonts: {async acquire() {acquisitions++; await gate; return {shape() {throw Error('must not shape');}, release() {released++;}};}}}], targets: []};
  const pending = ProductionCompositionOwner.create(definition, {invalidate() {}}, signal.signal); assert.equal(acquisitions, 1);
  signal.abort(); releaseGate(); await assert.rejects(pending, /cancel|disposed|abort/i); assert.equal(released, 1);
});

test('queued interpolation uses this frame delta from the last committed value without a one-frame lag or double advancement', () => {
  const owner = new ProductionDataOwner(data.data.parseHyaDataBinding(dataBindingFixture())); let value;
  const frame = new ProductionFrameTransaction([...owner.stages('data'), {id: 'layout', phase: 'text-layout', prepare() {value = owner.readBindingPrepared('b-score-smooth'); return empty();}}]);
  try {
    assert.equal(owner.readBinding('b-score-smooth'), 2.345);
    owner.run(write => write.set('root-local', ['score'], 10)); frame.advance(request(1, .5));
    assert.ok(Math.abs(value - 6.1725) < .001, String(value));
    owner.run(write => write.set('root-local', ['score'], 20)); frame.advance(request(2, .5));
    assert.ok(Math.abs(value - 13.08625) < .001, String(value));
    assert.equal(owner.readBinding('b-score-smooth'), value);
  } finally {frame.dispose(); owner.dispose();}
});

test('equivalent auto-context paths share one resolved-model interpolation step', () => {
  const source = dataBindingFixture(); source.bindings.find(binding => binding.id === 'b-score-smooth').source = {mode: 'auto', model: 'Root', path: ['score']};
  const owner = new ProductionDataOwner(data.data.parseHyaDataBinding(source)); let values;
  const frame = new ProductionFrameTransaction([...owner.stages('data'), {id: 'layout', phase: 'text-layout', prepare() {
    values = [owner.readBindingPrepared('b-score-smooth', ['root-local']), owner.readBindingPrepared('b-score-smooth', ['root-local', 'root-global'])]; return empty();
  }}]);
  try {
    frame.advance(request(1, 0)); owner.run(write => write.set('root-local', ['score'], 10)); frame.advance(request(2, .5));
    assert.ok(Math.abs(values[0] - 6.1725) < .001); assert.equal(values[0], values[1]);
  } finally {frame.dispose(); owner.dispose();}
});

test('large admitted property-group batches avoid argument-count limits and publish all immutable changes', () => {
  const source = dataBindingFixture(); source.propertyGroups.push({id: 'bulk', version: 1, operations: Array.from({length: 1000}, (_, value) => ({op: 'set', path: ['score'], value}))});
  const owner = new ProductionDataOwner(data.data.parseHyaDataBinding(source)); let received;
  const frame = new ProductionFrameTransaction(owner.stages('data')); owner.subscribe(changes => received = changes);
  try {
    owner.run(write => {for (let index = 0; index < 150; index++) write.group('bulk', 'root-local');});
    frame.advance(request(1)); assert.equal(received.length, 150000); assert.ok(Object.isFrozen(received)); assert.ok(Object.isFrozen(received.at(-1))); assert.equal(owner.read('root-local', ['score']), 999);
  } finally {frame.dispose(); owner.dispose();}
});

test('expanded property-group work observes the existing million-operation ceiling before mutation and does not poison the queue', () => {
  const source = dataBindingFixture(); source.propertyGroups.push({id: 'bulk', version: 1, operations: Array.from({length: 1000}, () => ({op: 'set', path: ['score'], value: 8}))});
  const errors = [], owner = new ProductionDataOwner(data.data.parseHyaDataBinding(source), {diagnostic: error => errors.push(error)});
  const frame = new ProductionFrameTransaction(owner.stages('data'));
  try {
    owner.run(write => {for (let index = 0; index < 1001; index++) write.group('bulk', 'root-local');}); frame.advance(request(1));
    assert.equal(owner.read('root-local', ['score']), 2.345); assert.equal(errors.length, 1); assert.equal(errors[0].code, 'E_DATA_RUNTIME_LIMIT'); assert.equal(owner.stats.pending, 0);
    owner.run(write => write.set('root-local', ['score'], 7)); frame.advance(request(2)); assert.equal(owner.read('root-local', ['score']), 7);
  } finally {frame.dispose(); owner.dispose();}
});

test('the composition wrapper validates the complete frame before reading input accessors or advancing any owner', async () => {
  const env = await compositionSetup({withState: false}); let reads = 0;
  try {
    const value = request(1); Object.defineProperty(value, 'input', {enumerable: true, get() {reads++; throw Error('must not execute');}});
    assert.throws(() => env.owner.advance(value), error => error.code === 'E_HYA_RUNTIME_FRAME'); assert.equal(reads, 0); assert.equal(env.owner.lastFrame, undefined);
    const frame = env.owner.advance(request(1)); assert.equal(frame.sequence, 1);
  } finally {env.dispose();}
});
