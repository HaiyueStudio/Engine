import { ColorSRGB } from '../color/ColorSRGB';
import { BasicMaterial, type BasicMaterialOptions } from './BasicMaterial';

export type CssPadding = number | [number, number] | [number, number, number, number];
export type CssVerticalAlign = 'top' | 'middle' | 'bottom';
export type CssWhiteSpace = 'normal' | 'pre-line';

export interface CssMaterialStyle {
  width?: number;
  height?: number;
  /** Canvas backing-store multiplier. Higher values are sharper and use more texture memory. Default 2. */
  resolutionScale?: number;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  padding?: CssPadding;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: CssVerticalAlign;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string | number;
  fontStyle?: string;
  lineHeight?: number;
  color?: string;
  whiteSpace?: CssWhiteSpace;
}

export interface CssMaterialOptions extends Omit<BasicMaterialOptions, 'texture'> {
  text?: string;
  style?: CssMaterialStyle;
}

const DEFAULT_STYLE: Required<CssMaterialStyle> = {
  width: 256,
  height: 96,
  resolutionScale: 2,
  backgroundColor: 'rgba(255,255,255,0)',
  borderColor: 'rgba(255,255,255,0)',
  borderWidth: 0,
  borderRadius: 0,
  padding: 12,
  textAlign: 'center',
  verticalAlign: 'middle',
  fontSize: 28,
  fontFamily: 'sans-serif',
  fontWeight: '400',
  fontStyle: 'normal',
  lineHeight: 1.2,
  color: '#ffffff',
  whiteSpace: 'normal',
};

export class CssMaterial extends BasicMaterial {
  private _text: string;
  private _style: CssMaterialStyle;
  textureVersion = 0;

  private _resolvedStyle: Required<CssMaterialStyle> = { ...DEFAULT_STYLE };
  private _dirty = true;
  private _updating = false;
  private _updateToken = 0;
  private _canvas: HTMLCanvasElement | null = null;

  get text(): string { return this._text; }
  set text(value: string) { this.setText(value); }
  get style(): CssMaterialStyle { return this._style; }
  set style(value: CssMaterialStyle) { this.setStyle(value); }

  constructor(options: CssMaterialOptions = {}) {
    super({
      color: options.color ?? new ColorSRGB(1, 1, 1, 1),
      blending: options.blending ?? 'normal',
      depthWrite: options.depthWrite ?? false,
      cullMode: options.cullMode ?? 'none',
      frontFace: options.frontFace ?? null,
      texture: null,
    });
    this._text = resolveCssText(options.text ?? 'Text');
    this._style = resolveCssStyle(options.style ?? {});
    this._updateResolvedStyle();
    void this.updateTexture();
  }

  setText(text: string): this {
    const next = resolveCssText(text);
    if (this._text === next) return this;
    this._text = next;
    this.markDirty();
    return this;
  }

  setStyle(style: CssMaterialStyle): this {
    const next = resolveCssStyle(style);
    if (sameCssStyle(this._style, next)) return this;
    this._style = next;
    this._updateResolvedStyle();
    this.markDirty();
    return this;
  }

  patchStyle(style: CssMaterialStyle): this {
    return this.setStyle({ ...this._style, ...style });
  }

  override markDirty(): this {
    super.markDirty();
    this._dirty = true;
    void this.updateTexture();
    return this;
  }

  async updateTexture(): Promise<void> {
    if (!this._dirty || this._updating) return;
    if (typeof document === 'undefined') return;

    const token = ++this._updateToken;
    this._dirty = false;
    this._updating = true;
    try {
      const canvas = this._drawToCanvas();
      this.texture = canvas;
      this.textureVersion++;
      if (typeof createImageBitmap === 'undefined') return;
      const bitmap = await createImageBitmap(canvas, { colorSpaceConversion: 'none' });
      if (token !== this._updateToken) {
        bitmap.close?.();
        return;
      }
      this.texture = bitmap;
      this.textureVersion++;
    } finally {
      this._updating = false;
      if (this._dirty) void this.updateTexture();
    }
  }

