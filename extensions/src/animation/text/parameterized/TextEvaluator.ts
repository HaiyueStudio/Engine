import {ProductionBidi} from './ProductionBidi.js';
import {rememberTextPaintSequence,textPaintSequence} from './ProductionTextPaintIdentity.js';
import {createProductionTextGeometry,rememberProductionTextGeometry} from './ProductionTextGeometry.js';
import { DeterministicTextShaper, TextShapingError, segmentGraphemes } from './DeterministicTextShaper.js';
import {validateConstraints} from '../../../layout/validate.js';
import {snapshotPlainTextData} from '../PlainTextData.js';
import {textRunValue,textClusters,textShapingRuns} from './TextContent.js';
import type { RuntimeFontAsset, RuntimeModifierRange, RuntimeTextBlock, RuntimeTextDocument, RuntimeTextModifier, ShapedGlyph, TextBlockPose, TextEvaluateUpdates, TextGlyphPose as FrozenTextGlyphPose, TextLinePose, TextRuntimeLimits, TextSelectionPose } from './runtime-types.js';

export class TextEvaluationError extends Error { readonly name = 'TextEvaluationError'; constructor(readonly code: 'E_TEXT_FORMAT' | 'E_TEXT_REFERENCE' | 'E_TEXT_LIMIT' | 'E_TEXT_DISPOSED', message: string) { super(message); } }

const DEFAULT_LIMITS: TextRuntimeLimits = Object.freeze({ maxGlyphs: 1_000_000, maxLines: 250_000 });
type TextGlyphPose = { -readonly [Key in keyof FrozenTextGlyphPose]: FrozenTextGlyphPose[Key] };

export class TextEvaluator {
  private readonly styles: Map<string, RuntimeTextDocument['textStyles'][number]>;
  private readonly blocks: Map<string, RuntimeTextBlock>;
  private readonly shaper: Pick<DeterministicTextShaper, 'shape'>;
  private readonly fonts: ReadonlyMap<string, RuntimeFontAsset>;
  private disposed = false;
  constructor(readonly document: RuntimeTextDocument, readonly limits: TextRuntimeLimits = DEFAULT_LIMITS, preparedShaper?: Pick<DeterministicTextShaper, 'shape'>, private readonly productionGeometry = false) {
    if (document.shaping.stack !== 'haiyue-text-shaping@1') throw new TextEvaluationError('E_TEXT_FORMAT', `Unsupported shaping stack ${document.shaping.stack}.`);
    this.styles = new Map(document.textStyles.map(style => [style.id, style]));
    this.blocks = new Map(document.textBlocks.map(block => [block.id, block]));
    const fonts = document.assets.filter((asset): asset is RuntimeFontAsset => asset.kind === 'font'); this.fonts = new Map(fonts.map(font => [font.id, font])); this.shaper = preparedShaper ?? new DeterministicTextShaper(fonts, document.shaping.backendRevision);
  }

  evaluate(blockId: string, updates: TextEvaluateUpdates = {}): TextBlockPose {
    if (this.disposed) throw new TextEvaluationError('E_TEXT_DISPOSED', 'Text evaluator is disposed.'); const block = this.blocks.get(blockId); if (!block) throw new TextEvaluationError('E_TEXT_REFERENCE', `Unknown text block ${blockId}.`);
    try { return this.evaluateBlock(block, updates); } catch (error) { if (error instanceof TextShapingError) throw new TextEvaluationError('E_TEXT_FORMAT', `${error.code}: ${error.message}`); throw error; }
  }
  dispose(): void { this.disposed = true; }

