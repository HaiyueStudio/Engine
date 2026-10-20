import { bitmapKerningKey, type BitmapFontChar, type BitmapFontData } from '../../font/BitmapFontData';
import { GUI_TEXTURED_VERTEX_LAYOUT } from './GuiVertexLayout';

const VERTICES_PER_GLYPH = 6;

export interface GuiTextCommand {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: [number, number, number, number];
  multiline?: boolean;
  verticalAlign?: 'top' | 'center';
  wrap?: boolean;
  lineHeight?: number;
  clip?: { x: number; y: number; width: number; height: number };
}

export class GuiTextBatch {
  readonly commands: GuiTextCommand[] = [];
  vertexData = new Float32Array(0);
  vertexCount = 0;
  version = 0;
  dirty = true;
  private scratch = new Float32Array(0);
  private retainedVertexCount = 0;

  clear(): void {
    this.commands.length = 0;
    this.vertexCount = 0;
    this.dirty = true;
  }

  addText(command: GuiTextCommand): void {
    if (!command.text || command.width <= 0 || command.height <= 0 || command.color[3] <= 0) return;
    this.commands.push(command);
    this.dirty = true;
  }

  rebuild(font: BitmapFontData): void {
    // Layout once, then reuse it for both the size calculation and packing.
    // Re-evaluate font metrics on rebuild: BitmapFontData is mutable.
    const layouts = this.commands.map(command => layoutText(command, font));
    const glyphCount = layouts.reduce((sum, layout) => sum + layout.glyphs.length, 0);
    const vertexCount = glyphCount * VERTICES_PER_GLYPH;
    const requiredFloats = vertexCount * GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
    if (this.scratch.length < requiredFloats) this.scratch = new Float32Array(nextCapacity(requiredFloats));
    let offset = 0;
    for (let i = 0; i < layouts.length; i++) {
      const layout = layouts[i]!, command = this.commands[i]!;
      for (const glyph of layout.glyphs) {
        offset = pushGlyph(this.scratch, offset, glyph.x0, glyph.y0, glyph.x1, glyph.y1,
          glyph.u0, glyph.v0, glyph.u1, glyph.v1, command.color,
          layout.clipX0, layout.clipY0, layout.clipX1, layout.clipY1);
      }
    }
    let changed = vertexCount !== this.retainedVertexCount;
    for (let i = 0; !changed && i < requiredFloats; i++) changed = this.vertexData[i] !== this.scratch[i];
    if (changed) {
      const previous = this.vertexData;
      this.vertexData = this.scratch;
      this.scratch = previous;
      this.version++;
    }
    this.retainedVertexCount = this.vertexCount = vertexCount;
    this.dirty = false;
  }
}

export function measureGuiTextWidth(text: string, font: BitmapFontData, fontSize: number): number {
  let maxWidth = 0;
  for (const line of text.split('\n')) {
    maxWidth = Math.max(maxWidth, measureGuiLineWidth(line, font, fontSize));
  }
  return maxWidth;
}

/** @internal Uses exactly the glyph advances, ink bounds, kerning and wrap of drawing. */
export function measureGuiTextBlock(text: string, font: BitmapFontData, fontSize: number, width: number, wrap: boolean): {width: number; height: number} {
  const result = layoutText({text, x: 0, y: 0, width, height: Infinity, fontSize, color: [1, 1, 1, 1], multiline: wrap, wrap, verticalAlign: 'top'}, font);
  return {width: result.advanceWidth, height: text ? result.blockHeight : 0};
}

function measureGuiLineWidth(text: string, font: BitmapFontData, fontSize: number): number {
  const scale = fontSize / font.size;
  let width = 0;
  let previousCode: number | null = null;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    const glyph = font.chars.get(code) ?? font.chars.get(63);
    if (!glyph) continue;
    if (previousCode !== null) width += (font.kernings.get(bitmapKerningKey(previousCode, code)) ?? 0) * scale;
    width += glyph.xadvance * scale;
    previousCode = code;
  }
  return width;
}

