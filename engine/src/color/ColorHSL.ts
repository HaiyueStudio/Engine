import { ColorSRGB } from './ColorSRGB';
import { Color } from './Color';

/** Color edited in HSL space. HSL is converted through display-encoded sRGB. */
export class ColorHSL extends Color {
  readonly colorSpace = 'hsl' as const;

  /** Hue in degrees [0, 360) */
  private _h: number;
  /** Saturation [0, 1] */
  private _s: number;
  /** Lightness [0, 1] */
  private _l: number;

  constructor(h = 0, s = 1, l = 0.5, a = 1) {
    super(a);
    this._h = h;
    this._s = s;
    this._l = l;
    this.syncSRGB(a);
  }

  get h(): number { return this._h; }
  set h(value: number) { if (this._h !== value) { this._h = value; this.syncSRGB(); } }
  get s(): number { return this._s; }
  set s(value: number) { if (this._s !== value) { this._s = value; this.syncSRGB(); } }
  get l(): number { return this._l; }
  set l(value: number) { if (this._l !== value) { this._l = value; this.syncSRGB(); } }

  set(h: number, s: number, l: number, a = 1): this {
    this._h = h; this._s = s; this._l = l;
    this.syncSRGB(a);
    return this;
  }

  setFromSRGB(r: number, g: number, b: number, a = this.a): this {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1));
      if (max === r) h = 60 * (((g - b) / delta + 6) % 6);
      else if (max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
    }
    return this.set(h, s, l, a);
  }

  setFromLinear(r: number, g: number, b: number, a = this.a): this {
    return this.setFromSRGB(
      ColorSRGB.linearToSRGB(r),
      ColorSRGB.linearToSRGB(g),
      ColorSRGB.linearToSRGB(b),
      a,
    );
  }

  toSRGB(): ColorSRGB {
    const [r, g, b] = this.toSRGBChannels();
    return new ColorSRGB(r, g, b, this.a);
  }

  clone(): ColorHSL {
    return new ColorHSL(this._h, this._s, this._l, this.a);
  }

  private syncSRGB(a = this.a): void {
    const [r, g, b] = this.toSRGBChannels();
    this.syncGPUFromSRGB(r, g, b, a);
  }

  private toSRGBChannels(): [number, number, number] {
    const h = ((this._h % 360) + 360) % 360;
    const s = this._s;
    const l = this._l;

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;

    let r = 0, g = 0, b = 0;
    if (h < 60)       { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }

    return [r + m, g + m, b + m];
  }

  static fromSRGB(color: ColorSRGB): ColorHSL {
    const r = color.r, g = color.g, b = color.b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const l = (max + min) / 2;
    let h = 0, s = 0;

    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1));
      if (max === r) h = 60 * (((g - b) / delta + 6) % 6);
      else if (max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
    }

    return new ColorHSL(h, s, l, color.a);
  }
}
