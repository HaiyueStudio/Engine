import { createBitmapFontData, type BitmapFontChar, type BitmapFontData } from './BitmapFontData';

const PRINTABLE_ASCII =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' +
  'abcdefghijklmnopqrstuvwxyz{|}~';

export interface BuildSdfFontOptions {
  /** Characters to include (default: printable ASCII 32-126). */
  chars?: string;
  /** Source raster size in CSS pixels (default: 48). */
  fontSize?: number;
  /** CSS font-family string (default: sans-serif). */
  fontFamily?: string;
  /** Empty pixels around each glyph. Must be larger than spread (default: 10). */
  padding?: number;
  /** Signed-distance range in atlas pixels (default: 8). */
  spread?: number;
  /** Power-of-two atlas dimension (default: 1024). */
  atlasSize?: number;
  /** Font weight (default: normal). */
  fontWeight?: string;
}

export interface BuiltSdfFont {
  data: BitmapFontData;
  /** RGBA atlas with the signed distance replicated to RGB. */
  atlas: HTMLCanvasElement;
  /** Distance range encoded on either side of the 0.5 contour. */
  spread: number;
}

interface GlyphInfo {
  char: string;
  code: number;
  width: number;
  xadvance: number;
  whitespace: boolean;
}

const SQRT_TWO = Math.SQRT2;
const LARGE_DISTANCE = 1e9;

/**
 * Builds a real signed-distance bitmap font at runtime. The source glyphs are
 * rasterized once with Canvas2D, then converted to a distance field; rendering
 * itself is handled entirely by WebGPU's BitmapText SDF shader.
 */
