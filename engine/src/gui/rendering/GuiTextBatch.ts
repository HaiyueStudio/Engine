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
    let glyphCount = 0;
    for (const command of this.commands) {
      glyphCount += countGlyphs(command, font);
    }
    const vertexCount = glyphCount * VERTICES_PER_GLYPH;
    const requiredFloats = vertexCount * GUI_TEXTURED_VERTEX_LAYOUT.floatsPerVertex;
    if (this.vertexData.length < requiredFloats) {
      this.vertexData = new Float32Array(nextCapacity(requiredFloats));
    }
    let offset = 0;
    for (const command of this.commands) {
      offset = appendText(this.vertexData, offset, command, font);
    }
    this.vertexCount = vertexCount;
    this.version++;
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

function countGlyphs(command: GuiTextCommand, font: BitmapFontData): number {
  return layoutText(command, font).glyphs.length;
}

function appendText(data: Float32Array, offset: number, command: GuiTextCommand, font: BitmapFontData): number {
  const layout = layoutText(command, font);
  for (const glyph of layout.glyphs) {
    offset = pushGlyph(data, offset, glyph.x0, glyph.y0, glyph.x1, glyph.y1, glyph.u0, glyph.v0, glyph.u1, glyph.v1, command.color, layout.clipX0, layout.clipY0, layout.clipX1, layout.clipY1);
  }
  return offset;
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
} {
  const scale = command.fontSize / font.size;
  const clip = command.clip ?? { x: command.x, y: command.y, width: command.width, height: command.height };
  const clipX0 = clip.x;
  const clipY0 = clip.y;
  const clipX1 = clip.x + clip.width;
  const clipY1 = clip.y + clip.height;
  const lineStep = (command.lineHeight ?? font.lineHeight) * scale;
  let x = command.x;
  let baselineY = command.y + (command.multiline ? 0 : (command.height - font.lineHeight * scale) * 0.5);
  let previousCode: number | null = null;
  const glyphs: LaidOutGlyph[] = [];

  for (const char of command.text) {
    if (char === '\n') {
      if (!command.multiline) break;
      x = command.x;
      baselineY += lineStep;
      previousCode = null;
      if (baselineY > clipY1) break;
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
      x = command.x;
      baselineY += lineStep;
      previousCode = null;
      if (baselineY > clipY1) break;
    }
    const nextX0 = x + glyph.xoffset * scale;
    const nextY0 = baselineY + glyph.yoffset * scale;
    const nextX1 = nextX0 + glyph.width * scale;
    const nextY1 = nextY0 + glyph.height * scale;
    const u0 = glyph.x / font.scaleW;
    const v0 = glyph.y / font.scaleH;
    const u1 = (glyph.x + glyph.width) / font.scaleW;
    const v1 = (glyph.y + glyph.height) / font.scaleH;

    if (nextY1 >= clipY0 && nextY0 <= clipY1 && nextX1 >= clipX0 && nextX0 <= clipX1) {
      glyphs.push({ x0: nextX0, y0: nextY0, x1: nextX1, y1: nextY1, u0, v0, u1, v1 });
    }
    x += glyph.xadvance * scale;
    previousCode = code;

    if (!command.wrap && x > clipX1) break;
  }
  return { glyphs, clipX0, clipY0, clipX1, clipY1 };
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
