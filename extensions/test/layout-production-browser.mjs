import {ProductionLayoutOwner} from '/g11-layout-build/animation/layout/production/ProductionLayoutOwner.js';
import {ProductionTextOwner} from '/g11-layout-build/animation/text/production/ProductionTextOwner.js';
import {createProductionBrowserFontPort} from '/g11-layout-build/animation/text/production/ProductionBrowserFontPort.js';
import {LayoutAssetOwner} from '/g11-layout-build/animation/layout/parameterized/AssetOwner.js';
const check = (condition, message) => {if (!condition) throw Error(message);};
const cases = [], captures = [], layouts = [], bitmaps = new Set(); let text, assets, face;
const initialFonts = document.fonts.size, dpr = Number(new URLSearchParams(location.search).get('dpr') ?? 1);
const point = value => ({unit: 'point', value});
function canvas() {
  const canvas = document.createElement('canvas'); canvas.width = 480 * dpr; canvas.height = 360 * dpr;
  const context = canvas.getContext('2d', {willReadFrequently: true}); context.scale(dpr, dpr); context.fillStyle = '#f0f0f0'; context.fillRect(0, 0, 480, 360);
  return {canvas, context};
}
function clip(context, rect) {if (rect) {context.beginPath(); context.rect(...rect); context.clip();}}
function production(frame) {
  const output = canvas(), context = output.context;
  for (const node of frame.nodes) {
    context.save(); clip(context, node.clip); context.globalAlpha = node.opacity;
    if (node.background) {const c = node.background; context.fillStyle = `rgba(${c[0]*255},${c[1]*255},${c[2]*255},${c[3]})`; context.fillRect(...node.rect);}
    if (node.text) {
      context.translate(node.rect[0], node.rect[1]);
      for (const control of node.text.controls) {context.fillStyle = 'rgba(25,100,255,.7)'; context.fillRect(...control.rect);}
      for (const run of node.text.runs) for (const glyph of run.glyphs) {
        check(glyph.paint.kind === 'bitmap', 'explicit browser host must return actual font bitmaps'); bitmaps.add(glyph.paint.source.value);
        context.save(); context.globalAlpha = node.opacity * glyph.opacity; context.transform(...glyph.transform); context.imageSmoothingEnabled = false;
        context.drawImage(glyph.paint.source.value, 0, 0, 1, 1); context.restore();
      }
    }
    context.restore();
  }
  return output;
}
function reference(labels, style, caret = false) {
  const output = canvas(), context = output.context;
  for (const label of labels) {
    context.save(); clip(context, label.clip); context.globalAlpha = label.opacity ?? 1; context.translate(label.x, label.y);
    if (caret) {context.fillStyle = 'rgba(25,100,255,.7)'; context.fillRect(0, 0, 1, style.lineHeight);}
    const c = style.fills[0].source.color;
    context.fillStyle = `rgba(${c[0]*255},${c[1]*255},${c[2]*255},${c[3]})`;
    context.font = `${style.fontSize}px "Haiyue G11 Fixture"`; context.textBaseline = 'alphabetic'; context.direction = style.direction; context.textAlign = style.direction === 'rtl' ? 'right' : 'left';
    label.lines.forEach((line, index) => context.fillText(line, style.direction === 'rtl' ? label.width : 0, style.fontSize * .8 + style.lineHeight * index));
    if (label.foot) {context.fillStyle = 'rgb(204,25.5,51)'; context.fillRect(0, label.lines.length * style.lineHeight, 12, 8);}
    context.restore();
  }
  return output;
}
function compare(id, actual, expected, frame) {
  const a = actual.context.getImageData(0, 0, actual.canvas.width, actual.canvas.height).data;
  const e = expected.context.getImageData(0, 0, expected.canvas.width, expected.canvas.height).data;
  let maximum = 0, channels = 0, ink = 0;
  for (let i = 0; i < a.length; i++) {const difference = Math.abs(a[i] - e[i]); maximum = Math.max(maximum, difference); if (difference) channels++; if (i % 4 === 0 && a[i] !== 240) ink++;}
  captures.push({id, actual: actual.canvas.toDataURL(), reference: expected.canvas.toDataURL()});
  cases.push({id, dpr, maximumChannelDifference: maximum, differingChannels: channels, inkPixels: ink, textNodes: frame.nodes.filter(node => node.text).length, revision: frame.revision});
  check(ink > 50 && maximum <= 2, `${id}: complete native font scene differs by ${maximum} (original tolerance 2)`);
}
try {
  const value = await (await fetch('/g11-layout-fixture/document.json')).json(), bytes = await (await fetch('/g11-layout-fixture/font.otf')).arrayBuffer();
  face = await new FontFace('Haiyue G11 Fixture', bytes).load(); document.fonts.add(face); await document.fonts.ready;
  const base = structuredClone(value); base.artboards[0].nodes[1].style = {width: {unit: 'percent', value: 100}, height: {unit: 'hug'}};
  base.artboards[0].nodes.push({id: 'after', parent: 'root', kind: 'leaf', style: {width: point(12), height: point(8)}, visual: {background: [.8, .1, .2, 1]}});
  assets = new LayoutAssetOwner(value, {policy: {mode: 'deny'}}); text = new ProductionTextOwner(value, createProductionBrowserFontPort(assets, {maxBitmapBytes: 16 * 1024 * 1024})); await text.prepare();
  const layout = new ProductionLayoutOwner(base, text); layouts.push(layout);
  const variants = [
    {id: 'wide-flow', width: 240, text: 'ABA', lines: ['ABA']},
    {id: 'narrow-flow-resize', width: 150, text: 'ABA', lines: ['AB', 'A']},
    {id: 'emoji-UTF16', width: 240, text: 'A😀B', lines: ['A😀B']},
    {id: 'RTL-color-opacity', width: 150, text: 'אבב', lines: ['אבב'], style: {direction: 'rtl', fontSize: 50, lineHeight: 60, fills: [{source: {kind: 'solid', color: [.2, .4, .6, .5]}}]}},
    {id: 'small-long-fractional-lines', width: 100, text: 'ABAABAABAABA', lines: ['ABAAB', 'AABAA', 'BA'], style: {fontSize: 24, lineHeight: 28.8}},
    {id: 'empty-input-caret', width: 150, text: '', lines: [''], caret: true},
    {id: 'return-to-wide', width: 240, text: 'ABA', lines: ['ABA']},
  ];
  for (const variant of variants) {
    const style = {...value.textStyles[0], ...(variant.style ?? {})};
    const request = {viewport: [variant.width, 340], dpr, time: 0, strings: {value: variant.text}, ...(variant.style ? {styles: {body: variant.style}} : {}), ...(variant.caret ? {cursors: {cursor: 0}} : {})};
    const frame = layout.evaluate(request), node = frame.nodes.find(node => node.kind === 'text');
    check(node.rect[2] === variant.width && Math.abs(node.rect[3] - variant.lines.length * style.lineHeight) < 1e-9, variant.id + ': constrained text height/width');
    compare(variant.id, production(frame), reference([{x: 0, y: 0, width: variant.width, lines: variant.lines, foot: true}], style, variant.caret), frame);
    const stats = layout.stats; check(layout.evaluate(request) === frame && JSON.stringify(stats) === JSON.stringify(layout.stats), 'static layout must reuse the same immutable frame');
  }
  const card = structuredClone(base.artboards[0]); card.id = 'card';
  const dual = {...base, artboards: [{id: 'main', width: 410, height: 340, root: 'root', nodes: [
    {id: 'root', kind: 'container', style: {direction: 'row', gap: [point(20), point(0)]}},
    ...[150, 240].map((width, i) => ({id: 'host' + i, kind: 'component', parent: 'root', style: {width: point(width), height: point(340)}, component: {artboard: 'card', sizing: 'layout'}})),
  ]}, card]};
  const components = new ProductionLayoutOwner(dual, text); layouts.push(components);
  let frame = components.evaluate({viewport: [410, 340], dpr, time: 0});
  compare('same-block-two-components', production(frame), reference([{x: 0, y: 0, width: 150, lines: ['AB', 'A'], foot: true}, {x: 170, y: 0, width: 240, lines: ['ABA'], foot: true}], value.textStyles[0]), frame);
  const nested = structuredClone(dual); nested.artboards[0].nodes = [
    {id: 'root', kind: 'container', style: {padding: [point(20), point(12), point(0), point(0)]}, visual: {opacity: .5, clip: true}},
    {id: 'host', parent: 'root', kind: 'component', style: {width: point(150), height: point(180), overflow: 'hidden'}, component: {artboard: 'card', sizing: 'layout'}},
  ]; nested.artboards[1].nodes[0].visual = {opacity: .5};
  const clipped = new ProductionLayoutOwner(nested, text); layouts.push(clipped); frame = clipped.evaluate({viewport: [300, 340], dpr, time: 0});
  compare('nested-inherited-clip-opacity', production(frame), reference([{x: 20, y: 12, width: 150, lines: ['AB', 'A'], foot: true, opacity: .25, clip: [20, 12, 150, 180]}], value.textStyles[0]), frame);
  nested.artboards[0].nodes[0].style.padding = [point(20.25), point(12.5), point(0), point(0)];
  const fractional = new ProductionLayoutOwner(nested, text); layouts.push(fractional); frame = fractional.evaluate({viewport: [300, 340], dpr, time: 0});
  compare('fractional-node-origin', production(frame), reference([{x: 20.25, y: 12.5, width: 150, lines: ['AB', 'A'], foot: true, opacity: .25, clip: [20.25, 12.5, 150, 180]}], value.textStyles[0]), frame);
  for (const owner of layouts) {owner.dispose(); owner.dispose();} check(!text.stats.disposed, 'layout cleanup must borrow the shared text owner');
  text.dispose(); assets.dispose(); document.fonts.delete(face);
  check([...bitmaps].every(canvas => canvas.width === 0 && canvas.height === 0), 'retire all observed native glyph bitmaps');
  check(document.fonts.size === initialFonts, 'owned FontFace cleanup leaves the registry unchanged');
  cases.push({id: 'borrowed-font-owner-cleanup', releases: text.stats.releases, retiredBitmaps: bitmaps.size, fontResidue: document.fonts.size - initialFonts});
  const result = {status: 'passed', caseCount: cases.length, cases, captures, background: '#f0f0f0', scope: 'Actual constrained layout/text owner pipeline against independent native font whole-scene references; no Engine WebGPU renderer, affine-root qualification or complete G11 composition'};
  document.querySelector('#result').textContent = JSON.stringify(result); document.querySelector('#result').dataset.status = result.status;
} catch (error) {
  for (const owner of layouts) owner.dispose(); text?.dispose(); assets?.dispose(); if (face) document.fonts.delete(face);
  document.querySelector('#result').textContent = JSON.stringify({status: 'failed', cases, captures, error: String(error.stack ?? error)}); document.querySelector('#result').dataset.status = 'failed';
}
