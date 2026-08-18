import type { ColorValue } from '../color/Color';
import { resolveColor, type ColorLike } from '../color/ColorLike';
import { Component, UniqueCheckType } from '../ecs/Component';

export type FogMode = 'distance' | 'height';

export interface FogOptions {
  mode?: FogMode;
  color?: ColorLike;
  /** Maximum fog contribution after evaluating the selected model. */
  maxOpacity?: number;
  /** Distance at which linear distance fog begins. */
  distanceStart?: number;
  /** Distance at which linear distance fog reaches maxOpacity. */
  distanceEnd?: number;
  /** World-space height where height fog has its reference density. */
  baseHeight?: number;
  /** Extinction density of height fog at baseHeight. */
  density?: number;
  /** Exponential density decay per world-space height unit. Zero gives uniform exponential fog. */
  heightFalloff?: number;
}

/** Scene-level fog configuration. The first active Fog in a World is used by 3-D render systems. */
export class Fog extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Fog');
  static editor = {
    fields: {
      mode: { type: 'select', label: 'Mode', group: 'Fog', options: ['distance', 'height'] },
      color: { type: 'color', label: 'Color', group: 'Fog' },
      maxOpacity: { type: 'number', label: 'Max Opacity', group: 'Fog', min: 0, max: 1, step: 0.01 },
      distanceStart: { type: 'number', label: 'Distance Start', group: 'Distance Fog', min: 0, step: 0.1 },
      distanceEnd: { type: 'number', label: 'Distance End', group: 'Distance Fog', min: 0, step: 0.1 },
      baseHeight: { type: 'number', label: 'Base Height', group: 'Height Fog', step: 0.1 },
      density: { type: 'number', label: 'Density', group: 'Height Fog', min: 0, step: 0.001 },
      heightFalloff: { type: 'number', label: 'Height Falloff', group: 'Height Fog', min: 0, step: 0.01 },
    },
  };

  private _mode: FogMode;
  private _color: ColorValue;
  private _maxOpacity: number;
  private _distanceStart: number;
  private _distanceEnd: number;
  private _baseHeight: number;
  private _density: number;
  private _heightFalloff: number;

  constructor(options: FogOptions = {}) {
    super('Fog');
    this._mode = options.mode ?? 'distance';
    this._color = resolveColor(options.color, [0.62, 0.7, 0.8, 1]);
    this._maxOpacity = clamp01(options.maxOpacity ?? 1);
    this._distanceStart = nonNegative(options.distanceStart ?? 10);
    this._distanceEnd = nonNegative(options.distanceEnd ?? 60);
    this._baseHeight = finite(options.baseHeight, 0);
    this._density = nonNegative(options.density ?? 0.04);
    this._heightFalloff = nonNegative(options.heightFalloff ?? 0.2);
  }

  get mode(): FogMode { return this._mode; }
  set mode(value: FogMode) { this._mode = value === 'height' ? 'height' : 'distance'; }

  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) { this._color = resolveColor(value); }

  get maxOpacity(): number { return this._maxOpacity; }
  set maxOpacity(value: number) { this._maxOpacity = clamp01(value); }

  get distanceStart(): number { return this._distanceStart; }
  set distanceStart(value: number) { this._distanceStart = nonNegative(value); }

  get distanceEnd(): number { return this._distanceEnd; }
  set distanceEnd(value: number) { this._distanceEnd = nonNegative(value); }

  get baseHeight(): number { return this._baseHeight; }
  set baseHeight(value: number) { this._baseHeight = finite(value, 0); }

  get density(): number { return this._density; }
  set density(value: number) { this._density = nonNegative(value); }

  get heightFalloff(): number { return this._heightFalloff; }
  set heightFalloff(value: number) { this._heightFalloff = nonNegative(value); }

  override clone(): Fog {
    return new Fog({
      mode: this.mode,
      color: this.color.clone(),
      maxOpacity: this.maxOpacity,
      distanceStart: this.distanceStart,
      distanceEnd: this.distanceEnd,
      baseHeight: this.baseHeight,
      density: this.density,
      heightFalloff: this.heightFalloff,
    });
  }
}

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

function nonNegative(value: number): number {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