  private evaluateBlock(block: RuntimeTextBlock, updates: TextEvaluateUpdates): TextBlockPose {
    if (updates.styles) updates = {...updates, styles: snapshotPlainTextData(updates.styles, '$.styles', (path, message, limit) => {throw new TextEvaluationError(limit ? 'E_TEXT_LIMIT' : 'E_TEXT_FORMAT', `${message} (${path})`);}) as unknown as NonNullable<TextEvaluateUpdates['styles']>};
    if (updates.constraints) {
      try {validateConstraints({width: updates.constraints.width ?? {mode: 'unbounded'}, height: updates.constraints.height ?? {mode: 'unbounded'}});}
      catch (error) {throw new TextEvaluationError('E_TEXT_FORMAT', error instanceof Error ? error.message : 'Invalid text constraints.');}
    }
    const shaped: ShapedGlyph[] = []; let logicalOffset = 0;
    if (this.productionGeometry) for (const run of block.runs) if (!this.styles.has(run.style)) throw new TextEvaluationError('E_TEXT_REFERENCE', `Unknown style ${run.style}.`);
    const resolvedRuns = this.productionGeometry ? textShapingRuns(block, updates.strings) : block.runs.map((run, index) => ({style: run.style, text: textRunValue(block, index, updates.strings)}));
    const firstStyle = resolvedRuns[0]?.style, baseDirection = firstStyle ? updates.styles?.[firstStyle]?.direction ?? this.styles.get(firstStyle)?.direction : undefined;
    const bidi = this.productionGeometry ? new ProductionBidi(resolvedRuns, textClusters(block, updates.strings), baseDirection) : undefined;
    const shapingRuns = bidi?.runs ?? resolvedRuns;
    for (const run of shapingRuns) { const original = this.styles.get(run.style); if (!original) throw new TextEvaluationError('E_TEXT_REFERENCE', `Unknown style ${run.style}.`); const patch = updates.styles?.[run.style], style = patch ? {...original, ...patch, id: original.id} : original; if (!Number.isFinite(style.fontSize) || style.fontSize <= 0 || !Number.isFinite(style.lineHeight) || style.lineHeight <= 0 || !Number.isFinite(style.tracking)) throw new TextEvaluationError('E_TEXT_FORMAT', `Invalid text metrics for style ${run.style}.`); const text = run.text; for (const glyph of this.shaper.shape(text, style, this.document.shaping.backendRevision, this.productionGeometry)) shaped.push(bidi ? bidi.restore(glyph, logicalOffset) : { ...glyph, logicalIndex: glyph.logicalIndex + logicalOffset }); logicalOffset += segmentLogicalLength(text); }
    if (shaped.length > this.limits.maxGlyphs) throw new TextEvaluationError('E_TEXT_LIMIT', `Glyph budget ${this.limits.maxGlyphs} exceeded.`);
    const pairSpacing = this.productionGeometry ? prepareProductionPairSpacing(shaped, this.fonts) : undefined;
    const widthConstraint = updates.constraints?.width, heightConstraint = updates.constraints?.height;
    const wrapWidth = widthConstraint ? widthConstraint.mode === 'unbounded' ? Infinity : widthConstraint.value! : block.width;
    const rawLines = this.productionGeometry ? wrapProductionGlyphs(shaped, wrapWidth, block.wrap ?? 'word', pairSpacing!) : wrapGlyphs(shaped, wrapWidth, block.wrap ?? 'word');
    if (bidi) for (const line of rawLines) {line.direction = bidi.direction(line.glyphs); if (line.glyphs[0]?.style.alignment) line.alignment = line.glyphs[0].style.alignment; line.glyphs = bidi.reorder(line.glyphs); line.width = productionVisualLineWidth(line.glyphs, pairSpacing!);}
    if (this.productionGeometry && rawLines.some(line => line.height === 0)) {
      const style = this.styles.get(block.runs[0]?.style ?? '');
      const lineHeight = updates.styles?.[style?.id ?? '']?.lineHeight ?? style?.lineHeight ?? 0;
      for (const line of rawLines) if (line.height === 0) line.height = lineHeight;
    }
    const naturalWidth = rawLines.reduce((maximum, line) => Math.max(maximum, line.width), 0);
    const width = !widthConstraint ? block.width : widthConstraint.mode === 'exact' ? widthConstraint.value! : widthConstraint.mode === 'at-most' ? Math.min(widthConstraint.value!, naturalWidth) : naturalWidth;
    const clipHeight = !heightConstraint ? block.height : heightConstraint.mode === 'unbounded' ? Infinity : heightConstraint.value!;
    const visibleLines = this.productionGeometry&&block.input&&updates.editingViewport?rawLines:heightConstraint && clipHeight === 0 && block.overflow !== 'visible' ? [] : clipLines(rawLines, clipHeight, block.overflow ?? 'visible'); if (visibleLines.length > this.limits.maxLines) throw new TextEvaluationError('E_TEXT_LIMIT', `Line budget ${this.limits.maxLines} exceeded.`);
    const naturalHeight = visibleLines.reduce((sum, line) => sum + line.height, 0) + Math.max(0, visibleLines.length - 1) * (block.paragraphSpacing ?? 0);
    const height = !heightConstraint ? block.height : heightConstraint.mode === 'exact' ? heightConstraint.value! : heightConstraint.mode === 'at-most' ? Math.min(heightConstraint.value!, naturalHeight) : naturalHeight;
    if (![width, height, naturalWidth, naturalHeight].every(Number.isFinite)) throw new TextEvaluationError('E_TEXT_LIMIT', 'Text measurement exceeds finite geometry.');
    block = {...block, width, height};
    const totalHeight = visibleLines.reduce((sum, line) => sum + line.height, 0) + Math.max(0, visibleLines.length - 1) * (block.paragraphSpacing ?? 0), vertical = shaped[0]?.style.verticalAlignment ?? 'top', yOffset = vertical === 'middle' ? (block.height - totalHeight) * 0.5 : vertical === 'bottom' ? block.height - totalHeight : 0, origin = block.origin ?? [0, 0], glyphs: TextGlyphPose[] = [], lines: TextLinePose[] = []; let y = yOffset + origin[1];
    for (const [lineIndex, line] of visibleLines.entries()) { const alignment = line.alignment ?? line.glyphs[0]?.style.alignment ?? 'start', direction = line.direction ?? line.glyphs[0]?.direction ?? 'ltr', available = Math.max(0, block.width - line.width), xOffset = alignment === 'center' ? available * 0.5 : alignment === 'end' && (!this.productionGeometry || direction === 'ltr') || alignment === 'start' && direction === 'rtl' ? available : 0, spaces = line.glyphs.filter(glyph => glyph.breakClass === 'space').length, justifyGap = alignment === 'justify' && lineIndex < visibleLines.length - 1 && spaces > 0 ? available / spaces : 0, startGlyph = glyphs.length; let x = xOffset + origin[0];
      const baseline = this.productionGeometry ? line.glyphs.reduce((maximum, glyph) => {const metrics = this.fonts.get(glyph.fontAsset)!.metrics; return Math.max(maximum, metrics.ascent * glyph.style.fontSize / metrics.unitsPerEm);}, 0) : 0;
      for (const [glyphIndex, glyph] of line.glyphs.entries()) { const advance = this.productionGeometry ? glyph.advance + productionVisualPairSpacing(glyph, line.glyphs[glyphIndex - 1], line.glyphs[glyphIndex + 1], pairSpacing!) : glyph.advance; const width = Math.max(0, glyph.bounds[2] - glyph.bounds[0]), height = Math.max(0, glyph.bounds[3] - glyph.bounds[1]); glyphs.push(rememberTextPaintSequence({ glyphId: glyph.glyphId, sequence: glyph.sequence, logicalIndex: glyph.logicalIndex, line: lineIndex, fontAsset: glyph.fontAsset, x: x + glyph.bounds[0], y: y + baseline - glyph.bounds[3], width, height, advance, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, axes: glyph.axes, fills: glyph.style.fills, strokes: glyph.style.strokes ?? [], ...(this.productionGeometry ? {style: glyph.style, penOffset: [-glyph.bounds[0], glyph.bounds[3] - baseline] as const, direction: glyph.direction} : {}) },textPaintSequence(glyph))); x += advance + (glyph.breakClass === 'space' ? justifyGap : 0); }
      lines.push(Object.freeze({ index: lineIndex, startGlyph, endGlyph: glyphs.length, x: xOffset + origin[0], y, width: alignment === 'justify' ? block.width : line.width, height: line.height })); y += line.height + (block.paragraphSpacing ?? 0); }
    applyModifiers(glyphs, lines, block.modifiers ?? []);
    const productionGeometry=this.productionGeometry&&block.input?createProductionTextGeometry(glyphs,lines,textClusters(block,updates.strings),this.fonts):undefined;
    const controls = buildControls(block, glyphs, lines, updates, this.productionGeometry, this.fonts, productionGeometry), contentWidth = lines.reduce((max, line) => Math.max(max, line.width), 0), trim = block.verticalTrim ?? { top: 0, bottom: 0 };
    return rememberProductionTextGeometry(Object.freeze({ id: block.id, width: block.width, height: block.height, contentWidth, contentHeight: Math.max(0, totalHeight - trim.top - trim.bottom), glyphs: Object.freeze(glyphs.map(glyph => Object.freeze(glyph) as FrozenTextGlyphPose)), lines: Object.freeze(lines), controls: Object.freeze(controls) }),productionGeometry);
  }
}

