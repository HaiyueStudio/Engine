import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import { Entity } from '@haiyue/engine';
import { parseAnimation } from '@haiyue/animation-spec';

const scenario = process.argv[2];
let imports = 0;
let releaseParser;
globalThis.fontParserGate = new Promise(resolve => { releaseParser = resolve; });
globalThis.fontParseCount = 0;
globalThis.unsupportedFont = scenario === 'unsupported';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== 'opentype.js') return next(specifier, context);
    imports++;
    if (scenario === 'failure' && imports === 1) throw new Error('simulated chunk network failure');
    return { url: 'test:animation-font-parser', shortCircuit: true };
  },
  load(url, context, next) {
    if (url !== 'test:animation-font-parser') return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      await globalThis.fontParserGate;
      export function parse() {
        globalThis.fontParseCount++;
        if (globalThis.unsupportedFont) throw new Error('unsupported container');
        return { getPath() { return { commands: [] }; } };
      }
    ` };
  },
});
const { Animation2DRuntime } = await import('../../dist-test/animation/Animation2DRuntime.js');
const faces = new Set();
let released = 0;
let requests = 0;
let draws = 0;
globalThis.document = {
  fonts: { add: face => faces.add(face), delete: face => faces.delete(face) },
  createElement: () => ({ set width(_) { draws++; }, getContext: () => null }),
};
globalThis.FontFace = class {
  async load() {
    if (scenario === 'face-failure') throw new Error('invalid font');
    return this;
  }
};
const data = new ArrayBuffer(16);
const assetManager = { async load() {
  requests++;
  let active = true;
  return { value: data, release() { assert.ok(active, 'handle must release once'); active = false; released++; } };
} };
const text = { type: 'text2d', text: 'A', size: [40, 20], color: [1, 1, 1, 1], fontResource: 'font', fontFamily: 'Test' };
const make = (components = [text, text]) => new Animation2DRuntime(new Entity('test'), parseAnimation({
  format: 'haiyue-animation', version: '1.0', duration: 1,
  canvas: { width: 100, height: 100, coordinateSystem: 'screen-y-down' },
  nodes: [{ id: 'label', components }], tracks: [],
  resources: [{ id: 'font', type: 'binary', uri: '/font.ttf' }],
}), undefined, assetManager);
const settle = async runtime => {
  for (let i = 0; i < 100 && runtime.stats.pendingResourceCount; i++) await tick();
  assert.equal(runtime.stats.pendingResourceCount, 0);
};

if (scenario === 'idle') {
  const shape = make([{ type: 'shape2d', shape: 'rect', size: [20, 20], fill: [1, 0, 0, 1] }]);
  const { fontResource: _, ...systemText } = text;
  const system = make([systemText]);
  await tick();
  assert.equal(imports, 0);
  assert.equal(requests, 0);
  shape.destroy(); system.destroy();
} else if (scenario === 'failure' || scenario === 'face-failure') {
  const failed = make();
  await settle(failed);
  assert.equal(failed.stats.failedResourceCount, 1);
  assert.equal(faces.size, 0);
  assert.equal(released, 1);
  assert.equal(imports, scenario === 'face-failure' ? 0 : 1);
  failed.destroy();
  if (scenario === 'failure') {
    releaseParser();
    const retry = make();
    await settle(retry);
    assert.equal(imports, 2, 'new runtime can retry a failed chunk request');
    assert.equal(retry.stats.failedResourceCount, 0);
    assert.equal(faces.size, 1);
    retry.destroy();
    assert.equal(released, 2);
  }
} else {
  const runtime = make();
  await tick();
  assert.equal(imports, 1);
  assert.equal(runtime.stats.pendingResourceCount, 1, 'parser preparation belongs to font readiness');
  assert.equal(faces.size, 0, 'font is not registered before parser preparation');
  if (scenario === 'destroy') {
    runtime.destroy();
    assert.equal(released, 1, 'destruction releases the asset without waiting for a module download');
    const before = draws;
    releaseParser();
    await settle(runtime);
    assert.equal(draws, before, 'destroyed text cannot redraw after the import resolves');
    assert.equal(faces.size, 0);
    assert.equal(released, 1);
  } else {
    const second = make();
    await tick();
    assert.equal(imports, 1, 'concurrent runtimes share the parser import');
    releaseParser();
    await settle(runtime); await settle(second);
    assert.equal(globalThis.fontParseCount, 1, 'shared buffers parse once, including unsupported containers');
    assert.equal(runtime.stats.failedResourceCount, 0);
    assert.equal(faces.size, 2);
    assert.equal(draws, 8, 'all four text atlases are invalidated once after preparation');
    if (scenario === 'late-visual') {
      const { AnimationTextRasterizer } = await import('../../dist-test/animation/AnimationTextRasterizer.js');
      const late = new AnimationTextRasterizer(text);
      runtime._loadTextFonts(text, late);
      assert.equal(requests, 2);
      assert.equal(late.outlineFonts.size, 1, 'later materialized visuals reuse the prepared font synchronously');
      late.destroy();
    }
    runtime.destroy(); second.destroy();
    assert.equal(faces.size, 0);
    assert.equal(released, 2);
  }
}
