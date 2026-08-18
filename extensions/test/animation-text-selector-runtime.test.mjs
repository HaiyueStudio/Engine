import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationTextRasterizer } from '../dist-test/animation/AnimationTextRasterizer.js';

test('text rasterizer applies word selector groups to every grapheme in the selected word', async () => {
  const previousDocument = globalThis.document;
  const draws = [];
  let translatedX = 0;
  const context = {
    setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {}, rotate() {}, scale() {},
    measureText: () => ({ width: 10 }),
    translate(x) { translatedX = x; },
    fillText(glyph) { draws.push({ glyph, x: translatedX }); },
    font: '', textBaseline: 'alphabetic', textAlign: 'left', fillStyle: '', globalAlpha: 1,
  };
  globalThis.document = {
    createElement() { return { width: 0, height: 0, getContext: () => context }; },
  };
  try {
    const rasterizer = new AnimationTextRasterizer({
      type: 'text2d', text: 'AB CD\nEF', size: [300, 100], color: [1, 1, 1, 1],
      fontSize: 10, lineHeight: 20, textAlign: 'left', verticalAlign: 'top',
      animators: [{
        selector: { start: 0, end: 1, units: 'index', shape: 'square', basedOn: 'words' },
        position: [100, 0],
      }],
    });
    await rasterizer.updateTexture();
    assert.deepEqual(draws.map(draw => draw.glyph), ['A', 'B', ' ', 'C', 'D', 'E', 'F']);
    assert.ok(draws.slice(0, 3).every(draw => draw.x >= 100), 'first word and its delimiter receive the same selector group');
    assert.ok(draws.slice(3).every(draw => draw.x < 100), 'later words and lines remain outside the selected group');
    rasterizer.destroy();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('randomized text selector permutation is stable for the same imported seed', async () => {
  const previousDocument = globalThis.document;
  const render = () => {
    const draws = [];
    let translatedX = 0;
    const context = {
      setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {}, rotate() {}, scale() {},
      measureText: () => ({ width: 10 }),
      translate(x) { translatedX = x; },
      fillText(glyph) { draws.push([glyph, translatedX]); },
      font: '', textBaseline: 'alphabetic', textAlign: 'left', fillStyle: '', globalAlpha: 1,
    };
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
    const rasterizer = new AnimationTextRasterizer({
      type: 'text2d', text: 'ABCD', size: [100, 30], color: [1, 1, 1, 1], fontSize: 10,
      textAlign: 'left', verticalAlign: 'top',
      animators: [{
        selector: { start: 0, end: 1, units: 'index', basedOn: 'characters', randomSeed: 0x12345678 },
        position: [40, 0],
      }],
    });
    rasterizer.destroy();
    return draws;
  };
  try {
    assert.deepEqual(render(), render());
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