interface WorkingLine { glyphs: ShapedGlyph[]; width: number; height: number; direction?: 'ltr'|'rtl'; alignment?: 'start'|'center'|'end'|'justify'; }
function wrapGlyphs(glyphs: readonly ShapedGlyph[], width: number, wrap: RuntimeTextBlock['wrap']): WorkingLine[] { const lines: WorkingLine[] = [{ glyphs: [], width: 0, height: 0 }]; for (const glyph of glyphs) { let line = lines[lines.length - 1]!; if (glyph.breakClass === 'newline') { lines.push({ glyphs: [], width: 0, height: glyph.style.lineHeight }); continue; } if (wrap !== 'none' && width > 0 && line.glyphs.length > 0 && line.width + glyph.advance > width) { if (wrap === 'word') { const space = line.glyphs.findLastIndex(candidate => candidate.breakClass === 'space'); if (space >= 0 && space < line.glyphs.length - 1) { const moved = line.glyphs.splice(space + 1); line.width = line.glyphs.reduce((sum, item) => sum + item.advance, 0); line = { glyphs: moved, width: moved.reduce((sum, item) => sum + item.advance, 0), height: moved.reduce((max, item) => Math.max(max, item.style.lineHeight), 0) }; lines.push(line); } else { line = { glyphs: [], width: 0, height: 0 }; lines.push(line); } } else { line = { glyphs: [], width: 0, height: 0 }; lines.push(line); } } line.glyphs.push(glyph); line.width += glyph.advance; line.height = Math.max(line.height, glyph.style.lineHeight); } return lines; }
function clipLines(lines: readonly WorkingLine[], height: number, overflow: RuntimeTextBlock['overflow']): WorkingLine[] { if (overflow === 'visible' || height <= 0) return [...lines]; const output: WorkingLine[] = []; let used = 0; for (const line of lines) { if (used + line.height > height) break; output.push(line); used += line.height; } return output; }

