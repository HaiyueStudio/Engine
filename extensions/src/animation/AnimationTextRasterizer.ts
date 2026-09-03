import type {
  AnimationText2DComponent,
  AnimationTextAnimator,
  AnimationTextDocumentKeyframe,
  AnimationVectorValueTrack,
} from '@haiyue/animation-spec';
import { evaluateSafeExpression } from '@haiyue/animation-spec';
import { parse as parseOpenType, type Font as OpenTypeFont, type Path as OpenTypePath } from 'opentype.js';

type TextTexture = HTMLCanvasElement | ImageBitmap;

interface ResolvedTextDocument {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  fontStyle: 'normal' | 'italic';
  lineHeight: number;
  tracking: number;
  textAlign: 'left' | 'center' | 'right';
  color: readonly [number, number, number, number];
}

interface GlyphState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  tracking: number;
  color: [number, number, number, number];
}

interface ResolvedRunStyle extends Omit<ResolvedTextDocument, 'text' | 'textAlign'> {
  readonly key: number;
  readonly lineBackground?: NonNullable<Readonly<AnimationText2DComponent>['lineBackground']>;
}

interface StyledGlyph {
  readonly value: string;
  readonly style: ResolvedRunStyle;
}

interface StyledLine {
  readonly glyphs: readonly StyledGlyph[];
  readonly paragraphEnd: boolean;
}

interface StyledLineLayout {
  readonly line: StyledLine;
  readonly metrics: ReturnType<typeof measureStyledLine>;
  readonly x: number;
  readonly top: number;
  readonly baseline: number;
  readonly height: number;
}

interface BackgroundRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface SelectorIndexPlan {
  readonly indices: readonly number[];
  readonly count: number;
}

/** Runtime-private deterministic grapheme shaper and Canvas atlas uploader. */
export class AnimationTextRasterizer {
  texture: TextTexture | null = null;
  textureVersion = 0;
  private readonly canvas: HTMLCanvasElement | null;
  private time = Number.NaN;
  private dirty = true;
  private updating = false;
  private updateToken = 0;
  private readonly animated: boolean;
  private readonly expressionData = new Map<string, unknown>();
  private readonly outlineFonts = new Map<string, OpenTypeFont>();

  constructor(readonly component: Readonly<AnimationText2DComponent>) {
    this.canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    this.animated = component.expression !== undefined || (component.documents?.length ?? 0) > 1
      || component.paragraphSpacingTrack !== undefined
      || (component.styleRuns ?? []).some(run => run.fontSizeTrack || run.lineHeightTrack || run.trackingTrack)
      || (component.animators ?? []).some(animator => hasAnimatedAnimator(animator));
    void this.updateTexture();
  }

  setTime(time: number): void {
    if (!this.animated) return;
    if (this.time === time && !this.dirty) return;
    this.time = time;
    this.dirty = true;
    void this.updateTexture();
  }

  invalidateFont(): void {
    this.dirty = true;
    void this.updateTexture();
  }

  setFontData(family: string, style: 'normal' | 'italic', weight: string | number, data: ArrayBuffer): void {
    try {
      let font = parsedOpenTypeFonts.get(data);
      if (!font) { font = parseOpenType(data); parsedOpenTypeFonts.set(data, font); }
      this.outlineFonts.set(outlineFontKey(family, style, weight), font);
    } catch {
      // FontFace remains the deterministic fallback for unsupported OpenType
      // containers. A failed outline parse must not invalidate a loadable font.
    }
    this.invalidateFont();
  }

  setExpressionData(resource: string, value: unknown): void {
    this.expressionData.set(resource, value);
    this.dirty = true;
    void this.updateTexture();
  }

  destroy(): void {
    this.updateToken++;
    closeTextTexture(this.texture, this.canvas);
    this.texture = null;
  }

  async updateTexture(): Promise<void> {
    if (!this.dirty || this.updating || !this.canvas) return;
    const token = ++this.updateToken;
    this.dirty = false;
    this.updating = true;
    try {
      this.draw(this.canvas, Number.isFinite(this.time) ? this.time : 0);
      this.texture = this.canvas;
      this.textureVersion++;
      if (typeof createImageBitmap !== 'function') return;
      const bitmap = await createImageBitmap(this.canvas, { colorSpaceConversion: 'none' });
      if (token !== this.updateToken) { bitmap.close(); return; }
      const retired = this.texture;
      this.texture = bitmap;
      this.textureVersion++;
      closeTextTexture(retired, this.canvas);
    } finally {
      this.updating = false;
      if (this.dirty) void this.updateTexture();
    }
  }

