import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
import {productionFontFixture} from './text-production-font-fixture.mjs';
const {spec, runtime, textProduction: {ProductionTextOwner}, outlineProduction: {createProductionOutlineFontPort}, layoutProduction: {ProductionLayoutOwner}} = await loadResponsiveLayoutModules();
const point = value => ({unit: 'point', value});
const percent = value => ({unit: 'percent', value});
async function setup(mutate = () => {}, options = {}, limits) {
  const {document: source} = productionFontFixture();
  source.artboards[0].nodes[1].style = {width: percent(100), height: {unit: 'hug'}};
  mutate(source);
  const document = spec.parseResponsiveLayoutDocument(source), assets = new runtime.LayoutAssetOwner(document, {policy: {mode: 'deny'}});
  const text = new ProductionTextOwner(document, createProductionOutlineFontPort(assets)); await text.prepare();
  const layout = new ProductionLayoutOwner(document, text, options, limits);
  return {document, assets, text, layout, dispose() {layout.dispose(); text.dispose(); assets.dispose();}};
}
const request = (width = 240, extra = {}) => ({viewport: [width, 600], dpr: 1, time: 0, ...extra});
const textNodes = frame => frame.nodes.filter(node => node.kind === 'text');

test('real text/layout snapshots retain authored selection radius and rounded ancestor clip shapes', async () => {
  const env = await setup(source => {source.textBlocks[0].input.selectionRadius = 4; source.artboards[0].nodes[0].visual = {clip: true, cornerRadius: [6, 7, 8, 9]};});
  try {
    const frame = env.layout.evaluate(request(240, {selections: {selection: [0, 1]}, cursors: {cursor: 1}})), node = textNodes(frame)[0];
    assert.equal(node.text.controls.length, 2); assert.ok(node.text.controls.every(control => control.radius === 4));
    assert.deepEqual(node.clipShapes[0].radii, [6, 7, 8, 9]); assert.ok(Object.isFrozen(node.clipShapes)); assert.ok(Object.isFrozen(node.clipShapes[0].radii));
  } finally {env.dispose();}
});

test('one real-font layout reuses HYA core, wraps at assigned width, propagates hug height and retains actual outlines', async () => {
  const env = await setup(source => {
    source.artboards[0].nodes.push({id: 'after', parent: 'root', kind: 'leaf', style: {width: point(10), height: point(10)}});
  });
  try {
    const wide = env.layout.evaluate(request()), narrow = env.layout.evaluate(request(150));
    assert.deepEqual(textNodes(wide)[0].rect, [0, 0, 240, 120]);
    assert.deepEqual(textNodes(narrow)[0].rect, [0, 0, 150, 240]);
    assert.equal(narrow.nodes.find(node => node.node === 'after').rect[1], 240);
    assert.equal(textNodes(narrow)[0].text.lines.length, 2);
    assert.ok(textNodes(narrow)[0].text.runs.some(run => run.glyphs.some(g => g.paint.commands.includes('C'))));
    assert.equal(env.layout.stats.layoutPasses, 4);
    assert.ok(Object.isFrozen(narrow)); assert.ok(Object.isFrozen(textNodes(narrow)[0].text.runs));
  } finally {env.dispose();}
});

test('the same block in different component instances receives independent available-width metrics', async () => {
  const env = await setup(source => {
    const original = source.artboards[0]; original.id = 'card'; original.width = 240;
    source.artboards = [{id: 'main', width: 420, height: 600, root: 'root', nodes: [
      {id: 'root', kind: 'container', style: {direction: 'row'}},
      ...[150, 240].map((width, i) => ({id: 'host' + i, parent: 'root', kind: 'component', style: {width: point(width), height: point(600)}, component: {artboard: 'card', sizing: 'layout'}})),
    ]}, original];
  });
  try {
    const frame = env.layout.evaluate(request(420)), nodes = textNodes(frame);
    assert.deepEqual(nodes.map(node => node.rect.slice(2)), [[150, 240], [240, 120]]);
    assert.deepEqual(nodes.map(node => node.text.lines.length), [2, 1]);
    assert.notEqual(nodes[0].instance, nodes[1].instance);
    assert.equal(frame.instances.length, 3);
    assert.equal(frame.instances[1].host, 'r5:stage/n5:host0');
  } finally {env.dispose();}
});

