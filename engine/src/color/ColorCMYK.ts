import { Color, linearToSRGB } from './Color';
import { ColorSRGB } from './ColorSRGB';

/**
 * Uncalibrated device CMYK, normalized ink coverage in [0, 1].
 * Uses the CSS Color 5 naive CMYK ↔ sRGB conversion, not an ICC print profile.
 * GPU consumers use the inherited cached sRGB/linear RGBA writers.
 */
export class ColorCMYK extends Color {
  readonly colorSpace = 'cmyk' as const;
  private _c: number;
  private _m: number;
  private _y: number;
  private _k: number;

  constructor(c = 0, m = 0, y = 0, k = 0, a = 1) {
    super(unit(a));
    this._c = unit(c); this._m = unit(m); this._y = unit(y); this._k = unit(k);
    this.sync(a);
  }
  get c(): number { return this._c; }
  set c(value: number) { this.set(value, this._m, this._y, this._k, this.a); }
  get m(): number { return this._m; }
  set m(value: number) { this.set(this._c, value, this._y, this._k, this.a); }
  get y(): number { return this._y; }
  set y(value: number) { this.set(this._c, this._m, value, this._k, this.a); }
  get k(): number { return this._k; }
  set k(value: number) { this.set(this._c, this._m, this._y, value, this.a); }
  override get a(): number { return super.a; }
  override set a(value: number) { super.a = unit(value); }

  set(c: number, m: number, y: number, k: number, a = this.a): this {
    unit(c); unit(m); unit(y); unit(k); unit(a);
    if (c === this._c && m === this._m && y === this._y && k === this._k && a === this.a) return this;
    this._c = c; this._m = m; this._y = y; this._k = k; this.sync(a); return this;
  }
  setFromSRGB(r: number, g: number, b: number, a = this.a): this {
    unit(r); unit(g); unit(b); unit(a);
    const light = Math.max(r, g, b), k = 1 - light;
    return this.set(light ? 1 - r / light : 0, light ? 1 - g / light : 0, light ? 1 - b / light : 0, k, a);
  }
  /** CMYK is bounded: HDR / negative RGB cannot be represented and is rejected. */
  setFromLinear(r: number, g: number, b: number, a = this.a): this {
    unit(r); unit(g); unit(b); unit(a);
    return this.setFromSRGB(Math.min(1, linearToSRGB(r)), Math.min(1, linearToSRGB(g)), Math.min(1, linearToSRGB(b)), a);
  }
  clone(): ColorCMYK { return new ColorCMYK(this._c, this._m, this._y, this._k, this.a); }
  toSRGB(): ColorSRGB { const light = 1 - this._k; return new ColorSRGB((1 - this._c) * light, (1 - this._m) * light, (1 - this._y) * light, this.a); }
  toArray(): [number, number, number, number, number] { return [this._c, this._m, this._y, this._k, this.a]; }
  private sync(a = this.a): void { const light = 1 - this._k; this.syncGPUFromSRGB((1 - this._c) * light, (1 - this._m) * light, (1 - this._y) * light, a); }
}
function unit(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('CMYK channels and alpha must be finite values in [0, 1].');
  return value;
}