  private draw(canvas: HTMLCanvasElement, time: number): void {
    const component = this.component;
    const document = resolveDocument(component, time, this.expressionData);
    const width = Math.max(1, Math.ceil(component.size[0]));
    const height = Math.max(1, Math.ceil(component.size[1]));
    const dpr = Math.max(1, Math.min(4, component.resolutionScale ?? 2));
    canvas.width = Math.max(1, Math.ceil(width * dpr));
    canvas.height = Math.max(1, Math.ceil(height * dpr));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Rive rasterizes unhinted vector glyph outlines. Ask the browser text
    // shaper for geometric precision so Canvas does not snap small embedded
    // fonts to the host platform's UI-text hinting grid.
    context.textRendering = 'geometricPrecision';
    context.fontKerning = 'normal';
    context.clearRect(0, 0, width, height);
    const background = component.backgroundColor;
    if (background && background[3] > 0) {
      context.fillStyle = cssColor(background);
      context.fillRect(0, 0, width, height);
    }
    const padding = Math.max(0, component.padding ?? 0);
    const contentWidth = Math.max(1, width - padding * 2);
    const contentHeight = Math.max(1, height - padding * 2);
    if ((component.styleRuns?.length ?? 0) > 0) {
      drawStyledText(context, component, document, time, padding, contentWidth, contentHeight, this.outlineFonts);
      quantizeRiveTextCoverage(context, canvas.width, canvas.height, riveTextPaintPalette(component, document));
      return;
    }
    let fontSize = document.fontSize;
    let lineHeight = document.lineHeight;
    let tracking = document.tracking;
    context.font = `${document.fontStyle} ${document.fontWeight} ${fontSize}px ${quoteFont(document.fontFamily)}`;
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    let lines = layoutTextLines(context, document.text, contentWidth, component.wrap ?? 'none', tracking);
    if ((component.fit === 'scale' || component.fit === 'font-size') && lines.length > 0) {
      const measuredWidth = Math.max(...lines.map(line => measuredLineWidth(context, line, tracking)), 1);
      const measuredHeight = Math.max(1, lines.length * lineHeight);
      const continuousScale = Math.min(1, contentWidth / measuredWidth, contentHeight / measuredHeight);
      const scale = component.fit === 'font-size'
        ? Math.max(1, Math.floor(fontSize * continuousScale)) / Math.max(1, fontSize)
        : continuousScale;
      fontSize *= scale;
      lineHeight *= scale;
      tracking *= scale;
      context.font = `${document.fontStyle} ${document.fontWeight} ${fontSize}px ${quoteFont(document.fontFamily)}`;
      lines = layoutTextLines(context, document.text, contentWidth, component.wrap ?? 'none', tracking);
    }
    const animators = component.animators ?? [];
    const outlineFont = this.outlineFonts.get(outlineFontKey(document.fontFamily, document.fontStyle, document.fontWeight));
    const selectorPlans = animators.map(animator => createSelectorIndexPlan(lines, animator));
    lineHeight = Math.max(1, lineHeight);
    const textHeight = lines.length * lineHeight;
    let top = padding;
    const vertical = component.verticalAlign ?? 'middle';
    if (vertical === 'middle') top += Math.max(0, (contentHeight - textHeight) / 2);
    else if (vertical === 'bottom') top += Math.max(0, contentHeight - textHeight);
    let globalIndex = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const advances = line.map(glyph => context.measureText(glyph).width);
      const baseWidth = advances.reduce((sum, advance) => sum + advance, 0) + Math.max(0, line.length - 1) * tracking;
      let x = padding;
      if (document.textAlign === 'center') x += Math.max(0, (contentWidth - baseWidth) / 2);
      else if (document.textAlign === 'right') x += Math.max(0, contentWidth - baseWidth);
      const baseline = top + lineIndex * lineHeight + fontSize;
      if (component.lineBackground) {
        drawJoinedLineBackground(context, component.lineBackground, [{
          left: x,
          top: baseline - fontSize,
          right: x + baseWidth,
          bottom: baseline - fontSize + lineHeight,
        }]);
      }
      if (animators.length === 0 && outlineFont) {
        drawOpenTypeText(context, outlineFont, line.join(''), x, baseline, fontSize, document.color);
        continue;
      }
      for (let glyphIndex = 0; glyphIndex < line.length; glyphIndex++, globalIndex++) {
        const glyph = line[glyphIndex]!;
        const advance = advances[glyphIndex] ?? 0;
        const state = resolveGlyphState(animators, selectorPlans, time, globalIndex, document.color);
        const centerX = x + advance / 2 + state.x;
        context.save();
        context.translate(centerX, baseline + state.y);
        context.rotate(state.rotation);
        context.scale(state.scaleX, state.scaleY);
        context.globalAlpha = state.opacity;
        context.fillStyle = cssColor(state.color);
        context.fillText(glyph, -advance / 2, 0);
        context.restore();
        x += advance + tracking + state.tracking;
      }
    }
    quantizeRiveTextCoverage(context, canvas.width, canvas.height, riveTextPaintPalette(component, document));
  }
}

/**
 * Canvas preserves continuous coverage inside every high-resolution atlas
 * texel. Rive's WebGL2 renderer instead evaluates authored vector paints at
 * four discrete MSAA locations. Converting opaque text paint edges back to a
 * binary high-resolution sample grid lets the fragment shader reproduce those
 * four coverage steps without changing shaping or authored colors.
 *
 * Semi-transparent paints intentionally bypass this compatibility path: their
 * source-over result cannot be reconstructed from one flattened Canvas pixel.
 */
export function quantizeRiveTextCoverage(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: readonly (readonly [number, number, number, number])[] | null,
): void {
  if (!palette || palette.length === 0
    || typeof context.getImageData !== 'function'
    || typeof context.putImageData !== 'function') return;
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const colors = palette.map(color => [
    Math.round(clamp(color[0], 0, 1) * 255),
    Math.round(clamp(color[1], 0, 1) * 255),
    Math.round(clamp(color[2], 0, 1) * 255),
  ] as const);
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3]!;
    if (alpha === 0) continue;
    if (alpha < 192) {
      data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0; data[offset + 3] = 0;
      continue;
    }
    let nearest = colors[0]!;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const color of colors) {
      const red = data[offset]! - color[0];
      const green = data[offset + 1]! - color[1];
      const blue = data[offset + 2]! - color[2];
      const distance = red * red + green * green + blue * blue;
      if (distance < nearestDistance) { nearest = color; nearestDistance = distance; }
    }
    data[offset] = nearest[0]; data[offset + 1] = nearest[1]; data[offset + 2] = nearest[2]; data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function riveTextPaintPalette(
  component: Readonly<AnimationText2DComponent>,
  document: ResolvedTextDocument,
): readonly (readonly [number, number, number, number])[] | null {
  if ((component.resolutionScale ?? 2) < 4) return null;
  if ((component.animators ?? []).some(animator => animator.opacity !== undefined || animator.opacityTrack !== undefined
    || animator.fillColor !== undefined || animator.fillColorTrack !== undefined)) return null;
  const colors: (readonly [number, number, number, number])[] = [document.color];
  if (component.backgroundColor?.[3]) colors.push(component.backgroundColor);
  if (component.lineBackground) {
    colors.push(component.lineBackground.fill);
    if (component.lineBackground.stroke) colors.push(component.lineBackground.stroke);
  }
  for (const run of component.styleRuns ?? []) {
    if (run.color) colors.push(run.color);
    if (run.lineBackground) {
      colors.push(run.lineBackground.fill);
      if (run.lineBackground.stroke) colors.push(run.lineBackground.stroke);
    }
  }
  const visible = colors.filter(color => color[3] > 1e-6);
  if (visible.some(color => Math.abs(color[3] - 1) > 1e-6)) return null;
  return visible.filter((color, index) => visible.findIndex(candidate => candidate.every((value, channel) => value === color[channel])) === index);
}

