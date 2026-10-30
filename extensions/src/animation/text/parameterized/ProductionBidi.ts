import {embeddingLevels, getBidiCharTypeName, getMirroredCharacter, reorderedLineIndices} from './ProductionBidiKernel.js';
import {rememberTextPaintSequence, textPaintSequence} from './ProductionTextPaintIdentity.js';
import type {ShapedGlyph, RuntimeTextStyle} from './runtime-types.js';

type Cluster = Readonly<{start: number; end: number; sequence: string}>;
type Run = Readonly<{style: string; text: string}>;
const invisible = new Set(['BN', 'RLE', 'LRE', 'RLO', 'LRO', 'PDF', 'LRI', 'RLI', 'FSI', 'PDI']);
const trailing = new Set(['S', 'WS', 'B', ...invisible]);

/** One paragraph analysis, shared by original shaping, wrapping and final line placement. */
export class ProductionBidi {
  readonly runs: readonly Run[];
  private readonly text: string;
  private readonly points: readonly string[];
  private readonly scalarAt: Uint32Array;
  private readonly levels: ReturnType<typeof embeddingLevels>;

  constructor(runs: readonly Run[], private readonly clusters: readonly Cluster[], direction: RuntimeTextStyle['direction']) {
    this.text = runs.map(run => run.text).join('');
    this.points = Array.from(this.text);
    this.scalarAt = new Uint32Array(this.text.length + 1);
    let offset = 0;
    for (const [index, point] of this.points.entries()) {
      for (let unit = 0; unit < point.length; unit++) this.scalarAt[offset++] = index;
    }
    this.scalarAt[offset] = this.points.length;
    this.levels = embeddingLevels(this.text, direction);
    const painted = this.points.map((point, index) => this.levels.levels[index]! & 1 ? getMirroredCharacter(point) ?? point : point).join('');
    offset = 0;
    this.runs = runs.map(run => { const text = painted.slice(offset, offset + run.text.length); offset += run.text.length; return {style: run.style, text}; });
  }

  restore(glyph: ShapedGlyph, logicalOffset: number): ShapedGlyph {
    const logicalIndex = glyph.logicalIndex + logicalOffset, start = this.clusters[logicalIndex]?.start ?? this.text.length;
    const sequence = this.text.slice(start, start + glyph.sequence.length), hidden = [...sequence].every(point => invisible.has(getBidiCharTypeName(point)));
    const direction = this.levels.levels[this.scalarAt[start]!]! & 1 ? 'rtl' : 'ltr';
    return rememberTextPaintSequence({...glyph, logicalIndex, sequence, direction,
      ...(hidden ? {advance: 0, bounds: [0, 0, 0, 0] as const} : {})}, hidden ? '' : glyph.sequence !== sequence ? glyph.sequence : undefined);
  }

  direction(glyphs: readonly ShapedGlyph[]): 'ltr' | 'rtl' {
    const first = glyphs[0], scalar = this.scalarAt[first ? this.clusters[first.logicalIndex]?.start ?? 0 : 0] ?? 0;
    return this.paragraph(scalar)?.level === 1 ? 'rtl' : 'ltr';
  }

  reorder(glyphs: readonly ShapedGlyph[]): ShapedGlyph[] {
    if (!glyphs.length) return [];
    const first = glyphs[0]!, last = glyphs[glyphs.length - 1]!, start = this.scalarAt[this.clusters[first.logicalIndex]!.start]!;
    const end = this.scalarAt[this.clusters[last.logicalIndex]!.start + last.sequence.length]! - 1;
    const owner = new Map<number, ShapedGlyph>();
    let trailingIndex = glyphs.length;
    while (trailingIndex > 0 && [...glyphs[trailingIndex - 1]!.sequence].every(point => trailing.has(getBidiCharTypeName(point)))) trailingIndex--;
    const paragraph = this.paragraph(start);
    for (const [index, glyph] of glyphs.entries()) {
      const from = this.clusters[glyph.logicalIndex]!.start, to = from + glyph.sequence.length;
      const value: ShapedGlyph = index >= trailingIndex ? rememberTextPaintSequence({...glyph, direction: paragraph?.level === 1 ? 'rtl' : 'ltr'}, textPaintSequence(glyph)) : glyph;
      for (let scalar = this.scalarAt[from]!; scalar < this.scalarAt[to]!; scalar++) owner.set(scalar, value);
    }
    const order = reorderedLineIndices(this.points, {...this.levels, paragraphs: paragraph ? [paragraph] : []}, start, end);
    const seen = new Set<ShapedGlyph>(), result: ShapedGlyph[] = [];
    for (const scalar of order) { const glyph = owner.get(scalar); if (glyph && !seen.has(glyph)) {seen.add(glyph); result.push(glyph);} }
    return result;
  }

  private paragraph(scalar: number) {
    const paragraphs = this.levels.paragraphs;
    let low = 0, high = paragraphs.length - 1;
    while (low <= high) {const mid = (low + high) >>> 1, value = paragraphs[mid]!; if (scalar < value.start) high = mid - 1; else if (scalar > value.end) low = mid + 1; else return value;}
    return undefined;
  }
}
