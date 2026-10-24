import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import opentype from 'opentype.js';
import {Entity} from '@haiyue/engine';
import {parseAnimation} from '@haiyue/animation-spec';
import {Animation2DRuntime} from '../dist-test/animation/Animation2DRuntime.js';
import {AnimationTextRasterizer} from '../dist-test/animation/AnimationTextRasterizer.js';
import {productionFontFixture} from './text-production-font-fixture.mjs';

const bytesA = productionFontFixture().bytes;
const fontA = opentype.parse(bytesA.slice().buffer);
const glyphs = Array.from({length: fontA.glyphs.length}, (_, index) => {
  const glyph = fontA.glyphs.get(index);
  return new opentype.Glyph({name: glyph.name, unicode: glyph.unicode,
    advanceWidth: glyph.unicode === 65 ? 900 : glyph.advanceWidth, path: glyph.path});
});
const bytesB = new Uint8Array(new opentype.Font({familyName: 'Haiyue G11 Fixture', styleName: 'Regular',
  unitsPerEm: 1000, ascender: 800, descender: -200, createdTimestamp: 1577836800, glyphs}).toArrayBuffer());
const fontB = opentype.parse(bytesB.slice().buffer);
assert.equal(fontA.getAdvanceWidth('A', 20), 14);
assert.equal(fontB.getAdvanceWidth('A', 20), 18);
const text = {type: 'text2d', text: 'A', size: [100, 48], fontSize: 20,
  fontFamily: 'Haiyue G11 Fixture', fontResource: 'a', color: [0, 0, 0, 1]};

function documentFor(component = {}) {
  return parseAnimation({format: 'haiyue-animation', version: '1.0', duration: 1,
    canvas: {width: 100, height: 100, coordinateSystem: 'screen-y-down'},
    nodes: [{id: 'label', components: [{...text, ...component}]}], tracks: [],
    resources: ['a', 'b'].map(id => ({id, type: 'binary', uri: `${id}.otf`}))});
}
class CpuRuntime extends Animation2DRuntime {
  get _rasterizeCoreText() {return false;}
  get _materializeCoreFontFace() {return false;}
  get _materializeCoreImages() {return false;}
}
const port = loadBinary => ({loadBinary, loadTexture() {throw Error('Unexpected texture request');},
  loadExpressionData() {throw Error('Unexpected JSON request');}});
async function settled(runtime) {
  const until = Date.now() + 5000;
  while (runtime.stats.pendingResourceCount && Date.now() < until) await tick();
  assert.equal(runtime.stats.pendingResourceCount, 0);
}
async function withoutPlatform(action) {
  const names = ['document', 'window', 'OffscreenCanvas', 'FontFace', 'fetch', 'AudioContext', 'createImageBitmap'];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]), accessed = [];
  for (const name of names) Object.defineProperty(globalThis, name, {configurable: true,
    get() {accessed.push(name); throw Error(`Unexpected platform access: ${name}`);}});
  try {await action(); assert.deepEqual(accessed, []);}
  finally {for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];}
}

test('CPU core uses the actual resource for same-family font keyframes without platform access', async () => {
  await withoutPlatform(async () => {
    const requests = [], releases = [];
    const runtime = new CpuRuntime(new Entity('font resources'), documentFor({documents: [
      {time: 0, text: 'A', fontResource: 'a'}, {time: .5, text: 'A', fontResource: 'b'},
    ]}), undefined, undefined, undefined, port(async resource => {
      requests.push(resource.id); const bytes = resource.id === 'a' ? bytesA : bytesB;
      return {value: bytes.slice().buffer, release() {releases.push(resource.id);}};
    }));
    try {
      await settled(runtime); assert.equal(runtime.stats.failedResourceCount, 0);
      const rasterizer = runtime._nodes[0].visuals[0].textRasterizer;
      const plans = [0, .75, 0].map(time => rasterizer.evaluateOutlineGlyphLayout(time));
      assert.deepEqual(plans.map(plan => plan.lines[0].glyphs[0].advance), [14, 18, 14]);
      assert.deepEqual(requests.sort(), ['a', 'b']); assert.deepEqual(releases, []);
      assert.equal(Object.isFrozen(plans[0].lines[0].glyphs), true);
    } finally {runtime.destroy();}
    assert.equal(runtime.stats.nodeCount, 0); assert.deepEqual(releases.sort(), ['a', 'b']);
  });
});

test('synchronous core font port failures settle the original resource counters', async () => {
  await withoutPlatform(async () => {
    let requests = 0;
    const runtime = new CpuRuntime(new Entity('rejecting font'), documentFor(), undefined, undefined, undefined,
      port(() => {requests++; throw Error('Rejected by resource host');}));
    try {await settled(runtime); assert.equal(requests, 1); assert.equal(runtime.stats.failedResourceCount, 1);}
    finally {runtime.destroy();}
  });
});

test('destroying a CPU core font request releases a late real font handle once', async () => {
  await withoutPlatform(async () => {
    let complete, released = 0;
    const runtime = new CpuRuntime(new Entity('late font'), documentFor(), undefined, undefined, undefined,
      port(() => new Promise(resolve => {complete = resolve;})));
    runtime.destroy();
    complete({value: bytesA.slice().buffer, release() {released++;}});
    await settled(runtime); runtime.destroy();
    assert.equal(released, 1); assert.equal(runtime.stats.nodeCount, 0);
  });
});