function drawStyledText(
  context: CanvasRenderingContext2D,
  component: Readonly<AnimationText2DComponent>,
  document: ResolvedTextDocument,
  time: number,
  padding: number,
  contentWidth: number,
  contentHeight: number,
  outlineFonts: ReadonlyMap<string, OpenTypeFont>,
): void {
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  let scale = 1;
  let scaleLineMetrics = false;
  const paragraphSpacing = sampled(component.paragraphSpacingTrack, time, [component.paragraphSpacing ?? 0])[0] ?? 0;
  let lines = layoutStyledText(context, component, document, contentWidth, scale, scaleLineMetrics, time);
  if (component.fit === 'font-size' && lines.length > 0) {
    const maxFontSize = Math.max(document.fontSize, ...lines.flatMap(line => line.glyphs.map(glyph => glyph.style.fontSize)));
    let low = 1; let high = Math.max(1, Math.floor(maxFontSize)); let best = 1;
    while (low <= high) {
      const candidate = low + Math.floor((high - low) / 2);
      const candidateScale = candidate / Math.max(1, maxFontSize);
      const candidateLines = layoutStyledText(context, component, document, contentWidth, candidateScale, false, time);
      const candidateMetrics = measureStyledBlock(context, candidateLines, document, paragraphSpacing, candidateScale, false);
      if (candidateMetrics.width <= contentWidth && candidateMetrics.height <= contentHeight) {
        best = candidate; low = candidate + 1;
      } else high = candidate - 1;
    }
    scale = best / Math.max(1, maxFontSize);
    // @rive-app/webgl2@2.40.0 preserves authored custom line boxes while
    // stepping the top font size. This legacy compatibility behavior is
    // observable in the pinned text_fit_test.riv oracle.
    scaleLineMetrics = false;
    lines = layoutStyledText(context, component, document, contentWidth, scale, scaleLineMetrics, time);
  } else if (component.fit === 'scale' && lines.length > 0) {
    const metrics = measureStyledBlock(context, lines, document, paragraphSpacing, scale, false);
    scale = Math.min(1, contentWidth / Math.max(1, metrics.width), contentHeight / Math.max(1, metrics.height));
    scaleLineMetrics = true;
    lines = layoutStyledText(context, component, document, contentWidth, scale, scaleLineMetrics, time);
  }
  const metrics = measureStyledBlock(context, lines, document, paragraphSpacing, scale, scaleLineMetrics);
  let top = padding;
  const vertical = component.verticalAlign ?? 'middle';
  if (vertical === 'middle') top += Math.max(0, (contentHeight - metrics.height) / 2);
  else if (vertical === 'bottom') top += Math.max(0, contentHeight - metrics.height);
  const glyphLines = lines.map(line => line.glyphs.map(glyph => glyph.value));
  const animators = component.animators ?? [];
  const selectorPlans = animators.map(animator => createSelectorIndexPlan(glyphLines, animator));
  const layouts: StyledLineLayout[] = [];
  let firstLine = true;
  for (const line of lines) {
    const lineMetrics = measureStyledLine(context, line.glyphs, document, scale, scaleLineMetrics);
    let x = padding;
    if (document.textAlign === 'center') x += Math.max(0, (contentWidth - lineMetrics.width) / 2);
    else if (document.textAlign === 'right') x += Math.max(0, contentWidth - lineMetrics.width);
    const lineHeight = firstLine
      ? lineMetrics.naturalAscent + lineMetrics.descent
      : lineMetrics.ascent + lineMetrics.descent;
    const baseline = top + (firstLine ? lineMetrics.naturalAscent : lineMetrics.ascent);
    layouts.push({ line, metrics: lineMetrics, x, top, baseline, height: lineHeight });
    top += lineHeight;
    if (line.paragraphEnd) top += Math.max(0, paragraphSpacing) * (scaleLineMetrics ? scale : 1);
    firstLine = false;
  }

  // Rive accumulates every glyph rectangle owned by a TextStylePaint, unions
  // touching lines into one contour, and paints all backgrounds before any
  // glyph paths. Keeping the geometry grouped by style key preserves both the
  // stepped outline between unequal line widths and the official paint order.
  const backgroundGroups = new Map<number, {
    background: NonNullable<ResolvedRunStyle['lineBackground']>;
    rects: BackgroundRect[];
  }>();
  for (const layout of layouts) {
    const { line, metrics: lineMetrics, x } = layout;
    let segmentStart = 0;
    while (segmentStart < line.glyphs.length) {
      const style = line.glyphs[segmentStart]!.style;
      const background = style.lineBackground;
      let segmentEnd = segmentStart + 1;
      while (segmentEnd < line.glyphs.length
        && line.glyphs[segmentEnd]!.style.key === style.key) segmentEnd++;
      if (background) {
        const segmentX = x + lineMetrics.offsets[segmentStart]!;
        const segmentWidth = lineMetrics.offsets[segmentEnd]! - lineMetrics.offsets[segmentStart]!;
        const group = backgroundGroups.get(style.key) ?? { background, rects: [] };
        group.rects.push({
          left: segmentX,
          top: layout.top,
          right: segmentX + segmentWidth,
          bottom: layout.top + layout.height,
        });
        backgroundGroups.set(style.key, group);
      }
      segmentStart = segmentEnd;
    }
  }
  for (const group of backgroundGroups.values()) {
    drawJoinedLineBackground(context, group.background, group.rects);
  }

  let globalIndex = 0;
  for (const layout of layouts) {
    const { line, metrics: lineMetrics, x, baseline } = layout;
    if (animators.length === 0) {
      drawShapedStyleSegments(context, line.glyphs, lineMetrics.offsets, x, baseline, outlineFonts);
      globalIndex += line.glyphs.length;
    } else for (let glyphIndex = 0; glyphIndex < line.glyphs.length; glyphIndex++, globalIndex++) {
      const glyph = line.glyphs[glyphIndex]!;
      const advance = lineMetrics.advances[glyphIndex] ?? 0;
      const state = resolveGlyphState(animators, selectorPlans, time, globalIndex, glyph.style.color);
      const glyphX = x + lineMetrics.offsets[glyphIndex]!;
      const centerX = glyphX + advance / 2 + state.x;
      context.save();
      context.font = textFont(glyph.style);
      context.translate(centerX, baseline + state.y);
      context.rotate(state.rotation);
      context.scale(state.scaleX, state.scaleY);
      context.globalAlpha = state.opacity;
      context.fillStyle = cssColor(state.color);
      context.fillText(glyph.value, -advance / 2, 0);
      context.restore();
    }
  }
}

