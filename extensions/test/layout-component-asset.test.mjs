import assert from 'node:assert/strict';
import test from 'node:test';
import { embeddedBytes, embeddedIntegrity, loadResponsiveLayoutModules, responsiveLayoutFixture } from './responsive-layout-fixture.mjs';

const { spec, runtime } = await loadResponsiveLayoutModules();
const { parseResponsiveLayoutDocument, LayoutDiagnostic } = spec;
const { LayoutAssetOwner, LayoutEvaluator, LayoutGpuRenderer } = runtime;

test('responsive flex, absolute, reflow, scroll, N-slice, nested components and virtual lists are canonical', () => {
  const document = parseResponsiveLayoutDocument(responsiveLayoutFixture()), evaluator = new LayoutEvaluator(document);
  const request = { viewport: [320, 180], dpr: 1, time: 0.5, strings: { inputText: 'A fi' }, selections: { selection: [0, 2] }, cursors: { cursor: 1 }, lists: { items: Array.from({ length: 20 }, (_, id) => ({ id: `item-${id}` })) }, scroll: { 'stage/list': { offset: [0, 44], settled: true }, 'stage/scroller': { offset: [47, 0], settled: true } }, componentReplacements: { 'stage/component': 'alternate' }, componentInputs: { 'stage/component': { phase: 0.75, mix: 0.25, hidden: 99 } }, componentEvents: { 'stage/component': [{ name: 'activate' }, { name: 'blocked' }] }, componentStateTimes: { 'stage/component': 1.25 }, priorRects: { 'stage/text': { x: 0, y: 0, width: 50, height: 20 } }, reflowProgress: 0.5 };
  const first = evaluator.evaluate(request), replay = evaluator.evaluate(request);
  assert.deepEqual(first, replay); assert.equal(first.layoutPasses, 2);
  const text = first.nodes.find(node => node.nodeId === 'text'); assert.ok(text.text.glyphs.some(glyph => glyph.sequence === 'fi')); assert.ok(text.rect.width > 50 && text.rect.width < 100, 'reflow interpolates size');
  const component = first.instances.find(instance => instance.artboardId === 'alternate'); assert.deepEqual(component.times, [1.25, 0.75]); assert.equal(component.mixWeight, 0.25); assert.deepEqual(component.inputs, { phase: 0.75, mix: 0.25 }); assert.deepEqual(component.events.map(event => event.name), ['activate']);
  assert.ok(first.visibleListItems > 0 && first.visibleListItems < 20); assert.ok(first.instances.some(instance => instance.id.includes('item-2')));
  const slice = first.nodes.find(node => node.nodeId === 'slice'); assert.ok(slice.nSlice.length >= 9 && slice.nSlice.some(patch => patch.tileMode === 'mirror'));
  const bar = first.nodes.find(node => node.nodeId === 'bar'); assert.ok(bar.rect.width < 100 && bar.rect.x >= 5);
  const resized = evaluator.evaluate({ ...request, viewport: [640, 360], priorRects: undefined }); assert.equal(resized.nodes.find(node => node.nodeId === 'root').rect.width, 640);
  evaluator.dispose(); evaluator.dispose(); assert.throws(() => evaluator.evaluate(request), error => error.code === 'E_LAYOUT_RUNTIME_DISPOSED');
});

