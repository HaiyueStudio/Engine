import { Component, UniqueCheckType } from '../ecs/Component';
import type { BitmapFontData } from '../font/BitmapFontData';
import type { ColorValue } from '../color/Color';
import { resolveColor, type ColorLike } from '../color/ColorLike';

export type BitmapFontMode = 'normal' | 'sdf' | 'msdf';

export interface BitmapTextOptions {
  mode?: BitmapFontMode;
  color?: ColorLike;
  /** Override the render size in world units (default: font.size) */
  fontSize?: number;
  /** Line spacing multiplier (default: 1.0) */
  lineSpacing?: number;
  /** Extra spacing between characters in font units (default: 0) */
  letterSpacing?: number;
  /** SDF/MSDF: alpha threshold (default: 0.5) */
  threshold?: number;
  /** SDF/MSDF: edge smoothing half-width (default: 0.1) */
  smoothing?: number;
}

export class BitmapText extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('BitmapText');

  font: BitmapFontData;
  mode: BitmapFontMode;
  private _color: ColorValue;
  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) { this._color = resolveColor(value); this._dirty = true; }
  fontSize: number;
  lineSpacing: number;
  letterSpacing: number;
  threshold: number;
  smoothing: number;

  private _text: string;
  private _dirty = true;

  constructor(font: BitmapFontData, text: string, options: BitmapTextOptions = {}) {
    super('BitmapText');
    this.font         = font;
    this._text        = text;
    this.mode         = options.mode         ?? 'normal';
    this._color       = resolveColor(options.color);
    this.fontSize     = options.fontSize     ?? font.size;
    this.lineSpacing  = options.lineSpacing  ?? 1.0;
    this.letterSpacing = options.letterSpacing ?? 0;
    this.threshold    = options.threshold    ?? 0.5;
    this.smoothing    = options.smoothing    ?? 0.1;
  }

  get text(): string { return this._text; }
  set text(v: string) {
    if (this._text !== v) {
      this._text = v;
      this._dirty = true;
    }
  }

  get dirty(): boolean { return this._dirty; }
  clearDirty(): void { this._dirty = false; }
}
