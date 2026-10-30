import type {AnimationOutlineFont} from '../../AnimationTextRasterizer.js';
import type {RuntimeTextStyle} from '../parameterized/runtime-types.js';

const nativeSequences = new WeakMap<object, () => string | undefined>();
export function rememberNativeGlyphPaint<T extends object>(glyph: T, resolve: () => string | undefined): T {
  nativeSequences.set(glyph, resolve);
  return glyph;
}
export function nativeGlyphPaintSequence(glyph: object): string | undefined { return nativeSequences.get(glyph)?.(); }

/** Prepared-font identity only; default outline consumers never execute this native recognition work. */
export function createNativeGlyphPaintResolver(font: AnimationOutlineFont, id: number, style: RuntimeTextStyle,
  preferred: string, selected: ReturnType<AnimationOutlineFont['getPath']>): () => string | undefined {
  let resolved = false, sequence: string | undefined;
  return () => {
    if (resolved) return sequence;
    resolved = true;
    const glyph = font.glyphs!.get(id) as ReturnType<NonNullable<AnimationOutlineFont['glyphs']>['get']> & Readonly<{unicode?: number; unicodes?: readonly number[]}>;
    const candidates = new Set([preferred.normalize('NFC')]);
    for (const code of glyph.unicodes?.slice(0, 16) ?? (glyph.unicode === undefined ? [] : [glyph.unicode]))
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) candidates.add(String.fromCodePoint(code));
    for (const text of candidates) {
      // Bound recognition cost, not rendering capability: long/unaddressable compiled sequences use their validated outline.
      if (text.length > 64) continue;
      let path: ReturnType<AnimationOutlineFont['getPath']>;
      try {path = font.getPath(text, 0, 0, style.fontSize, {kerning: false, features: {liga: style.features?.liga !== false, rlig: style.features?.rlig !== false}});}
      catch {continue;} // Recognition may lack a source shaping feature; the already validated compiled outline remains renderable.
      if (path.commands.length === selected.commands.length && path.commands.every((command, index) => {
        const other = selected.commands[index]!;
        return command.type === other.type && command.x === other.x && command.y === other.y && command.x1 === other.x1 && command.y1 === other.y1 && command.x2 === other.x2 && command.y2 === other.y2;
      })) {sequence = text; break;}
    }
    return sequence;
  };
}