test('parser and runtime reject oscillation, depth, budgets, malformed grids and aborted updates', () => {
  const oscillating = responsiveLayoutFixture(); oscillating.artboards[0].nodes[0].style.width = { unit: 'hug' }; oscillating.artboards[0].nodes[1].style.width = { unit: 'fill' };
  assert.throws(() => parseResponsiveLayoutDocument(oscillating), error => error instanceof LayoutDiagnostic && error.code === 'E_LAYOUT_OSCILLATION');
  const badGrid = responsiveLayoutFixture(); badGrid.artboards[0].nodes[0].style.gridColumns = [{ min: { unit: 'point', value: -1 } }];
  assert.throws(() => parseResponsiveLayoutDocument(badGrid), error => error.code === 'E_LAYOUT_NUMBER');
  const missingAsset = responsiveLayoutFixture(); missingAsset.artboards[0].nodes.find(node => node.id === 'wide').asset = 'missing'; assert.throws(() => parseResponsiveLayoutDocument(missingAsset), error => error.code === 'E_LAYOUT_REFERENCE');
  const unhashedHosted = responsiveLayoutFixture(); delete unhashedHosted.assets.find(asset => asset.id === 'hosted').source.integrity; assert.throws(() => parseResponsiveLayoutDocument(unhashedHosted), error => error.code === 'E_LAYOUT_FORMAT');
  assert.throws(() => parseResponsiveLayoutDocument(responsiveLayoutFixture(), { limits: { maxAssetBytes: 2 } }), error => error.code === 'E_LAYOUT_LIMIT');
  const parsed = parseResponsiveLayoutDocument(responsiveLayoutFixture());
  assert.throws(() => new LayoutEvaluator(parsed, limits({ maxNslicePatches: 1 })).evaluate({ viewport: [320, 180], dpr: 1, time: 0 }), error => error.code === 'E_LAYOUT_RUNTIME_LIMIT');
  assert.throws(() => new LayoutEvaluator(parsed, limits({ maxLayoutPasses: 1 })).evaluate({ viewport: [320, 180], dpr: 1, time: 0 }), error => error.code === 'E_LAYOUT_RUNTIME_LIMIT');
  assert.throws(() => new LayoutEvaluator(parsed, limits({ maxVirtualizedWindow: 1 })).evaluate({ viewport: [320, 180], dpr: 1, time: 0, lists: { items: [{}, {}, {}] } }), error => error.code === 'E_LAYOUT_RUNTIME_LIMIT');
  const controller = new AbortController(); controller.abort(); assert.throws(() => new LayoutEvaluator(parsed).evaluate({ viewport: [320, 180], dpr: 1, time: 0, signal: controller.signal }), error => error.code === 'E_LAYOUT_RUNTIME_ABORTED');
  const nested = structuredClone(parsed); nested.artboards.find(artboard => artboard.id === 'card').nodes[0] = { id: 'card-root', kind: 'component', style: { width: { unit: 'fill' }, height: { unit: 'fill' } }, component: { artboard: 'card' } };
  assert.throws(() => new LayoutEvaluator(nested, limits({ maxNestedDepth: 2 })).evaluate({ viewport: [320, 180], dpr: 1, time: 0 }), error => error.code === 'E_LAYOUT_RUNTIME_LIMIT');
});

