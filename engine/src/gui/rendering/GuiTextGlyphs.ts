import type {BitmapFontChar, BitmapFontData} from '../../font/BitmapFontData';
import {guiGraphemeBoundaries} from '../input/GuiGraphemes';

// Private GUI metadata: the public BMFont codepoint map and package API stay unchanged.
const atlases = new WeakMap<BitmapFontData, {glyphs: ReadonlyMap<string, BitmapFontChar>; colored: ReadonlySet<string>}>();
export function guiTextClusters(text: string): string[] {
  // ASCII has only the CR/LF grapheme join. Keep Unicode 15.1 for all other text.
  if(/^[\x00-\x7f]*$/.test(text))return text.match(/\r\n|[\s\S]/g)??[];
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

/** Exact mutable layout inputs, captured once per batch rather than per command. */
export function guiFontLayoutState(font:BitmapFontData,textWork:number):readonly unknown[]|undefined {
  const atlas=atlases.get(font),state:unknown[]=[font,atlas];
  const values=(object:object,keys:readonly string[]):boolean=>{for(const key of keys){const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!('value' in d))return false;state.push(d.value);}return true;};
  if(!values(font,['size','lineHeight','scaleW','scaleH','chars','kernings']))return;
  const ordinary=(map:ReadonlyMap<unknown,unknown>):boolean=>map instanceof Map&&map.get===Map.prototype.get&&map[Symbol.iterator]===Map.prototype[Symbol.iterator];
  if(!ordinary(font.chars)||!ordinary(font.kernings)||atlas&&!ordinary(atlas.glyphs))return;
  // A huge external font must not cost more to inspect than laying out this batch.
  // Falling back keeps live metrics and partial vertex packing; this is no font limit.
  if(font.chars.size+font.kernings.size+(atlas?.glyphs.size??0)>textWork+32)return;
  const glyphs=(map:ReadonlyMap<number|string,BitmapFontChar>):boolean=>{state.push(map.size);for(const [key,g]of map){state.push(key);if(!values(g,['id','x','y','width','height','xoffset','yoffset','xadvance','page']))return false;}return true;};
  if(!glyphs(font.chars)||atlas&&!glyphs(atlas.glyphs))return;
  state.push(font.kernings.size);for(const [key,value]of font.kernings)state.push(key,value);
  return state;
}
