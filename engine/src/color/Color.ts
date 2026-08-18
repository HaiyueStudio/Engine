export type BuiltinColorSpace = 'srgb' | 'linear' | 'hsl';

/** Structural color contract used by materials, renderers, plugins, and cross-bundle values. */
export interface ColorValue {
  readonly colorSpace: string;
  readonly version: number;
  a: number;
  clone(): ColorValue;
  setFromSRGB(r: number, g: number, b: number, a?: number): ColorValue;
  setFromLinear(r: number, g: number, b: number, a?: number): ColorValue;
  writeSRGB(out: Float32Array, offset?: number): Float32Array;
  writeLinear(out: Float32Array, offset?: number): Float32Array;
}

/**
 * Base for mutable color models.
 *
 * Subclasses expose model-specific channels while this base keeps synchronized
 * sRGB and linear RGBA buffers ready for GPU uniform/storage writes.
 */
export abstract class Color implements ColorValue {
  abstract readonly colorSpace: BuiltinColorSpace | (string & {});

  private readonly _srgbData = new Float32Array(4);
  private readonly _linearData = new Float32Array(4);
  private _a: number;
  private _version = 0;

  protected constructor(a = 1) {
    this._a = a;
    this._srgbData[3] = a;
    this._linearData[3] = a;
  }

  get version(): number { return this._version; }

  get a(): number { return this._a; }
  set a(value: number) {
    if (this._a === value) return;
    this._a = value;
    this._srgbData[3] = value;
    this._linearData[3] = value;
    this._version++;
  }

  abstract clone(): Color;
  abstract setFromSRGB(r: number, g: number, b: number, a?: number): this;
  abstract setFromLinear(r: number, g: number, b: number, a?: number): this;

  writeSRGB(out: Float32Array, offset = 0): Float32Array {
    out.set(this._srgbData, offset);
    return out;
  }

  writeLinear(out: Float32Array, offset = 0): Float32Array {
    out.set(this._linearData, offset);
    return out;
  }

  protected syncGPUFromSRGB(r: number, g: number, b: number, a = this._a): void {
    this._srgbData[0] = r;
    this._srgbData[1] = g;
    this._srgbData[2] = b;
    this._srgbData[3] = a;
    this._linearData[0] = srgbToLinear(r);
    this._linearData[1] = srgbToLinear(g);
    this._linearData[2] = srgbToLinear(b);
    this._linearData[3] = a;
    this._a = a;
    this._version++;
  }

  protected syncGPUFromLinear(r: number, g: number, b: number, a = this._a): void {
    this._linearData[0] = r;
    this._linearData[1] = g;
    this._linearData[2] = b;
    this._linearData[3] = a;
    this._srgbData[0] = linearToSRGB(r);
    this._srgbData[1] = linearToSRGB(g);
    this._srgbData[2] = linearToSRGB(b);
    this._srgbData[3] = a;
    this._a = a;
    this._version++;
  }
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSRGB(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