test('layout sizing, relative offsets, elastic scrolling and every component timing mode remain dynamic', () => {
  const source = responsiveLayoutFixture(), textNode = source.artboards[0].nodes.find(node => node.id === 'text'); delete textNode.style.height; textNode.intrinsicSize = [20, 10]; textNode.style.width = { unit: 'point', value: 40 }; textNode.style.aspectRatio = 2; textNode.style.position = 'relative'; textNode.style.inset = [{ unit: 'point', value: 3 }, { unit: 'point', value: 2 }, { unit: 'point', value: 0 }, { unit: 'point', value: 0 }];
  const scroller = source.artboards[0].nodes.find(node => node.id === 'scroller'); scroller.scroll.mode = 'elastic'; scroller.scroll.elasticity = 0.25;
  const document = parseResponsiveLayoutDocument(source), elasticPose = new LayoutEvaluator(document).evaluate({ viewport: [320, 180], dpr: 1, time: 0, scroll: { 'stage/scroller': { offset: [-20, 0] } } }), text = elasticPose.nodes.find(node => node.nodeId === 'text'), wide = elasticPose.nodes.find(node => node.nodeId === 'wide'), scrollPose = elasticPose.nodes.find(node => node.nodeId === 'scroller');
  assert.equal(text.rect.width, 80, 'minWidth clamps the requested point width'); assert.equal(text.rect.height, 40, 'aspect ratio derives the missing dimension after min/max'); assert.ok(text.rect.x >= 8 && text.rect.y >= 8, 'margin and relative inset both affect placement'); assert.equal(wide.rect.x, scrollPose.rect.x + 5, 'elastic overscroll applies the declared factor');
  const componentNode = document.artboards[0].nodes.find(node => node.id === 'component'), componentKey = 'stage/component';
  const simple = structuredClone(document); simple.artboards[0].nodes.find(node => node.id === 'component').component.playback = { mode: 'simple', speed: 2 }; let evaluation = new LayoutEvaluator(simple).evaluate({ viewport: [320, 180], dpr: 1, time: 0.75 }); assert.deepEqual(evaluation.instances.find(instance => instance.hostNode === componentKey).times, [1.5]);
  const remap = structuredClone(document); remap.artboards[0].nodes.find(node => node.id === 'component').component.playback = { mode: 'remap', remapPort: 'phase' }; evaluation = new LayoutEvaluator(remap).evaluate({ viewport: [320, 180], dpr: 1, time: 99, componentInputs: { [componentKey]: { phase: 0.4 } } }); assert.deepEqual(evaluation.instances.find(instance => instance.hostNode === componentKey).times, [0.4]);
  const leaf = structuredClone(document); leaf.artboards[0].nodes.find(node => node.id === 'component').component.sizing = 'leaf'; evaluation = new LayoutEvaluator(leaf).evaluate({ viewport: [320, 180], dpr: 1, time: 0, componentReplacements: { [componentKey]: 'alternate' } }); assert.equal(evaluation.instances.find(instance => instance.hostNode === componentKey).rect.width, 36);
  const vectorSource = responsiveLayoutFixture(); vectorSource.artboards[0].nodes.find(node => node.id === 'slice').nSlice.source = { kind: 'node', node: 'wide' }; evaluation = new LayoutEvaluator(parseResponsiveLayoutDocument(vectorSource)).evaluate({ viewport: [320, 180], dpr: 1, time: 0 }); assert.ok(evaluation.nodes.find(node => node.nodeId === 'slice').nSlice.length >= 9, 'vector-node and raster-asset N-slice share deterministic sizing');
  assert.equal(componentNode.component.sizing, 'layout');
});

test('grid tracks, placement spans, row/column flow and RTL ordering are deterministic', () => {
  const source = responsiveLayoutFixture(), main = source.artboards.find(artboard => artboard.id === 'main'); main.nodes = [
    { id: 'root', kind: 'container', style: { display: 'grid', width: { unit: 'fill' }, height: { unit: 'fill' }, gridColumns: [{ min: { unit: 'point', value: 100 } }, { min: { unit: 'fraction', value: 1 } }], gridRows: [{ min: { unit: 'point', value: 50 } }, { min: { unit: 'fraction', value: 1 } }] } },
    { id: 'a', parent: 'root', kind: 'leaf', style: { gridPlacement: { column: 0, row: 0 } } },
    { id: 'b', parent: 'root', kind: 'leaf', style: { gridPlacement: { column: 1, row: 0, rowSpan: 2 } } }
  ];
  const evaluation = new LayoutEvaluator(parseResponsiveLayoutDocument(source)).evaluate({ viewport: [320, 180], dpr: 1, time: 0 }), a = evaluation.nodes.find(node => node.nodeId === 'a'), b = evaluation.nodes.find(node => node.nodeId === 'b'); assert.deepEqual(a.rect, { x: 0, y: 0, width: 100, height: 50 }); assert.deepEqual(b.rect, { x: 100, y: 0, width: 220, height: 180 });
  const column = responsiveLayoutFixture(); column.artboards[0].nodes[0].style.direction = 'column'; column.artboards[0].nodes[0].style.writingDirection = 'rtl'; const pose = new LayoutEvaluator(parseResponsiveLayoutDocument(column)).evaluate({ viewport: [320, 180], dpr: 1, time: 0 }); assert.ok(pose.nodes.find(node => node.nodeId === 'component').rect.y > pose.nodes.find(node => node.nodeId === 'text').rect.y);
});