function drawShapedStyleSegments(
  context: CanvasRenderingContext2D,
  glyphs: readonly StyledGlyph[],
  offsets: readonly number[],
  x: number,
  baseline: number,
  outlineFonts: ReadonlyMap<string, OpenTypeFont>,
): void {
  let start = 0;
  while (start < glyphs.length) {
    let end = start + 1;
    while (end < glyphs.length && glyphs[end]!.style.key === glyphs[start]!.style.key) end++;
    const style = glyphs[start]!.style;
    const text = glyphs.slice(start, end).map(glyph => glyph.value).join('');
    const outlineFont = outlineFonts.get(outlineFontKey(style.fontFamily, style.fontStyle, style.fontWeight));
    if (outlineFont && Math.abs(style.tracking) < 1e-6) {
      drawOpenTypeText(context, outlineFont, text, x + offsets[start]!, baseline, style.fontSize, style.color);
    } else {
      context.font = textFont(style);
      setCanvasLetterSpacing(context, style.tracking);
      context.fillStyle = cssColor(style.color);
      context.fillText(text, x + offsets[start]!, baseline);
    }
    start = end;
  }
  setCanvasLetterSpacing(context, 0);
}

const parsedOpenTypeFonts = new WeakMap<ArrayBuffer, OpenTypeFont>();

function outlineFontKey(family: string, style: 'normal' | 'italic', weight: string | number): string {
  return `${family}\0${style}\0${String(weight)}`;
}

function drawOpenTypeText(
  context: CanvasRenderingContext2D,
  font: OpenTypeFont,
  text: string,
  x: number,
  baseline: number,
  fontSize: number,
  color: readonly [number, number, number, number],
): void {
  const path = font.getPath(text, x, baseline, fontSize, { kerning: true, features: { liga: true, rlig: true } });
  drawOpenTypePath(context, path);
  context.fillStyle = cssColor(color);
  context.fill('nonzero');
}

function drawOpenTypePath(context: CanvasRenderingContext2D, path: OpenTypePath): void {
  context.beginPath();
  for (const command of path.commands) switch (command.type) {
    case 'M': context.moveTo(command.x!, command.y!); break;
    case 'L': context.lineTo(command.x!, command.y!); break;
    case 'C': context.bezierCurveTo(command.x1!, command.y1!, command.x2!, command.y2!, command.x!, command.y!); break;
    case 'Q': context.quadraticCurveTo(command.x1!, command.y1!, command.x!, command.y!); break;
    case 'Z': context.closePath(); break;
  }
}

function layoutStyledText(
  context: CanvasRenderingContext2D,
  component: Readonly<AnimationText2DComponent>,
  document: ResolvedTextDocument,
  width: number,
  fontScale: number,
  scaleLineMetrics: boolean,
  time: number,
): StyledLine[] {
  const baseStyle = scaledRunStyle(document, component.lineBackground, 0, fontScale, scaleLineMetrics);
  const runStyles = (component.styleRuns ?? []).map((run, index) => ({
    start: run.start,
    end: run.end,
    style: scaledRunStyle({
      fontFamily: run.fontFamily ?? document.fontFamily,
      fontSize: sampled(run.fontSizeTrack, time, [run.fontSize ?? document.fontSize])[0] ?? run.fontSize ?? document.fontSize,
      fontWeight: run.fontWeight ?? document.fontWeight,
      fontStyle: run.fontStyle ?? document.fontStyle,
      // Zero is runtime-private shorthand for Rive's automatic line height;
      // it is resolved from the loaded font metrics in measureStyledLine.
      lineHeight: sampled(run.lineHeightTrack, time, [run.lineHeight ?? 0])[0] ?? run.lineHeight ?? 0,
      tracking: sampled(run.trackingTrack, time, [run.tracking ?? document.tracking])[0] ?? run.tracking ?? document.tracking,
      color: run.color ?? document.color,
    }, run.lineBackground ?? component.lineBackground, index + 1, fontScale, scaleLineMetrics),
  }));
  const paragraphs: StyledGlyph[][] = [];
  const breakPattern = /\r\n|\r|\n/gu;
  let cursor = 0;
  for (const match of document.text.matchAll(breakPattern)) {
    paragraphs.push(styledGlyphs(document.text.slice(cursor, match.index), cursor, baseStyle, runStyles));
    cursor = (match.index ?? cursor) + match[0].length;
  }
  paragraphs.push(styledGlyphs(document.text.slice(cursor), cursor, baseStyle, runStyles));
  const output: StyledLine[] = [];
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex]!;
    const words = styledWords(paragraph);
    let line: StyledGlyph[] = [];
    for (const candidateWord of words) {
      const candidate = [...line, ...candidateWord];
      if (component.wrap === 'word' && line.length > 0
        && measureStyledLine(context, candidate, document, fontScale, scaleLineMetrics).width > width) {
        output.push({ glyphs: line, paragraphEnd: false });
        line = [...candidateWord];
      } else line = candidate;
      if (component.wrap === 'word' && line.length > 1
        && measureStyledLine(context, line, document, fontScale, scaleLineMetrics).width > width) {
        const pending = [...line]; line = [];
        for (const glyph of pending) {
          const forced = [...line, glyph];
          if (line.length > 0 && measureStyledLine(context, forced, document, fontScale, scaleLineMetrics).width > width) {
            output.push({ glyphs: line, paragraphEnd: false }); line = [glyph];
          } else line = forced;
        }
      }
    }
    output.push({ glyphs: line, paragraphEnd: true });
  }
  return output;
}

