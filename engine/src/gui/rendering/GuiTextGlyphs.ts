import type {BitmapFontChar, BitmapFontData} from '../../font/BitmapFontData';
import {guiGraphemeBoundaries} from '../input/GuiGraphemes';

// Private GUI metadata: the public BMFont codepoint map and package API stay unchanged.
const atlases = new WeakMap<BitmapFontData, {glyphs: ReadonlyMap<string, BitmapFontChar>; colored: ReadonlySet<string>}>();
export function guiTextClusters(text: string): string[] {
  const boundaries = guiGraphemeBoundaries(text);
  return boundaries.slice(1).map((end, i) => text.slice(boundaries[i], end));
}
export function registerGuiTextGlyphs(font: BitmapFontData, glyphs: ReadonlyMap<string, BitmapFontChar>, atlas: HTMLCanvasElement): void {
  const colored = new Set<string>();
  const context = atlas.getContext('2d');
  const pixels = context?.getImageData?.(0, 0, atlas.width, atlas.height).data;
  if (pixels) for (const [text, glyph] of glyphs) {
    for (let y = glyph.y; y < glyph.y + glyph.height && !colored.has(text); y++) {
      for (let x = glyph.x; x < glyph.x + glyph.width; x++) {
        const i = (y * atlas.width + x) * 4;
        if (pixels[i + 3]! > 0 && (pixels[i] !== pixels[i + 1] || pixels[i + 1] !== pixels[i + 2])) {colored.add(text); break;}
      }
    }
  }
  atlases.set(font, {glyphs, colored});
}
export function guiFontCharacters(text: string, font: BitmapFontData): Iterable<string> {
  return atlases.has(font) ? guiTextClusters(text) : text.replaceAll('\r\n', '\n');
}
export function guiFontGlyph(text: string, font: BitmapFontData): BitmapFontChar | undefined {
  const atlas = atlases.get(font);
  return atlas ? atlas.glyphs.get(text) ?? atlas.glyphs.get('?') : font.chars.get(text.codePointAt(0)!) ?? font.chars.get(63);
}
export function guiFontGlyphIsColored(text: string, font: BitmapFontData): boolean {return atlases.get(font)?.colored.has(text) ?? false;}
