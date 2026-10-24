import type {LayoutConstraints} from '../../../layout/types.js';
import type {RuntimeLayoutDocument} from '../../layout/parameterized/runtime-types.js';
import type {RuntimeTextStyle} from '../parameterized/runtime-types.js';

export interface ProductionTextRequest {
  readonly editingViewport?:boolean;
  readonly block: string;
  readonly dpr?: number;
  /** Logical node origin for native bitmap raster phase; returned geometry remains block-local. */
  readonly rasterOrigin?: readonly [number, number];
  readonly strings?: Readonly<Record<string, string>>;
  readonly selections?: Readonly<Record<string, readonly [number, number]>>;
  readonly cursors?: Readonly<Record<string, number>>;
  readonly styles?: Readonly<Record<string, Partial<RuntimeTextStyle>>>;
  readonly constraints?: Readonly<Partial<LayoutConstraints>>;
}
export interface ProductionGlyph {
  readonly id: number; readonly clusterUtf16: number; readonly sequence: string;
  readonly rect: readonly [number, number, number, number]; readonly advance: number;
  readonly transform: readonly [number, number, number, number, number, number]; readonly opacity: number;
  readonly paint: Readonly<{kind: 'outline'; commands: string; values: readonly number[]}>
    | Readonly<{kind: 'bitmap'; source: Readonly<{value: unknown; generation: number; bytes: number}>; uv: readonly [number, number, number, number]}>;
}
export interface ProductionGlyphRun {readonly font: string; readonly style: RuntimeTextStyle; readonly glyphs: readonly ProductionGlyph[];}
export interface ProductionTextResult {
  readonly presentation?:Readonly<{composition:readonly (readonly[number,number,number,number])[]}>;
  readonly block: string; readonly size: readonly [number, number]; readonly contentSize: readonly [number, number];
  readonly runs: readonly ProductionGlyphRun[];
  readonly lines: readonly Readonly<{rect: readonly [number, number, number, number]; startUtf16: number; endUtf16: number}>[];
  /** Optional geometry supplied by the same prepared shaper; required for G06 editing, never inferred from glyph ink. */
  readonly editing?:Readonly<{text:string;carets:readonly Readonly<{offset:number;line:number;rect:readonly[number,number,number,number]}>[];cells:readonly Readonly<{start:number;end:number;line:number;rect:readonly[number,number,number,number]}>[]}>;
  readonly controls: readonly Readonly<{kind: 'selection' | 'cursor'; rect: readonly [number, number, number, number]; radius?: number}>[];
}
export interface ProductionFontPort {
  acquire(document: RuntimeLayoutDocument, signal: AbortSignal): Promise<Readonly<{
    shape(request: ProductionTextRequest): ProductionTextResult; release(): void;
  }>>;
}