function styledWords(glyphs: readonly StyledGlyph[]): StyledGlyph[][] {
  if (glyphs.length === 0) return [[]];
  const text = glyphs.map(glyph => glyph.value).join('');
  const boundaries = new Set<number>();
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const segment of segmenter.segment(text)) boundaries.add(segment.index + segment.segment.length);
  } else {
    let offset = 0;
    for (const match of text.matchAll(/\S+\s*|\s+/gu)) { offset += match[0].length; boundaries.add(offset); }
  }
  const words: StyledGlyph[][] = []; let word: StyledGlyph[] = []; let offset = 0;
  for (const glyph of glyphs) {
    word.push(glyph); offset += glyph.value.length;
    if (boundaries.has(offset)) { words.push(word); word = []; }
  }
  if (word.length > 0) words.push(word);
  return words;
}

function styledGlyphs(
  text: string,
  baseOffset: number,
  baseStyle: ResolvedRunStyle,
  runStyles: readonly { start: number; end: number; style: ResolvedRunStyle }[],
): StyledGlyph[] {
  const output: StyledGlyph[] = [];
  let offset = baseOffset;
  for (const value of splitGraphemes(text)) {
    const run = runStyles.find(candidate => offset >= candidate.start && offset < candidate.end);
    output.push({ value, style: run?.style ?? baseStyle });
    offset += value.length;
  }
  return output;
}

function scaledRunStyle(
  source: Omit<ResolvedTextDocument, 'text' | 'textAlign'>,
  lineBackground: NonNullable<Readonly<AnimationText2DComponent>['lineBackground']> | undefined,
  key: number,
  fontScale: number,
  scaleLineMetrics = true,
): ResolvedRunStyle {
  const metricScale = scaleLineMetrics ? fontScale : 1;
  return {
    key,
    fontFamily: source.fontFamily,
    fontSize: source.fontSize * fontScale,
    fontWeight: source.fontWeight,
    fontStyle: source.fontStyle,
    // Rive applies one uniform fit scale to font size, custom line height,
    // letter spacing and TextStyleBackground geometry.
    lineHeight: source.lineHeight * metricScale,
    tracking: source.tracking * metricScale,
    color: source.color,
    ...(lineBackground ? {
      lineBackground: {
        ...lineBackground,
        ...(lineBackground.strokeWidth === undefined ? {} : { strokeWidth: lineBackground.strokeWidth * metricScale }),
        ...(lineBackground.cornerRadius === undefined ? {} : { cornerRadius: lineBackground.cornerRadius * metricScale }),
        ...(lineBackground.padding === undefined ? {} : { padding: lineBackground.padding * metricScale }),
      },
    } : {}),
  };
}

function measureStyledBlock(
  context: CanvasRenderingContext2D,
  lines: readonly StyledLine[],
  document: ResolvedTextDocument,
  paragraphSpacing: number,
  fontScale: number,
  scaleLineMetrics: boolean,
): { width: number; height: number } {
  let width = 0; let height = 0; let firstLine = true;
  for (const line of lines) {
    const metrics = measureStyledLine(context, line.glyphs, document, fontScale, scaleLineMetrics);
    width = Math.max(width, metrics.width);
    height += firstLine ? metrics.naturalAscent + metrics.descent : metrics.ascent + metrics.descent;
    if (line.paragraphEnd) height += Math.max(0, paragraphSpacing) * (scaleLineMetrics ? fontScale : 1);
    firstLine = false;
  }
  return { width, height };
}

function measureStyledLine(
  context: CanvasRenderingContext2D,
  glyphs: readonly StyledGlyph[],
  document: ResolvedTextDocument,
  fontScale: number,
  scaleLineMetrics = true,
): { width: number; ascent: number; descent: number; naturalAscent: number; advances: number[]; offsets: number[] } {
  const advances: number[] = [];
  const offsets = [0];
  let width = 0;
  let ascent = 0; let descent = 0; let naturalAscent = 0;
  const sourceGlyphs = glyphs.length > 0
    ? glyphs
    : [{ value: 'Mg', style: scaledRunStyle(document, undefined, 0, fontScale, scaleLineMetrics) }];
  let start = 0;
  while (start < sourceGlyphs.length) {
    let end = start + 1;
    while (end < sourceGlyphs.length && sourceGlyphs[end]!.style.key === sourceGlyphs[start]!.style.key) end++;
    const style = sourceGlyphs[start]!.style;
    context.font = textFont(style);
    setCanvasLetterSpacing(context, 0);
    const sample = context.measureText(sourceGlyphs.slice(start, end).map(glyph => glyph.value).join(''));
    const fontAscent = positiveMetric(sample.fontBoundingBoxAscent, sample.actualBoundingBoxAscent, style.fontSize * 0.8);
    const fontDescent = positiveMetric(sample.fontBoundingBoxDescent, sample.actualBoundingBoxDescent, style.fontSize * 0.2);
    const metricHeight = Math.max(1e-6, fontAscent + fontDescent);
    const customHeight = style.lineHeight > 0 ? style.lineHeight : metricHeight;
    ascent = Math.max(ascent, customHeight * fontAscent / metricHeight);
    descent = Math.max(descent, customHeight * fontDescent / metricHeight);
    naturalAscent = Math.max(naturalAscent, fontAscent);
    let prefix = '';
    for (let index = start; index < end; index++) {
      prefix += sourceGlyphs[index]!.value;
      const prefixWidth = context.measureText(prefix).width + Math.max(0, index - start) * style.tracking;
      const offset = width + prefixWidth;
      if (glyphs.length > 0) {
        advances.push(offset - offsets[offsets.length - 1]!);
        offsets.push(offset);
      }
    }
    width = offsets[offsets.length - 1] ?? width;
    start = end;
  }
  setCanvasLetterSpacing(context, 0);
  return { width, ascent, descent, naturalAscent, advances, offsets };
}

