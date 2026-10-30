import {textGraphemeBoundaries} from '@haiyue/engine/text';
import type { RuntimeFontAsset, RuntimeTextStyle, ShapedGlyph } from './runtime-types.js';

export class TextShapingError extends Error { readonly name = 'TextShapingError'; constructor(readonly code: 'E_TEXT_SHAPING_REVISION' | 'E_TEXT_FONT_MISSING' | 'E_TEXT_AXIS_RANGE' | 'E_TEXT_NUMBER', message: string) { super(message); } }

export class DeterministicTextShaper {
  private readonly fonts = new Map<string, RuntimeFontAsset>();
  constructor(fonts: readonly RuntimeFontAsset[], readonly backendRevision: string) { for (const font of fonts) this.fonts.set(font.id, font); }

  shape(text: string, style: RuntimeTextStyle, expectedRevision: string, logicalOrder = false): readonly ShapedGlyph[] {
    if (expectedRevision !== this.backendRevision) throw new TextShapingError('E_TEXT_SHAPING_REVISION', `Expected ${expectedRevision}, received ${this.backendRevision}.`);
    const fonts = style.fontAssets.map(id => this.fonts.get(id)); if (fonts.some(font => font === undefined)) throw new TextShapingError('E_TEXT_FONT_MISSING', `Missing font in fallback chain ${style.fontAssets.join(',')}.`);
    const logical=applyLigatures(segmentGraphemes(text),fonts as RuntimeFontAsset[],style.features?.liga!==false&&(!logicalOrder||style.features?.liga!==0), logicalOrder),ordered:Array<Cluster & {readonly direction:'ltr'|'rtl'}>=[],output:ShapedGlyph[]=[];
    if (logicalOrder) for (const cluster of logical) ordered.push({...cluster, direction: 'ltr'});
    else {
    let paragraph:Cluster[]=[];const flush=()=>{const direction=resolveBaseDirection(paragraph,style.direction??'auto');for(const cluster of bidiOrder(paragraph,direction))ordered.push(cluster);paragraph=[];};
    for(const cluster of logical)if(['\n','\r','\r\n'].includes(cluster.sequence)){flush();ordered.push({...cluster,direction:'ltr'});}else paragraph.push(cluster);flush();
    }
    let priorSequence: string | undefined, priorFont: RuntimeFontAsset | undefined;
    for (const cluster of ordered) {
      const font = (logicalOrder && cluster.ligatureFont ? this.fonts.get(cluster.ligatureFont) : (fonts as RuntimeFontAsset[]).find(candidate => candidate.metrics.glyphs[cluster.sequence] !== undefined || candidate.metrics.ligatures?.[cluster.sequence] !== undefined)) ?? fonts[0]!;
      const metric = font.metrics.ligatures?.[cluster.sequence] ?? font.metrics.glyphs[cluster.sequence] ?? font.metrics.missingGlyph, axes: Record<string, number> = {};
      for (const [tag, axis] of Object.entries(font.metrics.axes ?? {})) { const value = style.axes?.[tag] ?? axis.default; if (!Number.isFinite(value) || value < axis.min || value > axis.max) throw new TextShapingError('E_TEXT_AXIS_RANGE', `Axis ${tag}=${value} is outside ${axis.min}..${axis.max}.`); axes[tag] = value; }
      let advanceUnits = metric.advance; for (const [tag, coefficient] of Object.entries(metric.axisAdvance ?? {})) { const axis = font.metrics.axes?.[tag]; if (axis) advanceUnits += (axes[tag]! - axis.default) * coefficient; }
      if (!logicalOrder && priorSequence !== undefined) advanceUnits += font.metrics.kerning?.[`${priorSequence}|${cluster.sequence}`] ?? 0; // Production pairs are applied to complete visual lines, never across a wrap.
      const scale = style.fontSize / font.metrics.unitsPerEm, advance = advanceUnits * scale + style.tracking; if (!Number.isFinite(advance)) throw new TextShapingError('E_TEXT_NUMBER', 'Glyph advance is non-finite.');
      output.push(Object.freeze({ glyphId: metric.glyphId, sequence: cluster.sequence, logicalIndex: cluster.logicalIndex, direction: cluster.direction, fontAsset: font.id, style, advance, bounds: [metric.bounds[0] * scale, metric.bounds[1] * scale, metric.bounds[2] * scale, metric.bounds[3] * scale] as const, axes: Object.freeze(axes), breakClass: ['\n','\r','\r\n'].includes(cluster.sequence) ? 'newline' : /^\s+$/u.test(cluster.sequence) ? 'space' : 'none' })); priorSequence = ['\n','\r','\r\n'].includes(cluster.sequence)?undefined:cluster.sequence; priorFont = priorSequence === undefined ? undefined : font;
    }
    return Object.freeze(output);
  }
}