export function buildSdfBitmapFont(options: BuildSdfFontOptions = {}): BuiltSdfFont {
  const {
    chars = PRINTABLE_ASCII,
    fontSize = 48,
    fontFamily = 'sans-serif',
    padding = 10,
    spread = 8,
    atlasSize = 1024,
    fontWeight = 'normal',
  } = options;
  if (!Number.isInteger(atlasSize) || atlasSize <= 0) throw new Error('SDF font atlasSize must be a positive integer.');
  if (!Number.isFinite(spread) || spread <= 0) throw new Error('SDF font spread must be greater than zero.');
  if (!Number.isFinite(padding) || padding < spread + 1) {
    throw new Error(`SDF font padding (${padding}) must be at least spread + 1 (${spread + 1}).`);
  }

  const uniqueChars = [...new Set(chars)];
  const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const probe = document.createElement('canvas');
  const probeContext = probe.getContext('2d');
  if (!probeContext) throw new Error('Canvas2D is required to rasterize an SDF font atlas.');
  probeContext.font = font;

  const glyphs: GlyphInfo[] = [];
  let maxAscent = 0;
  let maxDescent = 0;
  for (const char of uniqueChars) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    const metrics = probeContext.measureText(char);
    maxAscent = Math.max(maxAscent, Math.ceil(metrics.actualBoundingBoxAscent));
    maxDescent = Math.max(maxDescent, Math.ceil(metrics.actualBoundingBoxDescent));
    const xadvance = Math.max(1, Math.ceil(metrics.width));
    glyphs.push({
      char,
      code,
      width: xadvance + padding * 2,
      xadvance,
      whitespace: /^\s$/u.test(char),
    });
  }

  const contentHeight = Math.max(1, maxAscent + maxDescent);
  const cellHeight = contentHeight + padding * 2;
  const baseline = padding + maxAscent;
  const source = document.createElement('canvas');
  source.width = atlasSize;
  source.height = atlasSize;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Canvas2D is required to rasterize an SDF font atlas.');
  sourceContext.clearRect(0, 0, atlasSize, atlasSize);
  sourceContext.font = font;
  sourceContext.fillStyle = '#fff';
  sourceContext.textBaseline = 'alphabetic';

  const charMap = new Map<number, BitmapFontChar>();
  let cursorX = 0;
  let cursorY = 0;
  for (const glyph of glyphs) {
    if (glyph.whitespace) {
      charMap.set(glyph.code, {
        id: glyph.code,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        xoffset: 0,
        yoffset: 0,
        xadvance: glyph.xadvance,
        page: 0,
      });
      continue;
    }
    if (cursorX + glyph.width > atlasSize) {
      cursorX = 0;
      cursorY += cellHeight;
    }
    if (cursorY + cellHeight > atlasSize) {
      throw new Error(`SDF font atlas ${atlasSize}x${atlasSize} is too small for ${glyphs.length} glyphs.`);
    }
    sourceContext.fillText(glyph.char, cursorX + padding, cursorY + baseline);
    charMap.set(glyph.code, {
      id: glyph.code,
      x: cursorX,
      y: cursorY,
      width: glyph.width,
      height: cellHeight,
      xoffset: -padding,
      yoffset: -padding,
      xadvance: glyph.xadvance,
      page: 0,
    });
    cursorX += glyph.width;
  }

  const pixels = sourceContext.getImageData(0, 0, atlasSize, atlasSize);
  const count = atlasSize * atlasSize;
  const inside = new Uint8Array(count);
  for (let index = 0; index < count; index++) inside[index] = pixels.data[index * 4 + 3]! >= 128 ? 1 : 0;
  const toInside = distanceTransform(inside, atlasSize, atlasSize, 1);
  const toOutside = distanceTransform(inside, atlasSize, atlasSize, 0);

  const atlas = document.createElement('canvas');
  atlas.width = atlasSize;
  atlas.height = atlasSize;
  const atlasContext = atlas.getContext('2d');
  if (!atlasContext) throw new Error('Canvas2D is required to create an SDF font atlas.');
  const output = atlasContext.createImageData(atlasSize, atlasSize);
  for (let index = 0; index < count; index++) {
    const signedDistance = toOutside[index]! - toInside[index]!;
    const value = Math.max(0, Math.min(255, Math.round((0.5 + signedDistance / (spread * 2)) * 255)));
    const offset = index * 4;
    output.data[offset] = value;
    output.data[offset + 1] = value;
    output.data[offset + 2] = value;
    output.data[offset + 3] = 255;
  }
  atlasContext.putImageData(output, 0, 0);

  return {
    data: createBitmapFontData({
      face: fontFamily,
      size: fontSize,
      bold: fontWeight === 'bold',
      italic: false,
      lineHeight: contentHeight,
      base: maxAscent,
      scaleW: atlasSize,
      scaleH: atlasSize,
      pages: [''],
      pageImages: [atlas],
      chars: charMap,
      kernings: new Map(),
    }),
    atlas,
    spread,
  };
}

function distanceTransform(
  mask: Uint8Array,
  width: number,
  height: number,
  target: 0 | 1,
): Float32Array {
  const distance = new Float32Array(mask.length);
  for (let index = 0; index < mask.length; index++) {
    distance[index] = mask[index] === target ? 0 : LARGE_DISTANCE;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      let value = distance[index]!;
      if (x > 0) value = Math.min(value, distance[index - 1]! + 1);
      if (y > 0) value = Math.min(value, distance[index - width]! + 1);
      if (x > 0 && y > 0) value = Math.min(value, distance[index - width - 1]! + SQRT_TWO);
      if (x + 1 < width && y > 0) value = Math.min(value, distance[index - width + 1]! + SQRT_TWO);
      distance[index] = value;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      let value = distance[index]!;
      if (x + 1 < width) value = Math.min(value, distance[index + 1]! + 1);
      if (y + 1 < height) value = Math.min(value, distance[index + width]! + 1);
      if (x + 1 < width && y + 1 < height) value = Math.min(value, distance[index + width + 1]! + SQRT_TWO);
      if (x > 0 && y + 1 < height) value = Math.min(value, distance[index + width - 1]! + SQRT_TWO);
      distance[index] = value;
    }
  }
  return distance;
}
