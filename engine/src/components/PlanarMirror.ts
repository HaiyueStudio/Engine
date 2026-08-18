import { Component, UniqueCheckType } from '../ecs/Component';
import { PlanarMirrorMaterial } from '../material/PlanarMirrorMaterial';

export interface PlanarMirrorOptions {
  /** Mirror-plane normal in the entity's local space. Defaults to +Z. */
  localNormal?: readonly [number, number, number];
  /** Reflection resolution relative to the source view. Defaults to 0.5. */
  resolutionScale?: number;
  /** Additional resolution multiplier applied at every recursive bounce. Defaults to 0.85. */
  bounceResolutionScale?: number;
  /** Fixed target width. When omitted, resolutionScale is used. */
  width?: number;
  /** Fixed target height. When omitted, resolutionScale is used. */
  height?: number;
  /** Moves the oblique clip plane away from the surface to suppress self artifacts. */
  clipBias?: number;
  /**
   * Total reflection levels, including the first mirror view. Defaults to 1.
   * Each extra level renders another view for every reachable opposing mirror.
   */
  maxBounces?: number;
  /** Render at most once per this many logical frames. Defaults to 1. */
  updateInterval?: number;
  /** Keep the first rendered reflection until invalidateReflection() is called. */
  staticCache?: boolean;
  sampleCount?: 1 | 4;
  clearColor?: Readonly<GPUColorDict>;
  tint?: readonly [number, number, number];
  reflectivity?: number;
}

/**
 * Marks the entity's Mesh3D surface as a real-time planar mirror.
 *
 * Add this beside Mesh3D and a 3D transform. The mirror plane passes through
 * the entity origin and uses `localNormal` (defaults to local +Z).
 *
 * @example
 * ```ts
 * mirrorEntity
 *   .addComponent(new Mesh3D(planeGeometry))
 *   .addComponent(new PlanarMirror({ resolutionScale: 0.5 }));
 * ```
 */
