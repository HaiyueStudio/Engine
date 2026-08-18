import type {
  Animation3DBindingMask,
} from './Animation3DBinding';
import type { Animation3DClip } from './Animation3DClip';

export type Animation3DLoopMode =
  | 'once'
  | 'repeat'
  | 'ping-pong';

export type Animation3DBlendMode =
  | 'override'
  | 'additive';

export type Animation3DActionStatus =
  | 'idle'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'finished'
  | 'stopped';

export interface Animation3DActionOptions {
  readonly id?: string;
  readonly loop?: Animation3DLoopMode;
  /** Infinity is valid for repeat and ping-pong. */
  readonly repetitions?: number;
  readonly clampWhenFinished?: boolean;
  readonly timeScale?: number;
  readonly weight?: number;
  readonly blendMode?: Animation3DBlendMode;
  readonly mask?: Animation3DBindingMask;
}

/**
 * One mutable playback instance of an immutable clip.
 * Actions are mixer-owned and become invalid after removal or mixer destroy.
 */
export interface Animation3DAction {
  readonly id: string;
  readonly clip: Animation3DClip;
  readonly status: Animation3DActionStatus;
  enabled: boolean;
  paused: boolean;
  time: number;
  timeScale: number;
  weight: number;
  loop: Animation3DLoopMode;
  repetitions: number;
  clampWhenFinished: boolean;
  blendMode: Animation3DBlendMode;
  mask: Animation3DBindingMask | null;
  readonly effectiveTimeScale: number;
  readonly effectiveWeight: number;

  play(): this;
  stop(): this;
  reset(): this;
  startAt(mixerTimeSeconds: number): this;
  fadeIn(durationSeconds: number): this;
  fadeOut(durationSeconds: number): this;
  crossFadeFrom(
    source: Animation3DAction,
    durationSeconds: number,
    warp?: boolean,
  ): this;
  crossFadeTo(
    destination: Animation3DAction,
    durationSeconds: number,
    warp?: boolean,
  ): this;
  stopFading(): this;
}
