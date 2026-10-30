import opentype from 'opentype.js';
import {createHash} from 'node:crypto';

/** Self-authored MIT font; no external font, platform font or downloaded reference. */
export function productionFontFixture() {
  const path = commands => {const p = new opentype.Path(); for (const [kind, ...values] of commands) p[kind](...values); return p;};
  const A = [['moveTo', 50, 0], ['lineTo', 350, 700], ['lineTo', 650, 0], ['close'], ['moveTo', 280, 250], ['lineTo', 420, 250], ['lineTo', 350, 420], ['close']];
  const B = [['moveTo', 50, 0], ['lineTo', 50, 700], ['lineTo', 350, 700], ['curveTo', 700, 700, 700, 350, 400, 350], ['curveTo', 750, 350, 750, 0, 350, 0], ['close']];
  const emoji = [['moveTo', 100, 350], ['curveTo', 100, 800, 900, 800, 900, 350], ['curveTo', 900, -100, 100, -100, 100, 350], ['close'], ['moveTo', 300, 500], ['lineTo', 300, 400], ['lineTo', 380, 400], ['lineTo', 380, 500], ['close']];
  const glyph = (name, unicode, advanceWidth, commands) => new opentype.Glyph({name, ...(unicode === undefined ? {} : {unicode}), advanceWidth, path: path(commands)});
  const font = new opentype.Font({familyName: 'Haiyue G11 Fixture', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200, createdTimestamp: 1577836800,
    glyphs: [glyph('.notdef', undefined, 700, B), glyph('space', 32, 300, []), glyph('A', 65, 700, A), glyph('B', 66, 700, B), glyph('alef', 0x5d0, 700, A), glyph('bet', 0x5d1, 700, B), glyph('face', 0x1f600, 1000, emoji)]});
  const buffer = font.toArrayBuffer(), view = new DataView(buffer); let head, headEntry;
  for (let index = 0; index < view.getUint16(4); index++) {
    const entry = 12 + index * 16;
    if (view.getUint32(entry) === 0x68656164) {head = view.getUint32(entry + 8); headEntry = entry;}
  }
  // Normalize head timestamps/checksums so repeated fixture generation has the same bytes.
  for (const offset of [head + 20, head + 28]) {view.setUint32(offset, 0); view.setUint32(offset + 4, 3660681600);}
  view.setUint32(head + 8, 0);
  const checksum = (offset, length) => {let sum = 0; for (let index = 0; index < length; index += 4) sum = (sum + view.getUint32(offset + index)) >>> 0; return sum;};
  view.setUint32(headEntry + 4, checksum(head, (view.getUint32(headEntry + 12) + 3) & ~3));
  view.setUint32(head + 8, (0xb1b0afba - checksum(0, buffer.byteLength)) >>> 0);
  const bytes = new Uint8Array(buffer), parsed = opentype.parse(buffer), metrics = {};
  for (const character of [' ', 'A', 'B', 'א', 'ב', '😀']) {
    const g = parsed.charToGlyph(character), b = g.getBoundingBox(); metrics[character] = {glyphId: g.index, advance: g.advanceWidth, bounds: [b.x1, b.y1, b.x2, b.y2]};
  }
  const missing = parsed.glyphs.get(0), bounds = missing.getBoundingBox();
  const digest = createHash('sha256').update(bytes).digest('base64');
  const document = {format: 'haiyue-responsive-layout-2d', version: 1, extension: 'org.haiyue.layout-2d@1',
    shaping: {stack: 'haiyue-text-shaping@1', backendRevision: 'g11-owned-font-1', unicodeVersion: '15.1', graphemeRevision: 'uax29-43', bidiRevision: 'uax9-50'},
    assets: [{id: 'font', kind: 'font', family: 'Haiyue G11 Fixture', weight: 400, style: 'normal',
      source: {kind: 'embedded', data: [...bytes], integrity: 'sha256-' + digest},
      metrics: {unitsPerEm: 1000, ascent: 800, descent: -200, lineGap: 0, missingGlyph: {glyphId: 0, advance: missing.advanceWidth, bounds: [bounds.x1, bounds.y1, bounds.x2, bounds.y2]}, glyphs: metrics}}],
    textStyles: [{id: 'body', fontAssets: ['font'], fontFamily: 'Haiyue G11 Fixture', fontWeight: 400, fontStyle: 'normal', fontSize: 100, lineHeight: 120,
      tracking: 0, alignment: 'start', direction: 'ltr', verticalAlignment: 'top', fills: [{source: {kind: 'solid', color: [0, 0, 0, 1]}}]}],
    textBlocks: [{id: 'label', runs: [{id: 'run', style: 'body', text: 'ABA', valuePort: 'value'}], width: 240, height: 300, wrap: 'grapheme', overflow: 'clip', input: {valuePort: 'value', selectionPort: 'selection', cursorPort: 'cursor'}}],
    artboards: [{id: 'main', width: 320, height: 320, root: 'root', nodes: [{id: 'root', kind: 'container', style: {display: 'flex', direction: 'column', width: {unit: 'fill'}, height: {unit: 'fill'}}}, {id: 'text', parent: 'root', kind: 'text', text: 'label', style: {width: {unit: 'point', value: 240}, height: {unit: 'hug'}}}]}],
    instances: [{id: 'stage', artboard: 'main', fit: 'fill', alignment: [0, 0]}]};
  return {bytes, document, sha256: createHash('sha256').update(bytes).digest('hex'), license: 'MIT', author: 'Haiyue G11 test fixture; original geometric glyphs'};
}
