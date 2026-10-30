import {boxMinimum, clampDimension, dimensions, distribute, edges, length, relativeRect} from './box.js';
import type {LayoutNode, LayoutProfile, LayoutRect, LayoutStyle, Size} from './types.js';

interface Item {
  node: LayoutNode; base: number; main: number; cross: number; before: number; after: number;
  crossBefore: number; crossAfter: number; grow: number; shrink: number; autoCross: boolean;
  mainFloor: number; crossFloor: number;
}
export type MeasureSize = (node: LayoutNode, width?: number, height?: number, allocated?: boolean, containing?: {width: number | undefined; height: number | undefined}) => Size;

/** Freeze violated min/max constraints and redistribute only among unfrozen items. */
function flexLine(items: Item[], available: number, gap: number, row: boolean, profile: LayoutProfile, checkpoint: () => void): void {
  const axis = row ? 'width' : 'height';
  const space = available - Math.max(0, items.length - 1) * gap - items.reduce((sum, item) => sum + item.before + item.after, 0);
  if (profile === 'hya-v1') {
    const total = items.reduce((sum, item) => sum + item.grow, 0);
    const remaining = Math.max(0, space - items.reduce((sum, item) => sum + (item.grow > 0 ? 0 : item.main), 0));
    for (const item of items) {checkpoint(); if (item.grow > 0) item.main = clampDimension(item.node.style, axis, remaining * item.grow / total, available);}
    return;
  }
  const growing = items.reduce((sum, item) => sum + item.main, 0) < space;
  const frozen = new Set<Item>();
  for (const item of items) {
    const factor = growing ? item.grow : item.shrink;
    if (factor === 0 || (growing ? item.base > item.main : item.base < item.main)) frozen.add(item);
    else item.main = item.base;
  }
  const initialFree = space - items.reduce((sum, item) => sum + (frozen.has(item) ? item.main : item.base), 0);
  // Each nonterminal iteration freezes at least one item; no numeric convergence loop.
  for (let pass = 0; frozen.size < items.length && pass <= items.length; pass++) {
    checkpoint();
    const active = items.filter(item => !frozen.has(item));
    let free = space - items.reduce((sum, item) => sum + (frozen.has(item) ? item.main : item.base), 0);
    const factors = active.reduce((sum, item) => sum + (growing ? item.grow : item.shrink), 0);
    if (factors < 1 && Math.abs(initialFree * factors) < Math.abs(free)) free = initialFree * factors;
    const weight = active.reduce((sum, item) => sum + (growing ? item.grow : item.shrink * item.base), 0);
    const violations = new Map<Item, number>(); let totalViolation = 0;
    for (const item of active) {
      checkpoint();
      const factor = growing ? item.grow : item.shrink * item.base;
      const target = item.base + (weight > 0 ? free * factor / weight : 0);
      item.main = clampDimension(item.node.style, axis, target, available, item.mainFloor);
      const violation = item.main - target;
      violations.set(item, violation); totalViolation += violation;
    }
    if (Math.abs(totalViolation) < 1e-9) {for (const item of active) frozen.add(item);}
    else {
      let count = 0;
      for (const item of active) if ((violations.get(item) ?? 0) * totalViolation > 0) {frozen.add(item); count++;}
      if (count === 0) for (const item of active) frozen.add(item);
    }
  }
}