test('static requests reuse the same frame; changed time reuses prepared glyph geometry and disposal borrows fonts', async () => {
  const env = await setup();
  try {
    const first = env.layout.evaluate(request(150)), stats = env.layout.stats;
    assert.equal(env.layout.evaluate(request(150)), first); assert.deepEqual(env.layout.stats, stats);
    const next = env.layout.evaluate(request(150, {time: 1}));
    assert.equal(next.revision, first.revision + 1); assert.equal(textNodes(next)[0].text, textNodes(first)[0].text);
    assert.equal(env.layout.stats.shapes, stats.shapes);
    env.layout.dispose(); env.layout.dispose(); assert.equal(env.text.stats.disposed, false);
    assert.ok(env.text.shape({block: 'label'}).runs.length);
    assert.throws(() => env.layout.evaluate(request()), error => error.code === 'E_HYA_RUNTIME_DISPOSED');
  } finally {env.dispose();}
});

test('UTF-16 controls, RTL, language/style and DPR changes use the same node-local shaping geometry', async () => {
  const env = await setup();
  try {
    const input = request(240, {strings: {value: 'A😀B'}, selections: {selection: [1, 3]}, cursors: {cursor: 3}});
    const a = textNodes(env.layout.evaluate(input))[0];
    assert.deepEqual(a.text.controls.find(control => control.kind === 'cursor').rect, [170, 0, 1, 120]);
    const b = textNodes(env.layout.evaluate({...input, dpr: 2}))[0]; assert.deepEqual(b.rect, a.rect); assert.deepEqual(b.text.controls, a.text.controls);
    const rtl = textNodes(env.layout.evaluate(request(150, {strings: {value: 'אבב'}, styles: {body: {direction: 'rtl', fontSize: 50, lineHeight: 60}}})))[0];
    assert.deepEqual(rtl.rect.slice(2), [150, 60]);
    assert.deepEqual(rtl.text.runs.flatMap(run => run.glyphs.map(g => g.clusterUtf16)), [2, 1, 0]);
  } finally {env.dispose();}
});

test('ancestor clipping and opacity cross a nested component boundary without moving local glyphs', async () => {
  const env = await setup(source => {
    const card = source.artboards[0]; card.id = 'card'; card.nodes[0].visual = {opacity: .5};
    source.artboards = [{id: 'main', width: 300, height: 600, root: 'root', nodes: [
      {id: 'root', kind: 'container', style: {padding: [point(20), point(10), point(0), point(0)]}, visual: {clip: true, opacity: .5}},
      {id: 'host', parent: 'root', kind: 'component', style: {width: point(150), height: point(180), overflow: 'hidden'}, component: {artboard: 'card', sizing: 'layout'}},
    ]}, card];
  });
  try {
    const node = textNodes(env.layout.evaluate(request(300)))[0];
    assert.deepEqual(node.rect, [20, 10, 150, 240]); assert.deepEqual(node.clip, [20, 10, 150, 180]); assert.equal(node.opacity, .25);
    assert.equal(node.text.runs[0].glyphs[0].transform[4], 0);
  } finally {env.dispose();}
});

test('list identities survive reorder and reserved separators, and duplicates outside the virtual window fail atomically', async () => {
  const env = await setup(source => {
    const item = source.artboards[0]; item.id = 'item';
    source.artboards = [{id: 'main', width: 150, height: 120, root: 'list', nodes: [
      {id: 'list', kind: 'list', style: {}, list: {dataPort: 'items', templateArtboard: 'item', direction: 'column', itemExtent: 120, virtualize: true, buffer: 0}},
    ]}, item];
  });
  try {
    const a = env.layout.evaluate(request(150, {viewport: [150, 120], lists: {items: [{id: 'a]/n1:b'}, {id: 'b'}]}}));
    const id = textNodes(a)[0].instance;
    const b = env.layout.evaluate(request(150, {viewport: [150, 120], lists: {items: [{id: 'b'}, {id: 'a]/n1:b'}]}, scroll: {items: {offset: [0, 120]}}}));
    assert.equal(textNodes(b)[0].instance, id);
    assert.throws(() => env.layout.evaluate(request(150, {viewport: [150, 120], lists: {items: [{id: 'x'}, {id: 'y'}, {id: 'y'}]}})), /Duplicate list item/);
    assert.equal(env.layout.stats.revision, 2); assert.equal(env.layout.evaluate(request(150, {viewport: [150, 120], lists: {items: [{id: 'b'}, {id: 'a]/n1:b'}]}, scroll: {items: {offset: [0, 120]}}})), b);
  } finally {env.dispose();}
});

test('failed shaping and recursive entry never publish a partial layout revision', async () => {
  const env = await setup(); let mode = 'normal', owner;
  const custom = {shape(value) {if (mode === 'fail') throw Error('font replacement is pending'); if (mode === 'reenter') owner.evaluate(request()); return env.text.shape(value);}};
  owner = new ProductionLayoutOwner(env.document, custom);
  try {
    const a = owner.evaluate(request()); mode = 'fail';
    assert.throws(() => owner.evaluate(request(150)), /font replacement is pending/); assert.equal(owner.stats.revision, 1);
    mode = 'reenter'; assert.throws(() => owner.evaluate(request(150)), /recursively/); assert.equal(owner.stats.revision, 1);
    mode = 'normal'; assert.equal(owner.evaluate(request()), a); assert.equal(owner.evaluate(request(150)).revision, 2);
  } finally {owner.dispose(); env.dispose();}
});

