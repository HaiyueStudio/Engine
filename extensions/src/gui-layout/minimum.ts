import {LayoutError} from '../layout.js';
import type {LayoutMeasure, LayoutNode} from '../layout.js';
import {boxMinimum, dimensions, edges} from '../layout/box.js';
import {intrinsicFlowSize} from '../layout/intrinsic.js';

/** A content-minimum measurement pass; core box/flow/track math remains the only solver. */
export function createContentMinimumMeasure(measure: LayoutMeasure): (node: LayoutNode) => {width: number; height: number} {
  const cache = new Map<string, {width: number; height: number}>();
  const minimum = (node: LayoutNode): {width: number; height: number} => {
    if (node.style.display === 'none') return {width: 0, height: 0};
    const hit = cache.get(node.id); if (hit) return hit;
    const own = measure(node.id, {width: {mode: 'unbounded'}, height: {mode: 'unbounded'}});
    if (!own || ![own.width, own.height, own.minWidth, own.minHeight].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new LayoutError('invalid-input', 'Invalid GUI content minimum measurement.', node.id);
    const sizes = (node.children ?? []).filter(child => child.style.display !== 'none' && child.style.position !== 'absolute').map(child => {
      const size = dimensions(child.style, minimum(child), undefined, undefined), margin = edges(child.style.margin, undefined, undefined);
      return {width: size.width + margin.left + margin.right, height: size.height + margin.top + margin.bottom};
    });
    const flow = intrinsicFlowSize(node.style, sizes, {width: 0, height: 0});
    const result = {width: Math.max(own.minWidth + boxMinimum(node.style, 'width', undefined), flow.width), height: Math.max(own.minHeight + boxMinimum(node.style, 'height', undefined), flow.height)};
    cache.set(node.id, result); return result;
  };
  return minimum;
}