test('asset owner enforces integrity, cache, hosted replacement, explicit network policy and idempotent lifecycle', async () => {
  const document = parseResponsiveLayoutDocument(responsiveLayoutFixture());
  const owner = new LayoutAssetOwner(document, { policy: { mode: 'deny' } });
  const first = await owner.load('image'); assert.deepEqual([...first.bytes], embeddedBytes); first.release(); first.release();
  const copy = await owner.load('copy'); assert.equal(owner.stats.cacheEntries, 1); copy.release();
  const fallback = await owner.load('hosted'); assert.deepEqual([...fallback.bytes], embeddedBytes); fallback.release();
  owner.setHostedReplacement('hero', { kind: 'embedded', data: [1, 2, 3], integrity: embeddedIntegrity }); const replacement = await owner.load('hosted'); replacement.release();
  await assert.rejects(owner.load('remote'), error => error.code === 'E_LAYOUT_ASSET_NETWORK');
  owner.replace('copy', { kind: 'embedded', data: [9], integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }); await assert.rejects(owner.load('copy'), error => error.code === 'E_LAYOUT_ASSET_INTEGRITY');
  owner.replace('copy', { kind: 'embedded', data: embeddedBytes, integrity: 'sha256-039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' }); const hexHandle = await owner.load('copy'); assert.deepEqual([...hexHandle.bytes], embeddedBytes); hexHandle.release();
  owner.dispose(); owner.dispose(); assert.deepEqual({ entries: owner.stats.entries, bytes: owner.stats.totalBytes, disposed: owner.stats.disposed }, { entries: 0, bytes: 0, disposed: true });
  await assert.rejects(owner.load('image'), error => error.code === 'E_LAYOUT_ASSET_DISPOSED');

  const network = new LayoutAssetOwner(document, { policy: { mode: 'same-origin', baseUrl: 'https://example.test/' }, resolver: { async resolve(uri) { assert.equal(uri, '/asset.bin'); return new Uint8Array(embeddedBytes); } } });
  const remote = await network.load('remote'); remote.release(); network.dispose();
  const cross = new LayoutAssetOwner(document, { policy: { mode: 'same-origin', baseUrl: 'https://example.test/' }, resolver: { async resolve() { return new Uint8Array(embeddedBytes); } } }); cross.replace('remote', { kind: 'referenced', uri: 'https://other.test/a', integrity: embeddedIntegrity }); await assert.rejects(cross.load('remote'), error => error.code === 'E_LAYOUT_ASSET_NETWORK'); cross.dispose();
});

test('late asset results cannot write back and device materializations rebuild or dispose exactly once', async () => {
  const document = parseResponsiveLayoutDocument(responsiveLayoutFixture()); let resolveLate;
  const late = new LayoutAssetOwner(document, { policy: { mode: 'same-origin', baseUrl: 'https://example.test/' }, resolver: { resolve() { return new Promise(resolve => { resolveLate = resolve; }); } } });
  const pending = late.load('remote'); late.dispose(); resolveLate(new Uint8Array(embeddedBytes)); await assert.rejects(pending, error => error.code === 'E_LAYOUT_ASSET_ABORTED'); assert.equal(late.stats.entries, 0);
  const destroyed = [], materializer = { async materialize(_asset, _bytes, device) { const handle = { device, destroyed: false, destroy() { if (!this.destroyed) { this.destroyed = true; destroyed.push(this); } } }; return handle; } }, firstDevice = { id: 1 }, secondDevice = { id: 2 };
  const owner = new LayoutAssetOwner(document, { policy: { mode: 'deny' }, materializer, device: firstDevice }); const handle = await owner.load('image'); owner.notifyDeviceLost(); assert.equal(destroyed.length, 1); await owner.recoverDevice(secondDevice); assert.equal(owner.stats.lost, false); handle.release(); owner.dispose(); assert.equal(destroyed.length, 2);
  let resolveIndependent; const independent = new LayoutAssetOwner(document, { policy: { mode: 'same-origin', baseUrl: 'https://example.test/' }, resolver: { resolve() { return new Promise(resolve => { resolveIndependent = resolve; }); } } }), remotePending = independent.load('remote'); independent.replace('copy', { kind: 'embedded', data: embeddedBytes, integrity: embeddedIntegrity }); resolveIndependent(new Uint8Array(embeddedBytes)); const remote = await remotePending; assert.deepEqual([...remote.bytes], embeddedBytes, 'replacing one asset does not retire unrelated pending loads'); remote.release(); independent.dispose();
});

