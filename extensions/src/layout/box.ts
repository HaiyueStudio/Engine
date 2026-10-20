import {LayoutError} from './types.js';
import type {Edges, LayoutEdges, LayoutLength, LayoutNode, LayoutRect, LayoutStyle, Size} from './types.js';

export function length(value: LayoutLength | undefined, containing: number | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && containing !== undefined) return containing * value.percent / 100;
  return undefined;
}
export function edges(value: LayoutEdges | undefined, width: number | undefined, height: number | undefined, inset = false): Edges {
  const vertical = inset ? height : width;
  return {left: length(value?.left, width) ?? 0, right: length(value?.right, width) ?? 0, top: length(value?.top, vertical) ?? 0, bottom: length(value?.bottom, vertical) ?? 0};
}
export function boxMinimum(style: LayoutStyle, axis: 'width' | 'height', containingWidth: number | undefined): number {
  const p = edges(style.padding, containingWidth, undefined), b = edges(style.border, containingWidth, undefined);
  return axis === 'width' ? p.left + p.right + b.left + b.right : p.top + p.bottom + b.top + b.bottom;
}
export function clampDimension(style: LayoutStyle, axis: 'width' | 'height', value: number, containing: number | undefined, floor = 0): number {
  const min = length(axis === 'width' ? style.minWidth : style.minHeight, containing) ?? 0;
  const max = length(axis === 'width' ? style.maxWidth : style.maxHeight, containing) ?? Infinity;
  return Math.max(min, floor, Math.min(max, Math.max(0, value)));
}
export function dimensions(style: LayoutStyle, intrinsic: Size, width: number | undefined, height: number | undefined): Size {
  const w = length(style.width, width), h = length(style.height, height);
  const minW = boxMinimum(style, 'width', width), minH = boxMinimum(style, 'height', width);
  let result = {width: clampDimension(style, 'width', w ?? intrinsic.width, width, minW), height: clampDimension(style, 'height', h ?? intrinsic.height, height, minH)};
  if (style.aspectRatio !== undefined) {
    if (w !== undefined && h === undefined) result.height = clampDimension(style, 'height', result.width / style.aspectRatio, height, minH);
    else if (h !== undefined && w === undefined) result.width = clampDimension(style, 'width', result.height * style.aspectRatio, width, minW);
  }
  return result;
}
export function innerBox(rect: LayoutRect, style: LayoutStyle, containingWidth = rect.width, containingHeight = rect.height): LayoutRect {
  const p = edges(style.padding, containingWidth, containingHeight), b = edges(style.border, rect.width, rect.height);
  return {x: rect.x + p.left + b.left, y: rect.y + p.top + b.top, width: Math.max(0, rect.width - p.left - p.right - b.left - b.right), height: Math.max(0, rect.height - p.top - p.bottom - b.top - b.bottom)};
}
export function relativeRect(rect: LayoutRect, style: LayoutStyle, parent: LayoutRect): LayoutRect {
  const e = edges(style.inset, parent.width, parent.height, true);
  const startX = style.inset?.left !== undefined && style.inset.left !== 'auto' && !(style.writingDirection === 'rtl' && style.inset.right !== undefined && style.inset.right !== 'auto');
  const startY = style.inset?.top !== undefined && style.inset.top !== 'auto';
  return {...rect, x: rect.x + (startX ? e.left : -e.right), y: rect.y + (startY ? e.top : -e.bottom)};
}
export function absoluteRect(node: LayoutNode, parent: LayoutRect, intrinsic: Size): LayoutRect {
  const style = node.style, e = edges(style.inset, parent.width, parent.height, true), size = dimensions(style, intrinsic, parent.width, parent.height);
  const margin = edges(style.margin, parent.width, parent.height);
  const left = length(style.inset?.left, parent.width), right = length(style.inset?.right, parent.width), top = length(style.inset?.top, parent.height), bottom = length(style.inset?.bottom, parent.height);
  const stretchW = length(style.width, parent.width) === undefined && left !== undefined && right !== undefined;
  const stretchH = length(style.height, parent.height) === undefined && top !== undefined && bottom !== undefined;
  const width = stretchW ? clampDimension(style, 'width', parent.width - e.left - e.right - margin.left - margin.right, parent.width, boxMinimum(style, 'width', parent.width)) : size.width;
  const height = stretchH ? clampDimension(style, 'height', parent.height - e.top - e.bottom - margin.top - margin.bottom, parent.height, boxMinimum(style, 'height', parent.width)) : size.height;
  const x = style.writingDirection === 'rtl' && right !== undefined ? parent.width - right - width - margin.right : left !== undefined ? left + margin.left : right === undefined ? margin.left : parent.width - right - width - margin.right;
  const y = top !== undefined ? top + margin.top : bottom === undefined ? margin.top : parent.height - bottom - height - margin.bottom;
  return {x: parent.x + x, y: parent.y + y, width, height};
}
export function distribute(mode: string, available: number, used: number, count: number): {start: number; between: number} {
  const remaining = Math.max(0, available - used);
  switch (mode) {
    case 'center': return {start: remaining / 2, between: 0};
    case 'end': return {start: remaining, between: 0};
    case 'space-between': return {start: 0, between: count > 1 ? remaining / (count - 1) : 0};
    case 'space-around': return {start: count ? remaining / count / 2 : 0, between: count ? remaining / count : 0};
    case 'space-evenly': return {start: remaining / (count + 1), between: remaining / (count + 1)};
    default: return {start: 0, between: 0};
  }
}
export function assertFiniteRect(rect: LayoutRect, id: string): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) throw new LayoutError('invalid-input', 'Layout arithmetic produced an invalid rectangle.', id);
}
