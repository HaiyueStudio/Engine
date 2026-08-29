import type {
  AnimationText2DComponent,
  AnimationTextAnimator,
  AnimationTextDocumentKeyframe,
  AnimationVectorValueTrack,
} from '@haiyue/animation-spec';
import { evaluateSafeExpression } from '@haiyue/animation-spec';

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

  constructor(readonly component: Readonly<AnimationText2DComponent>) {
    this.canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    this.animated = component.expression !== undefined || (component.documents?.length ?? 0) > 1
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
    const dpr = Math.max(1, Math.min(4, component.resolutionScale ?? 2));
    const width = Math.max(1, Math.ceil(component.size[0]));
    const height = Math.max(1, Math.ceil(component.size[1]));
    canvas.width = Math.max(1, Math.ceil(width * dpr));
    canvas.height = Math.max(1, Math.ceil(height * dpr));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const background = component.backgroundColor;
    if (background && background[3] > 0) {
      context.fillStyle = cssColor(background);
      context.fillRect(0, 0, width, height);
    }
    const padding = Math.max(0, component.padding ?? 0);
    const contentWidth = Math.max(1, width - padding * 2);
    const contentHeight = Math.max(1, height - padding * 2);
    let fontSize = document.fontSize;
    let lineHeight = document.lineHeight;
    let tracking = document.tracking;
    context.font = `${document.fontStyle} ${document.fontWeight} ${fontSize}px ${quoteFont(document.fontFamily)}`;
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    let lines = layoutTextLines(context, document.text, contentWidth, component.wrap ?? 'none', tracking);
    if (component.fit === 'shrink' && lines.length > 0) {
      const measuredWidth = Math.max(...lines.map(line => measuredLineWidth(context, line, tracking)), 1);
      const measuredHeight = Math.max(1, lines.length * lineHeight);
      const scale = Math.min(1, contentWidth / measuredWidth, contentHeight / measuredHeight);
      fontSize *= scale;
      lineHeight *= scale;
      tracking *= scale;
      context.font = `${document.fontStyle} ${document.fontWeight} ${fontSize}px ${quoteFont(document.fontFamily)}`;
      lines = layoutTextLines(context, document.text, contentWidth, component.wrap ?? 'none', tracking);
    }
    const animators = component.animators ?? [];
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
        drawLineBackground(context, component.lineBackground, x, baseline - fontSize, baseWidth, lineHeight);
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
  }
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

function drawLineBackground(
  context: CanvasRenderingContext2D,
  background: NonNullable<Readonly<AnimationText2DComponent>['lineBackground']>,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const padding = Math.max(0, background.padding ?? 0);
  const strokeWidth = Math.max(0, background.strokeWidth ?? 0);
  const left = x - padding;
  const top = y - padding;
  const decoratedWidth = Math.max(0, width + padding * 2);
  const decoratedHeight = Math.max(0, height + padding * 2);
  const radius = Math.min(Math.max(0, background.cornerRadius ?? 0), decoratedWidth / 2, decoratedHeight / 2);
  context.save();
  roundedRect(context, left, top, decoratedWidth, decoratedHeight, radius);
  context.fillStyle = cssColor(background.fill);
  context.fill();
  if (background.stroke && strokeWidth > 0) {
    context.strokeStyle = cssColor(background.stroke);
    context.lineWidth = strokeWidth;
    context.stroke();
  }
  context.restore();
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
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
