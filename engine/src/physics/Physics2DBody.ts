import { Component, UniqueCheckType } from '../ecs/Component';
import type { Physics2DBodyHandle } from './Physics2DBackend';
import { getPhysics2DBodyHandle } from './Physics2DRuntimeHandles';

export type Physics2DBodyType = 'static' | 'dynamic' | 'kinematic';
export type Physics2DShapeType = 'box' | 'circle';

export interface Physics2DBodyOptions {
  type?: Physics2DBodyType;
  shape?: Physics2DShapeType;
  width?: number;
  height?: number;
  radius?: number;
  density?: number;
  friction?: number;
  restitution?: number;
  fixedRotation?: boolean;
  linearDamping?: number;
  angularDamping?: number;
  bullet?: boolean;
  allowSleep?: boolean;
  isSensor?: boolean;
  categoryBits?: number;
  maskBits?: number;
  groupIndex?: number;
  syncTransform?: boolean;
}

export class Physics2DBody extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Physics2DBody');
  static editor = {
    fields: {
      type: { type: 'string', label: 'Body Type' },
      shape: { type: 'string', label: 'Shape' },
      width: { type: 'number', label: 'Width', min: 0, step: 1 },
      height: { type: 'number', label: 'Height', min: 0, step: 1 },
      radius: { type: 'number', label: 'Radius', min: 0, step: 1 },
      density: { type: 'number', label: 'Density', min: 0, step: 0.01 },
      friction: { type: 'number', label: 'Friction', min: 0, step: 0.01 },
      restitution: { type: 'number', label: 'Restitution', min: 0, step: 0.01 },
      fixedRotation: { type: 'boolean', label: 'Fixed Rotation' },
      linearDamping: { type: 'number', label: 'Linear Damping', min: 0, step: 0.01 },
      angularDamping: { type: 'number', label: 'Angular Damping', min: 0, step: 0.01 },
      bullet: { type: 'boolean', label: 'Bullet' },
      allowSleep: { type: 'boolean', label: 'Allow Sleep' },
      isSensor: { type: 'boolean', label: 'Is Sensor' },
      categoryBits: { type: 'number', label: 'Category Bits', min: 0, step: 1 },
      maskBits: { type: 'number', label: 'Mask Bits', min: 0, step: 1 },
      groupIndex: { type: 'number', label: 'Group Index', step: 1 },
      syncTransform: { type: 'boolean', label: 'Sync Transform' },
    },
  };

  type: Physics2DBodyType;
  shape: Physics2DShapeType;
  width: number;
  height: number;
  radius: number;
  density: number;
  friction: number;
  restitution: number;
  fixedRotation: boolean;
  linearDamping: number;
  angularDamping: number;
  bullet: boolean;
  allowSleep: boolean;
  isSensor: boolean;
  categoryBits: number;
  maskBits: number;
  groupIndex: number;
  syncTransform: boolean;
  constructor(options: Physics2DBodyOptions = {}) {
    super('Physics2DBody');
    this.type = options.type ?? 'dynamic';
    this.shape = options.shape ?? 'box';
    this.width = options.width ?? 100;
    this.height = options.height ?? 100;
    this.radius = options.radius ?? Math.min(this.width, this.height) / 2;
    this.density = options.density ?? (this.type === 'dynamic' ? 1 : 0);
    this.friction = options.friction ?? 0.3;
    this.restitution = options.restitution ?? 0.1;
    this.fixedRotation = options.fixedRotation ?? false;
    this.linearDamping = options.linearDamping ?? 0;
    this.angularDamping = options.angularDamping ?? 0;
    this.bullet = options.bullet ?? false;
    this.allowSleep = options.allowSleep ?? true;
    this.isSensor = options.isSensor ?? false;
    this.categoryBits = options.categoryBits ?? 0x0001;
    this.maskBits = options.maskBits ?? 0xffff;
    this.groupIndex = options.groupIndex ?? 0;
    this.syncTransform = options.syncTransform ?? true;
  }

  /** Runtime-only, backend-neutral handle. Null until the system creates the body. */
  get handle(): Physics2DBodyHandle | null {
    return getPhysics2DBodyHandle(this);
  }

  setCollisionFilter(categoryBits: number, maskBits: number, groupIndex = this.groupIndex): this {
    this.categoryBits = categoryBits;
    this.maskBits = maskBits;
    this.groupIndex = groupIndex;
    return this;
  }
}