test('aggregate glyph ceilings and finite convergence ceilings fail rather than return incomplete geometry', async () => {
  const env = await setup(), base = new runtime.LayoutEvaluator(env.document), limits = base.limits; base.dispose();
  const limited = new ProductionLayoutOwner(env.document, env.text, {}, {...limits, maxGlyphs: 2});
  const onePass = new ProductionLayoutOwner(env.document, env.text, {}, {...limits, maxLayoutPasses: 2});
  try {
    assert.throws(() => limited.evaluate(request()), error => error.code === 'E_HYA_RUNTIME_LIMIT');
    assert.throws(() => onePass.evaluate(request()), /did not converge/);
    assert.equal(limited.stats.revision, 0); assert.equal(onePass.stats.revision, 0);
  } finally {limited.dispose(); onePass.dispose(); env.dispose();}
});

test('abort during platform shaping cleans the layout owner without disposing the shared font owner', async () => {
  const env = await setup(), controller = new AbortController();
  const owner = new ProductionLayoutOwner(env.document, {shape(value) {controller.abort(); return env.text.shape(value);}}, {signal: controller.signal});
  try {
    assert.throws(() => owner.evaluate(request()), error => error.code === 'E_HYA_RUNTIME_ABORTED');
    assert.equal(owner.stats.revision, 0); assert.equal(owner.stats.cachedTextNodes, 0); assert.equal(env.text.stats.disposed, false);
    assert.throws(() => new ProductionLayoutOwner(env.document), error => error.code === 'E_HYA_RUNTIME_HOST_PORT');
  } finally {owner.dispose(); env.dispose();}
});

test('N-slice normalized UVs retain both mirror axes including partial tiles; the source stays explicit', async () => {
  const env = await setup(source => {
    source.assets.push({id: 'image', kind: 'image', width: 16, height: 16, source: source.assets[0].source});
    source.artboards = [{id: 'main', width: 38, height: 20, root: 'slice', nodes: [{id: 'slice', kind: 'n-slice', style: {}, nSlice: {source: {kind: 'asset', asset: 'image'}, sourceSize: [16, 16], xCuts: [1, 15], yCuts: [1, 15], tileModes: ['stretch', 'stretch', 'stretch', 'stretch', 'mirror', 'stretch', 'stretch', 'stretch', 'stretch']}}]}];
  });
  try {
    const node = env.layout.evaluate(request(38, {viewport: [38, 20]})).nodes[0];
    const tiles = node.nSlice.filter(patch => patch.tile === 'mirror');
    assert.deepEqual(node.source, {kind: 'asset', id: 'image'}); assert.equal(tiles.length, 6);
    assert.deepEqual(tiles[0].uv, [1/16, 1/16, 14/16, 14/16]); assert.deepEqual(tiles[1].uv, [15/16, 1/16, -14/16, 14/16]);
    assert.deepEqual(tiles[2].uv, [1/16, 1/16, .5, 14/16]); assert.deepEqual(tiles[4].uv, [15/16, 15/16, -14/16, -.25]);
    assert.deepEqual(tiles[4].rect, [15, 15, 14, 4]);
  } finally {env.dispose();}
});

test('invalid finite metadata and array getters fail before shaping, preserving the previous immutable frame', async () => {
  const env = await setup();
  try {
    const first = env.layout.evaluate(request()), shapes = env.layout.stats.shapes;
    const invalid = [
      {scroll: {root: {offset: ['bad', 0]}}}, {scroll: {root: {settled: 'yes'}}}, {lists: {items: {id: 'x'}}},
      {componentInputs: {root: []}}, {componentEvents: {root: [{name: 3}]}}, {strings: {value: 3}},
      {componentReplacements: {host: 'missing'}}, {componentStateTimes: {host: '0'}}, {cursors: {cursor: -.5}},
      {selections: {selection: [0, -1]}}, {priorRects: {root: {x: 0, y: 0, width: -1, height: 0}}},
      {dpr: NaN}, {viewport: [Infinity, 10]}, {callback() {}},
    ];
    for (const patch of invalid) assert.throws(() => env.layout.evaluate(request(150, patch)), error => error.code === 'E_HYA_RUNTIME_LAYOUT');
    let reads = 0; const viewport = [240, 600]; Object.defineProperty(viewport, 0, {get() {reads++; return 240;}});
    assert.throws(() => env.layout.evaluate({...request(), viewport}), /without accessors/); assert.equal(reads, 0);
    assert.equal(env.layout.stats.shapes, shapes); assert.equal(env.layout.evaluate(request()), first);
    assert.throws(() => {first.nodes[0].rect[0] = 99;}, TypeError);
  } finally {env.dispose();}
});

