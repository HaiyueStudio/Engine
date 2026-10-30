import type {LayoutLength, LayoutNode, LayoutStyle, LayoutTrack, Size} from '../../../layout/types.js';
import {absoluteRect, clampDimension, dimensions, innerBox, length as resolveLength} from '../../../layout/box.js';
import {arrangeFlex} from '../../../layout/flex.js';
import {arrangeGrid} from '../../../layout/grid.js';
import {intrinsicFlowSize} from '../../../layout/intrinsic.js';
import type {LayoutRect, RuntimeLength, RuntimeNode, RuntimeStyle} from './runtime-types.js';

function length(value: RuntimeLength): LayoutLength {
  return value.unit === 'point' ? value.value : value.unit === 'percent' ? {percent: value.value} : 'auto';
}
function resolved(value: RuntimeLength | undefined, available: number): number {return value ? resolveLength(length(value), available) ?? 0 : 0;}
/** v1 edges use left/top/right/bottom and axis-relative percentages. */
function edge(value: RuntimeStyle['padding'], reference: Size): {left: number; top: number; right: number; bottom: number} {
  return {left: resolved(value?.[0], reference.width), top: resolved(value?.[1], reference.height), right: resolved(value?.[2], reference.width), bottom: resolved(value?.[3], reference.height)};
}
function track(value: NonNullable<RuntimeStyle['gridColumns']>[number]): LayoutTrack {
  const v = value.min;
  if (v.unit === 'fraction') return {fr: v.value};
  if (v.unit === 'fill') return {fr: 1};
  const min = v.unit === 'point' ? v.value : v.unit === 'percent' ? {percent: v.value} : 0;
  if (!value.max) return min;
  const max = value.max;
  return {min, max: max.unit === 'fraction' ? {fr: max.value} : max.unit === 'fill' ? {fr: 1} : max.unit === 'point' ? max.value : max.unit === 'percent' ? {percent: max.value} : 0};
}
/** fraction is an always-normalized v1 weight, unlike a CSS fr smaller than one. */
function tracks(values: RuntimeStyle['gridColumns']): readonly LayoutTrack[] {
  if (!values?.length) return [{fr: 1}];
  const result = values.map(track), total = result.reduce<number>((sum, t) => sum + (typeof t === 'object' && 'fr' in t ? t.fr : 0), 0);
  return total > 0 && total < 1 ? result.map(t => typeof t === 'object' && 'fr' in t ? {fr: t.fr / total} : t) : result;
}
function hyaStyle(s: RuntimeStyle, mainAxis?: 'width' | 'height'): LayoutStyle {
  const main = mainAxis && s[mainAxis], weight = main && (main.unit === 'fraction' ? main.value : main.unit === 'fill' ? 1 : 0);
  return {
    ...(s.width === undefined ? {} : {width: length(s.width)}), ...(s.height === undefined ? {} : {height: length(s.height)}),
    ...(s.minWidth === undefined ? {} : {minWidth: length(s.minWidth)}), ...(s.minHeight === undefined ? {} : {minHeight: length(s.minHeight)}),
    ...(s.maxWidth === undefined ? {} : {maxWidth: length(s.maxWidth)}), ...(s.maxHeight === undefined ? {} : {maxHeight: length(s.maxHeight)}),
    ...(s.aspectRatio === undefined ? {} : {aspectRatio: s.aspectRatio}),
    direction: s.direction ?? 'row', wrap: s.wrap ? 'wrap' : 'nowrap', justifyContent: s.justify ?? 'start', alignItems: s.align ?? 'start',
    ...(s.justifySelf === undefined ? {} : {alignSelf: s.justifySelf}), shrink: 0, ...(weight ? {grow: weight, basis: 0} : {}),
  };
}
export function hyaInnerBox(rect: LayoutRect, parent: RuntimeNode): LayoutRect {return innerBox(rect, {padding: edge(parent.style.padding, rect)});}
function sizedStyle(node: RuntimeNode, intrinsic: Size, mainAxis?: 'width' | 'height'): LayoutStyle {
  const style = hyaStyle(node.style, mainAxis);
  if (style.aspectRatio === undefined) return style;
  // hug/fill are present format axes. Only an absent axis is ratio-derived.
  if ((node.style.width !== undefined) === (node.style.height !== undefined)) {
    const {aspectRatio: _ratio, ...withoutRatio} = style; return withoutRatio;
  }
  if (node.style.width !== undefined && style.width === 'auto') return {...style, width: intrinsic.width};
  if (node.style.height !== undefined && style.height === 'auto') return {...style, height: intrinsic.height};
  return style;
}
export function hyaNodeSize(node: RuntimeNode, parent: LayoutRect, intrinsic: Size): Size {return dimensions(sizedStyle(node, intrinsic), intrinsic, parent.width, parent.height);}
export function hyaIntrinsicFlow(style: RuntimeStyle, children: readonly Size[], artboard: Size): Size {
  // v1 hug measures natural child metrics as a flow, including Grid containers.
  return intrinsicFlowSize({...hyaStyle(style), display: 'flex', padding: edge(style.padding, artboard), columnGap: resolved(style.gap?.[0], artboard.width), rowGap: resolved(style.gap?.[1], artboard.height)}, children, artboard);
}
function flowNode(node: RuntimeNode, content: LayoutRect, intrinsic: Size, mainAxis: 'width' | 'height'): LayoutNode {
  const mapped = sizedStyle(node, intrinsic, mainAxis), size = dimensions(mapped, intrinsic, content.width, content.height), inset = edge(node.style.inset, content);
  const {aspectRatio: _ratio, ...style} = mapped;
  const absolute = node.style.position === 'absolute';
  // Child padding is applied by the next HYA parent adapter, not twice by the
  // sibling solver. v1 point sizes may be smaller than that padding.
  const width = absolute && node.style.width === undefined ? clampDimension(style, 'width', Math.max(0, content.width - inset.left - inset.right), content.width) : size.width;
  const height = absolute && node.style.height === undefined ? clampDimension(style, 'height', Math.max(0, content.height - inset.top - inset.bottom), content.height) : size.height;
  return {id: node.id, contentVersion: 0, style: {...style, width, height,
    ...(absolute ? {position: 'absolute' as const} : {}),
    ...(!absolute ? {margin: edge(node.style.margin, content)} : {}),
    ...(node.style.inset ? {inset: {left: absolute ? inset.left : inset.left !== 0 ? inset.left : -inset.right, top: absolute ? inset.top : inset.top !== 0 ? inset.top : -inset.bottom}} : {}),
  }};
}