function applyModifiers(glyphs: TextGlyphPose[], lines: readonly TextLinePose[], modifiers: readonly RuntimeTextModifier[]): void {
  const wordGroups = wordGroupIndices(glyphs), lineCount = Math.max(1, lines.length), logicalCount = Math.max(1, ...glyphs.map(glyph => glyph.logicalIndex + 1));
  for (const modifier of modifiers) for (const [index, glyph] of glyphs.entries()) {
    const group = modifier.range.units === 'word' ? wordGroups[index]! : modifier.range.units === 'line' ? glyph.line : glyph.logicalIndex;
    const count = modifier.range.units === 'word' ? Math.max(...wordGroups, 0) + 1 : modifier.range.units === 'line' ? lineCount : logicalCount;
    const weight = rangeWeight(group, count, modifier.range); if (weight === 0) continue;
    if (modifier.kind === 'transform') {
      const scaleX = 1 + ((modifier.scale?.[0] ?? 1) - 1) * weight, scaleY = 1 + ((modifier.scale?.[1] ?? 1) - 1) * weight, rotation = (modifier.rotation ?? 0) * weight, origin = modifier.origin ?? [glyph.x + glyph.width * 0.5, glyph.y + glyph.height * 0.5], dx = glyph.x - origin[0], dy = glyph.y - origin[1], cosine = Math.cos(rotation), sine = Math.sin(rotation);
      glyph.x = origin[0] + dx * scaleX * cosine - dy * scaleY * sine + (modifier.translation?.[0] ?? 0) * weight;
      glyph.y = origin[1] + dx * scaleX * sine + dy * scaleY * cosine + (modifier.translation?.[1] ?? 0) * weight;
      glyph.scaleX *= scaleX; glyph.scaleY *= scaleY; glyph.rotation += rotation; glyph.opacity *= 1 + ((modifier.opacity ?? 1) - 1) * weight;
      if (modifier.variables) glyph.axes = Object.freeze({ ...glyph.axes, ...Object.fromEntries(Object.entries(modifier.variables).map(([tag, value]) => [tag, (glyph.axes[tag] ?? 0) + value * weight])) });
    } else {
      const sampled = samplePath(modifier.points, pathDistance(modifier, glyph.logicalIndex, logicalCount)); glyph.x += (sampled.x - glyph.x) * weight; glyph.y += (sampled.y - glyph.y) * weight; if (modifier.orient) glyph.rotation += sampled.angle * weight; if (modifier.radial) glyph.rotation += Math.PI * 0.5 * weight;
    }
  }
}
function rangeWeight(index: number, count: number, range: RuntimeModifierRange): number { const value = range.units === 'percent' ? count <= 1 ? 0 : index / (count - 1) * 100 : index, increment = range.increment ?? 0, offset = range.offset ?? 0, raw = value + index * increment + offset, mapped = range.mode === 'repeat' ? modulo(raw, Math.max(1e-8, range.end - range.start)) + range.start : range.mode === 'mirror' ? mirror(raw, range.start, range.end) : raw, low = Math.min(range.start, range.end), high = Math.max(range.start, range.end), from = Math.max(0, range.falloffFrom ?? 0), to = Math.max(0, range.falloffTo ?? 0); let weight = mapped >= low && mapped <= high ? 1 : mapped < low && mapped >= low - from && from > 0 ? (mapped - (low - from)) / from : mapped > high && mapped <= high + to && to > 0 ? 1 - (mapped - high) / to : 0; return clamp(weight * (range.strength ?? 1), -1, 1); }
function wordGroupIndices(glyphs: readonly TextGlyphPose[]): number[] { const result: number[] = []; let group = 0, wasSpace = true; for (const glyph of glyphs) { const space = /^\s+$/u.test(glyph.sequence); if (!space && wasSpace && result.length > 0) group++; result.push(group); wasSpace = space; } return result; }
function pathDistance(modifier: Extract<RuntimeTextModifier, { kind: 'follow-path' }>, index: number, count: number): number { const start = modifier.start ?? 0, end = modifier.end ?? polylineLength(modifier.points); return start + (end - start) * (count <= 1 ? 0 : index / (count - 1)) + (modifier.offset ?? 0); }
function samplePath(points: readonly number[], distance: number): { x: number; y: number; angle: number } { let remaining = clamp(distance, 0, polylineLength(points)); for (let index = 2; index < points.length; index += 2) { const ax = points[index - 2]!, ay = points[index - 1]!, bx = points[index]!, by = points[index + 1]!, length = Math.hypot(bx - ax, by - ay); if (remaining <= length || index === points.length - 2) { const amount = length > 0 ? remaining / length : 0; return { x: ax + (bx - ax) * amount, y: ay + (by - ay) * amount, angle: Math.atan2(by - ay, bx - ax) }; } remaining -= length; } return { x: points[0]!, y: points[1]!, angle: 0 }; }
function polylineLength(points: readonly number[]): number { let length = 0; for (let index = 2; index < points.length; index += 2) length += Math.hypot(points[index]! - points[index - 2]!, points[index + 1]! - points[index - 1]!); return length; }

