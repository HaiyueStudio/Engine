import { Component, UniqueCheckType } from '../ecs/Component';

export interface Physics3DGravitySourceOptions {
  /** Gravitational parameter G*M in world units cubed per second squared. */
  strength?: number;
  softening?: number;
  maxDistance?: number;
}

/** Point-mass gravity source consumed by the backend-neutral gravity system. */
export class Physics3DGravitySource extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Physics3DGravitySource');

  strength: number;
  softening: number;
  maxDistance: number;

  constructor(options: Physics3DGravitySourceOptions = {}) {
    super('Physics3DGravitySource');
    this.strength = options.strength ?? 20;
    this.softening = options.softening ?? 0.5;
    this.maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY;
  }
}
