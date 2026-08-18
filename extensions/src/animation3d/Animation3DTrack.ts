import type {
  Animation3DBinding,
} from './Animation3DBinding';

export type Animation3DInterpolation =
  | 'step'
  | 'linear'
  | 'cubic-spline';

export interface Animation3DTrackFor<
  TBinding extends Animation3DBinding,
> {
  readonly id: string;
  readonly binding: TBinding;
  readonly interpolation: Animation3DInterpolation;
  /**
   * Strictly increasing key times in seconds.
   * The clip resource owns the underlying storage; consumers must not mutate it.
   */
  readonly times: Readonly<Float32Array>;
  /**
   * step/linear: keyCount * binding.valueSize values.
   * cubic-spline: keyCount groups of [inTangent, value, outTangent], with each
   * entry containing binding.valueSize values.
   */
  readonly values: Readonly<Float32Array>;
}

export type Animation3DTrack = Animation3DTrackFor<Animation3DBinding>;