function positiveMetric(primary: number | undefined, secondary: number | undefined, fallback: number): number {
  return Number.isFinite(primary) && primary! > 0 ? primary!
    : Number.isFinite(secondary) && secondary! > 0 ? secondary! : fallback;
}

function setCanvasLetterSpacing(context: CanvasRenderingContext2D, value: number): void {
  if ('letterSpacing' in context) context.letterSpacing = `${value}px`;
}

function textFont(style: Pick<ResolvedRunStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle'>): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${quoteFont(style.fontFamily)}`;
}

function layoutTextLines(
  context: CanvasRenderingContext2D,
  text: string,
  width: number,
  wrap: 'none' | 'word',
  tracking: number,
): string[][] {
  if (wrap === 'none') return text.split(/\r?\n/).map(splitGraphemes);
  const output: string[][] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.match(/\S+\s*/gu) ?? [''];
    let line: string[] = [];
    for (const word of words) {
      const glyphs = splitGraphemes(word);
      const candidate = [...line, ...glyphs];
      if (line.length > 0 && measuredLineWidth(context, candidate, tracking) > width) {
        output.push(line);
        line = glyphs;
      } else line = candidate;
    }
    output.push(line);
  }
  return output;
}

function measuredLineWidth(context: CanvasRenderingContext2D, line: readonly string[], tracking: number): number {
  return line.reduce((sum, glyph) => sum + context.measureText(glyph).width, 0)
    + Math.max(0, line.length - 1) * tracking;
}

