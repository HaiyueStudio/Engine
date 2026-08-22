import type { RuntimeFontAsset, RuntimeTextStyle, ShapedGlyph } from './runtime-types.js';

export class TextShapingError extends Error { readonly name = 'TextShapingError'; constructor(readonly code: 'E_TEXT_SHAPING_REVISION' | 'E_TEXT_FONT_MISSING' | 'E_TEXT_AXIS_RANGE' | 'E_TEXT_NUMBER', message: string) { super(message); } }

export class DeterministicTextShaper {
  private readonly fonts = new Map<string, RuntimeFontAsset>();
  constructor(fonts: readonly RuntimeFontAsset[], readonly backendRevision: string) { for (const font of fonts) this.fonts.set(font.id, font); }

  shape(text: string, style: RuntimeTextStyle, expectedRevision: string): readonly ShapedGlyph[] {
    if (expectedRevision !== this.backendRevision) throw new TextShapingError('E_TEXT_SHAPING_REVISION', `Expected ${expectedRevision}, received ${this.backendRevision}.`);
    const fonts = style.fontAssets.map(id => this.fonts.get(id)); if (fonts.some(font => font === undefined)) throw new TextShapingError('E_TEXT_FONT_MISSING', `Missing font in fallback chain ${style.fontAssets.join(',')}.`);
    const logical = applyLigatures(segmentGraphemes(text), fonts as RuntimeFontAsset[], style.features?.liga !== false), direction = resolveBaseDirection(logical, style.direction ?? 'auto'), ordered = bidiOrder(logical, direction), output: ShapedGlyph[] = [];
    let priorSequence: string | undefined;
    for (const cluster of ordered) {
      const font = (fonts as RuntimeFontAsset[]).find(candidate => candidate.metrics.glyphs[cluster.sequence] !== undefined || candidate.metrics.ligatures?.[cluster.sequence] !== undefined) ?? fonts[0]!;
      const metric = font.metrics.ligatures?.[cluster.sequence] ?? font.metrics.glyphs[cluster.sequence] ?? font.metrics.missingGlyph, axes: Record<string, number> = {};
      for (const [tag, axis] of Object.entries(font.metrics.axes ?? {})) { const value = style.axes?.[tag] ?? axis.default; if (!Number.isFinite(value) || value < axis.min || value > axis.max) throw new TextShapingError('E_TEXT_AXIS_RANGE', `Axis ${tag}=${value} is outside ${axis.min}..${axis.max}.`); axes[tag] = value; }
      let advanceUnits = metric.advance; for (const [tag, coefficient] of Object.entries(metric.axisAdvance ?? {})) { const axis = font.metrics.axes?.[tag]; if (axis) advanceUnits += (axes[tag]! - axis.default) * coefficient; }
      if (priorSequence !== undefined) advanceUnits += font.metrics.kerning?.[`${priorSequence}|${cluster.sequence}`] ?? 0;
      const scale = style.fontSize / font.metrics.unitsPerEm, advance = advanceUnits * scale + style.tracking; if (!Number.isFinite(advance)) throw new TextShapingError('E_TEXT_NUMBER', 'Glyph advance is non-finite.');
      output.push(Object.freeze({ glyphId: metric.glyphId, sequence: cluster.sequence, logicalIndex: cluster.logicalIndex, direction: cluster.direction, fontAsset: font.id, style, advance, bounds: [metric.bounds[0] * scale, metric.bounds[1] * scale, metric.bounds[2] * scale, metric.bounds[3] * scale] as const, axes: Object.freeze(axes), breakClass: cluster.sequence === '\n' ? 'newline' : /^\s+$/u.test(cluster.sequence) ? 'space' : 'none' })); priorSequence = cluster.sequence;
    }
    return Object.freeze(output);
  }
}

interface Cluster { readonly sequence: string; readonly logicalIndex: number; readonly direction: 'ltr' | 'rtl' | 'neutral'; }

