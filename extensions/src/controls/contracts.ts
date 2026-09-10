import type { Entity } from '@haiyue/engine/ecs';
import type { GuiRoot, GuiStyle } from '@haiyue/engine/gui';

export interface JoystickPoint { readonly x: number; readonly y: number }
export interface JoystickViewport { readonly width: number; readonly height: number }
export interface JoystickRegion extends JoystickPoint, JoystickViewport {}

/** Coordinates and radii use surface-local CSS/logical pixels, never framebuffer pixels. */
export interface VirtualJoystickSurface extends EventTarget {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  readonly ownerDocument?: Document | null;
}

export interface VirtualJoystickOptions {
  /** Fixed center, or the initial press becomes the center. Default: floating. */
  mode?: 'fixed' | 'floating';
  /** Fixed mode center. Default: near the bottom-left corner. */
  center?: JoystickPoint | ((viewport: JoystickViewport) => JoystickPoint);
  /** Activation region in both modes. Default: the bottom-left quarter. */
  region?: JoystickRegion | ((viewport: JoystickViewport) => JoystickRegion);
  /** Maximum thumb travel from center, in logical pixels. Default: 64. */
  maxDistance?: number;
  /** Fixed mode hit radius; null uses maxDistance + knobRadius. Default: null. */
  activationRadius?: number | null;
  /** Fraction of maxDistance with zero output, in [0, 1). Default: 0.1. */
  deadZone?: number;
  /** Optional Entity with CartesianTransform3D (xz) or Transform2D (xy). */
  target?: Entity | null;
  /** Parent-local movement plane. Default: xz; up on screen maps to -Z or +Y. */
  plane?: 'xz' | 'xy';
  /** World/parent units per second at full strength. Default: 4. */
  moveSpeed?: number;
  /** Scale speed by dead-zone-adjusted strength. Default: true. */
  analog?: boolean;
  rotateToDirection?: boolean;
  /** Maximum turning radians per second; Infinity snaps. Default: Infinity. */
  turnSpeed?: number;
  /** Heading correction for the model. Default forward: -Z (xz), +X (xy). */
  rotationOffset?: number;
  /** Rotate the movement basis around +Y (xz) or +Z (xy), in radians. Default: 0. */
  movementRotation?: number;
  /** Cap only built-in movement integration after stalls. Frame events retain actual dt. Default: 100. */
  maxDeltaMilliseconds?: number;
  /** Optional shared, full-surface Engine GUI root. Omit for input-only/custom rendering. */
  guiRoot?: GuiRoot | null;
  knobRadius?: number;
  /** Show the fixed joystick while idle. Floating mode always hides while idle. */
  showIdle?: boolean;
  baseStyle?: GuiStyle;
  knobStyle?: GuiStyle;
  /** Optional HUD/input arbitration. Returning false leaves this pointer untouched. */
  shouldActivate?: (point: JoystickPoint, event: PointerEvent) => boolean;
}

export interface VirtualJoystickState {
  readonly active: boolean;
  readonly pointerId: number | null;
  readonly center: JoystickPoint;
  /** Unit screen direction: +X right, +Y down. Zero inside the dead zone. */
  readonly direction: JoystickPoint;
  /** Clamped thumb displacement, including displacement within the dead zone. */
  readonly offset: JoystickPoint;
  readonly rawDistance: number;
  readonly distance: number;
  /** [0, 1], rescaled continuously after the dead zone. */
  readonly strength: number;
  /** Screen radians from +X clockwise, or zero inside the dead zone. */
  readonly angle: number;
}

export interface VirtualJoystickFrame extends VirtualJoystickState {
  readonly deltaMilliseconds: number;
  readonly deltaSeconds: number;
  readonly movementDeltaSeconds: number;
}

export interface VirtualJoystickEventMap {
  start: VirtualJoystickState;
  end: VirtualJoystickState;
  cancel: VirtualJoystickState;
  /** One event per enabled step, including idle frames and held stationary input. */
  frame: VirtualJoystickFrame;
}
