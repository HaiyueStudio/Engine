let _fontIdCounter = 0;

export interface BitmapFontChar {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
  xadvance: number;
  page: number;
}

export interface BitmapFontData {
  readonly id: number;
  face: string;
  size: number;
  bold: boolean;
  italic: boolean;
  lineHeight: number;
  base: number;
  scaleW: number;
  scaleH: number;
  /** URL strings for each page texture */
  pages: string[];
  /** Pre-loaded page images — if provided, the renderer uses these directly */
  pageImages?: (HTMLCanvasElement | ImageBitmap | HTMLImageElement)[];
  chars: Map<number, BitmapFontChar>;
  /** Key format: `first * 65536 + second` */
  kernings: Map<number, number>;
}

export function bitmapKerningKey(first: number, second: number): number {
  return first * 65536 + second;
}

export function createBitmapFontData(
  partial: Omit<BitmapFontData, 'id'>,
): BitmapFontData {
  return { id: ++_fontIdCounter, ...partial };
}
