import { Component, UniqueCheckType } from '../ecs/Component';
import type { Entity } from '../ecs/Entity';
import type { Physics3DJointHandle } from './Physics3DBackend';
import { getPhysics3DJointHandle } from './Physics3DRuntimeHandles';

export type Physics3DJointType = 'fixed' | 'spherical' | 'revolute' | 'prismatic' | 'spring' | 'rope';
export type Physics3DJointTarget = Entity | string | number;

export interface Physics3DJointOptions {
  type?: Physics3DJointType;
  bodyA: Physics3DJointTarget;
  bodyB: Physics3DJointTarget;
  /** Local-space anchor on body A. */
  anchorA?: readonly [number, number, number];
  /** Local-space anchor on body B. */
  anchorB?: readonly [number, number, number];
  /** Local-space axis for revolute and prismatic joints. */
  axis?: readonly [number, number, number];
  /** Local-space reference frames for fixed joints, encoded as xyzw quaternions. */
  frameA?: readonly [number, number, number, number];
  frameB?: readonly [number, number, number, number];
  collideConnected?: boolean;
  limits?: readonly [number, number] | null;
  restLength?: number;
  maxLength?: number;
  stiffness?: number;
  damping?: number;
}

export class Physics3DJoint extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Physics3DJoint');
  static editor = {
    fields: {
      type: { type: 'string', label: 'Joint Type', group: 'Physics 3D' },
      bodyA: { type: 'string', label: 'Body A', group: 'Physics 3D' },
      bodyB: { type: 'string', label: 'Body B', group: 'Physics 3D' },
      anchorA: { type: 'json', label: 'Anchor A', group: 'Physics 3D', rows: 2 },
      anchorB: { type: 'json', label: 'Anchor B', group: 'Physics 3D', rows: 2 },
      axis: { type: 'json', label: 'Axis', group: 'Physics 3D', rows: 2 },
      collideConnected: { type: 'boolean', label: 'Collide Connected', group: 'Physics 3D' },
      limits: { type: 'json', label: 'Limits', group: 'Physics 3D', rows: 2 },
      restLength: { type: 'number', label: 'Rest Length', group: 'Spring', min: 0, step: 0.01 },
      maxLength: { type: 'number', label: 'Max Length', group: 'Rope', min: 0, step: 0.01 },
      stiffness: { type: 'number', label: 'Stiffness', group: 'Spring', min: 0, step: 1 },
      damping: { type: 'number', label: 'Damping', group: 'Spring', min: 0, step: 0.01 },
    },
  };

  type: Physics3DJointType;
  bodyA: Physics3DJointTarget;
  bodyB: Physics3DJointTarget;
  anchorA: [number, number, number];
  anchorB: [number, number, number];
  axis: [number, number, number];
  frameA: [number, number, number, number];
  frameB: [number, number, number, number];
  collideConnected: boolean;
  limits: [number, number] | null;
  restLength: number;
  maxLength: number;
  stiffness: number;
  damping: number;

  constructor(options: Physics3DJointOptions) {
    super('Physics3DJoint');
    this.type = options.type ?? 'fixed';
    this.bodyA = options.bodyA;
    this.bodyB = options.bodyB;
    this.anchorA = [...(options.anchorA ?? [0, 0, 0])];
    this.anchorB = [...(options.anchorB ?? [0, 0, 0])];
    this.axis = [...(options.axis ?? [1, 0, 0])];
    this.frameA = [...(options.frameA ?? [0, 0, 0, 1])];
    this.frameB = [...(options.frameB ?? [0, 0, 0, 1])];
    this.collideConnected = options.collideConnected ?? false;
    this.limits = options.limits ? [...options.limits] : null;
    this.restLength = options.restLength ?? 1;
    this.maxLength = options.maxLength ?? 1;
    this.stiffness = options.stiffness ?? 30;
    this.damping = options.damping ?? 3;
  }

  /** Runtime-only, backend-neutral handle. Null until the system creates the joint. */
  get handle(): Physics3DJointHandle | null {
    return getPhysics3DJointHandle(this);
  }
}