test('WebGPU layout upload uses clip-space vertices, bounded buffers, device recovery and zero residuals', () => {
  globalThis.GPUBufferUsage = { VERTEX: 1, COPY_DST: 2 }; const first = fakeDevice(), second = fakeDevice(), document = parseResponsiveLayoutDocument(responsiveLayoutFixture()), evaluation = new LayoutEvaluator(document).evaluate({ viewport: [320, 180], dpr: 1, time: 0, lists: { items: [{ id: 'a' }] } });
  const renderer = new LayoutGpuRenderer(first.device); renderer.upload(evaluation); assert.ok(renderer.stats.vertexCount > 0); assert.ok(first.uploads[0].every((value, index) => index % 6 > 1 || value >= -1.001 && value <= 1.001));
  const gradient = structuredClone(evaluation), gradientGlyph = gradient.nodes.find(node => node.text)?.text.glyphs[0]; gradientGlyph.fills = [{ source: { kind: 'linear-gradient', start: [0, 0], end: [1, 1], stops: [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }] } }]; gradientGlyph.strokes = [{ width: 1, source: { kind: 'radial-gradient', center: [0.5, 0.5], radius: 0.75, stops: [{ offset: 0, color: [1, 1, 1, 1] }, { offset: 1, color: [0, 0, 0, 1] }] } }]; renderer.upload(gradient); assert.ok(renderer.stats.vertexCount > 100, 'gradient paints are deterministically tessellated');
  const pass = { setPipeline() {}, setVertexBuffer() {}, draw(count) { assert.equal(count, renderer.stats.vertexCount); } }; renderer.render(pass); renderer.recoverDevice(second.device, 4); assert.equal(renderer.stats.generation, 4); assert.ok(first.buffers.every(buffer => buffer.destroyed)); renderer.dispose(); renderer.dispose(); assert.deepEqual({ buffers: renderer.stats.bufferCount, bytes: renderer.stats.allocatedBytes }, { buffers: 0, bytes: 0 }); assert.ok(second.buffers.every(buffer => buffer.destroyed));
  const limited = fakeDevice(); const tiny = new LayoutGpuRenderer(limited.device, 'rgba8unorm', 24); assert.throws(() => tiny.upload(evaluation), /E_LAYOUT_GPU_BUDGET/); tiny.dispose();
});

function limits(overrides) { return { maxGlyphs: 1_000_000, maxLines: 250_000, maxLayoutPasses: 64, maxNestedDepth: 128, maxComponentInstances: 8192, maxListItems: 100_000, maxVirtualizedWindow: 4096, maxNslicePatches: 1_000_000, ...overrides }; }
function fakeDevice() { const buffers = [], uploads = []; const device = { limits: { maxBufferSize: 1024 * 1024, maxVertexBufferArrayStride: 2048 }, lost: new Promise(() => {}), queue: { writeBuffer(_buffer, _offset, source) { uploads.push([...source]); } }, createShaderModule() { return {}; }, createRenderPipeline() { return {}; }, createBuffer(options) { const buffer = { size: options.size, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; } }; return { device, buffers, uploads }; }
