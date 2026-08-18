import { Component, UniqueCheckType } from '../ecs/Component';

export interface Physics3DBuoyancyOptions {
  /** World-space height of an infinite horizontal fluid plane. */
  fluidLevel?: number;
  fluidDensity?: number;
  /** Displaced volume. When omitted it is derived from the body's collider. */
  volume?: number | null;
  /** Approximate vertical extent used to calculate submerged fraction. */
  bodyHeight?: number | null;
  linearDrag?: number;
  angularDrag?: number;
  centerOfBuoyancy?: readonly [number, number, number];
}

/** Backend-neutral buoyancy force description consumed by Physics3DBuoyancySystem. */
export class Physics3DBuoyancy extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Physics3DBuoyancy');

  fluidLevel: number;
  fluidDensity: number;
  volume: number | null;
  bodyHeight: number | null;
  linearDrag: number;
  angularDrag: number;
  centerOfBuoyancy: [number, number, number];

  constructor(options: Physics3DBuoyancyOptions = {}) {
    super('Physics3DBuoyancy');
    this.fluidLevel = options.fluidLevel ?? 0;
    this.fluidDensity = options.fluidDensity ?? 1;
    this.volume = options.volume ?? null;
    this.bodyHeight = options.bodyHeight ?? null;
    this.linearDrag = options.linearDrag ?? 1.4;
    this.angularDrag = options.angularDrag ?? 0.8;
    this.centerOfBuoyancy = [...(options.centerOfBuoyancy ?? [0, 0, 0])];
  }
}
