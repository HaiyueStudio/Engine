import { BitmapFontChar, BitmapFontData, createBitmapFontData } from './BitmapFontData';

const PRINTABLE_ASCII =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' +
  'abcdefghijklmnopqrstuvwxyz{|}~';

export interface BuildFontOptions {
  /** Characters to include (default: printable ASCII 32-126) */
  chars?: string;
  /** Font size in CSS pixels (default: 32) */
  fontSize?: number;
  /** CSS font-family string (default: 'sans-serif') */
  fontFamily?: string;
  /** Padding around each glyph cell in pixels (default: 4) */
  padding?: number;
  /** Power-of-two atlas dimension (default: 512) */
  atlasSize?: number;
  /** Font weight (default: 'normal') */
  fontWeight?: string;
}

export interface BuiltFont {
  data: BitmapFontData;
  /** Canvas containing the rendered glyph atlas (rgba8, text in white on transparent) */
  atlas: HTMLCanvasElement;
}

/**
 * Generate a bitmap font atlas from a system font using the Canvas 2D API.
 * The result can be used directly with BitmapText in 'normal' rendering mode.
 * For SDF/MSDF quality, use an external tool (e.g. msdf-bmfont-xml) instead.
 */
export function buildBitmapFont(options: BuildFontOptions = {}): BuiltFont {
  const {
    chars = PRINTABLE_ASCII,
    fontSize = 32,
    fontFamily = 'sans-serif',
    padding = 4,
    atlasSize = 512,
    fontWeight = 'normal',
  } = options;

  const fontStr = `${fontWeight} ${fontSize}px ${fontFamily}`;

  // ── Measure phase ──────────────────────────────────────────────────────────
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const pctx = probe.getContext('2d')!;
  pctx.font = fontStr;

  interface GlyphInfo {
    char: string;
    code: number;
    cellW: number;
    ascent: number;
    descent: number;
    xadvance: number;
  }
  const glyphs: GlyphInfo[] = [];
  let maxAscent = 0;
  let maxDescent = 0;

  for (const ch of chars) {
    if (!ch.codePointAt(0)) continue;
    const m = pctx.measureText(ch);
    const ascent  = Math.ceil(m.actualBoundingBoxAscent)  + 1;
    const descent = Math.ceil(m.actualBoundingBoxDescent) + 1;
    const advance = Math.ceil(m.width) + 1;
    maxAscent  = Math.max(maxAscent,  ascent);
    maxDescent = Math.max(maxDescent, descent);
    glyphs.push({ char: ch, code: ch.codePointAt(0)!, cellW: advance, ascent, descent, xadvance: advance });
  }

  const lineHeight = maxAscent + maxDescent + padding * 2;
  const base = maxAscent + padding;

  // ── Pack into atlas ────────────────────────────────────────────────────────
  const atlas = document.createElement('canvas');
  atlas.width  = atlasSize;
  atlas.height = atlasSize;
  const ctx = atlas.getContext('2d')!;
  ctx.clearRect(0, 0, atlasSize, atlasSize);
  ctx.font = fontStr;
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'alphabetic';

  const charMap = new Map<number, BitmapFontChar>();
  let curX = padding;
  let curY = padding;

  for (const g of glyphs) {
    if (curX + g.cellW + padding > atlasSize) {
      curX = padding;
      curY += lineHeight;
    }
    if (curY + lineHeight > atlasSize) {
      console.warn('BitmapFontBuilder: atlas too small — increase atlasSize');
      break;
    }

    // Draw at the alphabetic baseline
    ctx.fillText(g.char, curX, curY + base);

    charMap.set(g.code, {
      id:       g.code,
      x:        curX,
      y:        curY,
      width:    g.cellW,
      height:   lineHeight,
      xoffset:  0,
      yoffset:  0,
      xadvance: g.xadvance,
      page:     0,
    });

    curX += g.cellW + padding;
  }

  const data = createBitmapFontData({
    face:       fontFamily,
    size:       fontSize,
    bold:       fontWeight === 'bold',
    italic:     false,
    lineHeight,
    base,
    scaleW:     atlasSize,
    scaleH:     atlasSize,
    pages:      [''],
    pageImages: [atlas],
    chars:      charMap,
    kernings:   new Map(),
  });

  return { data, atlas };
}
