import type { Animation3DTrack } from './Animation3DTrack';

export interface Animation3DEvent {
  readonly id: string;
  readonly time: number;
  readonly name: string;
  /** Loader-validated, structured-cloneable event data. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Immutable, source-format-independent CPU animation resource.
 * Times are seconds; rotations are normalized XYZW quaternions.
 */
export interface Animation3DClip {
  readonly format: 'haiyue-animation3d-clip@1';
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly Animation3DTrack[];
  readonly events: readonly Animation3DEvent[];
}
