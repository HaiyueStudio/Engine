import { Component, UniqueCheckType } from '../ecs/Component';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { BoundingSphere } from '../culling/Frustum';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';

export interface BvhLodLevel3D {
  /** Geometry used while the camera-to-bounds distance is at or below this value. */
  geometry: Geometry3D;
  /** Inclusive switch distance. The final level must use `Infinity`. */
  maxDistance: number;
  /** Optional material override. Omitted levels keep the Mesh3D's original material. */
  material?: Material;
}

export interface BvhLod3DOptions {
  /** Levels ordered from highest detail / shortest distance to lowest detail. */
  levels: readonly BvhLodLevel3D[];
  /** Optional conservative local-space bounds shared by every level. */
  bounds?: BoundingSphere;
  /** Fractional switch hysteresis in [0, 0.5). Defaults to 0.1. */
  hysteresis?: number;
}

/**
 * Describes immutable mesh LOD choices. Selection is view-local and render
 * frames consume the chosen resources without mutating the entity's Mesh3D.
 */
export class BvhLod3D extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('BvhLod3D');

  private _levels: readonly Readonly<BvhLodLevel3D>[];
  private _bounds: BoundingSphere | null;
  private _hysteresis: number;
  private _revision = 1;

  constructor(options: BvhLod3DOptions) {
    super('BvhLod3D');
    this._levels = normalizeLevels(options.levels);
    this._bounds = normalizeBounds(options.bounds);
    this._hysteresis = normalizeHysteresis(options.hysteresis ?? 0.1);
  }

  get levels(): readonly Readonly<BvhLodLevel3D>[] { return this._levels; }
  get bounds(): BoundingSphere | null { return this._bounds; }
  get hysteresis(): number { return this._hysteresis; }
  get revision(): number { return this._revision; }

  setLevels(levels: readonly BvhLodLevel3D[]): this {
    this._levels = normalizeLevels(levels);
    this._touch();
    return this;
  }

  setBounds(bounds: BoundingSphere | null): this {
    this._bounds = normalizeBounds(bounds ?? undefined);
    this._touch();
    return this;
  }

  setHysteresis(hysteresis: number): this {
    const next = normalizeHysteresis(hysteresis);
    if (next === this._hysteresis) return this;
    this._hysteresis = next;
    this._touch();
    return this;
  }

  /** Select a level for an exact camera-to-bounds distance, including hysteresis. */
  selectLevel(distance: number, currentLevel = -1): number {
    const safeDistance = Math.max(0, Number.isFinite(distance) ? distance : Infinity);
    let desired = this._levels.length - 1;
    for (let i = 0; i < this._levels.length; i++) {
      const level = this._levels[i];
      if (level && safeDistance <= level.maxDistance) {
        desired = i;
        break;
      }
    }
    if (currentLevel < 0 || currentLevel >= this._levels.length || desired === currentLevel) return desired;

    // Cross every adjacent boundary independently. Comparing a Low -> High
    // jump only against High's boundary can incorrectly leave the object on
    // Low when it should at least advance to Medium.
    let selected = currentLevel;
    if (desired < selected) {
      while (selected > desired) {
        const boundary = this._levels[selected - 1]?.maxDistance ?? 0;
        if (safeDistance >= boundary * (1 - this._hysteresis)) break;
        selected--;
      }
    } else {
      while (selected < desired) {
        const boundary = this._levels[selected]?.maxDistance ?? Infinity;
        if (safeDistance <= boundary * (1 + this._hysteresis)) break;
        selected++;
      }
    }
    return selected;
  }

  /** Largest distance at which a level above the fallback can be selected. */
  get activationDistance(): number {
    if (this._levels.length < 2) return 0;
    return this._levels[this._levels.length - 2]?.maxDistance ?? 0;
  }

  override clone(): BvhLod3D {
    const clone = new BvhLod3D({
      levels: this._levels,
      ...(this._bounds ? { bounds: this._bounds } : {}),
      hysteresis: this._hysteresis,
    });
    clone.disabled = this.disabled;
    return clone;
  }

  private _touch(): void {
    this._revision = (this._revision + 1) >>> 0;
    if (this._revision === 0) this._revision = 1;
    for (const entity of this.usedBy) entity.world?.notifyEntityComponentChanged(entity, this);
  }
}

function normalizeLevels(levels: readonly BvhLodLevel3D[]): readonly Readonly<BvhLodLevel3D>[] {
  if (levels.length === 0) throw invalidLod('BvhLod3D requires at least one level.');
  const normalized: Readonly<BvhLodLevel3D>[] = [];
  let previous = -Infinity;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (!level?.geometry) throw invalidLod(`BvhLod3D level ${i} requires a Geometry3D.`);
    const distance = level.maxDistance;
    const finalLevel = i === levels.length - 1;
    if ((!Number.isFinite(distance) && !(finalLevel && distance === Infinity)) || distance <= 0) {
      throw invalidLod(`BvhLod3D level ${i} maxDistance must be positive and finite; only the final level may use Infinity.`);
    }
    if (distance <= previous) throw invalidLod('BvhLod3D maxDistance values must be strictly increasing.');
    if (finalLevel && distance !== Infinity) throw invalidLod('BvhLod3D final level maxDistance must be Infinity.');
    normalized.push(Object.freeze({
      geometry: level.geometry,
      maxDistance: distance,
      ...(level.material ? { material: level.material } : {}),
    }));
    previous = distance;
  }
  return Object.freeze(normalized);
}

function normalizeBounds(bounds: BoundingSphere | undefined): BoundingSphere | null {
  if (!bounds) return null;
  const [x, y, z] = bounds.center;
  if (![x, y, z, bounds.radius].every(Number.isFinite) || bounds.radius < 0) {
    throw invalidLod('BvhLod3D bounds must contain a finite center and a non-negative finite radius.');
  }
  return Object.freeze({ center: Object.freeze([x, y, z]) as readonly [number, number, number], radius: bounds.radius });
}

function normalizeHysteresis(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 0.5) {
    throw invalidLod('BvhLod3D hysteresis must be finite and in [0, 0.5).');
  }
  return value;
}

function invalidLod(message: string): EngineError {
  return new EngineError(EngineErrorCode.GeometryInvalidParameter, message, {
    hint: 'Order LOD levels from nearest to farthest and end with maxDistance: Infinity.',
    docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
  });
}