function prepared(component = {}) {
  const value = new AnimationTextRasterizer({...text, ...component}, {rasterize: false});
  value.setOutlineFont(text.fontFamily, 'normal', 400, fontA, 'a');
  value.setOutlineFont(text.fontFamily, 'normal', 400, fontB, 'b');
  return value;
}
test('style runs retain resource inheritance while a family override selects its own font', () => {
  const value = prepared({text: 'AAA', styleRuns: [
    {start: 0, end: 1, fontResource: 'b'}, {start: 1, end: 2}, {start: 2, end: 3, fontFamily: 'Other'},
  ]});
  try {
    value.setOutlineFont('Other', 'normal', 400, fontB, 'other');
    const plan = value.evaluateOutlineGlyphLayout(0);
    assert.deepEqual(plan.lines[0].glyphs.map(glyph => glyph.advance), [18, 14, 18]);
    assert.deepEqual(plan.lines[0].glyphs.map(glyph => glyph.style.fontResource), ['b', 'a', undefined]);
  } finally {value.destroy();}
});

test('ambiguous or missing resource selection cannot fall through to a different font', () => {
  for (const fontResource of [undefined, 'missing']) {
    const value = prepared({fontResource});
    try {assert.throws(() => value.evaluateOutlineGlyphLayout(0), error => error.code === 'E_HYA_RUNTIME_HOST_PORT');}
    finally {value.destroy();}
  }
  const nativeOnly = new AnimationTextRasterizer(text, {rasterize: false});
  try {
    nativeOnly.setOutlineFont(text.fontFamily, 'normal', 400, undefined, 'a', 'Private-native-only');
    assert.throws(() => nativeOnly.evaluateOutlineGlyphLayout(0), error => error.code === 'E_HYA_RUNTIME_HOST_PORT');
  } finally {nativeOnly.destroy();}
});

test('state updates and font replacement preserve old immutable glyph snapshots', () => {
  const value = prepared(), color = [1, 0, 0, 1];
  try {
    const before = value.evaluateOutlineGlyphLayout(0);
    value.setStateDocument({value: 'AA', color}); color[0] = 0;
    value.setOutlineFont(text.fontFamily, 'normal', 400, fontB, 'a');
    const after = value.evaluateOutlineGlyphLayout(0);
    assert.equal(before.lines[0].glyphs[0].advance, 14);
    assert.deepEqual(after.lines[0].glyphs.map(glyph => glyph.advance), [18, 18]);
    assert.deepEqual(value.evaluateDocument(0).color, [1, 0, 0, 1]);
    assert.equal(Object.isFrozen(before), true);
    assert.throws(() => {before.lines[0].glyphs[0].advance = 0;}, TypeError);
  } finally {value.destroy();}
});

async function bitmapHost(action) {
  const saved = ['document', 'createImageBitmap'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const queue = [], closed = [];
  globalThis.document = {createElement: () => ({getContext: () => null})};
  globalThis.createImageBitmap = () => new Promise((resolve, reject) => queue.push({resolve, reject}));
  const bitmap = id => ({width: 80, height: 40, close() {closed.push(id);}});
  try {await action({queue, closed, bitmap});}
  finally {for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];}
}
test('leased immutable text bitmaps survive replacement and producer destruction until their last release', async () => {
  await bitmapHost(async ({queue, closed, bitmap}) => {
    const value = new AnimationTextRasterizer(text);
    try {
      queue[0].resolve(bitmap(1)); await value.whenReady();
      const first = value.acquireTextureSnapshot(); assert.equal(first.bytes, 80 * 40 * 4);
      value.setStateDocument({value: 'B'});
      assert.throws(() => value.acquireTextureSnapshot(), error => error.code === 'E_HYA_RUNTIME_RESOURCE_PENDING');
      queue[1].resolve(bitmap(2)); await value.whenReady();
      const second = value.acquireTextureSnapshot(); assert.deepEqual(closed, []);
      value.destroy(); assert.deepEqual(closed, []);
      second.release(); second.release(); first.release(); first.release();
      assert.deepEqual(closed, [2, 1]); assert.equal(value.texture, null);
    } finally {value.destroy();}
  });
});

test('text readiness follows the latest queued generation rather than the first conversion', async () => {
  await bitmapHost(async ({queue, closed, bitmap}) => {
    const value = new AnimationTextRasterizer(text); let ready = false;
    try {
      const pending = value.whenReady().then(() => {ready = true;});
      value.setStateDocument({value: 'B'}); queue[0].resolve(bitmap(1)); await tick();
      assert.equal(ready, false); assert.equal(queue.length, 2); assert.deepEqual(closed, [1]);
      queue[1].resolve(bitmap(2)); await pending;
      assert.equal(ready, true); assert.equal(value.texture.width, 80);
    } finally {value.destroy();}
    assert.deepEqual(closed, [1, 2]);
  });
});

test('bitmap conversion failure rejects readiness and an explicit invalidation can recover', async () => {
  await bitmapHost(async ({queue, closed, bitmap}) => {
    const value = new AnimationTextRasterizer(text), failure = Error('Bitmap host failure');
    try {
      queue[0].reject(failure); await assert.rejects(value.whenReady(), error => error === failure);
      assert.throws(() => value.acquireTextureSnapshot(), error => error === failure);
      value.invalidateFont(); queue[1].resolve(bitmap(2)); await value.whenReady();
      const handle = value.acquireTextureSnapshot(); handle.release();
    } finally {value.destroy();}
    assert.deepEqual(closed, [2]);
  });
});
