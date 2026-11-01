import type { Entity } from '@haiyue/engine/ecs';

export interface Camera2DControllerOptions {
  readonly camera: Entity;
  readonly target: () => readonly [number, number];
  readonly damping?: number;
  readonly deadZone?: Readonly<{ width: number; height: number }>;
  readonly bounds?: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly interpolation?: () => Readonly<{ previous: readonly [number, number]; current: readonly [number, number]; alpha: number }>;
}
export interface Camera2DControllerState {
  readonly position: readonly [number, number];
  readonly offset: readonly [number, number];
}
export interface Camera2DController {
  update(deltaMs: number): void;
  reset(): void;
  shake(options: Readonly<{ amplitude: number; durationMs: number; seed?: number }>): void;
  readonly state: Camera2DControllerState;
  dispose(): void;
}
