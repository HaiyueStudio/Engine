import type { AnimationOutlineFont } from './AnimationTextRasterizer.js';

let parserLoad: Promise<typeof import('opentype.js')> | undefined;
const parsedFonts = new WeakMap<ArrayBuffer, AnimationOutlineFont | undefined>();

/** Private font preparation step; importing an animation never loads the parser. */
export async function loadAnimationOutlineFont(data: ArrayBuffer): Promise<AnimationOutlineFont | undefined> {
  if (parsedFonts.has(data)) return parsedFonts.get(data);
  const parser = await (parserLoad ??= import('opentype.js').catch(error => {
    // Let a later resource request retry; never hide chunk/network failures as
    // an unsupported font container or repeatedly retry a failed resource.
    parserLoad = undefined;
    throw error;
  }));
  // Concurrent font descriptors may share the same asset buffer.
  if (parsedFonts.has(data)) return parsedFonts.get(data);
  let font: AnimationOutlineFont | undefined;
  try {
    font = parser.parse(data);
  } catch {
    // FontFace has already accepted the font. Preserve Canvas shaping for
    // containers unsupported by opentype.js (including WOFF2).
  }
  parsedFonts.set(data, font);
  return font;
}
