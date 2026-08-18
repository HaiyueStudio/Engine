import { Color, linearToSRGB, srgbToLinear } from './Color';

/** Color edited in display-encoded sRGB space (r,g,b,a all normally in [0,1]). */
export class ColorSRGB extends Color {
  readonly colorSpace = 'srgb' as const;

  private _r: number;
  private _g: number;
  private _b: number;

  constructor(r = 1, g = 1, b = 1, a = 1) {
    super(a);
    this._r = r;
    this._g = g;
    this._b = b;
    this.syncGPUFromSRGB(r, g, b, a);
  }

  get r(): number { return this._r; }
  set r(value: number) { if (this._r !== value) { this._r = value; this.syncGPUFromSRGB(this._r, this._g, this._b); } }
  get g(): number { return this._g; }
  set g(value: number) { if (this._g !== value) { this._g = value; this.syncGPUFromSRGB(this._r, this._g, this._b); } }
  get b(): number { return this._b; }
  set b(value: number) { if (this._b !== value) { this._b = value; this.syncGPUFromSRGB(this._r, this._g, this._b); } }

  set(r: number, g: number, b: number, a = 1): this {
    this._r = r; this._g = g; this._b = b;
    this.syncGPUFromSRGB(r, g, b, a);
    return this;
  }

  setFromSRGB(r: number, g: number, b: number, a = this.a): this {
    return this.set(r, g, b, a);
  }

  setFromLinear(r: number, g: number, b: number, a = this.a): this {
    return this.set(linearToSRGB(r), linearToSRGB(g), linearToSRGB(b), a);
  }

  clone(): ColorSRGB {
    return new ColorSRGB(this._r, this._g, this._b, this.a);
  }

  toArray(): [number, number, number, number] {
    return [this._r, this._g, this._b, this.a];
  }

  toFloat32Array(out = new Float32Array(4)): Float32Array {
    return this.writeSRGB(out);
  }

  toHex(): string {
    const toHex2 = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toHex2(this._r)}${toHex2(this._g)}${toHex2(this._b)}`;
  }

  /** Convert sRGB component to linear */
  static srgbToLinear(c: number): number {
    return srgbToLinear(c);
  }

  /** Convert linear component to sRGB */
  static linearToSRGB(c: number): number {
    return linearToSRGB(c);
  }

  static fromHex(hex: string): ColorSRGB {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return new ColorSRGB(r, g, b, a);
  }

  /** Create sRGB color from 0-255 integer components */
  static fromBytes(r: number, g: number, b: number, a = 255): ColorSRGB {
    return new ColorSRGB(r / 255, g / 255, b / 255, a / 255);
  }
}