  private _drawToCanvas(): HTMLCanvasElement {
    const style = this._getResolvedStyle();
    const width = Math.max(1, Math.floor(style.width));
    const height = Math.max(1, Math.floor(style.height));
    const dpr = Math.max(1, Math.min(4, style.resolutionScale));
    const canvas = this._canvas ?? document.createElement('canvas');
    this._canvas = canvas;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));

    const context = canvas.getContext('2d');
    if (!context) return canvas;
    context.scale(dpr, dpr);
    context.clearRect(0, 0, width, height);

    const borderWidth = Math.max(0, style.borderWidth);
    const radius = Math.max(0, style.borderRadius);
    if (style.backgroundColor !== 'transparent' || borderWidth > 0) {
      this._roundedRect(context, borderWidth / 2, borderWidth / 2, width - borderWidth, height - borderWidth, radius);
      if (style.backgroundColor !== 'transparent') {
        context.fillStyle = style.backgroundColor;
        context.fill();
      }
      if (borderWidth > 0) {
        context.strokeStyle = style.borderColor;
        context.lineWidth = borderWidth;
        context.stroke();
      }
    }

    const padding = this._normalizePadding(style.padding);
    const contentX = padding[3];
    const contentY = padding[0];
    const contentWidth = Math.max(1, width - padding[1] - padding[3]);
    const contentHeight = Math.max(1, height - padding[0] - padding[2]);
    const fontSize = Math.max(1, style.fontSize);
    const lineHeight = Math.max(1, typeof style.lineHeight === 'number' && style.lineHeight < 4 ? fontSize * style.lineHeight : style.lineHeight);

    context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
    context.fillStyle = style.color;
    context.textBaseline = 'middle';
    context.textAlign = style.textAlign;

    const lines = this._layoutLines(context, this.text, contentWidth, style.whiteSpace);
    const textHeight = lines.length * lineHeight;
    let y = contentY;
    if (style.verticalAlign === 'middle') y += Math.max(0, (contentHeight - textHeight) / 2);
    else if (style.verticalAlign === 'bottom') y += Math.max(0, contentHeight - textHeight);
    y += lineHeight / 2;

    const x = style.textAlign === 'left'
      ? contentX
      : style.textAlign === 'right'
        ? contentX + contentWidth
        : contentX + contentWidth / 2;
    for (const line of lines) {
      context.fillText(line, x, y);
      y += lineHeight;
    }
    return canvas;
  }

  private _getResolvedStyle(): Required<CssMaterialStyle> {
    return this._resolvedStyle;
  }

  private _updateResolvedStyle(): void {
    const target = this._resolvedStyle;
    target.width = this.style.width ?? DEFAULT_STYLE.width;
    target.height = this.style.height ?? DEFAULT_STYLE.height;
    target.resolutionScale = this.style.resolutionScale ?? DEFAULT_STYLE.resolutionScale;
    target.backgroundColor = this.style.backgroundColor ?? DEFAULT_STYLE.backgroundColor;
    target.borderColor = this.style.borderColor ?? DEFAULT_STYLE.borderColor;
    target.borderWidth = this.style.borderWidth ?? DEFAULT_STYLE.borderWidth;
    target.borderRadius = this.style.borderRadius ?? DEFAULT_STYLE.borderRadius;
    target.padding = this.style.padding ?? DEFAULT_STYLE.padding;
    target.textAlign = this.style.textAlign ?? DEFAULT_STYLE.textAlign;
    target.verticalAlign = this.style.verticalAlign ?? DEFAULT_STYLE.verticalAlign;
    target.fontSize = this.style.fontSize ?? DEFAULT_STYLE.fontSize;
    target.fontFamily = this.style.fontFamily ?? DEFAULT_STYLE.fontFamily;
    target.fontWeight = this.style.fontWeight ?? DEFAULT_STYLE.fontWeight;
    target.fontStyle = this.style.fontStyle ?? DEFAULT_STYLE.fontStyle;
    target.lineHeight = this.style.lineHeight ?? DEFAULT_STYLE.lineHeight;
    target.color = this.style.color ?? DEFAULT_STYLE.color;
    target.whiteSpace = this.style.whiteSpace ?? DEFAULT_STYLE.whiteSpace;
  }

  private _normalizePadding(padding: CssPadding): [number, number, number, number] {
    if (typeof padding === 'number') return [padding, padding, padding, padding];
    if (padding.length === 2) return [padding[0], padding[1], padding[0], padding[1]];
    return padding;
  }

  private _layoutLines(context: CanvasRenderingContext2D, text: string, maxWidth: number, whiteSpace: CssWhiteSpace): string[] {
    const sourceLines = whiteSpace === 'pre-line' ? text.split(/\r?\n/) : text.replace(/\s+/g, ' ').split(/\r?\n/);
    const lines: string[] = [];
    for (const source of sourceLines) {
      if (!source) {
        lines.push('');
        continue;
      }
      let current = '';
      for (const word of source.split(/(\s+)/).filter(Boolean)) {
        const next = current ? `${current}${word}` : word.trimStart();
        if (current && context.measureText(next).width > maxWidth) {
          lines.push(current.trimEnd());
          current = word.trimStart();
        } else {
          current = next;
        }
      }
      lines.push(current.trimEnd());
    }
    return lines.length ? lines : [''];
  }

  private _roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }
}

