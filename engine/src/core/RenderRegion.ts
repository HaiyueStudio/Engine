import type {ScissorRect} from './ViewportRect';

/** Logical host pixels; named entry registration belongs to G13. */
export type RegionUpdateMode = 'demand' | 'once' | 'continuous' | 'disabled';
export interface RenderRegionOptions {
  readonly id: string;
  readonly bounds: Readonly<ScissorRect>;
  readonly updateMode: RegionUpdateMode;
  readonly clearMode: 'on-update' | 'once' | 'never-after-initialization';
  readonly visible: boolean;
}
export interface RenderRegion {
  readonly id: string;
  invalidate(reason: string): void;
  setBounds(rect: Readonly<ScissorRect>): void;
  setMode(mode: RegionUpdateMode): void;
  setVisible(visible: boolean): void;
  requestOnce(): void;
  dispose(): void;
}
