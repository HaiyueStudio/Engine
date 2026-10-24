import {createNativeGlyphBitmap} from './NativeGlyphBitmap.js';
import {nativeGlyphPaintSequence} from './NativeGlyphPaint.js';
import type {LayoutAssetHandle, LayoutAssetOwner} from '../../layout/parameterized/AssetOwner.js';
import type {RuntimeLayoutDocument} from '../../layout/parameterized/runtime-types.js';
import type {RuntimeColor, RuntimePaintSource} from '../parameterized/runtime-types.js';
import {createProductionOutlineFontPort} from './ProductionOutlineFontPort.js';
import {textFail} from './snapshot.js';
import type {ProductionFontPort, ProductionGlyph, ProductionTextRequest} from './types.js';

let nextFontGeneration = 0;
/** Explicit browser host. Reuses prepared outlines/layout; only native glyph rasterization is platform-owned. */
export function createProductionBrowserFontPort(assets: LayoutAssetOwner, options: Readonly<{maxBitmapBytes: number}>): ProductionFontPort {
  const registry = globalThis.document?.fonts;
  if (!registry || typeof globalThis.FontFace !== 'function' || typeof globalThis.document?.createElement !== 'function') textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts', 'browser font preparation requires explicit DOM/FontFace services');
  if (!options || !Number.isSafeInteger(options.maxBitmapBytes) || options.maxBitmapBytes < 0) textFail('E_HYA_RUNTIME_LIMIT', '$.host.fonts.maxBitmapBytes', 'an explicit finite bitmap-byte budget is required');
  const outlinePort = createProductionOutlineFontPort(assets, {nativeGlyphPaint: true});
  return Object.freeze({async acquire(document: RuntimeLayoutDocument, signal: AbortSignal) {
    if (!Number.isSafeInteger(++nextFontGeneration)) textFail('E_HYA_RUNTIME_LIMIT', '$.host.fonts.generation', 'font generation exhausted');
    const bitmapOwner = Object.freeze({});
    const generation = nextFontGeneration, handles = new Set<LayoutAssetHandle>(), faces = new Set<FontFace>(), families = new Map<string, string>();
    const fontAssets = new Map(document.assets.filter(asset => asset.kind === 'font').map(asset => [asset.id, asset]));
    const fontMetrics = new Map([...fontAssets].map(([id, asset]) => [id, new Map([asset.metrics.missingGlyph, ...Object.values(asset.metrics.glyphs), ...Object.values(asset.metrics.ligatures ?? {})].map(metric => [metric.glyphId, metric]))]));
    const cached = new Map<string, ProductionGlyph['paint']>(); let bytes = 0, retired = false, bitmapGeneration = 0, activeBitmaps = 0, activeWorkBytes = 0, released = false;
    let prepared: Awaited<ReturnType<ProductionFontPort['acquire']>> | undefined;
    const finishRelease = () => {
      if (!retired || activeBitmaps || released) return; released = true; const errors: unknown[] = [];
      for (const face of faces) try {registry.delete(face);} catch (error) {errors.push(error);} faces.clear();
      for (const handle of handles) try {handle.release();} catch (error) {errors.push(error);} handles.clear();
      try {prepared?.release();} catch (error) {errors.push(error);}
      if (errors.length) throw new AggregateError(errors, 'Browser font cleanup failed.');
    };
    const release = () => {if (retired) return; retired = true; cached.clear(); bytes = 0; finishRelease();};
    const inspect = () => Object.freeze({cacheEntries: cached.size, cacheBytes: bytes, activeBitmaps, activeWorkBytes, retired, released});
    const live = () => {if (retired || signal.aborted) textFail('E_HYA_RUNTIME_ABORTED', '$.host.fonts', 'browser font preparation was retired');};
    try {
      live(); prepared = await outlinePort.acquire(document, signal); live();
      for (const asset of document.assets) if (asset.kind === 'font') {
        const handle = await assets.load(asset.id, {signal});
        if (retired || signal.aborted) {handle.release(); live();}
        handles.add(handle);
        const family = `HaiyuePreparedFont${generation}-${families.size}`;
        const data = handle.bytes.slice().buffer as ArrayBuffer;
        const face = await new FontFace(family, data, {weight: String(asset.weight), style: asset.style}).load(); live();
        registry.add(face); faces.add(face); families.set(asset.id, family);
      }
      return Object.freeze({shape(request: ProductionTextRequest) {
        live(); const source = prepared!.shape(request), dpr = request.dpr ?? 1, origin = request.rasterOrigin ?? [0, 0];
        if (!Number.isFinite(dpr) || dpr <= 0) textFail('E_HYA_RUNTIME_TEXT', '$.text.dpr', 'invalid glyph raster DPR');
        const runs = source.runs.map(run => Object.freeze({...run, glyphs: Object.freeze(run.glyphs.map(glyph => {
          const asset = fontAssets.get(run.font);
          if (!asset || asset.kind !== 'font' || run.style.fontWeight !== asset.weight || run.style.fontStyle !== asset.style) textFail('E_HYA_RUNTIME_HOST_PORT', '$.text.font', 'synthetic font variants require an explicit matching prepared font');
          for (const paint of [...run.style.fills, ...(run.style.strokes ?? [])]) {
            validatePaint(paint.source);
            if (paint.opacity !== undefined && (!Number.isFinite(paint.opacity) || paint.opacity < 0 || paint.opacity > 1)) textFail('E_HYA_RUNTIME_TEXT', '$.text.paint.opacity', 'paint opacity must be in [0,1]');
          }
          for (const stroke of run.style.strokes ?? []) if (!Number.isFinite(stroke.width) || stroke.width <= 0) textFail('E_HYA_RUNTIME_TEXT', '$.text.stroke.width', 'stroke width must be positive');
          const [ma, mb, mc, md, px, py] = glyph.transform;
          const aligned = ma === 1 && mb === 0 && mc === 0 && md === 1;
          const snappedX = aligned ? Math.floor((px + origin[0]!) * dpr) / dpr - origin[0]! : px;
          const snappedY = aligned ? Math.floor((py + origin[1]!) * dpr) / dpr - origin[1]! : py;
          const phaseX = aligned ? px - snappedX : 0, phaseY = aligned ? py - snappedY : 0;
          // A single paint's uniform alpha belongs to the existing glyph opacity.
          // Keep multiple overlapping paints baked: distributing alpha across them changes source-over coverage.
          const singleFill = run.style.fills.length === 1 && !(run.style.strokes?.length);
          const paintOpacity = singleFill ? run.style.fills[0]!.opacity ?? 1 : 1;
          const rasterStyle = singleFill ? {...run.style, fills: [{...run.style.fills[0]!, opacity: 1}]} : run.style;
          const key = JSON.stringify([run.font, glyph.id, rasterStyle, dpr, phaseX, phaseY]); let paint = cached.get(key);
          const metric = fontMetrics.get(run.font)!.get(glyph.id)!;
          if (glyph.id === asset.metrics.missingGlyph.glyphId) textFail('E_HYA_RUNTIME_HOST_PORT', '$.text.font', 'a native missing-glyph fallback needs an explicitly matching font port');
          const scale = run.style.fontSize / asset.metrics.unitsPerEm, padding = 2 + Math.max(0, ...(run.style.strokes ?? []).map(stroke => stroke.width * 5));
          const left = Math.floor(Math.min(0, metric.bounds[0] * scale + phaseX) * dpr) / dpr - padding, top = Math.floor((Math.min(-asset.metrics.ascent * scale, -metric.bounds[3] * scale) + phaseY) * dpr) / dpr - padding;
          const width = Math.max(1, Math.ceil((Math.max(metric.advance, metric.bounds[2]) * scale + phaseX - left + padding) * dpr)), height = Math.max(1, Math.ceil((Math.max(-asset.metrics.descent, -metric.bounds[1]) * scale + phaseY - top + padding) * dpr));
          if (!paint) {
            const workCopies = [...run.style.fills, ...(run.style.strokes ?? [])].some(paint => paint.source.kind === 'radial-gradient') ? 2 : 1;
            if (!Number.isSafeInteger(width * height * 4 * workCopies) || width * height * 4 * workCopies > options.maxBitmapBytes) textFail('E_HYA_RUNTIME_LIMIT', '$.host.fonts.bitmapBytes', 'native glyph bitmaps exceed the supplied byte budget');
            const workBytes = width * height * 4 * workCopies;
            const acquire = (signal: AbortSignal) => {
              live(); if (signal.aborted) textFail('E_HYA_RUNTIME_ABORTED', '$.host.fonts.bitmap', 'glyph snapshot was cancelled');
              if (activeWorkBytes + workBytes > options.maxBitmapBytes) textFail('E_HYA_RUNTIME_LIMIT', '$.host.fonts.bitmapBytes', 'concurrent glyph raster work exceeds the supplied byte budget');
              activeBitmaps++; activeWorkBytes += workBytes; let canvas: HTMLCanvasElement | undefined, closed = false;
              const close = () => {if (closed) return; closed = true; try {if (canvas) canvas.width = canvas.height = 0;} finally {activeBitmaps--; activeWorkBytes -= workBytes; finishRelease();}};
              try {
              canvas = globalThis.document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', {willReadFrequently: true}); if (!context) textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts.canvas', 'native glyph raster context is unavailable');
            context.scale(dpr, dpr); context.font = `${run.style.fontStyle} ${run.style.fontWeight} ${run.style.fontSize}px "${families.get(run.font)!}"`;
            context.textBaseline = 'alphabetic'; context.direction = 'ltr'; context.textAlign = 'left';
            const nativeSequence = nativeGlyphPaintSequence(glyph);
            if (nativeSequence === undefined && glyph.paint.kind !== 'outline') textFail('E_HYA_RUNTIME_HOST_PORT', '$.text.font', 'compiled glyph lacks a native sequence or validated outline');
            const draw = (target: CanvasRenderingContext2D, stroke: boolean): void => {
              if (nativeSequence !== undefined) {if (stroke) target.strokeText(nativeSequence, phaseX - left, phaseY - top); else target.fillText(nativeSequence, phaseX - left, phaseY - top);}
              else if (glyph.paint.kind === 'outline') drawGlyphOutline(target, glyph.paint, phaseX - left, phaseY - top, stroke);
            };
            const bounds = [metric.bounds[0] * scale + phaseX - left, -metric.bounds[3] * scale + phaseY - top, (metric.bounds[2] - metric.bounds[0]) * scale, (metric.bounds[3] - metric.bounds[1]) * scale] as const;
            for (const fill of rasterStyle.fills) paintGlyph(context, fill.source, fill.opacity ?? 1, bounds, 'fillStyle', target => draw(target, false), nativeSequence !== undefined);
            for (const stroke of run.style.strokes ?? []) paintGlyph(context, stroke.source, stroke.opacity ?? 1, bounds, 'strokeStyle', target => {target.lineWidth = stroke.width; target.lineJoin = stroke.join ?? 'miter'; draw(target, true);}, nativeSequence !== undefined);

                return {value: canvas!, release: close};
              } catch (error) {try {close();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Glyph raster and cleanup failed.');} throw error;}
            };
            const value = createNativeGlyphBitmap(width, height, acquire, inspect, Object.freeze({owner: bitmapOwner, key}));
            paint = Object.freeze({kind: 'bitmap', source: Object.freeze({value, generation: ++bitmapGeneration, bytes: width * height * 4}), uv: [0, 0, 1, 1] as const});
            // Evict recipe metadata only. Older immutable results can still rasterize while the font owner is live.
            while (cached.size && (cached.size >= 1024 || bytes + width * height * 4 > options.maxBitmapBytes)) {
              const oldest = cached.keys().next().value!, previous = cached.get(oldest)!; cached.delete(oldest);
              if (previous.kind === 'bitmap') bytes -= previous.source.bytes;
            }
            cached.set(key, paint); bytes += width * height * 4;
          }
          const [a, b, c, d, tx, ty] = glyph.transform, w = width / dpr, h = height / dpr;
          const transform = [a * w, b * w, c * h, d * h, a * left + c * top + snappedX, b * left + d * top + snappedY] as const;
          const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [transform[0] * x! + transform[2] * y! + transform[4], transform[1] * x! + transform[3] * y! + transform[5]]);
          const x = Math.min(...points.map(point => point[0]!)), y = Math.min(...points.map(point => point[1]!));
          return Object.freeze({...glyph, opacity: glyph.opacity * paintOpacity, transform, rect: [x, y, Math.max(...points.map(point => point[0]!)) - x, Math.max(...points.map(point => point[1]!)) - y] as const, paint});
        }))}));
        return Object.freeze({...source, runs: Object.freeze(runs)});
      }, release});
    } catch (error) {release(); if (signal.aborted) textFail('E_HYA_RUNTIME_ABORTED', '$.host.fonts', 'browser font preparation was retired'); throw error;}
  }});
}
/** A real compiled glyph without a native text address uses its validated original outline. */
function drawGlyphOutline(context: CanvasRenderingContext2D, paint: Extract<ProductionGlyph['paint'], {kind: 'outline'}>, x: number, y: number, stroke: boolean): void {
  context.beginPath(); let offset = 0;
  const number = () => paint.values[offset++]!;
  for (const command of paint.commands) {
    if (command === 'M') context.moveTo(x + number(), y + number());
    else if (command === 'L') context.lineTo(x + number(), y + number());
    else if (command === 'Q') context.quadraticCurveTo(x + number(), y + number(), x + number(), y + number());
    else if (command === 'C') context.bezierCurveTo(x + number(), y + number(), x + number(), y + number(), x + number(), y + number());
    else if (command === 'Z') context.closePath();
  }
  if (stroke) context.stroke(); else context.fill();
}
/** Reuses native glyph coverage; paint coordinates match normalized outline bounds. */
function paintGlyph(context: CanvasRenderingContext2D, source: RuntimePaintSource, opacity: number,
  bounds: readonly [number, number, number, number], style: 'fillStyle' | 'strokeStyle', draw: (target: CanvasRenderingContext2D) => void, nativeCoverage: boolean): void {
  if (source.kind !== 'radial-gradient' || bounds[2] === 0 || bounds[3] === 0) {
    if (source.kind === 'solid') context[style] = css(source.color);
    else if (source.kind === 'radial-gradient' || source.start[0] === source.end[0] && source.start[1] === source.end[1]) context[style] = css(source.stops[0]!.color);
    else {
      const gradient = context.createLinearGradient(bounds[0] + source.start[0] * bounds[2], bounds[1] + source.start[1] * bounds[3], bounds[0] + source.end[0] * bounds[2], bounds[1] + source.end[1] * bounds[3]);
      for (const stop of source.stops) gradient.addColorStop(stop.offset, css(stop.color)); context[style] = gradient;
    }
    context.globalAlpha = opacity; draw(context); return;
  }
  // Rasterize the normalized elliptical color field once, then shade the actual
  // compiled outline coverage in one pass; native text keeps its established mask path. A second source-in mask round-trip
  // quantizes premultiplied edge alpha twice; this retains the original two-canvas peak.
  const canvas = globalThis.document.createElement('canvas'); canvas.width = context.canvas.width; canvas.height = context.canvas.height;
  try {
    const layer = canvas.getContext('2d', {willReadFrequently: true});
    if (!layer) textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts.canvas', 'native glyph paint context is unavailable');
    layer.setTransform(context.getTransform());
    layer.translate(bounds[0], bounds[1]); layer.scale(bounds[2], bounds[3]);
    const gradient = layer.createRadialGradient(...source.center, 0, ...source.center, source.radius);
    for (const stop of source.stops) gradient.addColorStop(stop.offset, css(stop.color));
    layer.fillStyle = gradient;
    const transform = layer.getTransform();
    layer.fillRect(-transform.e / transform.a, -transform.f / transform.d, canvas.width / transform.a, canvas.height / transform.d);
    if (nativeCoverage) {
      // Keep the established FontFace mask rasterization. Native text painted
      // with a CanvasPattern can apply a different edge coverage from solid
      // text; the independent whole-page FontFace oracle uses this mask path.
      layer.setTransform(context.getTransform()); layer.font = context.font;
      layer.textBaseline = context.textBaseline; layer.textAlign = context.textAlign; layer.direction = context.direction;
      layer.globalCompositeOperation = 'destination-in'; layer[style] = '#fff'; draw(layer);
      context.save();
      try {context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = opacity; context.drawImage(canvas, 0, 0);} finally {context.restore();}
      return;
    }
    const pattern = context.createPattern(canvas, 'no-repeat');
    if (!pattern) textFail('E_HYA_RUNTIME_HOST_PORT', '$.host.fonts.canvas', 'native glyph color field is unavailable');
    pattern.setTransform(context.getTransform().inverse());
    context.save();
    try {context[style] = pattern; context.globalAlpha = opacity; draw(context);} finally {context.restore();}
  } finally {canvas.width = canvas.height = 0;}
}
function validatePaint(source: RuntimePaintSource): void {
  const fail = (): never => textFail('E_HYA_RUNTIME_TEXT', '$.text.paint', 'paint must contain finite normalized colors, geometry and ordered stops');
  const color = (value: RuntimeColor): void => {if (!Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isFinite(n) || n < 0 || n > 1)) fail();};
  const point = (value: readonly [number, number]): void => {if (!Array.isArray(value) || value.length !== 2 || value.some(n => !Number.isFinite(n))) fail();};
  if (!source || typeof source !== 'object') fail();
  if (source.kind === 'solid') {color(source.color); return;}
  if (source.kind === 'linear-gradient') {point(source.start); point(source.end);}
  else if (source.kind === 'radial-gradient') {point(source.center); if (!Number.isFinite(source.radius) || source.radius <= 0) fail();}
  else fail();
  if (!Array.isArray(source.stops) || source.stops.length < 2) fail();
  let previous = -Infinity;
  for (const stop of source.stops) {
    if (!stop || !Number.isFinite(stop.offset) || stop.offset < previous || stop.offset < 0 || stop.offset > 1) fail();
    color(stop.color); previous = stop.offset;
  }
}
function css(color: RuntimeColor): string {return `rgba(${color[0] * 255},${color[1] * 255},${color[2] * 255},${color[3]})`;}
