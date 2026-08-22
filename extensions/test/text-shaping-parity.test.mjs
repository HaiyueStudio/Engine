import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadResponsiveLayoutModules, responsiveLayoutFixture } from './responsive-layout-fixture.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modules = await loadResponsiveLayoutModules(workspace);
const { parseResponsiveLayoutDocument, encodeResponsiveLayoutDocument, decodeResponsiveLayoutDocument, LayoutDiagnostic } = modules.spec;
const { TextEvaluator } = modules.runtime;

test('HYLA parser and codec freeze deterministic text, layout and embedded asset bytes', () => {
  const parsed = parseResponsiveLayoutDocument(responsiveLayoutFixture());
  assert.ok(Object.isFrozen(parsed));
  const first = encodeResponsiveLayoutDocument(parsed), second = encodeResponsiveLayoutDocument(parsed);
  assert.deepEqual(new Uint8Array(first), new Uint8Array(second));
  assert.equal(new TextDecoder().decode(new Uint8Array(first, 0, 4)), 'HYLA');
  const decoded = decodeResponsiveLayoutDocument(first);
  assert.deepEqual([...decoded.assets.find(asset => asset.id === 'font').source.data], [1, 2, 3]);
  const corrupt = first.slice(0); new DataView(corrupt).setUint16(6, 1, true);
  assert.throws(() => decodeResponsiveLayoutDocument(corrupt), error => error instanceof LayoutDiagnostic && error.code === 'E_LAYOUT_BINARY');
});

test('versioned shaping is deterministic across graphemes, bidi, fallback, ligatures, axes and explicit updates', () => {
  const parsed = parseResponsiveLayoutDocument(responsiveLayoutFixture()), evaluator = new TextEvaluator(parsed);
  const first = evaluator.evaluate('label', { selections: { selection: [0, 2] }, cursors: { cursor: 2 } });
  const replay = evaluator.evaluate('label', { selections: { selection: [0, 2] }, cursors: { cursor: 2 } });
  assert.deepEqual(first, replay);
  assert.ok(first.glyphs.some(glyph => glyph.sequence === 'fi' && glyph.glyphId === 20), 'OpenType ligature is compiled from the pinned metrics');
  assert.ok(first.glyphs.findIndex(glyph => glyph.sequence === 'ב') < first.glyphs.findIndex(glyph => glyph.sequence === 'א'), 'RTL run is visually reordered');
  assert.ok(first.glyphs.every(glyph => glyph.fontAsset === 'font' && glyph.axes.wght === 610));
  assert.ok(first.glyphs.some(glyph => glyph.rotation !== 0 && glyph.opacity < 1));
  assert.deepEqual(first.controls.map(control => control.kind).sort(), ['cursor', 'selection']);
  const rebound = evaluator.evaluate('label', { strings: { inputText: 'AB' } });
  assert.deepEqual(rebound.glyphs.map(glyph => glyph.sequence), ['A', 'B']);
  evaluator.dispose(); evaluator.dispose();
  assert.throws(() => evaluator.evaluate('label'), error => error.code === 'E_TEXT_DISPOSED');
});

test('shaping rejects missing metrics, bad axes, glyph budgets and machine-dependent revisions', () => {
  const missing = responsiveLayoutFixture(); missing.textStyles[0].fontAssets = ['missing'];
  assert.throws(() => parseResponsiveLayoutDocument(missing), error => error.code === 'E_LAYOUT_REFERENCE');
  const badAxis = responsiveLayoutFixture(); badAxis.textStyles[0].axes.wght = 901;
  const parsed = parseResponsiveLayoutDocument(badAxis);
  assert.throws(() => new TextEvaluator(parsed).evaluate('label'), error => /E_TEXT_AXIS_RANGE/.test(error.message));
  assert.throws(() => new TextEvaluator(parseResponsiveLayoutDocument(responsiveLayoutFixture()), { maxGlyphs: 1, maxLines: 20 }).evaluate('label'), error => error.code === 'E_TEXT_LIMIT');
  const revision = responsiveLayoutFixture(); revision.shaping.stack = 'host-font-stack';
  assert.throws(() => parseResponsiveLayoutDocument(revision), error => error.code === 'E_LAYOUT_FORMAT');
});

test('fallback fonts, extended graphemes, OpenType feature switches and alignment use only embedded evidence', () => {
  const source = responsiveLayoutFixture(), fallback = structuredClone(source.assets.find(asset => asset.id === 'font')); fallback.id = 'fallback'; fallback.family = 'Fixture Fallback'; fallback.metrics.glyphs = { B: fallback.metrics.glyphs.B }; delete source.assets.find(asset => asset.id === 'font').metrics.glyphs.B; source.assets.splice(1, 0, fallback); source.textStyles[0].fontAssets = ['font', 'fallback']; source.textStyles[0].features.liga = false; source.textStyles[0].alignment = 'center';
  const evaluator = new TextEvaluator(parseResponsiveLayoutDocument(source)), fallbackPose = evaluator.evaluate('label', { strings: { inputText: 'ABfi' } });
  assert.equal(fallbackPose.glyphs.find(glyph => glyph.sequence === 'B').fontAsset, 'fallback'); assert.deepEqual(fallbackPose.glyphs.map(glyph => glyph.sequence), ['A', 'B', 'f', 'i']); assert.ok(fallbackPose.lines[0].x > 0);
  const grapheme = evaluator.evaluate('label', { strings: { inputText: 'A\u0301' } }); assert.equal(grapheme.glyphs.length, 1); assert.equal(grapheme.glyphs[0].sequence, 'A\u0301'); evaluator.dispose();
});

test('published layout schema, binary contract and frozen census are complete and source-neutral', async () => {
  const schemaText = await readFile(path.join(workspace, 'animation-spec/schema/responsive-layout-2d.schema.json'), 'utf8');
  const contractText = await readFile(path.join(workspace, 'animation-spec/schema/responsive-layout-2d.contract.json'), 'utf8');
  const mapping = JSON.parse(await readFile(path.join(workspace, 'animation-spec/schema/responsive-layout-2d-census-map.json'), 'utf8'));
  const census = JSON.parse(await readFile(path.join(workspace, 'docs/for-ai/rive-hya/runtime-census.json'), 'utf8'));
  const family = 'text-layout-component-asset';
  const expectedObjects = census.objects.filter(entry => entry.family === family).map(entry => entry.name).sort();
  const mappedObjects = Object.keys(mapping.objectMappings).sort();
  const expectedProperties = census.properties.filter(entry => entry.family === family).map(entry => `${entry.owner}.${entry.name}`).sort();
  const mappedProperties = Object.entries(mapping.propertyGroups).flatMap(([owner, names]) => names.map(name => `${owner}.${name}`)).sort();
  const expectedAssets = census.assets.filter(entry => entry.family === family).map(entry => entry.name).sort();
  assert.deepEqual(mappedObjects, expectedObjects); assert.deepEqual(mappedProperties, expectedProperties); assert.deepEqual(Object.keys(mapping.assetMappings).sort(), expectedAssets);
  assert.deepEqual(mapping.counts, { objects: 37, properties: 182, assets: 10 }); assert.deepEqual(mapping.unmapped, []);
  assert.doesNotMatch(`${schemaText}\n${contractText}`, /\brive\b/i);
});