export class PlanarMirror extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('PlanarMirror');
  static editor = {
    fields: {
      resolutionScale: { type: 'number', label: 'Resolution Scale', group: 'Reflection', min: 0.1, max: 2, step: 0.1 },
      bounceResolutionScale: { type: 'number', label: 'Bounce Resolution', group: 'Reflection', min: 0.1, max: 1, step: 0.05 },
      clipBias: { type: 'number', label: 'Clip Bias', group: 'Reflection', min: 0, step: 0.001 },
      maxBounces: { type: 'number', label: 'Max Bounces', group: 'Reflection', min: 1, max: 8, step: 1 },
      updateInterval: { type: 'number', label: 'Update Interval', group: 'Reflection', min: 1, step: 1 },
      staticCache: { type: 'boolean', label: 'Static Cache', group: 'Reflection' },
      sampleCount: { type: 'select', label: 'MSAA', group: 'Reflection', options: [
        { label: 'Off', value: 1 },
        { label: '4x', value: 4 },
      ] },
      reflectivity: {
        type: 'number', label: 'Reflectivity', group: 'Surface', min: 0, max: 1, step: 0.01,
        get: (component: PlanarMirror) => component.material.reflectivity,
        set: (component: PlanarMirror, value: unknown) => { component.material.reflectivity = Number(value); },
      },
    },
  };

  readonly material: PlanarMirrorMaterial;
  private _localNormal: readonly [number, number, number];
  private _resolutionScale: number;
  private _bounceResolutionScale: number;
  private _width: number | null;
  private _height: number | null;
  private _clipBias: number;
  private _maxBounces: number;
  private _updateInterval: number;
  private _staticCache: boolean;
  private _sampleCount: 1 | 4;
  private _clearColor: Readonly<GPUColorDict>;
  private _reflectionRevision = 1;

  constructor(options: PlanarMirrorOptions = {}) {
    super('PlanarMirror');
    this._localNormal = normalize(options.localNormal ?? [0, 0, 1]);
    this._resolutionScale = positiveFinite(options.resolutionScale ?? 0.5, 'resolutionScale');
    this._bounceResolutionScale = unitPositiveFinite(options.bounceResolutionScale ?? 0.85, 'bounceResolutionScale');
    this._width = optionalDimension(options.width, 'width');
    this._height = optionalDimension(options.height, 'height');
    this._clipBias = nonNegativeFinite(options.clipBias ?? 0.01, 'clipBias');
    this._maxBounces = bounceCount(options.maxBounces ?? 1);
    this._updateInterval = positiveInteger(options.updateInterval ?? 1, 'updateInterval');
    this._staticCache = options.staticCache === true;
    this._sampleCount = options.sampleCount ?? 1;
    if (this._sampleCount !== 1 && this._sampleCount !== 4) {
      throw new RangeError('PlanarMirror.sampleCount must be 1 or 4.');
    }
    const clear = options.clearColor ?? { r: 0.02, g: 0.02, b: 0.025, a: 1 };
    this._clearColor = freezeColor(clear);
    this.material = new PlanarMirrorMaterial({
      ...(options.tint === undefined ? {} : { tint: options.tint }),
      ...(options.reflectivity === undefined ? {} : { reflectivity: options.reflectivity }),
    });
  }

  get localNormal(): readonly [number, number, number] { return this._localNormal; }
  set localNormal(value: readonly [number, number, number]) {
    const next = normalize(value);
    if (sameVec3(this._localNormal, next)) return;
    this._localNormal = next;
    this.invalidateReflection();
  }
  get resolutionScale(): number { return this._resolutionScale; }
  set resolutionScale(value: number) {
    const next = positiveFinite(value, 'resolutionScale');
    if (this._resolutionScale === next) return;
    this._resolutionScale = next;
    this.invalidateReflection();
  }
  get bounceResolutionScale(): number { return this._bounceResolutionScale; }
  set bounceResolutionScale(value: number) {
    const next = unitPositiveFinite(value, 'bounceResolutionScale');
    if (this._bounceResolutionScale === next) return;
    this._bounceResolutionScale = next;
    this.invalidateReflection();
  }
  get width(): number | null { return this._width; }
  set width(value: number | null) {
    const next = optionalDimension(value ?? undefined, 'width');
    if (this._width === next) return;
    this._width = next;
    this.invalidateReflection();
  }
  get height(): number | null { return this._height; }
  set height(value: number | null) {
    const next = optionalDimension(value ?? undefined, 'height');
    if (this._height === next) return;
    this._height = next;
    this.invalidateReflection();
  }
  get clipBias(): number { return this._clipBias; }
  set clipBias(value: number) {
    const next = nonNegativeFinite(value, 'clipBias');
    if (this._clipBias === next) return;
    this._clipBias = next;
    this.invalidateReflection();
  }
  get maxBounces(): number { return this._maxBounces; }
  set maxBounces(value: number) {
    const next = bounceCount(value);
    if (this._maxBounces === next) return;
    this._maxBounces = next;
    this.invalidateReflection();
  }
  get updateInterval(): number { return this._updateInterval; }
  set updateInterval(value: number) {
    const next = positiveInteger(value, 'updateInterval');
    if (this._updateInterval === next) return;
    this._updateInterval = next;
    this.invalidateReflection();
  }
  get staticCache(): boolean { return this._staticCache; }
  set staticCache(value: boolean) {
    const next = value === true;
    if (this._staticCache === next) return;
    this._staticCache = next;
    this.invalidateReflection();
  }
  get sampleCount(): 1 | 4 { return this._sampleCount; }
  set sampleCount(value: 1 | 4) {
    if (value !== 1 && value !== 4) throw new RangeError('PlanarMirror.sampleCount must be 1 or 4.');
    if (this._sampleCount === value) return;
    this._sampleCount = value;
    this.invalidateReflection();
  }
  get clearColor(): Readonly<GPUColorDict> { return this._clearColor; }
  set clearColor(value: Readonly<GPUColorDict>) {
    const next = freezeColor(value);
    if (sameColor(this._clearColor, next)) return;
    this._clearColor = next;
    this.invalidateReflection();
  }

  /** Monotonic cache key consumed by the reflection planner. */
  get reflectionRevision(): number { return this._reflectionRevision; }

  /** Requests a refresh for static or interval-cached reflection targets. */
  invalidateReflection(): this {
    this._reflectionRevision = this._reflectionRevision >= Number.MAX_SAFE_INTEGER ? 1 : this._reflectionRevision + 1;
    return this;
  }

  override clone(): PlanarMirror {
    const mirror = new PlanarMirror({
      localNormal: this.localNormal,
      resolutionScale: this.resolutionScale,
      bounceResolutionScale: this.bounceResolutionScale,
      ...(this.width === null ? {} : { width: this.width }),
      ...(this.height === null ? {} : { height: this.height }),
      clipBias: this.clipBias,
      maxBounces: this.maxBounces,
      updateInterval: this.updateInterval,
      staticCache: this.staticCache,
      sampleCount: this.sampleCount,
      clearColor: this.clearColor,
      tint: this.material.tint,
      reflectivity: this.material.reflectivity,
    });
    mirror.disabled = this.disabled;
    return mirror;
  }
}

function normalize(value: readonly [number, number, number]): readonly [number, number, number] {
  const x = value[0];
  const y = value[1];
  const z = value[2];
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 1e-8) {
    throw new RangeError('PlanarMirror.localNormal must be a finite, non-zero vector.');
  }
  return Object.freeze([x / length, y / length, z / length] as [number, number, number]);
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`PlanarMirror.${label} must be greater than zero.`);
  return value;
}

function unitPositiveFinite(value: number, label: string): number {
  const next = positiveFinite(value, label);
  if (next > 1) throw new RangeError(`PlanarMirror.${label} must not be greater than one.`);
  return next;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`PlanarMirror.${label} must be a positive integer.`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`PlanarMirror.${label} must be non-negative.`);
  return value;
}

function optionalDimension(value: number | undefined, label: string): number | null {
  return value === undefined ? null : Math.max(1, Math.floor(positiveFinite(value, label)));
}

function bounceCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new RangeError('PlanarMirror.maxBounces must be an integer in [1, 8].');
  }
  return value;
}

function freezeColor(value: Readonly<GPUColorDict>): Readonly<GPUColorDict> {
  if (![value.r, value.g, value.b, value.a].every(Number.isFinite)) {
    throw new RangeError('PlanarMirror.clearColor channels must be finite.');
  }
  return Object.freeze({ r: value.r, g: value.g, b: value.b, a: value.a });
}

function sameVec3(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function sameColor(a: Readonly<GPUColorDict>, b: Readonly<GPUColorDict>): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}
