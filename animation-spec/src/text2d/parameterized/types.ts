export const TEXT_SHAPING_STACK = 'haiyue-text-shaping@1' as const;

export type TextDirection = 'auto' | 'ltr' | 'rtl';
export type TextAlignment = 'start' | 'center' | 'end' | 'justify';
export type TextVerticalAlignment = 'top' | 'middle' | 'bottom' | 'baseline';
export type TextColor = readonly [number, number, number, number];

export type TextPaintSource =
  | { readonly kind: 'solid'; readonly color: TextColor }
  | { readonly kind: 'linear-gradient'; readonly start: readonly [number, number]; readonly end: readonly [number, number]; readonly stops: readonly { readonly offset: number; readonly color: TextColor }[] }
  | { readonly kind: 'radial-gradient'; readonly center: readonly [number, number]; readonly radius: number; readonly stops: readonly { readonly offset: number; readonly color: TextColor }[] };

export interface TextFill { readonly source: TextPaintSource; readonly opacity?: number; }
export interface TextStroke { readonly source: TextPaintSource; readonly width: number; readonly opacity?: number; readonly join?: 'miter' | 'round' | 'bevel'; }

export interface TextStyleDefinition {
  readonly id: string;
  readonly fontAssets: readonly string[];
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic';
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly tracking: number;
  readonly alignment: TextAlignment;
  readonly verticalAlignment?: TextVerticalAlignment;
  readonly direction?: TextDirection;
  readonly language?: string;
  readonly script?: string;
  readonly axes?: Readonly<Record<string, number>>;
  readonly features?: Readonly<Record<string, boolean | number>>;
  readonly fills: readonly TextFill[];
  readonly strokes?: readonly TextStroke[];
  readonly background?: { readonly color: TextColor; readonly cornerRadius?: number };
}

export interface TextRunDefinition { readonly id: string; readonly style: string; readonly text: string; readonly valuePort?: string; }

export interface TextModifierRange {
  readonly start: number;
  readonly end: number;
  readonly units: 'grapheme' | 'word' | 'line' | 'percent';
  readonly falloffFrom?: number;
  readonly falloffTo?: number;
  readonly increment?: number;
  readonly offset?: number;
  readonly mode?: 'clamp' | 'repeat' | 'mirror';
  readonly strength?: number;
}

export interface TextTransformModifier {
  readonly kind: 'transform';
  readonly range: TextModifierRange;
  readonly translation?: readonly [number, number];
  readonly scale?: readonly [number, number];
  readonly rotation?: number;
  readonly origin?: readonly [number, number];
  readonly opacity?: number;
  readonly variables?: Readonly<Record<string, number>>;
}

export interface TextFollowPathModifier {
  readonly kind: 'follow-path';
  readonly range: TextModifierRange;
  readonly points: readonly number[];
  readonly radial?: boolean;
  readonly orient?: boolean;
  readonly start?: number;
  readonly end?: number;
  readonly offset?: number;
}

export type TextModifier = TextTransformModifier | TextFollowPathModifier;

export interface TextBlockDefinition {
  readonly id: string;
  readonly runs: readonly TextRunDefinition[];
  readonly width: number;
  readonly height: number;
  readonly wrap?: 'none' | 'word' | 'grapheme';
  readonly overflow?: 'visible' | 'clip' | 'ellipsis';
  readonly paragraphSpacing?: number;
  readonly origin?: readonly [number, number];
  readonly verticalTrim?: { readonly top: number; readonly bottom: number };
  readonly modifiers?: readonly TextModifier[];
  readonly input?: { readonly valuePort: string; readonly selectionPort?: string; readonly cursorPort?: string; readonly multiline?: boolean; readonly selectionRadius?: number };
}

export interface TextShapingContract {
  readonly stack: typeof TEXT_SHAPING_STACK;
  readonly backendRevision: string;
  readonly unicodeVersion: string;
  readonly graphemeRevision: string;
  readonly bidiRevision: string;
}

export interface CompiledGlyphMetric { readonly glyphId: number; readonly advance: number; readonly bounds: readonly [number, number, number, number]; readonly axisAdvance?: Readonly<Record<string, number>>; }
export interface CompiledFontMetrics {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly missingGlyph: CompiledGlyphMetric;
  readonly glyphs: Readonly<Record<string, CompiledGlyphMetric>>;
  readonly ligatures?: Readonly<Record<string, CompiledGlyphMetric>>;
  readonly kerning?: Readonly<Record<string, number>>;
  readonly axes?: Readonly<Record<string, { readonly min: number; readonly default: number; readonly max: number }>>;
}
