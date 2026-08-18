import { ColorSRGB } from './ColorSRGB';
import { Color } from './Color';

/** Color edited in linear RGB space. */
export class ColorLinear extends Color {
  readonly colorSpace = 'linear' as const;

  private _r: number;
  private _g: number;
  private _b: number;

  constructor(r = 1, g = 1, b = 1, a = 1) {
    super(a);
    this._r = r;
    this._g = g;
    this._b = b;
    this.syncGPUFromLinear(r, g, b, a);
  }

  get r(): number { return this._r; }
  set r(value: number) { if (this._r !== value) { this._r = value; this.syncGPUFromLinear(this._r, this._g, this._b); } }
  get g(): number { return this._g; }
  set g(value: number) { if (this._g !== value) { this._g = value; this.syncGPUFromLinear(this._r, this._g, this._b); } }
  get b(): number { return this._b; }
  set b(value: number) { if (this._b !== value) { this._b = value; this.syncGPUFromLinear(this._r, this._g, this._b); } }

  set(r: number, g: number, b: number, a = 1): this {
    this._r = r; this._g = g; this._b = b;
    this.syncGPUFromLinear(r, g, b, a);
    return this;
  }

  setFromSRGB(r: number, g: number, b: number, a = this.a): this {
    return this.set(ColorSRGB.srgbToLinear(r), ColorSRGB.srgbToLinear(g), ColorSRGB.srgbToLinear(b), a);
  }

  setFromLinear(r: number, g: number, b: number, a = this.a): this {
    return this.set(r, g, b, a);
  }

  toSRGB(): ColorSRGB {
    return new ColorSRGB(
      ColorSRGB.linearToSRGB(this._r),
      ColorSRGB.linearToSRGB(this._g),
      ColorSRGB.linearToSRGB(this._b),
      this.a,
    );
  }

  clone(): ColorLinear {
    return new ColorLinear(this._r, this._g, this._b, this.a);
  }

  static fromSRGB(color: ColorSRGB): ColorLinear {
    return new ColorLinear(
      ColorSRGB.srgbToLinear(color.r),
      ColorSRGB.srgbToLinear(color.g),
      ColorSRGB.srgbToLinear(color.b),
      color.a,
    );
  }
}
