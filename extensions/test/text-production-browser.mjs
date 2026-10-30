import {ProductionTextOwner} from '/g11-text-build/animation/text/production/ProductionTextOwner.js';
import {createProductionBrowserFontPort} from '/g11-text-build/animation/text/production/ProductionBrowserFontPort.js';
import {LayoutAssetOwner} from '/g11-text-build/animation/layout/parameterized/AssetOwner.js';
const check = (condition, message) => {if (!condition) throw Error(message);};
const cases = [], captures = []; let owner, assets, face;
const initialFontCount = document.fonts.size, bitmaps = new Set();
const dpr = Number(new URLSearchParams(location.search).get('dpr') ?? 1);
function glyphPath(paint) {
  const path = new Path2D(); let offset = 0;
  for (const command of paint.commands) {
    if (command === 'M') {path.moveTo(...paint.values.slice(offset, offset + 2)); offset += 2;}
    else if (command === 'L') {path.lineTo(...paint.values.slice(offset, offset + 2)); offset += 2;}
    else if (command === 'C') {path.bezierCurveTo(...paint.values.slice(offset, offset + 6)); offset += 6;}
    else if (command === 'Q') {path.quadraticCurveTo(...paint.values.slice(offset, offset + 4)); offset += 4;}
    else path.closePath();
  }
  return path;
}
function canvas() {const value = document.createElement('canvas'); value.width = 320 * dpr; value.height = 320 * dpr; const context = value.getContext('2d', {willReadFrequently: true}); context.scale(dpr, dpr); context.fillStyle = '#f0f0f0'; context.fillRect(0, 0, 320, 320); return {canvas: value, context};}
function production(text) {
  const output = canvas(), context = output.context;
  for (const run of text.runs) for (const glyph of run.glyphs) {
    context.save(); context.transform(...glyph.transform); context.globalAlpha = glyph.opacity;
    if (glyph.paint.kind === 'bitmap') {context.imageSmoothingEnabled = false; context.drawImage(glyph.paint.source.value, 0, 0, 1, 1);}
    else {const color = run.style.fills[0].source.color; context.fillStyle = `rgba(${color[0] * 255},${color[1] * 255},${color[2] * 255},${color[3]})`; context.fill(glyphPath(glyph.paint), 'nonzero');}
    context.restore();
  }
  return output;
}
try {
  const value = await (await fetch('/g11-text-fixture/document.json')).json(), bytes = await (await fetch('/g11-text-fixture/font.otf')).arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  face = await new FontFace('Haiyue G11 Fixture', bytes).load(); document.fonts.add(face); await document.fonts.ready;
  const parserReads = () => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/opentype.module.js')).length;
  check(parserReads() === 0, 'OpenType must remain lazy before explicit font preparation');
  assets = new LayoutAssetOwner(value, {policy: {mode: 'deny'}}); owner = new ProductionTextOwner(value, createProductionBrowserFontPort(assets, {maxBitmapBytes: 8 * 1024 * 1024})); await owner.prepare();
  check(parserReads() === 1, 'existing lazy parser loads once during actual font preparation');
  cases.push({id: 'real-font-bytes-and-lazy-parser', fontSha256: hash, parserLoads: parserReads()});
  const variants = [
    {id:'fractional-small',text:'ABA',width:240,lines:['ABA'],style:{fontSize:24,lineHeight:29}},
    {id:'long-small-wrap',text:'ABABABABABABABAB',width:240,lines:['ABABABABABABAB','AB'],style:{fontSize:24,lineHeight:29}},
    {id: 'wide', text: 'ABA', width: 240, lines: ['ABA']},
    {id: 'narrow-wrap', text: 'ABA', width: 150, lines: ['AB', 'A']},
    {id: 'rtl', text: 'אבב', width: 240, lines: ['אבב'], style: {direction: 'rtl'}},
    {id: 'emoji-utf16', text: 'A😀B', width: 240, lines: ['A😀B']},
    {id: 'font-size-change', text: 'ABA', width: 240, lines: ['ABA'], style: {fontSize: 80, lineHeight: 96}},
    {id: 'colored-alpha', text: 'ABA', width: 240, lines: ['ABA'], style: {fills: [{source: {kind: 'solid', color: [.2, .4, .6, .5]}}]}},
  ];
  for (const variant of variants) {
    const style = {...value.textStyles[0], ...(variant.style ?? {})};
    const request = {block: 'label', dpr, strings: {value: variant.text}, constraints: {width: {mode: 'exact', value: variant.width}, height: {mode: 'unbounded'}}, ...(variant.style ? {styles: {body: variant.style}} : {})};
    const frame = owner.shape(request), actual = production(frame), expected = canvas(), context = expected.context;
    for (const run of frame.runs) for (const glyph of run.glyphs) if (glyph.paint.kind === 'bitmap') bitmaps.add(glyph.paint.source.value);
    context.font = `${style.fontSize}px "Haiyue G11 Fixture"`; context.textBaseline = 'alphabetic'; context.direction = style.direction; context.textAlign = style.direction === 'rtl' ? 'right' : 'left';
    const color = style.fills[0].source.color; context.fillStyle = `rgba(${color[0] * 255},${color[1] * 255},${color[2] * 255},${color[3]})`;
    // Independent authored lines/positions, rendered by the browser font engine (not the glyph port).
    for (let index = 0; index < variant.lines.length; index++) context.fillText(variant.lines[index], style.direction === 'rtl' ? variant.width : 0, style.fontSize * .8 + style.lineHeight * index);
    const pixels = actual.context.getImageData(0, 0, actual.canvas.width, actual.canvas.height).data;
    const reference = context.getImageData(0, 0, expected.canvas.width, expected.canvas.height).data;
    let maximum = 0, differing = 0, nontransparent = 0;
    for (let index = 0; index < pixels.length; index++) {const difference = Math.abs(pixels[index] - reference[index]); maximum = Math.max(maximum, difference); if (difference) differing++; if (index % 4 === 0 && pixels[index] !== 240) nontransparent++;}
    captures.push({id: variant.id, actual: actual.canvas.toDataURL(), reference: expected.canvas.toDataURL()});
    cases.push({id: variant.id, dpr, maximumChannelDifference: maximum, differingChannels: differing, nontransparentPixels: nontransparent, lines: frame.lines.length});
    check(nontransparent > 100 && frame.lines.length === variant.lines.length, `${variant.id}: real ink/line geometry`);
    check(maximum <= 2, `${variant.id}: full-image channel difference ${maximum} exceeds original tolerance 2`);
    const count = owner.stats.shapes; check(owner.shape(request) === frame && owner.stats.shapes === count, 'static identical text must not re-shape');
  }
  const limited = new ProductionTextOwner(value, createProductionBrowserFontPort(assets, {maxBitmapBytes: 0})); await limited.prepare();
  let limitError; try {limited.shape({block: 'label', dpr});} catch (error) {limitError = error;}
  check(limitError?.code === 'E_HYA_RUNTIME_LIMIT', 'bitmap byte budget rejects before publishing a glyph'); limited.dispose();
  let variantError; try {owner.shape({block: 'label', dpr, styles: {body: {fontWeight: 700}}});} catch (error) {variantError = error;}
  check(variantError?.code === 'E_HYA_RUNTIME_HOST_PORT', 'unprepared synthetic font variants remain explicit, never a regular-font fallback');
  cases.push({id: 'explicit-bitmap-budget-and-unsupported-variant', budgetCode: limitError.code, variantCode: variantError.code});
  owner.dispose(); owner.dispose(); assets.dispose(); document.fonts.delete(face);
  check(owner.stats.releases === 1 && owner.stats.cached === 0, 'prepared font owner release/cached result');
  check([...bitmaps].every(canvas => canvas.width === 0 && canvas.height === 0), 'all created glyph bitmaps retired');
  check(document.fonts.size === initialFontCount, 'only owned FontFaces removed');
  cases.push({id: 'font-lifecycle-and-static-cache', releases: owner.stats.releases, parserLoads: parserReads(), retiredBitmaps: bitmaps.size, fontResidue: document.fonts.size - initialFontCount});
  const result = {status: 'passed', caseCount: cases.length, cases, captures, background: '#f0f0f0', scope: 'Real font port/geometry and complete opaque scene composite against independent native font drawing; not final Engine WebGPU composition or transparent intermediate RGB qualification'};
  document.querySelector('#result').textContent = JSON.stringify(result); document.querySelector('#result').dataset.status = result.status;
} catch (error) {
  owner?.dispose(); assets?.dispose(); if (face) document.fonts.delete(face);
  document.querySelector('#result').textContent = JSON.stringify({status: 'failed', cases, captures, error: String(error.stack ?? error)}); document.querySelector('#result').dataset.status = 'failed';
}