interface LaidOutGlyph {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

function layoutText(command: GuiTextCommand, font: BitmapFontData): {
  glyphs: LaidOutGlyph[];
  clipX0: number;
  clipY0: number;
  clipX1: number;
  clipY1: number;
  advanceWidth: number;
  blockHeight: number;
} {
  const scale = command.fontSize / font.size;
  const clip = command.clip ?? { x: command.x, y: command.y, width: command.width, height: command.height };
  const clipX0 = clip.x;
  const clipY0 = clip.y;
  const clipX1 = clip.x + clip.width;
  const clipY1 = clip.y + clip.height;
  const lineStep = (command.lineHeight ?? font.lineHeight) * scale;
  let x = command.x;
  const centerBlock = command.multiline && command.verticalAlign === 'center';
  let baselineY = command.y + (command.multiline || command.verticalAlign === 'top' ? 0 : (command.height - font.lineHeight * scale) * 0.5);
  let previousCode: number | null = null;
  const glyphs: LaidOutGlyph[] = [];
  let advanceWidth = 0;

  for (const char of command.text) {
    if (char === '\n') {
      if (!command.multiline) break;
      advanceWidth = Math.max(advanceWidth, x - command.x);
      x = command.x;
      baselineY += lineStep;
      previousCode = null;
      if (!centerBlock && baselineY > clipY1) break;
      continue;
    }
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    const glyph: BitmapFontChar | undefined = font.chars.get(code) ?? font.chars.get(63);
    if (!glyph) continue;

    if (previousCode !== null) {
      x += (font.kernings.get(bitmapKerningKey(previousCode, code)) ?? 0) * scale;
    }

    const x0 = x + glyph.xoffset * scale;
    const y0 = baselineY + glyph.yoffset * scale;
    const x1 = x0 + glyph.width * scale;
    const y1 = y0 + glyph.height * scale;
    if (command.wrap && x1 > clipX1 && x > command.x) {
      advanceWidth = Math.max(advanceWidth, x - command.x);
      x = command.x;
      baselineY += lineStep;
      previousCode = null;
      if (!centerBlock && baselineY > clipY1) break;
    }
    const nextX0 = x + glyph.xoffset * scale;
    const nextY0 = baselineY + glyph.yoffset * scale;
    const nextX1 = nextX0 + glyph.width * scale;
    const nextY1 = nextY0 + glyph.height * scale;
    const u0 = glyph.x / font.scaleW;
    const v0 = glyph.y / font.scaleH;
    const u1 = (glyph.x + glyph.width) / font.scaleW;
    const v1 = (glyph.y + glyph.height) / font.scaleH;

    if ((centerBlock || (nextY1 >= clipY0 && nextY0 <= clipY1)) && nextX1 >= clipX0 && nextX0 <= clipX1) {
      glyphs.push({ x0: nextX0, y0: nextY0, x1: nextX1, y1: nextY1, u0, v0, u1, v1 });
    }
    x += glyph.xadvance * scale;
    advanceWidth = Math.max(advanceWidth, x - command.x);
    previousCode = code;

    if (!command.wrap && x > clipX1) break;
  }
  if (centerBlock) {
    // Measure all wrapped lines before centering; overflowing text stays top-aligned.
    const blockHeight = baselineY - command.y + font.lineHeight * scale;
    const shift = Math.max(0, (command.height - blockHeight) * 0.5);
    for (const glyph of glyphs) { glyph.y0 += shift; glyph.y1 += shift; }
    return { glyphs: glyphs.filter(g => g.y1 >= clipY0 && g.y0 <= clipY1), clipX0, clipY0, clipX1, clipY1, advanceWidth, blockHeight };
  }
  return { glyphs, clipX0, clipY0, clipX1, clipY1, advanceWidth, blockHeight: baselineY - command.y + font.lineHeight * scale };
}

function pushGlyph(
  data: Float32Array,
  offset: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  color: [number, number, number, number],
  clipX0: number,
  clipY0: number,
  clipX1: number,
  clipY1: number,
): number {
  offset = writeGlyphVertex(data, offset, x0, y0, u0, v0, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x1, y0, u1, v0, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x0, y1, u0, v1, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x1, y0, u1, v0, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x1, y1, u1, v1, color, clipX0, clipY0, clipX1, clipY1);
  offset = writeGlyphVertex(data, offset, x0, y1, u0, v1, color, clipX0, clipY0, clipX1, clipY1);
  return offset;
}

function writeGlyphVertex(
  data: Float32Array,
  offset: number,
  x: number,
  y: number,
  u: number,
  v: number,
  color: [number, number, number, number],
  clipX0: number,
  clipY0: number,
  clipX1: number,
  clipY1: number,
): number {
  const base = offset;
  const fields = GUI_TEXTURED_VERTEX_LAYOUT.floatOffsets;
  data[base + fields.position] = x;
  data[base + fields.position + 1] = y;
  data[base + fields.uv] = u;
  data[base + fields.uv + 1] = v;
  data.set(color, base + fields.color);
  data[base + fields.clip] = clipX0;
  data[base + fields.clip + 1] = clipY0;
  data[base + fields.clip + 2] = clipX1;
  data[base + fields.clip + 3] = clipY1;
  return base + GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
}

function nextCapacity(required: number): number {
  let capacity = 1024;
  while (capacity < required) capacity *= 2;
  return capacity;
}

export const GUI_TEXT_FLOATS_PER_VERTEX = GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
export const GUI_TEXT_VERTICES_PER_GLYPH = VERTICES_PER_GLYPH;
