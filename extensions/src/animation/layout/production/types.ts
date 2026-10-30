import type {LayoutEvaluateRequest, LayoutNodePose} from '../parameterized/runtime-types.js';
import type {ProductionTextResult} from '../../text/production/types.js';
import type {LayoutAffine} from './ProductionLayoutGeometry.js';

export type ProductionLayoutValue = null | boolean | number | string | readonly ProductionLayoutValue[] | {readonly [key: string]: ProductionLayoutValue};
export interface ProductionLayoutRequest extends Omit<LayoutEvaluateRequest, 'constraints' | 'signal' | 'lists' | 'componentInputs' | 'componentEvents'> {
  readonly lists?: Readonly<Record<string, readonly ProductionLayoutValue[]>>;
  readonly componentInputs?: Readonly<Record<string, Readonly<Record<string, ProductionLayoutValue>>>>;
  readonly componentEvents?: Readonly<Record<string, readonly Readonly<{name: string; payload?: ProductionLayoutValue}>[]>>;
}
export interface ProductionLayoutNode {
  readonly part: string; readonly instance: string; readonly artboard: string; readonly node: string;
  readonly kind: LayoutNodePose['kind']; readonly rect: readonly [number, number, number, number];
  /** Fitted layout coordinates to the shared viewport. Boxes, glyphs and clips remain in the solver's coordinates. */
  readonly transform?: LayoutAffine;
  readonly clip?: readonly [number, number, number, number]; readonly opacity: number;
  /** Ordered logical clip shapes; the old clip remains their axis-aligned intersection. */
  readonly clipShapes?: readonly Readonly<{rect: readonly [number, number, number, number]; radii: readonly [number, number, number, number]}>[];
  /** Glyphs, lines and editing controls remain local to this node's rectangle. */
  readonly text?: ProductionTextResult;
  readonly source?: Readonly<{kind: 'asset' | 'node'; id: string}>;
  readonly background?: NonNullable<LayoutNodePose['background']>; readonly borderColor?: NonNullable<LayoutNodePose['borderColor']>;
  readonly borderWidth: LayoutNodePose['borderWidth']; readonly cornerRadius: LayoutNodePose['cornerRadius'];
  readonly nSlice?: readonly Readonly<{rect: readonly [number, number, number, number]; uv: readonly [number, number, number, number]; tile: 'stretch' | 'repeat' | 'mirror'}>[];
}
export interface ProductionLayoutInstance {
  readonly part: string; readonly id: string; readonly artboard: string; readonly parent?: string; readonly host?: string;
  readonly rect: readonly [number, number, number, number]; readonly times: readonly number[]; readonly mixWeight: number;
  readonly transform?: LayoutAffine;
  readonly inputs: Readonly<Record<string, ProductionLayoutValue>>;
  readonly events: readonly Readonly<{name: string; payload?: ProductionLayoutValue}>[];
}
export interface ProductionLayoutFrame {
  readonly revision: number; readonly viewport: readonly [number, number]; readonly dpr: number;
  readonly nodes: readonly ProductionLayoutNode[]; readonly instances: readonly ProductionLayoutInstance[];
}
