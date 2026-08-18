import { UniqueCheckType } from '../ecs/Component';
import { CartesianTransform3D } from './CartesianTransform3D';

export interface FixedScreenTransform3DOptions {
  left?: number | undefined;
  right?: number | undefined;
  top?: number | undefined;
  bottom?: number | undefined;
  width: number;
  height: number;
  z?: number;
  scale?: [number, number, number];
}

export interface FixedScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Transform3D variant for screen-fixed UI planes.
 * Distances are CSS pixels relative to the visible browser viewport, similar to
 * `position: fixed`. FixedScreenTransform3DSystem converts them into camera
 * world coordinates before rendering.
 */
export class FixedScreenTransform3D extends CartesianTransform3D {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Transform3D');

  left: number | undefined;
  right: number | undefined;
  top: number | undefined;
  bottom: number | undefined;
  width: number;
  height: number;
  z: number;
  readonly localScale: [number, number, number];
  readonly screenRect: FixedScreenRect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(options: FixedScreenTransform3DOptions) {
    super();
    this.name = 'FixedScreenTransform3D';
    this.left = options.left;
    this.right = options.right;
    this.top = options.top;
    this.bottom = options.bottom;
    this.width = Math.max(0, options.width);
    this.height = Math.max(0, options.height);
    this.z = options.z ?? 0;
    this.localScale = options.scale ? [...options.scale] : [1, 1, 1];
  }

  setInsets(options: Partial<Pick<FixedScreenTransform3DOptions, 'left' | 'right' | 'top' | 'bottom'>>): this {
    if ('left' in options) this.left = options.left;
    if ('right' in options) this.right = options.right;
    if ('top' in options) this.top = options.top;
    if ('bottom' in options) this.bottom = options.bottom;
    this.markDirty();
    return this;
  }

  setScreenSize(width: number, height: number): this {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.markDirty();
    return this;
  }

  setLocalScale(x: number, y: number, z = 1): this {
    this.localScale[0] = x;
    this.localScale[1] = y;
    this.localScale[2] = z;
    this.markDirty();
    return this;
  }

  containsClientPoint(clientX: number, clientY: number): boolean {
    const rect = this.screenRect;
    return clientX >= rect.x
      && clientX <= rect.x + rect.width
      && clientY >= rect.y
      && clientY <= rect.y + rect.height;
  }

  override clone(): FixedScreenTransform3D {
    return new FixedScreenTransform3D({
      left: this.left,
      right: this.right,
      top: this.top,
      bottom: this.bottom,
      width: this.width,
      height: this.height,
      z: this.z,
      scale: [...this.localScale],
    });
  }
}