interface Cluster { readonly sequence: string; readonly logicalIndex: number; readonly direction: 'ltr' | 'rtl' | 'neutral'; readonly ligatureFont?: string; }

export function segmentGraphemes(text: string): readonly Cluster[] {
  const boundaries=textGraphemeBoundaries(text);
  return Object.freeze(boundaries.slice(0,-1).map((start,logicalIndex)=>{const sequence=text.slice(start,boundaries[logicalIndex+1]);return {sequence,logicalIndex,direction:clusterDirection(sequence)};}));
}

function applyLigatures(clusters: readonly Cluster[], fonts: readonly RuntimeFontAsset[], enabled: boolean, orderedFonts = false): readonly Cluster[] {
  if (!enabled) return clusters;
  const preferred = orderedFonts ? clusters.map(cluster => fonts.find(font => font.metrics.glyphs[cluster.sequence] !== undefined || font.metrics.ligatures?.[cluster.sequence] !== undefined)) : undefined;
  const result: Cluster[] = [];
  for (let index = 0; index < clusters.length;) {
    let matched: Cluster | undefined, length = 0;
    for (let take = Math.min(4, clusters.length - index); take >= 2; take--) {
      const sequence = clusters.slice(index, index + take).map(item => item.sequence).join('');
      if (/[\r\n]/u.test(sequence)) continue;
      const font = fonts.find(font => font.metrics.ligatures?.[sequence] !== undefined && (!preferred || clusters.slice(index, index + take).every((_, local) => !preferred[index + local] || preferred[index + local] === font)));
      if (font) {matched = {sequence, logicalIndex: clusters[index]!.logicalIndex, direction: clusters[index]!.direction, ...(orderedFonts ? {ligatureFont: font.id} : {})}; length = take; break;}
    }
    if (matched) {result.push(matched); index += length;} else result.push(clusters[index++]!);
  }
  return result;
}
function resolveBaseDirection(clusters: readonly Cluster[], requested: RuntimeTextStyle['direction']): 'ltr' | 'rtl' { if (requested === 'ltr' || requested === 'rtl') return requested; return clusters.find(cluster => cluster.direction !== 'neutral')?.direction as 'ltr' | 'rtl' | undefined ?? 'ltr'; }
function bidiOrder(clusters: readonly Cluster[], base: 'ltr' | 'rtl'): readonly (Cluster & { readonly direction: 'ltr' | 'rtl' })[] { const runs: Array<{ direction: 'ltr' | 'rtl'; values: Cluster[] }> = []; let currentDirection = base; for (const cluster of clusters) { const direction = cluster.direction === 'neutral' ? currentDirection : cluster.direction; const run = runs[runs.length - 1]; if (!run || run.direction !== direction) runs.push({ direction, values: [cluster] }); else run.values.push(cluster); currentDirection = direction; } if (base === 'rtl') runs.reverse(); const result: Array<Cluster & { direction: 'ltr' | 'rtl' }> = []; for (const run of runs) { if (run.direction === 'rtl') run.values.reverse(); for (const cluster of run.values) result.push({ ...cluster, direction: run.direction }); } return result; }
function clusterDirection(value: string): Cluster['direction'] { for (const symbol of value) { const code = symbol.codePointAt(0)!; if (isRtl(code)) return 'rtl'; if (isLtr(code)) return 'ltr'; } return 'neutral'; }
function isRtl(code: number): boolean { return code >= 0x0590 && code <= 0x08ff || code >= 0xfb1d && code <= 0xfdff || code >= 0xfe70 && code <= 0xfeff; }
function isLtr(code: number): boolean { return code >= 0x0041 && code <= 0x005a || code >= 0x0061 && code <= 0x007a || code >= 0x00c0 && code <= 0x02af || code >= 0x0370 && code <= 0x058f || code >= 0x0900 && code <= 0x1fff; }




