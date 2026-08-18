import { Component, UniqueCheckType } from '../ecs/Component';
import type { Physics3DBodyHandle } from './Physics3DBackend';
import { getPhysics3DBodyHandle } from './Physics3DRuntimeHandles';

export type Physics3DBodyType = 'static' | 'dynamic' | 'kinematic';
export type Physics3DShapeType = 'box' | 'sphere' | 'capsule' | 'cylinder';

export interface Physics3DBodyOptions {
  type?: Physics3DBodyType;
  shape?: Physics3DShapeType;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  /** Half the straight segment length for capsules, or half-height for cylinders. */
  halfHeight?: number;
  density?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  ccd?: boolean;
  allowSleep?: boolean;
  isSensor?: boolean;
  categoryBits?: number;
  maskBits?: number;
  lockTranslations?: readonly [boolean, boolean, boolean];
  lockRotations?: readonly [boolean, boolean, boolean];
  syncTransform?: boolean;
}

export class Physics3DBody extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Physics3DBody');
  static editor = {
    fields: {
      type: { type: 'string', label: 'Body Type', group: 'Physics 3D' },
      shape: { type: 'string', label: 'Shape', group: 'Physics 3D' },
      width: { type: 'number', label: 'Width', group: 'Collider', min: 0, step: 0.01 },
      height: { type: 'number', label: 'Height', group: 'Collider', min: 0, step: 0.01 },
      depth: { type: 'number', label: 'Depth', group: 'Collider', min: 0, step: 0.01 },
      radius: { type: 'number', label: 'Radius', group: 'Collider', min: 0, step: 0.01 },
      density: { type: 'number', label: 'Density', group: 'Physics 3D', min: 0, step: 0.01 },
      friction: { type: 'number', label: 'Friction', group: 'Physics 3D', min: 0, step: 0.01 },
      restitution: { type: 'number', label: 'Restitution', group: 'Physics 3D', min: 0, step: 0.01 },
      linearDamping: { type: 'number', label: 'Linear Damping', group: 'Physics 3D', min: 0, step: 0.01 },
      angularDamping: { type: 'number', label: 'Angular Damping', group: 'Physics 3D', min: 0, step: 0.01 },
      gravityScale: { type: 'number', label: 'Gravity Scale', group: 'Physics 3D', step: 0.01 },
      ccd: { type: 'boolean', label: 'CCD', group: 'Physics 3D' },
      allowSleep: { type: 'boolean', label: 'Allow Sleep', group: 'Physics 3D' },
      isSensor: { type: 'boolean', label: 'Sensor', group: 'Collider' },
      syncTransform: { type: 'boolean', label: 'Sync Transform', group: 'Physics 3D' },
    },
  };

  type: Physics3DBodyType;
  shape: Physics3DShapeType;
  width: number;
  height: number;
  depth: number;
  radius: number;
  halfHeight: number;
  density: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  allowSleep: boolean;
  isSensor: boolean;
  categoryBits: number;
  maskBits: number;
  lockTranslations: [boolean, boolean, boolean];
  lockRotations: [boolean, boolean, boolean];
  syncTransform: boolean;

  constructor(options: Physics3DBodyOptions = {}) {
    super('Physics3DBody');
    this.type = options.type ?? 'dynamic';
    this.shape = options.shape ?? 'box';
    this.width = options.width ?? 1;
    this.height = options.height ?? 1;
    this.depth = options.depth ?? 1;
    this.radius = options.radius ?? Math.min(this.width, this.height, this.depth) * 0.5;
    this.halfHeight = options.halfHeight ?? Math.max(0, this.height * 0.5 - this.radius);
    this.density = options.density ?? (this.type === 'dynamic' ? 1 : 0);
    this.friction = options.friction ?? 0.5;
    this.restitution = options.restitution ?? 0.1;
    this.linearDamping = options.linearDamping ?? 0;
    this.angularDamping = options.angularDamping ?? 0;
    this.gravityScale = options.gravityScale ?? 1;
    this.ccd = options.ccd ?? false;
    this.allowSleep = options.allowSleep ?? true;
    this.isSensor = options.isSensor ?? false;
    this.categoryBits = options.categoryBits ?? 0x0001;
    this.maskBits = options.maskBits ?? 0xffff;
    this.lockTranslations = [...(options.lockTranslations ?? [false, false, false])];
    this.lockRotations = [...(options.lockRotations ?? [false, false, false])];
    this.syncTransform = options.syncTransform ?? true;
  }

  /** Runtime-only, backend-neutral handle. Null until the system creates the body. */
  get handle(): Physics3DBodyHandle | null {
    return getPhysics3DBodyHandle(this);
  }

  setCollisionFilter(categoryBits: number, maskBits: number): this {
    this.categoryBits = categoryBits;
    this.maskBits = maskBits;
    return this;
  }
}
