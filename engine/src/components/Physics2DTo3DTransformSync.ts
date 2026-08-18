import { Component, UniqueCheckType } from '../ecs/Component';
import type { Entity } from '../ecs/Entity';

export type Physics2DTo3DPlane = 'xy' | 'xz' | 'yz';
export type Physics2DTo3DRotationAxis = 'x' | 'y' | 'z' | 'none';
export type Physics2DTo3DSource = Entity | string | number | null;

export interface Physics2DTo3DTransformSyncOptions {
  sourceEntity?: Physics2DTo3DSource;
  plane?: Physics2DTo3DPlane;
  fixedAxisValue?: number;
  offset?: [number, number, number];
  syncRotation?: boolean;
  rotationAxis?: Physics2DTo3DRotationAxis;
  rotationOffset?: number;
}

export class Physics2DTo3DTransformSync extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Physics2DTo3DTransformSync');
  static editor = {
    fields: {
      sourceEntity: { type: 'string', label: 'Source Entity' },
      plane: { type: 'string', label: 'Plane' },
      fixedAxisValue: { type: 'number', label: 'Fixed Axis', step: 0.01 },
      offset: { type: 'json', label: 'Offset', rows: 2 },
      syncRotation: { type: 'boolean', label: 'Sync Rotation' },
      rotationAxis: { type: 'string', label: 'Rotation Axis' },
      rotationOffset: { type: 'number', label: 'Rotation Offset', step: 0.01 },
    },
  };

  sourceEntity: Physics2DTo3DSource;
  plane: Physics2DTo3DPlane;
  fixedAxisValue: number;
  offset: [number, number, number];
  syncRotation: boolean;
  rotationAxis: Physics2DTo3DRotationAxis;
  rotationOffset: number;

  constructor(options: Physics2DTo3DTransformSyncOptions = {}) {
    super('Physics2DTo3DTransformSync');
    this.sourceEntity = options.sourceEntity ?? null;
    this.plane = options.plane ?? 'xz';
    this.fixedAxisValue = options.fixedAxisValue ?? 0;
    this.offset = options.offset ? [...options.offset] : [0, 0, 0];
    this.syncRotation = options.syncRotation ?? true;
    this.rotationAxis = options.rotationAxis ?? 'y';
    this.rotationOffset = options.rotationOffset ?? 0;
  }
}
