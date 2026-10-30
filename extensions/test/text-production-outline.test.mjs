import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
import {productionFontFixture} from './text-production-font-fixture.mjs';
const {spec, runtime, textProduction: {ProductionTextOwner}, outlineProduction: {createProductionOutlineFontPort}} = await loadResponsiveLayoutModules();
async function owner(mutate = () => {}) {
  const fixture = productionFontFixture(); mutate(fixture.document);
  const document = spec.parseResponsiveLayoutDocument(fixture.document);
  const assets = new runtime.LayoutAssetOwner(document, {policy: {mode: 'deny'}});
  const owner = new ProductionTextOwner(document, createProductionOutlineFontPort(assets));
  await owner.prepare(); return {owner, assets, fixture};
}

test('real self-authored font yields actual glyph IDs, curved outlines, ascent baselines and constrained wrapping', async () => {
  const {owner: player, assets} = await owner();
  const wide = player.shape({block: 'label', constraints: {width: {mode: 'exact', value: 240}, height: {mode: 'unbounded'}}});
  assert.deepEqual(wide.size, [240, 120]); assert.deepEqual(wide.runs.flatMap(run => run.glyphs.map(glyph => glyph.id)), [2, 3, 2]);
  assert.ok(wide.runs.some(run => run.glyphs.some(glyph => glyph.paint.commands.includes('C'))));
  assert.equal(wide.runs[0].glyphs[0].transform[5], 80); assert.equal(wide.runs[0].glyphs[0].rect[1], 10);
  const narrow = player.shape({block: 'label', constraints: {width: {mode: 'exact', value: 150}, height: {mode: 'unbounded'}}});
  assert.deepEqual(narrow.size, [150, 240]); assert.equal(narrow.lines.length, 2);
  player.dispose(); assets.dispose();
});

test('compiled font metrics cannot silently disagree with the integrity-checked actual outline font', async () => {
  await assert.rejects(owner(document => {document.assets[0].metrics.glyphs.A.advance++;}), error => error.code === 'E_HYA_RUNTIME_TEXT');
});

test('UTF-16 emoji editing and RTL glyph ranges reuse existing segmentation and line/control geometry', async () => {
  const {owner: player, assets} = await owner();
  const emoji = player.shape({block: 'label', strings: {value: 'A😀B'}, selections: {selection: [1, 3]}, cursors: {cursor: 3}, constraints: {width: {mode: 'exact', value: 240}, height: {mode: 'unbounded'}}});
  assert.deepEqual(emoji.runs.flatMap(run => run.glyphs.map(glyph => glyph.clusterUtf16)), [0, 1, 3]);
  assert.deepEqual(emoji.controls.find(control => control.kind === 'cursor').rect, [170, 0, 1, 120]);
  assert.deepEqual(emoji.controls.find(control => control.kind === 'selection').rect, [70, 0, 100, 120]);
  assert.throws(() => player.shape({block: 'label', strings: {value: 'A😀B'}, cursors: {cursor: 2}}), error => error.code === 'E_HYA_RUNTIME_TEXT');
  const rtl = player.shape({block: 'label', strings: {value: 'אבב'}, styles: {body: {direction: 'rtl'}}, constraints: {width: {mode: 'exact', value: 240}, height: {mode: 'unbounded'}}});
  assert.deepEqual(rtl.runs.flatMap(run => run.glyphs.map(glyph => glyph.clusterUtf16)), [2, 1, 0]); assert.deepEqual(rtl.lines.map(line => [line.startUtf16, line.endUtf16]), [[0, 3]]);
  player.dispose(); assets.dispose();
});

test('font fixture bytes are reproducible and source license is explicit', () => {
  const a = productionFontFixture(), b = productionFontFixture(); assert.equal(a.sha256, b.sha256); assert.equal(a.license, 'MIT');
});

test('an empty production input retains its actual line height and a visible UTF-16 cursor at the origin', async () => {
  const {owner: player, assets} = await owner();
  const empty = player.shape({block: 'label', strings: {value: ''}, cursors: {cursor: 0}, constraints: {width: {mode: 'exact', value: 240}, height: {mode: 'unbounded'}}});
  assert.deepEqual(empty.size, [240, 120]); assert.deepEqual(empty.controls, [{kind: 'cursor', rect: [0, 0, 1, 120]}]);
  player.dispose(); assets.dispose();
});
