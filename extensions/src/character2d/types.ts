import type { Entity } from '@haiyue/engine/ecs';
import type { Physics2DSystem } from '@haiyue/engine/physics';

export interface Character2DOptions {
  readonly physics: Physics2DSystem;
  readonly entity: Entity;
  readonly up?: readonly [number, number];
  readonly maxSlides?: number;
  readonly maxSlopeAngle?: number;
  readonly floorSnap?: number;
  readonly safeMargin?: number;
  readonly carryPlatformVelocity?: boolean;
}
export interface Character2DState {
  readonly tick: number;
  readonly position: readonly [number, number];
  readonly previousPosition: readonly [number, number];
  readonly velocity: readonly [number, number];
  readonly grounded: boolean;
  readonly onWall: boolean;
  readonly floorNormal: readonly [number, number] | null;
  readonly platformEntityId: number | null;
  readonly stuck: boolean;
}
export interface Character2DController {
  setVelocity(velocity: readonly [number, number]): void;
  teleport(position: readonly [number, number]): void;
  readonly state: Character2DState;
  dispose(): void;
}