export function arrangeFlex(parent: LayoutStyle, content: LayoutRect, nodes: readonly LayoutNode[], measure: MeasureSize, profile: LayoutProfile, crossDefinite = true, checkpoint: () => void = () => {}): Map<string, LayoutRect> {
  const row = !(parent.direction ?? 'row').startsWith('column');
  const reverse = (parent.direction ?? 'row').endsWith('reverse') !== (row && parent.writingDirection === 'rtl');
  const available = row ? content.width : content.height;
  let crossAvailable = row ? content.height : content.width;
  const gap = length(row ? parent.columnGap : parent.rowGap, row ? content.width : content.height) ?? 0;
  const crossGap = length(row ? parent.rowGap : parent.columnGap, row ? content.height : content.width) ?? 0;
  const wrapping = parent.wrap !== undefined && parent.wrap !== 'nowrap';
  const items: Item[] = nodes.map(node => {
    checkpoint();
    const widthReference = row || crossDefinite ? content.width : undefined, heightReference = !row || crossDefinite ? content.height : undefined;
    const m = edges(node.style.margin, content.width, content.height);
    const align = node.style.alignSelf && node.style.alignSelf !== 'auto' ? node.style.alignSelf : parent.alignItems ?? 'stretch';
    const specifiedCross = length(row ? node.style.height : node.style.width, row ? heightReference : widthReference);
    const stretchedCross = crossDefinite && !wrapping && align === 'stretch' ? Math.max(0, crossAvailable - (row ? m.top + m.bottom : m.left + m.right)) : undefined;
    const ratioCross = specifiedCross ?? stretchedCross;
    const mainFloor = boxMinimum(node.style, row ? 'width' : 'height', widthReference), crossFloor = boxMinimum(node.style, row ? 'height' : 'width', widthReference);
    const ratioBase = node.style.aspectRatio !== undefined && ratioCross !== undefined
      ? (row ? clampDimension(node.style, 'height', ratioCross, heightReference, crossFloor) * node.style.aspectRatio : clampDimension(node.style, 'width', ratioCross, widthReference, crossFloor) / node.style.aspectRatio) : undefined;
    const knownBase = length(node.style.basis, available) ?? length(row ? node.style.width : node.style.height, available) ?? ratioBase;
    const intrinsic = knownBase !== undefined ? {width: 0, height: 0}
      : measure(node, row ? undefined : widthReference, row ? heightReference : undefined, specifiedCross === undefined && stretchedCross !== undefined, {width: widthReference, height: heightReference});
    const size = dimensions(node.style, intrinsic, widthReference, heightReference);
    const intrinsicBase = row ? intrinsic.width : intrinsic.height;
    const base = knownBase ?? intrinsicBase;
    return {node, base, main: clampDimension(node.style, row ? 'width' : 'height', base, available, mainFloor), cross: row ? size.height : size.width, mainFloor, crossFloor,
      before: row ? m.left : m.top, after: row ? m.right : m.bottom, crossBefore: row ? m.top : m.left, crossAfter: row ? m.bottom : m.right,
      grow: node.style.grow ?? 0, shrink: node.style.shrink ?? 1,
      autoCross: length(row ? node.style.height : node.style.width, crossAvailable) === undefined};
  });
  const result = new Map<string, LayoutRect>();
  if (!items.length) return result;
  const lines: Item[][] = [];
  if (profile === 'hya-v1') {
    // Preserve the v1 distribution-before-wrap and global justify stages.
    flexLine(items, available, gap, row, profile, checkpoint);
    const ordered = items;
    const used = items.reduce((sum, item) => sum + item.main + item.before + item.after, 0) + Math.max(0, items.length - 1) * gap;
    const offsets = distribute(parent.justifyContent ?? 'start', available, used, items.length);
    let cursor = offsets.start, crossCursor = 0, lineCross = 0;
    for (const item of ordered) {
      checkpoint();
      const align = item.node.style.alignSelf && item.node.style.alignSelf !== 'auto' ? item.node.style.alignSelf : parent.alignItems ?? 'start';
      const cross = align === 'stretch' ? Math.max(0, crossAvailable - item.crossBefore - item.crossAfter) : item.cross;
      const occupied = item.before + item.main + item.after;
      if (wrapping && cursor > 0 && cursor + occupied > available) {cursor = 0; crossCursor += lineCross + crossGap; lineCross = 0;}
      const offset = align === 'center' ? Math.max(0, crossAvailable - crossCursor - item.crossBefore - item.crossAfter - cross) / 2 : align === 'end' ? Math.max(0, crossAvailable - crossCursor - item.crossBefore - item.crossAfter - cross) : 0;
      const rect = row ? {x: content.x + cursor + item.before, y: content.y + crossCursor + item.crossBefore + offset, width: item.main, height: cross} : {x: content.x + crossCursor + item.crossBefore + offset, y: content.y + cursor + item.before, width: cross, height: item.main};
      result.set(item.node.id, relativeRect(rect, item.node.style, content));
      cursor += occupied + gap + offsets.between; lineCross = Math.max(lineCross, item.crossBefore + cross + item.crossAfter);
    }
    return result;
  }
  let line: Item[] = [], used = 0;
  for (const item of items) {
    checkpoint();
    const outer = item.main + item.before + item.after;
    if (wrapping && line.length > 0 && used + gap + outer > available + 1e-9) {lines.push(line); line = []; used = 0;}
    used += (line.length ? gap : 0) + outer; line.push(item);
  }
  if (line.length) lines.push(line);
  const crossSizes = lines.map(values => {
    flexLine(values, available, gap, row, profile, checkpoint);
    // Text height depends on its final allocated width, not its pre-flex width.
    for (const item of values) {
      checkpoint();
      if (item.autoCross) {
        const size = row ? measure(item.node, item.main, undefined, true, {width: content.width, height: crossDefinite ? content.height : undefined}) : measure(item.node, undefined, item.main, true, {width: crossDefinite ? content.width : undefined, height: content.height});
        item.cross = clampDimension(item.node.style, row ? 'height' : 'width', row ? size.height : size.width, crossAvailable, item.crossFloor);
        if (item.node.style.aspectRatio !== undefined) item.cross = clampDimension(item.node.style, row ? 'height' : 'width', row ? item.main / item.node.style.aspectRatio : item.main * item.node.style.aspectRatio, crossAvailable, item.crossFloor);
      }
    }
    return Math.max(0, ...values.map(item => item.crossBefore + item.cross + item.crossAfter));
  });
  if (!wrapping && crossDefinite) crossSizes[0] = crossAvailable;
  const totalCross = crossSizes.reduce((sum, size) => sum + size, 0) + Math.max(0, lines.length - 1) * crossGap;
  if (!crossDefinite) crossAvailable = totalCross;
  if (wrapping && (parent.alignContent ?? 'stretch') === 'stretch' && totalCross < crossAvailable) {
    for (let i = 0; i < crossSizes.length; i++) crossSizes[i]! += (crossAvailable - totalCross) / crossSizes.length;
  }
  const crossDistribution = distribute(parent.alignContent ?? 'stretch', crossAvailable, crossSizes.reduce((sum, size) => sum + size, 0) + Math.max(0, lines.length - 1) * crossGap, lines.length);
  let crossCursor = crossDistribution.start;
  for (let i = 0; i < lines.length; i++) {
    const values = lines[i]!, lineCross = crossSizes[i]!;
    const total = values.reduce((sum, item) => sum + item.main + item.before + item.after, 0) + Math.max(0, values.length - 1) * gap;
    const offsets = distribute(parent.justifyContent ?? 'start', available, total, values.length);
    let cursor = offsets.start;
    for (const item of values) {
      checkpoint();
      const align = item.node.style.alignSelf && item.node.style.alignSelf !== 'auto' ? item.node.style.alignSelf : parent.alignItems ?? 'stretch';
      let cross = item.cross;
      if (align === 'stretch' && item.autoCross) cross = clampDimension(item.node.style, row ? 'height' : 'width', lineCross - item.crossBefore - item.crossAfter, crossAvailable, item.crossFloor);
      const reverseCross = parent.wrap === 'wrap-reverse' !== (!row && parent.writingDirection === 'rtl');
      const crossStart = reverseCross ? item.crossAfter : item.crossBefore;
      const crossSpace = Math.max(0, lineCross - item.crossBefore - item.crossAfter - cross);
      const crossOffset = align === 'center' ? crossSpace / 2 : align === 'end' ? crossSpace : 0;
      const localMain = reverse ? available - cursor - item.after - item.main : cursor + item.before;
      const localCross = reverseCross ? crossAvailable - crossCursor - crossStart - crossOffset - cross : crossCursor + crossStart + crossOffset;
      const rect = row ? {x: content.x + localMain, y: content.y + localCross, width: item.main, height: cross} : {x: content.x + localCross, y: content.y + localMain, width: cross, height: item.main};
      result.set(item.node.id, relativeRect(rect, item.node.style, content));
      cursor += item.before + item.main + item.after + gap + offsets.between;
    }
    crossCursor += lineCross + crossGap + crossDistribution.between;
  }
  return result;
}