test('component replacements, input/event exposure and state time stay on the original runtime adapter', async () => {
  const env = await setup(source => {
    const card = source.artboards[0]; card.id = 'card';
    source.artboards = [{id: 'main', width: 240, height: 600, root: 'host', nodes: [
      {id: 'host', kind: 'component', style: {}, component: {artboard: 'card', sizing: 'layout', playback: {mode: 'mix', stateful: true, mixPort: 'mix', remapPort: 'phase'}, exposedInputs: ['mix', 'phase'], exposedEvents: ['go']}},
    ]}, card, {...structuredClone(card), id: 'alternate'}];
  });
  try {
    const host = 'r5:stage/n4:host';
    const frame = env.layout.evaluate(request(150, {componentReplacements: {[host]: 'alternate'}, componentInputs: {[host]: {mix: .25, phase: 3, secret: 1}}, componentEvents: {[host]: [{name: 'go', payload: {id: 1}}, {name: 'ignore'}]}, componentStateTimes: {[host]: 2}}));
    assert.equal(frame.instances[1].artboard, 'alternate'); assert.deepEqual(frame.instances[1].times, [2, 3]); assert.equal(frame.instances[1].mixWeight, .25);
    assert.deepEqual(Object.keys(frame.instances[1].inputs).sort(), ['mix', 'phase']); assert.deepEqual(frame.instances[1].events.map(event => event.name), ['go']);
    assert.equal(textNodes(frame)[0].text.lines.length, 2);
  } finally {env.dispose();}
});

test('only arranged text receives the instance raster origin while glyph/control geometry stays local', async () => {
  const env = await setup(source => {source.artboards[0].nodes[0].style.padding = [point(.25), point(.5), point(0), point(0)];});
  const calls = [], owner = new ProductionLayoutOwner(env.document, {shape(request) {calls.push(request); return env.text.shape(request);}});
  try {
    const node = textNodes(owner.evaluate(request(240)))[0];
    assert.deepEqual(node.rect.slice(0, 2), [.25, .5]);
    assert.ok(calls.some(request => request.rasterOrigin === undefined));
    assert.ok(calls.filter(request => request.rasterOrigin).every(request => request.rasterOrigin[0] === .25 && request.rasterOrigin[1] === .5));
    assert.equal(node.text.runs[0].glyphs[0].transform[4], 0);
    const before = env.text.stats.shapes;
    for (const rasterOrigin of [[0], [0, 'bad'], [0, Infinity], null]) assert.throws(() => env.text.shape({block: 'label', rasterOrigin}), error => error.code === 'E_HYA_RUNTIME_TEXT');
    assert.equal(env.text.stats.shapes, before);
  } finally {owner.dispose(); env.dispose();}
});

test('hidden production branches never measure text or reserve flow/gap space', async () => {
  const env = await setup(source => {
    source.artboards[0].nodes[0].style.gap = [point(8), point(8)];
    source.artboards[0].nodes[1].style.display = 'none';
    source.artboards[0].nodes.push({id: 'after', parent: 'root', kind: 'leaf', style: {width: point(12), height: point(8)}});
  });
  try {
    const frame = env.layout.evaluate(request());
    assert.equal(frame.nodes.length, 2); assert.equal(frame.nodes[1].rect[1], 0); assert.equal(env.layout.stats.shapes, 0); assert.equal(env.text.stats.shapes, 0);
  } finally {env.dispose();}
});

test('expanded node and repeated-instance glyph budgets stop work at the frame boundary', async () => {
  const env = await setup(source => {source.artboards[0].nodes.push({...structuredClone(source.artboards[0].nodes[1]), id: 'copy'});});
  const core = new runtime.LayoutEvaluator(env.document), limits = core.limits; core.dispose();
  const limited = new ProductionLayoutOwner(env.document, env.text, {}, {...limits, maxGlyphs: 4});
  const visits = [], expanded = new runtime.LayoutEvaluator(env.document, undefined, {evaluate(block, updates, context) {visits.push(context.node.id); return {id: block, width: 210, height: 120, contentWidth: 210, contentHeight: 120, glyphs: [], lines: [], controls: []};}}, {maxExpandedNodes: 2, stableIds: true});
  try {
    assert.throws(() => limited.evaluate(request()), error => error.code === 'E_HYA_RUNTIME_LIMIT');
    assert.equal(limited.stats.revision, 0);
    assert.throws(() => expanded.evaluate(request()), /Expanded node budget/); assert.ok(visits.length > 0);
  } finally {limited.dispose(); expanded.dispose(); env.dispose();}
});
