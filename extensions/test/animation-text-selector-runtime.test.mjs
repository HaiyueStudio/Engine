import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationTextRasterizer, quantizeRiveTextCoverage } from '../dist-test/animation/AnimationTextRasterizer.js';

test('Rive text coverage quantization restores binary opaque paint samples', () => {
  const image = { data: new Uint8ClampedArray([
    255, 255, 255, 96,
    24, 225, 24, 160,
    24, 225, 24, 200,
    88, 150, 88, 255,
    24, 225, 24, 255,
  ]) };
  let committed = null;
  const context = {
    getImageData() { return image; },
    putImageData(value) { committed = value; },
  };
  quantizeRiveTextCoverage(context, 5, 1, [[116 / 255, 116 / 255, 116 / 255, 1], [0, 1, 0, 1]]);
  assert.deepEqual([...image.data], [
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 255, 0, 255,
    116, 116, 116, 255,
    0, 255, 0, 255,
  ]);
  assert.equal(committed, image);
});

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

test('text rasterizer evaluates verified expression data and never receives source script', async () => {
  const previousDocument = globalThis.document;
  const draws = [];
  const context = {
    setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, translate() {},
    measureText: () => ({ width: 10 }),
    fillText(glyph) { draws.push(glyph); },
    font: '', textBaseline: 'alphabetic', textAlign: 'left', fillStyle: '', globalAlpha: 1,
  };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  try {
    const rasterizer = new AnimationTextRasterizer({
      type: 'text2d', text: 'fallback', size: [200, 40], color: [1, 1, 1, 1], fontSize: 10,
      textAlign: 'left', verticalAlign: 'top',
      expression: {
        version: 1, result: 'text', localCount: 0,
        instructions: [
          { op: 'data', resource: 'weather', path: ['timezone'] },
          { op: 'return' },
        ],
      },
    });
    draws.length = 0;
    rasterizer.setExpressionData('weather', { timezone: 'Asia/Shanghai' });
    await rasterizer.updateTexture();
    assert.equal(draws.join(''), 'Asia/Shanghai');
    rasterizer.destroy();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('styled text preserves whole-run shaping, pinned font fitting and Rive first-line background bounds', async () => {
  const previousDocument = globalThis.document;
  const draws = []; const pathPoints = []; let fillCount = 0;
  const context = {
    setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, translate() {},
    beginPath() {}, closePath() {}, fill() { fillCount++; }, stroke() {},
    moveTo(x, y) { pathPoints.push(['M', x, y]); }, lineTo(x, y) { pathPoints.push(['L', x, y]); },
    bezierCurveTo(_c1x, _c1y, _c2x, _c2y, x, y) { pathPoints.push(['C', x, y]); },
    measureText(text) {
      const size = Number(/([0-9.]+)px/u.exec(this.font)?.[1] ?? 10);
      return { width: text.length * size, fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2 };
    },
    fillText(text, x, y) { draws.push({ text, x, y, font: this.font }); },
    font: '', letterSpacing: '0px', textBaseline: 'alphabetic', textAlign: 'left', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  try {
    const background = new AnimationTextRasterizer({
      type: 'text2d', text: 'office', size: [200, 100], color: [1, 1, 1, 1], fontSize: 20, lineHeight: 30,
      textAlign: 'left', verticalAlign: 'top', styleRuns: [{
        start: 0, end: 6, fontSize: 20, lineHeight: 30, color: [1, 1, 1, 1],
        lineBackground: { fill: [1, 0, 0, 1] },
      }],
    });
    assert.deepEqual(draws.map(draw => draw.text), ['office']);
    assert.ok(pathPoints.some(point => point.at(-1) === 22), 'first line uses natural ascent plus custom descent');
    background.destroy();

    draws.length = 0; pathPoints.length = 0; fillCount = 0;
    const fitted = new AnimationTextRasterizer({
      type: 'text2d', text: 'AAAA', size: [39, 100], color: [1, 1, 1, 1], fontSize: 10, lineHeight: 10,
      textAlign: 'left', verticalAlign: 'top', wrap: 'none', fit: 'font-size',
      styleRuns: [{
        start: 0, end: 4, fontSize: 10, lineHeight: 10, color: [1, 1, 1, 1],
        lineBackground: { fill: [1, 0, 0, 1] },
      }],
    });
    assert.equal(draws.at(-1).text, 'AAAA');
    assert.match(draws.at(-1).font, / 9px /u);
    assert.ok(pathPoints.some(point => Math.abs(point.at(-1) - 9.2) < 1e-6),
      'pinned fit-font-size preserves the authored line box while the natural first-line ascent follows the fitted font');
    fitted.destroy();

    draws.length = 0; pathPoints.length = 0; fillCount = 0;
    const joined = new AnimationTextRasterizer({
      type: 'text2d', text: 'AB\nC', size: [100, 40], color: [1, 1, 1, 1], fontSize: 10, lineHeight: 10,
      textAlign: 'left', verticalAlign: 'top', styleRuns: [{
        start: 0, end: 4, fontSize: 10, lineHeight: 10, color: [1, 1, 1, 1],
        lineBackground: { fill: [1, 0, 0, 1], cornerRadius: 2 },
      }],
    });
    assert.equal(fillCount, 1, 'touching line backgrounds are painted as one joined path');
    assert.equal(pathPoints.filter(point => point[0] === 'C').length, 6, 'joined unequal lines retain six rounded contour vertices');
    joined.destroy();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