function drawJoinedLineBackground(
  context: CanvasRenderingContext2D,
  background: NonNullable<Readonly<AnimationText2DComponent>['lineBackground']>,
  sourceRects: readonly BackgroundRect[],
): void {
  const padding = Math.max(0, background.padding ?? 0);
  const strokeWidth = Math.max(0, background.strokeWidth ?? 0);
  const rects = sourceRects.map(rect => ({
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
  })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
  if (rects.length === 0) return;
  context.save();
  context.beginPath();
  for (const contour of unionRectContours(rects)) {
    roundedContour(context, contour, Math.max(0, background.cornerRadius ?? 0));
  }
  context.fillStyle = cssColor(background.fill);
  context.fill('evenodd');
  if (background.stroke && strokeWidth > 0) {
    context.strokeStyle = cssColor(background.stroke);
    context.lineWidth = strokeWidth;
    context.stroke();
  }
  context.restore();
}

function unionRectContours(rects: readonly BackgroundRect[]): [number, number][][] {
  const xs = [...new Set(rects.flatMap(rect => [rect.left, rect.right]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(rect => [rect.top, rect.bottom]))].sort((a, b) => a - b);
  const columns = Math.max(0, xs.length - 1);
  const rows = Math.max(0, ys.length - 1);
  const covered = Array.from({ length: rows }, () => Array<boolean>(columns).fill(false));
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const centerX = (xs[x]! + xs[x + 1]!) / 2;
    const centerY = (ys[y]! + ys[y + 1]!) / 2;
    covered[y]![x] = rects.some(rect => centerX >= rect.left && centerX < rect.right
      && centerY >= rect.top && centerY < rect.bottom);
  }
  const edges: { start: [number, number]; end: [number, number] }[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    if (!covered[y]![x]) continue;
    const left = xs[x]!; const right = xs[x + 1]!; const top = ys[y]!; const bottom = ys[y + 1]!;
    if (y === 0 || !covered[y - 1]![x]) edges.push({ start: [left, top], end: [right, top] });
    if (x === columns - 1 || !covered[y]![x + 1]) edges.push({ start: [right, top], end: [right, bottom] });
    if (y === rows - 1 || !covered[y + 1]![x]) edges.push({ start: [right, bottom], end: [left, bottom] });
    if (x === 0 || !covered[y]![x - 1]) edges.push({ start: [left, bottom], end: [left, top] });
  }
  const outgoing = new Map<string, number[]>();
  for (let index = 0; index < edges.length; index++) {
    const indices = outgoing.get(pointKey(edges[index]!.start)) ?? [];
    indices.push(index); outgoing.set(pointKey(edges[index]!.start), indices);
  }
  const used = new Set<number>();
  const contours: [number, number][][] = [];
  for (let seed = 0; seed < edges.length; seed++) {
    if (used.has(seed)) continue;
    const contour: [number, number][] = [];
    let edgeIndex = seed;
    const start = edges[seed]!.start;
    for (let guard = 0; guard <= edges.length; guard++) {
      const edge = edges[edgeIndex]!;
      used.add(edgeIndex);
      contour.push(edge.start);
      if (samePoint(edge.end, start)) break;
      const next = (outgoing.get(pointKey(edge.end)) ?? []).find(index => !used.has(index));
      if (next === undefined) break;
      edgeIndex = next;
    }
    const simplified = simplifyOrthogonalContour(contour);
    if (simplified.length >= 4) contours.push(signedArea(simplified) < 0 ? [...simplified].reverse() : simplified);
  }
  return contours;
}

function simplifyOrthogonalContour(points: readonly [number, number][]): [number, number][] {
  const output = [...points];
  let changed = true;
  while (changed && output.length >= 4) {
    changed = false;
    for (let index = 0; index < output.length; index++) {
      const previous = output[(index + output.length - 1) % output.length]!;
      const current = output[index]!;
      const next = output[(index + 1) % output.length]!;
      if ((previous[0] === current[0] && current[0] === next[0])
        || (previous[1] === current[1] && current[1] === next[1])) {
        output.splice(index, 1); changed = true; break;
      }
    }
  }
  return output;
}

function roundedContour(
  context: CanvasRenderingContext2D,
  contour: readonly [number, number][],
  radius: number,
): void {
  if (contour.length < 2) return;
  const corner = (index: number) => {
    const previous = contour[(index + contour.length - 1) % contour.length]!;
    const position = contour[index]!;
    const next = contour[(index + 1) % contour.length]!;
    const previousLength = Math.hypot(previous[0] - position[0], previous[1] - position[1]);
    const nextLength = Math.hypot(next[0] - position[0], next[1] - position[1]);
    const renderRadius = Math.min(previousLength / 2, nextLength / 2, radius);
    const toPrevious: [number, number] = [
      (previous[0] - position[0]) / previousLength,
      (previous[1] - position[1]) / previousLength,
    ];
    const toNext: [number, number] = [
      (next[0] - position[0]) / nextLength,
      (next[1] - position[1]) / nextLength,
    ];
    return { position, toPrevious, toNext, renderRadius };
  };
  if (radius <= 0) {
    context.moveTo(contour[0]![0], contour[0]![1]);
    for (let index = 1; index < contour.length; index++) context.lineTo(contour[index]![0], contour[index]![1]);
    context.closePath();
    return;
  }
  const first = corner(0);
  context.moveTo(
    first.position[0] + first.toPrevious[0] * first.renderRadius,
    first.position[1] + first.toPrevious[1] * first.renderRadius,
  );
  for (let index = 0; index < contour.length; index++) {
    const { position, toPrevious, toNext, renderRadius } = corner(index);
    const controlDistance = renderRadius * 0.5522847498307936;
    if (index > 0) context.lineTo(
      position[0] + toPrevious[0] * renderRadius,
      position[1] + toPrevious[1] * renderRadius,
    );
    context.bezierCurveTo(
      position[0] + toPrevious[0] * (renderRadius - controlDistance),
      position[1] + toPrevious[1] * (renderRadius - controlDistance),
      position[0] + toNext[0] * (renderRadius - controlDistance),
      position[1] + toNext[1] * (renderRadius - controlDistance),
      position[0] + toNext[0] * renderRadius,
      position[1] + toNext[1] * renderRadius,
    );
  }
  context.closePath();
}

function pointKey(point: readonly [number, number]): string { return `${point[0]}\0${point[1]}`; }
function samePoint(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}
function signedArea(points: readonly [number, number][]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index]!; const next = points[(index + 1) % points.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function resolveDocument(
  component: Readonly<AnimationText2DComponent>,
  time: number,
  expressionData: ReadonlyMap<string, unknown>,
): ResolvedTextDocument {
  let keyframe: Readonly<AnimationTextDocumentKeyframe> | undefined;
  for (const candidate of component.documents ?? []) {
    if (candidate.time > time) break;
    keyframe = candidate;
  }
  const resolved: ResolvedTextDocument = {
    text: keyframe?.text ?? component.text,
    fontFamily: keyframe?.fontFamily ?? component.fontFamily ?? 'sans-serif',
    fontSize: keyframe?.fontSize ?? component.fontSize ?? 28,
    fontWeight: keyframe?.fontWeight ?? component.fontWeight ?? 400,
    fontStyle: keyframe?.fontStyle ?? component.fontStyle ?? 'normal',
    lineHeight: keyframe?.lineHeight ?? component.lineHeight ?? (keyframe?.fontSize ?? component.fontSize ?? 28) * 1.2,
    tracking: keyframe?.tracking ?? component.tracking ?? 0,
    textAlign: keyframe?.textAlign ?? component.textAlign ?? 'center',
    color: keyframe?.color ?? component.color,
  };
  if (component.expression) {
    try {
      resolved.text = evaluateSafeExpression(component.expression, {
        time,
        text: resolved.text,
        data: expressionData,
      });
    } catch {
      // The authored/keyframed document is the deterministic permissive-mode fallback.
    }
  }
  return resolved;
}

function resolveGlyphState(
  animators: readonly Readonly<AnimationTextAnimator>[],
  selectorPlans: readonly SelectorIndexPlan[],
  time: number,
  index: number,
  baseColor: readonly [number, number, number, number],
): GlyphState {
  const state: GlyphState = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, tracking: 0, color: [...baseColor] };
  for (let animatorIndex = 0; animatorIndex < animators.length; animatorIndex++) {
    const animator = animators[animatorIndex]!;
    const plan = selectorPlans[animatorIndex]!;
    const weight = selectorWeight(animator, time, plan.indices[index] ?? 0, plan.count);
    if (Math.abs(weight) < 1e-6) continue;
    const position = sampled(animator.positionTrack, time, animator.position ?? [0, 0]);
    const scale = sampled(animator.scaleTrack, time, animator.scale ?? [1, 1]);
    const rotation = sampled(animator.rotationTrack, time, [animator.rotation ?? 0])[0] ?? 0;
    const opacity = sampled(animator.opacityTrack, time, [animator.opacity ?? 1])[0] ?? 1;
    const tracking = sampled(animator.trackingTrack, time, [animator.tracking ?? 0])[0] ?? 0;
    const color = sampled(animator.fillColorTrack, time, animator.fillColor ?? state.color);
    state.x += (position[0] ?? 0) * weight;
    state.y += (position[1] ?? 0) * weight;
    state.scaleX *= mix(1, scale[0] ?? 1, weight);
    state.scaleY *= mix(1, scale[1] ?? 1, weight);
    state.rotation += rotation * weight;
    state.opacity *= mix(1, opacity, weight);
    state.tracking += tracking * weight;
    for (let channel = 0; channel < 4; channel++) state.color[channel] = mix(state.color[channel]!, color[channel] ?? state.color[channel]!, weight);
  }
  state.opacity = clamp(state.opacity, 0, 1);
  return state;
}

function selectorWeight(animator: Readonly<AnimationTextAnimator>, time: number, index: number, count: number): number {
  const selector = animator.selector;
  const units = selector.units ?? 'percent';
  const coordinate = units === 'index' ? index + 0.5 : (index + 0.5) / Math.max(1, count);
  const start = sampled(selector.startTrack, time, [selector.start])[0] ?? selector.start;
  const end = sampled(selector.endTrack, time, [selector.end])[0] ?? selector.end;
  const offset = sampled(selector.offsetTrack, time, [selector.offset ?? 0])[0] ?? selector.offset ?? 0;
  const amount = sampled(selector.amountTrack, time, [selector.amount ?? 1])[0] ?? selector.amount ?? 1;
  const low = Math.min(start + offset, end + offset);
  const high = Math.max(start + offset, end + offset);
  const span = Math.max(1e-6, high - low);
  const progress = clamp((coordinate - low) / span, 0, 1);
  let weight = coordinate >= low && coordinate <= high ? 1 : 0;
  switch (selector.shape ?? 'square') {
    case 'ramp-up': weight = progress; break;
    case 'ramp-down': weight = 1 - progress; break;
    case 'triangle': weight = 1 - Math.abs(progress * 2 - 1); break;
    case 'round': weight = Math.sqrt(Math.max(0, 1 - (progress * 2 - 1) ** 2)); break;
    case 'smooth': weight = progress * progress * (3 - 2 * progress); break;
  }
  if (selector.easing) weight = cubicBezierYForX(weight, ...selector.easing);
  const smoothness = selector.smoothness ?? 1;
  if (smoothness < 1) {
    const width = Math.max(0.01, smoothness);
    const edge = 0.5 - width * 0.5;
    weight = clamp((weight - edge) / width, 0, 1);
  }
  return clamp(weight * amount, -1, 1);
}

function createSelectorIndexPlan(
  lines: readonly (readonly string[])[],
  animator: Readonly<AnimationTextAnimator>,
): SelectorIndexPlan {
  const basedOn = animator.selector.basedOn ?? 'characters';
  const indices: number[] = [];
  let group = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (let glyphIndex = 0; glyphIndex < line.length; glyphIndex++) {
      const glyph = line[glyphIndex]!;
      indices.push(basedOn === 'lines' ? lineIndex : group);
      if (basedOn === 'characters') group++;
      else if (basedOn === 'characters-excluding-spaces' && glyph !== ' ') group++;
      else if (basedOn === 'words' && (glyph === ' ' || glyphIndex === line.length - 1)) group++;
    }
  }
  const count = Math.max(1, basedOn === 'lines' ? lines.length : group);
  const seed = animator.selector.randomSeed;
  if (seed === undefined || count < 2) return { indices, count };
  const permutation = Array.from({ length: count }, (_, index) => index);
  let randomState = seed >>> 0;
  for (let index = permutation.length - 1; index > 0; index--) {
    randomState = deterministicRandom(randomState);
    const swap = randomState % (index + 1);
    [permutation[index], permutation[swap]] = [permutation[swap]!, permutation[index]!];
  }
  return { indices: indices.map(index => permutation[index] ?? index), count };
}