export function segmentGraphemes(text: string): readonly Cluster[] {
  const output: Cluster[] = []; let current = '', logicalIndex = 0, regionalCount = 0;
  for (const symbol of text) { const code = symbol.codePointAt(0)!; const extend = isCombining(code) || isVariation(code) || code === 0x200d || current.endsWith('\u200d') || isEmojiModifier(code) || isRegional(code) && regionalCount % 2 === 1; if (!extend && current) { output.push({ sequence: current, logicalIndex: logicalIndex++, direction: clusterDirection(current) }); current = ''; regionalCount = 0; } current += symbol; regionalCount = isRegional(code) ? regionalCount + 1 : 0; }
  if (current) output.push({ sequence: current, logicalIndex, direction: clusterDirection(current) }); return Object.freeze(output);
}

function applyLigatures(clusters: readonly Cluster[], fonts: readonly RuntimeFontAsset[], enabled: boolean): readonly Cluster[] { if (!enabled) return clusters; const result: Cluster[] = []; for (let index = 0; index < clusters.length;) { let matched: Cluster | undefined, length = 0; for (let take = Math.min(4, clusters.length - index); take >= 2; take--) { const sequence = clusters.slice(index, index + take).map(item => item.sequence).join(''); if (fonts.some(font => font.metrics.ligatures?.[sequence])) { matched = { sequence, logicalIndex: clusters[index]!.logicalIndex, direction: clusters[index]!.direction }; length = take; break; } } if (matched) { result.push(matched); index += length; } else result.push(clusters[index++]!); } return result; }
function resolveBaseDirection(clusters: readonly Cluster[], requested: RuntimeTextStyle['direction']): 'ltr' | 'rtl' { if (requested === 'ltr' || requested === 'rtl') return requested; return clusters.find(cluster => cluster.direction !== 'neutral')?.direction as 'ltr' | 'rtl' | undefined ?? 'ltr'; }
function bidiOrder(clusters: readonly Cluster[], base: 'ltr' | 'rtl'): readonly (Cluster & { readonly direction: 'ltr' | 'rtl' })[] { const runs: Array<{ direction: 'ltr' | 'rtl'; values: Cluster[] }> = []; let currentDirection = base; for (const cluster of clusters) { const direction = cluster.direction === 'neutral' ? currentDirection : cluster.direction; const run = runs[runs.length - 1]; if (!run || run.direction !== direction) runs.push({ direction, values: [cluster] }); else run.values.push(cluster); currentDirection = direction; } if (base === 'rtl') runs.reverse(); const result: Array<Cluster & { direction: 'ltr' | 'rtl' }> = []; for (const run of runs) { if (run.direction === 'rtl') run.values.reverse(); for (const cluster of run.values) result.push({ ...cluster, direction: run.direction }); } return result; }
function clusterDirection(value: string): Cluster['direction'] { for (const symbol of value) { const code = symbol.codePointAt(0)!; if (isRtl(code)) return 'rtl'; if (isLtr(code)) return 'ltr'; } return 'neutral'; }
function isRtl(code: number): boolean { return code >= 0x0590 && code <= 0x08ff || code >= 0xfb1d && code <= 0xfdff || code >= 0xfe70 && code <= 0xfeff; }
function isLtr(code: number): boolean { return code >= 0x0041 && code <= 0x005a || code >= 0x0061 && code <= 0x007a || code >= 0x00c0 && code <= 0x02af || code >= 0x0370 && code <= 0x058f || code >= 0x0900 && code <= 0x1fff; }
function isCombining(code: number): boolean { return code >= 0x0300 && code <= 0x036f || code >= 0x1ab0 && code <= 0x1aff || code >= 0x1dc0 && code <= 0x1dff || code >= 0x20d0 && code <= 0x20ff || code >= 0xfe20 && code <= 0xfe2f; }
function isVariation(code: number): boolean { return code >= 0xfe00 && code <= 0xfe0f || code >= 0xe0100 && code <= 0xe01ef; }
function isEmojiModifier(code: number): boolean { return code >= 0x1f3fb && code <= 0x1f3ff; }
function isRegional(code: number): boolean { return code >= 0x1f1e6 && code <= 0x1f1ff; }
