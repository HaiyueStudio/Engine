import { Component, UniqueCheckType } from '../ecs/Component';
import type { Entity } from '../ecs/Entity';
import type { Physics2DJointHandle } from './Physics2DBackend';
import { getPhysics2DJointHandle } from './Physics2DRuntimeHandles';

export type Physics2DJointType = 'revolute' | 'distance';
export type Physics2DJointTarget = Entity | string | number;

export interface Physics2DJointOptions {
  type?: Physics2DJointType;
  bodyA: Physics2DJointTarget;
  bodyB: Physics2DJointTarget;
  anchor?: [number, number] | undefined;
  anchorA?: [number, number] | undefined;
  anchorB?: [number, number] | undefined;
  collideConnected?: boolean;
  enableLimit?: boolean;
  lowerAngle?: number;
  upperAngle?: number;
  enableMotor?: boolean;
  motorSpeed?: number;
  maxMotorTorque?: number;
  length?: number | undefined;
  frequencyHz?: number;
  dampingRatio?: number;
}

export class Physics2DJoint extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Physics2DJoint');
  static editor = {
    fields: {
      type: { type: 'string', label: 'Joint Type' },
      bodyA: { type: 'string', label: 'Body A' },
      bodyB: { type: 'string', label: 'Body B' },
      anchor: { type: 'json', label: 'Anchor', rows: 2 },
      anchorA: { type: 'json', label: 'Anchor A', rows: 2 },
      anchorB: { type: 'json', label: 'Anchor B', rows: 2 },
      collideConnected: { type: 'boolean', label: 'Collide Connected' },
      enableLimit: { type: 'boolean', label: 'Enable Limit' },
      lowerAngle: { type: 'number', label: 'Lower Angle', step: 0.01 },
      upperAngle: { type: 'number', label: 'Upper Angle', step: 0.01 },
      enableMotor: { type: 'boolean', label: 'Enable Motor' },
      motorSpeed: { type: 'number', label: 'Motor Speed', step: 0.01 },
      maxMotorTorque: { type: 'number', label: 'Max Motor Torque', min: 0, step: 0.01 },
      length: { type: 'number', label: 'Length', min: 0, step: 1 },
      frequencyHz: { type: 'number', label: 'Frequency Hz', min: 0, step: 0.01 },
      dampingRatio: { type: 'number', label: 'Damping Ratio', min: 0, step: 0.01 },
    },
  };

  type: Physics2DJointType;
  bodyA: Physics2DJointTarget;
  bodyB: Physics2DJointTarget;
  anchor: [number, number] | null;
  anchorA: [number, number] | null;
  anchorB: [number, number] | null;
  collideConnected: boolean;
  enableLimit: boolean;
  lowerAngle: number;
  upperAngle: number;
  enableMotor: boolean;
  motorSpeed: number;
  maxMotorTorque: number;
  length: number | null;
  frequencyHz: number;
  dampingRatio: number;
  constructor(options: Physics2DJointOptions) {
    super('Physics2DJoint');
    this.type = options.type ?? 'revolute';
    this.bodyA = options.bodyA;
    this.bodyB = options.bodyB;
    this.anchor = options.anchor ?? null;
    this.anchorA = options.anchorA ?? null;
    this.anchorB = options.anchorB ?? null;
    this.collideConnected = options.collideConnected ?? false;
    this.enableLimit = options.enableLimit ?? false;
    this.lowerAngle = options.lowerAngle ?? 0;
    this.upperAngle = options.upperAngle ?? 0;
    this.enableMotor = options.enableMotor ?? false;
    this.motorSpeed = options.motorSpeed ?? 0;
    this.maxMotorTorque = options.maxMotorTorque ?? 0;
    this.length = options.length ?? null;
    this.frequencyHz = options.frequencyHz ?? 0;
    this.dampingRatio = options.dampingRatio ?? 0;
  }

  /** Runtime-only, backend-neutral handle. Null until the system creates the joint. */
  get handle(): Physics2DJointHandle | null {
    return getPhysics2DJointHandle(this);
  }
}