function deterministicRandom(state: number): number {
  let value = state || 0x6d2b79f5;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function sampled(track: Readonly<AnimationVectorValueTrack> | undefined, time: number, fallback: readonly number[]): readonly number[] {
  if (!track || track.times.length === 0) return fallback;
  let frame = 0;
  while (frame + 1 < track.times.length && track.times[frame + 1]! <= time) frame++;
  const next = Math.min(frame + 1, track.times.length - 1);
  let progress = 0;
  if (next !== frame && track.interpolation !== 'step') {
    progress = clamp((time - track.times[frame]!) / Math.max(1e-8, track.times[next]! - track.times[frame]!), 0, 1);
    if (track.interpolation === 'cubic-bezier' && track.easings) {
      const offset = frame * 4;
      progress = cubicBezierYForX(progress, track.easings[offset]!, track.easings[offset + 1]!, track.easings[offset + 2]!, track.easings[offset + 3]!);
    }
  }
  const result = new Array<number>(track.valueSize);
  for (let index = 0; index < track.valueSize; index++) {
    const from = track.values[frame * track.valueSize + index] ?? 0;
    result[index] = mix(from, track.values[next * track.valueSize + index] ?? from, progress);
  }
  return result;
}

function splitGraphemes(text: string): string[] {
  const result: string[] = [];
  for (const codePoint of Array.from(text)) {
    if (codePoint === '\u200D' && result.length > 0) {
      result[result.length - 1] += codePoint;
    } else if (result.length > 0 && (/\p{Mark}/u.test(codePoint) || codePoint === '\uFE0F' || result[result.length - 1]!.endsWith('\u200D'))) {
      result[result.length - 1] += codePoint;
    } else result.push(codePoint);
  }
  return result;
}

function hasAnimatedAnimator(animator: Readonly<AnimationTextAnimator>): boolean {
  return animator.positionTrack !== undefined || animator.scaleTrack !== undefined || animator.rotationTrack !== undefined
    || animator.opacityTrack !== undefined || animator.fillColorTrack !== undefined || animator.trackingTrack !== undefined
    || animator.selector.startTrack !== undefined || animator.selector.endTrack !== undefined
    || animator.selector.offsetTrack !== undefined || animator.selector.amountTrack !== undefined;
}

function cubicBezierYForX(x: number, x1: number, y1: number, x2: number, y2: number): number {
  let low = 0; let high = 1; let t = x;
  for (let iteration = 0; iteration < 10; iteration++) {
    const estimate = cubic(t, 0, x1, x2, 1);
    if (estimate < x) low = t; else high = t;
    t = (low + high) * 0.5;
  }
  return cubic(t, 0, y1, y2, 1);
}

function cubic(t: number, a: number, b: number, c: number, d: number): number {
  const inverse = 1 - t;
  return inverse ** 3 * a + 3 * inverse ** 2 * t * b + 3 * inverse * t ** 2 * c + t ** 3 * d;
}

function cssColor(color: readonly number[]): string {
  return `rgba(${Math.round(clamp(color[0] ?? 0, 0, 1) * 255)},${Math.round(clamp(color[1] ?? 0, 0, 1) * 255)},${Math.round(clamp(color[2] ?? 0, 0, 1) * 255)},${clamp(color[3] ?? 1, 0, 1)})`;
}

function quoteFont(value: string): string { return `"${value.replace(/["\\]/g, '')}"`; }
function closeTextTexture(texture: TextTexture | null, canvas: HTMLCanvasElement | null): void {
  if (texture && texture !== canvas && typeof (texture as ImageBitmap).close === 'function') (texture as ImageBitmap).close();
}
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
