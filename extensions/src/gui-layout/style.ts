import {LayoutError} from '../layout.js';
import type {LayoutStyle} from '../layout.js';
import type {GuiLayoutStyle} from './types.js';

export function coreStyle(style: GuiLayoutStyle = {}): LayoutStyle {
  const {anchors: _anchors, offsets: _offsets, contentMinimum: _minimum, ...result} = style;
  return result;
}
export function captureGuiLayoutStyle(style: GuiLayoutStyle): GuiLayoutStyle {
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new LayoutError('invalid-input', 'GUI layout style must be a data object.');
  if (style.contentMinimum !== undefined && typeof style.contentMinimum !== 'boolean') throw new LayoutError('invalid-input', 'contentMinimum must be a boolean.');
  if (style.offsets && !style.anchors) throw new LayoutError('invalid-input', 'Anchor offsets require anchors.');
  if (style.anchors) {
    if (style.inset) throw new LayoutError('invalid-input', 'Anchors and inset cannot own the same manual position.');
    if (Object.keys(style.anchors).length !== 4 || !['left', 'top', 'right', 'bottom'].every(key => Object.hasOwn(style.anchors!, key))) throw new LayoutError('invalid-input', 'Anchors require all four edges.');
    for (const n of Object.values(style.anchors)) if (!Number.isFinite(n) || n < 0 || n > 1) throw new LayoutError('invalid-input', 'Anchors must be finite fractions between zero and one.');
    if (style.anchors.left > style.anchors.right || style.anchors.top > style.anchors.bottom) throw new LayoutError('invalid-input', 'Anchor end must not precede its start.');
  }
  if (style.offsets) for (const [key, value] of Object.entries(style.offsets)) if (!['left', 'top', 'right', 'bottom'].includes(key) || !Number.isFinite(value)) throw new LayoutError('invalid-input', 'Invalid anchor offset.');
  // Preserve invalid numbers for core validation rather than JSON-normalizing them to null.
  const active = new WeakSet<object>();
  const clone = (value: unknown): unknown => {
    if (value && typeof value === 'object') {
      if (active.has(value)) throw new LayoutError('cycle', 'Cyclic GUI layout style.');
      active.add(value);
      const result = Array.isArray(value) ? Object.freeze(value.map(clone)) : Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])));
      active.delete(value); return result;
    }
    return value;
  };
  return clone(style) as GuiLayoutStyle;
}
/** Anchor units become ordinary absolute insets; the core owns sizing/min/max/ratio. */
export function anchoredStyle(style: GuiLayoutStyle, width: number, height: number): LayoutStyle {
  const a = style.anchors!, o = style.offsets;
  return {...coreStyle(style), position: 'absolute', width: style.width ?? 'auto', height: style.height ?? 'auto', inset: {
    left: a.left * width + (o?.left ?? 0), right: (1 - a.right) * width - (o?.right ?? 0),
    top: a.top * height + (o?.top ?? 0), bottom: (1 - a.bottom) * height - (o?.bottom ?? 0),
  }};
}
