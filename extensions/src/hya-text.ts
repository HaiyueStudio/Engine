import type {ResponsiveLayoutDocument} from '@haiyue/animation-spec/hya-production';
export interface HyaTextRequest {
  /** Keep complete shaped content available for the original G06 editing viewport. */
  readonly editingViewport?: boolean;
  readonly block: string; readonly dpr?: number; readonly strings?: Readonly<Record<string, string>>;
  readonly rasterOrigin?: readonly [number, number];
  readonly selections?: Readonly<Record<string, readonly [number, number]>>;
  readonly cursors?: Readonly<Record<string, number>>;
  readonly styles?: Readonly<Record<string, Partial<ResponsiveLayoutDocument['textStyles'][number]>>>;
  readonly constraints?: Readonly<Partial<{width: Readonly<{mode: 'exact' | 'at-most' | 'unbounded'; value?: number}>; height: Readonly<{mode: 'exact' | 'at-most' | 'unbounded'; value?: number}>}>>;
}
export interface HyaGlyph {
  readonly id: number; readonly clusterUtf16: number; readonly sequence: string;
  readonly rect: readonly [number, number, number, number]; readonly advance: number;
  readonly transform: readonly [number, number, number, number, number, number]; readonly opacity: number;
  readonly paint: Readonly<{kind: 'outline'; commands: string; values: readonly number[]}> | Readonly<{kind: 'bitmap'; source: Readonly<{value: unknown; generation: number; bytes: number}>; uv: readonly [number, number, number, number]}>;
}
export interface HyaGlyphRun {readonly font: string; readonly style: ResponsiveLayoutDocument['textStyles'][number]; readonly glyphs: readonly HyaGlyph[];}
export interface HyaTextResult {
  readonly block: string; readonly size: readonly [number, number]; readonly contentSize: readonly [number, number];
  readonly runs: readonly HyaGlyphRun[];
  readonly lines: readonly Readonly<{rect: readonly [number, number, number, number]; startUtf16: number; endUtf16: number}>[];
  /** Logical UTF-16 caret/cell geometry from the same prepared shaper; required by G06 editing.
   * Rectangles are block-local logical pixels, independent of raster DPR. */
  readonly editing?: Readonly<{
    text: string;
    carets: readonly Readonly<{offset: number; line: number; rect: readonly [number, number, number, number]}>[];
    cells: readonly Readonly<{start: number; end: number; line: number; rect: readonly [number, number, number, number]}>[];
  }>;
  readonly controls: readonly Readonly<{kind: 'selection' | 'cursor'; rect: readonly [number, number, number, number]; radius?: number}>[];
}
export interface HyaFontPort {
  acquire(document: ResponsiveLayoutDocument, signal: AbortSignal): Promise<Readonly<{shape(request: HyaTextRequest): HyaTextResult; release(): void}>>;
}
export interface HyaTextShaper {shape(request: HyaTextRequest): HyaTextResult; dispose(): void;}

import {parseResponsiveLayoutDocument} from '@haiyue/animation-spec/hya-production';
import {createProductionTextShaper} from './animation/text/production/createProductionTextShaper.js';
export async function createHyaTextShaper(document: ResponsiveLayoutDocument, fonts: HyaFontPort, options: Readonly<{signal?: AbortSignal}> = {}): Promise<HyaTextShaper> {return createProductionTextShaper(parseResponsiveLayoutDocument(document), fonts, options);}