/** The adapter owns format decoding; all rectangle algorithms remain shared. */
export function arrangeHyaChildren(parent: RuntimeNode, content: LayoutRect, values: readonly RuntimeNode[], measure: (node: RuntimeNode) => Size): readonly {node: RuntimeNode; rect: LayoutRect}[] {
  const source = new Map(values.map(node => [node.id, node]));
  let rectangles: Map<string, LayoutRect>;
  if (parent.style.display === 'grid') {
    const columns = tracks(parent.style.gridColumns), rows = tracks(parent.style.gridRows);
    const cells = new Map(values.map((node, i) => {
      const p = node.style.gridPlacement, column = Math.min(columns.length - 1, p?.column ?? i % columns.length), row = Math.min(rows.length - 1, p?.row ?? Math.floor(i / columns.length));
      return [node.id, {column, row, columnSpan: Math.min(columns.length - column, p?.columnSpan ?? 1), rowSpan: Math.min(rows.length - row, p?.rowSpan ?? 1)}] as const;
    }));
    // A v1 Grid item is its decoded cell, regardless of its Flex sizing fields.
    const nodes = values.map(node => ({id: node.id, contentVersion: 0, style: {}}));
    rectangles = arrangeGrid({columns, rows, alignItems: 'stretch', justifyContent: 'start', alignContent: 'start', writingDirection: 'ltr', columnGap: resolved(parent.style.gap?.[0], content.width), rowGap: resolved(parent.style.gap?.[1], content.height)}, content, nodes, () => ({width: 0, height: 0}), 'hya-v1', Math.max(10_000, values.length), () => {}, cells);
  } else {
    const row = parent.style.direction !== 'column';
    const nodes = values.map(node => flowNode(node, content, measure(node), row ? 'width' : 'height'));
    const normal = nodes.filter(node => node.style.position !== 'absolute');
    if (row && parent.style.writingDirection === 'rtl') normal.reverse();
    const style = {...hyaStyle(parent.style), writingDirection: 'ltr' as const, columnGap: resolved(parent.style.gap?.[0], content.width), rowGap: resolved(parent.style.gap?.[1], content.height)};
    rectangles = arrangeFlex(style, content, normal, () => ({width: 0, height: 0}), 'hya-v1');
    for (const node of nodes) if (node.style.position === 'absolute') rectangles.set(node.id, absoluteRect(node, content, {width: 0, height: 0}));
  }
  return [...rectangles].map(([id, rect]) => ({node: source.get(id)!, rect}));
}
