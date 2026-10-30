import type {ResponsiveLayoutDocument, HyaCompositionValue} from '@haiyue/animation-spec/hya-production';
import type {HyaTextResult, HyaTextShaper} from '@haiyue/extensions/hya-text';
export interface HyaLayoutRequest {
  readonly viewport: readonly [number, number]; readonly dpr: number; readonly time: number;
  readonly strings?: Readonly<Record<string, string>>; readonly lists?: Readonly<Record<string, readonly HyaCompositionValue[]>>;
  readonly selections?: Readonly<Record<string, readonly [number, number]>>; readonly cursors?: Readonly<Record<string, number>>;
  readonly styles?: Readonly<Record<string, Partial<ResponsiveLayoutDocument['textStyles'][number]>>>;
  readonly scroll?: Readonly<Record<string, Readonly<{offset: readonly [number, number]; velocity?: readonly [number, number]; active?: boolean; settled?: boolean}>>>;
  readonly componentInputs?: Readonly<Record<string, Readonly<Record<string, HyaCompositionValue>>>>;
  readonly componentReplacements?: Readonly<Record<string, string>>;
  readonly componentEvents?: Readonly<Record<string, readonly Readonly<{name: string; payload?: HyaCompositionValue}>[]>>;
  readonly componentStateTimes?: Readonly<Record<string, number>>;
}
export interface HyaLayoutNode {
  readonly part: string; readonly instance: string; readonly artboard: string; readonly node: string;
  readonly kind: 'container' | 'leaf' | 'text' | 'image' | 'component' | 'list' | 'n-slice';
  /** Fitted coordinates to the shared viewport; glyphs and clips remain local. */
  readonly transform?: readonly [number, number, number, number, number, number];
  readonly rect: readonly [number, number, number, number]; readonly clip?: readonly [number, number, number, number]; readonly opacity: number;
  readonly clipShapes?: readonly Readonly<{rect: readonly [number, number, number, number]; radii: readonly [number, number, number, number]}>[];
  readonly text?: HyaTextResult; readonly source?: Readonly<{kind: 'asset' | 'node'; id: string}>;
  readonly background?: readonly [number, number, number, number]; readonly borderColor?: readonly [number, number, number, number];
  readonly borderWidth: readonly [number, number, number, number]; readonly cornerRadius: readonly [number, number, number, number];
  readonly nSlice?: readonly Readonly<{rect: readonly [number, number, number, number]; uv: readonly [number, number, number, number]; tile: 'stretch' | 'repeat' | 'mirror'}>[];
}
export interface HyaLayoutFrame {
  readonly revision: number; readonly viewport: readonly [number, number]; readonly dpr: number; readonly nodes: readonly HyaLayoutNode[];
  readonly instances: readonly Readonly<{part: string; id: string; artboard: string; parent?: string; host?: string; rect: readonly [number, number, number, number]; transform?: readonly [number, number, number, number, number, number]; times: readonly number[]; mixWeight: number; inputs: Readonly<Record<string, HyaCompositionValue>>; events: readonly Readonly<{name: string; payload?: HyaCompositionValue}>[]}>[];
}
export interface HyaLayout {evaluate(request: HyaLayoutRequest): HyaLayoutFrame; dispose(): void;}

import {parseResponsiveLayoutDocument} from '@haiyue/animation-spec/hya-production';
import {createProductionLayout} from './animation/layout/production/createProductionLayout.js';
export function createHyaLayout(document: ResponsiveLayoutDocument, options: Readonly<{text?: HyaTextShaper; signal?: AbortSignal}> = {}): HyaLayout {return createProductionLayout(parseResponsiveLayoutDocument(document), options);}