const CSS_STYLE_KEYS = Object.freeze([
  'width', 'height', 'resolutionScale', 'backgroundColor', 'borderColor', 'borderWidth',
  'borderRadius', 'padding', 'textAlign', 'verticalAlign', 'fontSize', 'fontFamily',
  'fontWeight', 'fontStyle', 'lineHeight', 'color', 'whiteSpace',
] as const satisfies readonly (keyof CssMaterialStyle)[]);

function resolveCssText(value: string): string {
  if (typeof value !== 'string') throw new TypeError(`CssMaterial.text must be a string; received ${String(value)}.`);
  return value;
}

function resolveCssStyle(value: CssMaterialStyle): CssMaterialStyle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('CssMaterial.style must be an object.');
  }
  const allowed = new Set<string>(CSS_STYLE_KEYS);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RangeError(`Unknown CssMaterial.style property "${key}".`);
  }
  for (const key of ['width', 'height', 'resolutionScale', 'borderWidth', 'borderRadius', 'fontSize', 'lineHeight'] as const) {
    const entry = value[key];
    if (entry !== undefined && !Number.isFinite(entry)) {
      throw new RangeError(`CssMaterial.style.${key} must be finite; received ${entry}.`);
    }
  }
  const padding = value.padding;
  let resolvedPadding: CssPadding | undefined;
  if (padding !== undefined) {
    const entries = typeof padding === 'number' ? [padding] : [...padding];
    if (entries.length !== 1 && entries.length !== 2 && entries.length !== 4) {
      throw new RangeError('CssMaterial.style.padding must be a number or a 2/4-value tuple.');
    }
    if (entries.some(entry => !Number.isFinite(entry))) {
      throw new RangeError('CssMaterial.style.padding values must be finite.');
    }
    resolvedPadding = typeof padding === 'number' ? padding : Object.freeze(entries) as CssPadding;
  }
  return Object.freeze({
    ...value,
    ...(resolvedPadding === undefined ? {} : { padding: resolvedPadding }),
  });
}

function sameCssStyle(a: CssMaterialStyle, b: CssMaterialStyle): boolean {
  return CSS_STYLE_KEYS.every(key => {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((entry, index) => entry === right[index]);
    }
    return left === right;
  });
}
