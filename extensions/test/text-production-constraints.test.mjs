import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules, responsiveLayoutFixture} from './responsive-layout-fixture.mjs';
const {spec, runtime} = await loadResponsiveLayoutModules();
function source() {
  const document = responsiveLayoutFixture(); document.textBlocks[0].modifiers = []; document.textBlocks[0].origin = [0, 0];
  document.textStyles[0].verticalAlignment = 'top'; return spec.parseResponsiveLayoutDocument(document);
}
const strings = {labelText: 'AAAAAAAAAAAA'};

test('explicit production width and unbounded height reflow the existing text evaluator without changing authored legacy boxes', () => {
  const evaluator = new runtime.TextEvaluator(source());
  const original = evaluator.evaluate('label', {strings});
  const wide = evaluator.evaluate('label', {strings, constraints: {width: {mode: 'exact', value: 160}, height: {mode: 'unbounded'}}});
  const narrow = evaluator.evaluate('label', {strings, constraints: {width: {mode: 'exact', value: 60}, height: {mode: 'unbounded'}}});
  assert.equal(original.width, 100); assert.equal(original.height, 52); assert.equal(original.lines.length, 2);
  assert.equal(wide.width, 160); assert.equal(wide.lines.length, 1); assert.equal(wide.height, 24);
  assert.equal(narrow.width, 60); assert.equal(narrow.lines.length, 3); assert.equal(narrow.height, 76);
  assert.deepEqual(evaluator.evaluate('label', {strings}), original, 'measurement never mutates the authored block'); evaluator.dispose();
});

test('at-most and unbounded axes return finite natural geometry and preserve alignment/clip semantics', () => {
  const evaluator = new runtime.TextEvaluator(source());
  const natural = evaluator.evaluate('label', {strings, constraints: {width: {mode: 'unbounded'}, height: {mode: 'unbounded'}}});
  assert.equal(natural.lines.length, 1); assert.equal(natural.width, natural.contentWidth); assert.ok(natural.width > 100);
  const bounded = evaluator.evaluate('label', {strings, constraints: {width: {mode: 'at-most', value: 40}, height: {mode: 'at-most', value: 30}}});
  assert.ok(bounded.width <= 40 && bounded.height <= 30); assert.equal(bounded.lines.length, 1);
  const empty = evaluator.evaluate('label', {strings, constraints: {width: {mode: 'exact', value: 0}, height: {mode: 'exact', value: 0}}});
  assert.equal(empty.width, 0); assert.equal(empty.height, 0); assert.equal(empty.glyphs.length, 0);
  for (const line of natural.lines) assert.ok([line.x, line.y, line.width, line.height].every(Number.isFinite)); evaluator.dispose();
});

test('invalid text constraints are rejected before any host shaping or geometry publication', () => {
  const document = source(); let calls = 0;
  const shaper = {shape() {calls++; return [];}};
  const evaluator = new runtime.TextEvaluator(document, undefined, shaper);
  for (const width of [{mode: 'exact', value: -1}, {mode: 'exact', value: Infinity}, {mode: 'at-most'}, {mode: 'unbounded', value: 4}, {mode: 'wrong'}]) {
    assert.throws(() => evaluator.evaluate('label', {constraints: {width}}), error => error.code === 'E_TEXT_FORMAT');
  }
  assert.equal(calls, 0); evaluator.dispose();
});

test('style changes affect measurement and paint in the same frame and retain immutable snapshots', () => {
  const evaluator = new runtime.TextEvaluator(source());
  const patch = {fontSize: 40, lineHeight: 48, tracking: 2, fills: [{source: {kind: 'solid', color: [.2, .4, .6, 1]}}]};
  const before = evaluator.evaluate('label', {strings, constraints: {width: {mode: 'unbounded'}, height: {mode: 'unbounded'}}});
  const changed = evaluator.evaluate('label', {strings, styles: {body: patch}, constraints: {width: {mode: 'unbounded'}, height: {mode: 'unbounded'}}});
  assert.equal(changed.width, before.width * 2); assert.equal(changed.height, 48);
  assert.deepEqual(changed.glyphs[0].fills[0].source.color, [.2, .4, .6, 1]);
  patch.fills[0].source.color[0] = 1;
  assert.equal(changed.glyphs[0].fills[0].source.color[0], .2);
  assert.ok(Object.isFrozen(changed.glyphs[0].fills[0].source.color));
  assert.equal(evaluator.evaluate('label', {strings}).width, 100); evaluator.dispose();
});

test('prepared glyph shaping reuses the original wrapping/modifier/control evaluator and remains borrowed', () => {
  const document = source(), fonts = document.assets.filter(asset => asset.kind === 'font');
  const original = new runtime.DeterministicTextShaper(fonts, document.shaping.backendRevision); let calls = 0, disposed = 0;
  const prepared = {shape(...args) {calls++; return original.shape(...args);}, dispose() {disposed++;}};
  const evaluator = new runtime.TextEvaluator(document, undefined, prepared), reference = new runtime.TextEvaluator(document);
  const request = {strings, constraints: {width: {mode: 'exact', value: 60}, height: {mode: 'unbounded'}}, cursors: {caret: 2}};
  assert.deepEqual(evaluator.evaluate('label', request), reference.evaluate('label', request)); assert.equal(calls, 1);
  evaluator.dispose(); reference.dispose(); assert.equal(disposed, 0);
});