function buildControls(block: RuntimeTextBlock, glyphs: readonly TextGlyphPose[], lines: readonly TextLinePose[], updates: TextEvaluateUpdates, production = false, fonts:ReadonlyMap<string,RuntimeFontAsset>=new Map(),prepared?:ReturnType<typeof createProductionTextGeometry>): TextSelectionPose[] { if (production) return productionControls(block, glyphs, lines, updates,fonts,prepared); if (!block.input) return []; const output: TextSelectionPose[] = [], selection = block.input.selectionPort ? updates.selections?.[block.input.selectionPort] : undefined, cursor = block.input.cursorPort ? updates.cursors?.[block.input.cursorPort] : undefined, radius = block.input.selectionRadius ?? 0; if (selection) { const start = Math.min(selection[0], selection[1]), end = Math.max(selection[0], selection[1]); for (const line of lines) { const selected = glyphs.slice(line.startGlyph, line.endGlyph).filter(glyph => glyph.logicalIndex >= start && glyph.logicalIndex < end); if (selected.length > 0) { const left = Math.min(...selected.map(glyph => glyph.x)), right = Math.max(...selected.map(glyph => glyph.x + glyph.advance)); output.push(Object.freeze({ kind: 'selection', x: left, y: production ? line.y : line.y - line.height, width: right - left, height: line.height, radius })); } } } if (cursor !== undefined) { const glyph = [...glyphs].sort((a, b) => a.logicalIndex - b.logicalIndex).find(candidate => candidate.logicalIndex >= cursor) ?? glyphs[glyphs.length - 1]; if (glyph) output.push(Object.freeze({ kind: 'cursor', x: cursor > glyph.logicalIndex ? glyph.x + glyph.advance : glyph.x, y: production ? lines[glyph.line]!.y : glyph.y, width: 1, height: production ? lines[glyph.line]!.height : Math.max(glyph.height, glyph.advance), radius })); } return output; }
function productionControls(block:RuntimeTextBlock,glyphs:readonly TextGlyphPose[],lines:readonly TextLinePose[],updates:TextEvaluateUpdates,fonts:ReadonlyMap<string,RuntimeFontAsset>,prepared?:ReturnType<typeof createProductionTextGeometry>):TextSelectionPose[]{
  if(!block.input)return[];const geometry=prepared??createProductionTextGeometry(glyphs,lines,textClusters(block,updates.strings),fonts),output:TextSelectionPose[]=[],radius=block.input.selectionRadius??0;
  const selection=block.input.selectionPort?updates.selections?.[block.input.selectionPort]:undefined,cursor=block.input.cursorPort?updates.cursors?.[block.input.cursorPort]:undefined;
  if(selection)for(const [x,y,width,height] of geometry.selection(selection[0],selection[1]))output.push({kind:'selection',x,y,width,height,radius});
  const caret=cursor===undefined?undefined:geometry.caret(cursor);if(caret){const[x,y,width,height]=caret.rect;output.push({kind:'cursor',x,y,width,height,radius});}return output;
}
function segmentLogicalLength(text: string): number { return segmentGraphemes(text).length; }
function modulo(value: number, period: number): number { return ((value % period) + period) % period; }
function mirror(value: number, start: number, end: number): number { const low = Math.min(start, end), high = Math.max(start, end), span = high - low; if (span <= 1e-8) return low; const phase = modulo(value - low, span * 2); return low + (phase <= span ? phase : span * 2 - phase); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }


/** Nonzero compiled pairs keep their logical owner through bidi reordering and wrapping. */
type ProductionPairSpacing = ReadonlyMap<number, Readonly<{next: number; value: number}>>;
function prepareProductionPairSpacing(glyphs: readonly ShapedGlyph[], fonts: ReadonlyMap<string, RuntimeFontAsset>): ProductionPairSpacing {
  const result = new Map<number, Readonly<{next: number; value: number}>>();
  for (let index = 0; index + 1 < glyphs.length; index++) {
    const left = glyphs[index]!, right = glyphs[index + 1]!;
    if (left.style !== right.style || left.fontAsset !== right.fontAsset || left.direction !== right.direction
        || left.breakClass === 'newline' || right.breakClass === 'newline'
        || left.style.features?.kern === false || left.style.features?.kern === 0
        || textPaintSequence(left) === '' || textPaintSequence(right) === '') continue;
    const a = textPaintSequence(left) ?? left.sequence, b = textPaintSequence(right) ?? right.sequence;
    const font = fonts.get(left.fontAsset)!, value = (font.metrics.kerning?.[`${a}|${b}`] ?? 0) * left.style.fontSize / font.metrics.unitsPerEm;
    if (!Number.isFinite(value) || !Number.isFinite(left.advance + value)) throw new TextShapingError('E_TEXT_NUMBER', 'Glyph advance is non-finite.');
    if (value !== 0) result.set(left.logicalIndex, {next: right.logicalIndex, value});
  }
  return result;
}
function productionLogicalPairSpacing(left: ShapedGlyph, right: ShapedGlyph | undefined, spacing: ProductionPairSpacing): number {
  const pair = spacing.get(left.logicalIndex);
  return pair && right?.logicalIndex === pair.next ? pair.value : 0;
}
function productionVisualPairSpacing(glyph: ShapedGlyph, previous: ShapedGlyph | undefined,
    next: ShapedGlyph | undefined, spacing: ProductionPairSpacing): number {
  return productionLogicalPairSpacing(glyph, glyph.direction === 'rtl' ? previous : next, spacing);
}
function productionLogicalLineWidth(glyphs: readonly ShapedGlyph[], spacing: ProductionPairSpacing): number {
  let width = 0;
  for (let index = 0; index < glyphs.length; index++) width += glyphs[index]!.advance + productionLogicalPairSpacing(glyphs[index]!, glyphs[index + 1], spacing);
  return width;
}
function productionVisualLineWidth(glyphs: readonly ShapedGlyph[], spacing: ProductionPairSpacing): number {
  let width = 0;
  for (let index = 0; index < glyphs.length; index++) width += glyphs[index]!.advance + productionVisualPairSpacing(glyphs[index]!, glyphs[index - 1], glyphs[index + 1], spacing);
  return width;
}
/** Logical line membership is resolved before visual ordering, using the same prepared pairs. */
function wrapProductionGlyphs(glyphs: readonly ShapedGlyph[], width: number, wrap: RuntimeTextBlock['wrap'],
    spacing: ProductionPairSpacing): WorkingLine[] {
  const lines: WorkingLine[] = [{glyphs: [], width: 0, height: 0}];
  for (const glyph of glyphs) {
    let line = lines[lines.length - 1]!;
    if (glyph.breakClass === 'newline') {lines.push({glyphs: [], width: 0, height: glyph.style.lineHeight}); continue;}
    const previous = line.glyphs.at(-1), adjustment = previous ? productionLogicalPairSpacing(previous, glyph, spacing) : 0;
    if (wrap !== 'none' && width > 0 && line.glyphs.length > 0 && line.width + glyph.advance + adjustment > width) {
      const space = wrap === 'word' ? line.glyphs.findLastIndex(candidate => candidate.breakClass === 'space') : -1;
      if (space >= 0 && space < line.glyphs.length - 1) {
        const moved = line.glyphs.splice(space + 1); line.width = productionLogicalLineWidth(line.glyphs, spacing);
        line.height = line.glyphs.reduce((maximum, item) => Math.max(maximum, item.style.lineHeight), 0);
        line = {glyphs: moved, width: productionLogicalLineWidth(moved, spacing), height: moved.reduce((maximum, item) => Math.max(maximum, item.style.lineHeight), 0)};
      } else line = {glyphs: [], width: 0, height: 0};
      lines.push(line);
    }
    const last = line.glyphs.at(-1);
    line.width += glyph.advance + (last ? productionLogicalPairSpacing(last, glyph, spacing) : 0);
    line.glyphs.push(glyph); line.height = Math.max(line.height, glyph.style.lineHeight);
  }
  return lines;
}
