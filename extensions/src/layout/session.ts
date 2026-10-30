import {LayoutError} from './types.js';
import type {AxisConstraint, LayoutConstraints, LayoutLimits, LayoutMeasure, LayoutNode, LayoutRect, LayoutResult, LayoutSession, Size} from './types.js';
import {DEFAULT_LIMITS, limitsFrom, validateConstraints, validateTree} from './validate.js';
import {absoluteRect, assertFiniteRect, clampDimension, dimensions, edges, innerBox, length} from './box.js';
import {arrangeFlex} from './flex.js';
import {arrangeGrid} from './grid.js';
import {intrinsicFlowSize} from './intrinsic.js';

type Measurement = ReturnType<LayoutMeasure>;
interface CacheEntry {key: string; value: Measurement; measure: LayoutMeasure;}
const unbounded: AxisConstraint = Object.freeze({mode: 'unbounded'});
function axis(value?: number, exact = false): AxisConstraint {return value === undefined ? unbounded : Object.freeze({mode: exact ? 'exact' : 'at-most', value});}
function constraints(width?: number, height?: number, exactWidth = false, exactHeight = false): LayoutConstraints {return Object.freeze({width: axis(width, exactWidth), height: axis(height, exactHeight)});}
function available(value: AxisConstraint): number | undefined {return value.mode === 'unbounded' ? undefined : value.value;}
function bounded(n: number, value: AxisConstraint): number {return value.mode === 'exact' ? value.value! : value.mode === 'at-most' ? Math.min(n, value.value!) : n;}
class ReadonlyRects implements ReadonlyMap<string, LayoutRect> {
  readonly #map: Map<string, LayoutRect>;
  constructor(entries: Map<string, LayoutRect>) {this.#map = entries; Object.freeze(this);}
  get size(): number {return this.#map.size;}
  get(key: string): LayoutRect | undefined {return this.#map.get(key);}
  has(key: string): boolean {return this.#map.has(key);}
  entries(): MapIterator<[string, LayoutRect]> {return this.#map.entries();}
  keys(): MapIterator<string> {return this.#map.keys();}
  values(): MapIterator<LayoutRect> {return this.#map.values();}
  [Symbol.iterator](): MapIterator<[string, LayoutRect]> {return this.entries();}
  forEach(callback: (value: LayoutRect, key: string, map: ReadonlyMap<string, LayoutRect>) => void, thisArg?: unknown): void {this.#map.forEach((value, key) => callback.call(thisArg, value, key, this));}
}

export function createLayoutSession(limits: Partial<LayoutLimits> = {}): LayoutSession {return new Session(limitsFrom(limits));}
class Session implements LayoutSession {
  private cache = new Map<string, readonly CacheEntry[]>();
  private disposed = false;
  private updating = false;
  private generation = 0;
  constructor(private readonly limits: LayoutLimits = DEFAULT_LIMITS) {}
  update(input: LayoutNode, inputConstraints: LayoutConstraints, measure: LayoutMeasure, options: {readonly metricsVersion: number; readonly signal?: {readonly aborted: boolean}} = {metricsVersion: 0}): LayoutResult {
    if (this.disposed) throw new LayoutError('disposed', 'Layout session is disposed.');
    if (this.updating) throw new LayoutError('invalid-input', 'Reentrant layout update is not allowed.');
    this.updating = true;
    try {
      const check = (): void => {
        if (this.disposed) throw new LayoutError('disposed', 'Layout session was disposed during measurement.');
        if (options.signal?.aborted) throw new LayoutError('aborted', 'Layout update aborted.');
      };
      check(); validateConstraints(inputConstraints);
      inputConstraints = Object.freeze({width: Object.freeze({...inputConstraints.width}), height: Object.freeze({...inputConstraints.height})});
      options = {...options};
      if (typeof measure !== 'function' || !Number.isSafeInteger(options.metricsVersion) || options.metricsVersion < 0) throw new LayoutError('invalid-input', 'Invalid measure callback or metrics version.');
      const tree = validateTree(input, this.limits, check), root = tree.root;
      const cache = new Map([...this.cache].filter(([id]) => tree.ids.has(id)));
      const rects = new Map<string, LayoutRect>(), bounds = new Map<string, LayoutRect>();
      const passes = new Map<string, Set<string>>(), intrinsicCache = new Map<string, Size>();
      let measuredNodes = 0, solvedNodes = 0;
      const measured = (node: LayoutNode, c: LayoutConstraints): Measurement => {
        check();
        const constraintKey = JSON.stringify(c), seen = passes.get(node.id) ?? new Set<string>();
        seen.add(constraintKey); passes.set(node.id, seen);
        if (seen.size > this.limits.maxConstraintPasses) throw new LayoutError('limit', 'Measurement constraint-stage budget exceeded.', node.id);
        const key = `${node.contentVersion}/${options.metricsVersion}/${constraintKey}`;
        const entries = cache.get(node.id) ?? [], hit = entries.find(entry => entry.key === key && entry.measure === measure);
        if (hit) return hit.value;
        let value: Measurement;
        try {value = measure(node.id, c);} catch (error) {check(); if (error instanceof LayoutError) throw error; throw new LayoutError('invalid-input', `Measurement failed: ${String(error)}`, node.id);}
        check();
        if (!value || ![value.width, value.height, value.minWidth, value.minHeight].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new LayoutError('invalid-input', 'Measurement must return finite nonnegative sizes and minima.', node.id);
        if ((c.width.mode === 'unbounded' && value.width < value.minWidth) || (c.height.mode === 'unbounded' && value.height < value.minHeight)) throw new LayoutError('invalid-input', 'Unbounded preferred size cannot be smaller than its intrinsic minimum.', node.id);
        value = Object.freeze({width: bounded(value.width, c.width), height: bounded(value.height, c.height), minWidth: value.minWidth, minHeight: value.minHeight});
        cache.set(node.id, [...entries, {key, value, measure}].slice(-this.limits.maxMeasureEntriesPerNode));
        measuredNodes++; return value;
      };
      const natural = (node: LayoutNode, width?: number, height?: number, allocated = false, containing?: {width: number | undefined; height: number | undefined}): Size => {
        check();
        if (node.style.display === 'none') return {width: 0, height: 0};
        const referenceW = containing ? containing.width : width, referenceH = containing ? containing.height : height;
        const requestedW = length(node.style.width, referenceW), requestedH = length(node.style.height, referenceH);
        const ownW = allocated && width !== undefined ? width : requestedW === undefined ? undefined : clampDimension(node.style, 'width', requestedW, referenceW);
        const ownH = allocated && height !== undefined ? height : requestedH === undefined ? undefined : clampDimension(node.style, 'height', requestedH, referenceH);
        const c = constraints(ownW ?? width, ownH ?? height, ownW !== undefined, ownH !== undefined);
        const key = node.id + JSON.stringify([c, referenceW, referenceH]);
        const cached = intrinsicCache.get(key); if (cached) return cached;
        const children = (node.children ?? []).filter(child => child.style.display !== 'none' && child.style.position !== 'absolute');
        const ownPadding = edges(node.style.padding, referenceW, referenceH), ownBorder = edges(node.style.border, referenceW, referenceH);
        const measuredW = available(c.width), measuredH = available(c.height);
        const own = measured(node, constraints(measuredW === undefined ? undefined : Math.max(0, measuredW - ownPadding.left - ownPadding.right - ownBorder.left - ownBorder.right), measuredH === undefined ? undefined : Math.max(0, measuredH - ownPadding.top - ownPadding.bottom - ownBorder.top - ownBorder.bottom), c.width.mode === 'exact', c.height.mode === 'exact'));
        const ownSize = {width: own.width + ownPadding.left + ownPadding.right + ownBorder.left + ownBorder.right, height: own.height + ownPadding.top + ownPadding.bottom + ownBorder.top + ownBorder.bottom};
        let size: Size;
        if (children.length && !(ownW !== undefined && ownH !== undefined)) {
          const container = {width: referenceW ?? 0, height: referenceH ?? 0};
          const p = ownPadding, b = ownBorder;
          const w = ownW ?? width, h = ownH ?? height;
          const childW = w === undefined ? undefined : Math.max(0, w - p.left - p.right - b.left - b.right);
          const childH = h === undefined ? undefined : Math.max(0, h - p.top - p.bottom - b.top - b.bottom);
          const row = !(node.style.direction ?? 'row').startsWith('column');
          if (node.style.display === 'grid') size = intrinsicFlowSize(node.style, [], container, check);
          else if (row ? ownW !== undefined : ownH !== undefined) {
            const content = {x: 0, y: 0, width: childW ?? 0, height: childH ?? 0};
            const placed = arrangeFlex(node.style, content, children, natural, 'gui-v1', false, check);
            const extent = Math.max(0, ...children.map(child => {
              const rect = placed.get(child.id)!, m = edges(child.style.margin, childW, childH);
              return row ? rect.y + rect.height + m.bottom : rect.x + rect.width + m.right;
            }));
            size = row ? {width: ownW!, height: extent + p.top + p.bottom + b.top + b.bottom} : {height: ownH!, width: extent + p.left + p.right + b.left + b.right};
          } else {
            const sizes = children.map(child => {
              const intrinsic = natural(child, row ? undefined : childW, row ? childH : undefined, false, {width: childW, height: childH}), childSize = dimensions(child.style, intrinsic, childW, childH);
              const margin = edges(child.style.margin, childW, childH);
              return {width: childSize.width + margin.left + margin.right, height: childSize.height + margin.top + margin.bottom};
            });
            size = intrinsicFlowSize(node.style, sizes, container, check);
          }
        } else size = ownSize;
        size = {width: Math.max(size.width, ownSize.width), height: Math.max(size.height, ownSize.height)};
        intrinsicCache.set(key, size); return size;
      };
      const unresolved = (node: LayoutNode, width: boolean, height: boolean, mainIsWidth = true): void => {
        for (const [field, value] of Object.entries(node.style)) {
          if (field === 'rowGap' || field === 'columnGap') continue;
          const vertical = field.endsWith('Height') || field === 'height' || (field === 'basis' && !mainIsWidth);
          if (value && typeof value === 'object' && 'percent' in value && !(vertical ? height : width)) throw new LayoutError('cycle', 'Unresolved percentage in an indefinite containing axis.', node.id);
        }
        if (!width && [node.style.padding, node.style.margin].some(value => value && Object.values(value).some(v => v && typeof v === 'object'))) throw new LayoutError('cycle', 'Unresolved percentage edge.', node.id);
        for (const [side, value] of Object.entries(node.style.inset ?? {})) if (value && typeof value === 'object' && !(side === 'top' || side === 'bottom' ? height : width)) throw new LayoutError('cycle', 'Unresolved percentage inset.', node.id);
      };
      const arrange = (node: LayoutNode, rect: LayoutRect, parent: LayoutRect, definiteWidth: boolean, definiteHeight: boolean): void => {
        check(); if (node.style.display === 'none') return;
        assertFiniteRect(rect, node.id); rects.set(node.id, Object.freeze({...rect})); solvedNodes++;
        for (const [value, definite] of [[node.style.columnGap, definiteWidth], [node.style.rowGap, definiteHeight]] as const) if (value && typeof value === 'object' && !definite) throw new LayoutError('cycle', 'Percentage gap requires a definite content axis.', node.id);
        for (const [tracks, definite] of [[node.style.columns, definiteWidth], [node.style.rows, definiteHeight]] as const) if (!definite && tracks?.some(track => typeof track === 'object' && ('percent' in track || 'fr' in track || typeof track.min === 'object' || typeof track.max === 'object'))) throw new LayoutError('cycle', 'Grid relative tracks require a definite content axis.', node.id);
        const content = innerBox(rect, node.style, parent.width, parent.height);
        const border = edges(node.style.border, rect.width, rect.height);
        const absoluteContaining = {x: rect.x + border.left, y: rect.y + border.top, width: Math.max(0, rect.width - border.left - border.right), height: Math.max(0, rect.height - border.top - border.bottom)};
        const children = (node.children ?? []).filter(child => child.style.display !== 'none');
        const flow = children.filter(child => child.style.position !== 'absolute');
        const getSize = natural;
        const assigned = node.style.display === 'grid' ? arrangeGrid(node.style, content, flow, getSize, 'gui-v1', this.limits.maxNodes, check) : arrangeFlex(node.style, content, flow, getSize, 'gui-v1', true, check);
        let left = content.x, top = content.y, right = content.x, bottom = content.y;
        for (const child of children) {
          const row = !(node.style.direction ?? 'row').startsWith('column');
          unresolved(child, definiteWidth, definiteHeight, row);
          const containing = child.style.position === 'absolute' ? absoluteContaining : content;
          const childRect = child.style.position === 'absolute' ? absoluteRect(child, containing, natural(child, containing.width, containing.height)) : assigned.get(child.id)!;
          const ownW = length(child.style.width, definiteWidth ? containing.width : undefined), ownH = length(child.style.height, definiteHeight ? containing.height : undefined);
          const align = child.style.alignSelf && child.style.alignSelf !== 'auto' ? child.style.alignSelf : node.style.alignItems ?? 'stretch';
          let childW = ownW !== undefined, childH = ownH !== undefined;
          if (child.style.position === 'absolute') {
            childW ||= definiteWidth && length(child.style.inset?.left, containing.width) !== undefined && length(child.style.inset?.right, containing.width) !== undefined;
            childH ||= definiteHeight && length(child.style.inset?.top, containing.height) !== undefined && length(child.style.inset?.bottom, containing.height) !== undefined;
          } else if (node.style.display === 'grid') {
            childW ||= definiteWidth || node.style.columns?.every(track => typeof track === 'number') === true;
            childH ||= definiteHeight || node.style.rows?.every(track => typeof track === 'number') === true;
          } else {
            childW ||= definiteWidth && (row || align === 'stretch');
            childH ||= definiteHeight && (!row || align === 'stretch');
          }
          if (child.style.aspectRatio !== undefined) {if (childW && ownH === undefined) childH = true; else if (childH && ownW === undefined) childW = true;}
          arrange(child, childRect, containing, childW, childH);
          const childBounds = bounds.get(child.id) ?? childRect;
          left = Math.min(left, childRect.x, childBounds.x); top = Math.min(top, childRect.y, childBounds.y);
          right = Math.max(right, childRect.x + childRect.width, childBounds.x + childBounds.width); bottom = Math.max(bottom, childRect.y + childRect.height, childBounds.y + childBounds.height);
        }
        const result = {x: left, y: top, width: right - left, height: bottom - top}; assertFiniteRect(result, node.id); bounds.set(node.id, Object.freeze(result));
      };
      const width = available(inputConstraints.width), height = available(inputConstraints.height);
      unresolved(root, width !== undefined, height !== undefined);
      const measureRoot = {...root, style: {...root.style, ...(inputConstraints.width.mode === 'exact' ? {width: width!, minWidth: width!, maxWidth: width!} : {}), ...(inputConstraints.height.mode === 'exact' ? {height: height!, minHeight: height!, maxHeight: height!} : {})}};
      const intrinsic = natural(measureRoot, width, height), size = dimensions(root.style, intrinsic, width, height);
      let rootWidth = bounded(size.width, inputConstraints.width), rootHeight = bounded(size.height, inputConstraints.height);
      const autoW = inputConstraints.width.mode !== 'exact' && length(root.style.width, width) === undefined;
      const autoH = inputConstraints.height.mode !== 'exact' && length(root.style.height, height) === undefined;
      const row = !(root.style.direction ?? 'row').startsWith('column');
      if (root.style.aspectRatio !== undefined) {
        if (!autoW && autoH) rootHeight = bounded(clampDimension(root.style, 'height', rootWidth / root.style.aspectRatio, height), inputConstraints.height);
        else if (!autoH && autoW) rootWidth = bounded(clampDimension(root.style, 'width', rootHeight * root.style.aspectRatio, width), inputConstraints.width);
      }
      if (row && autoH) {
        const reflowed = natural({...measureRoot, style: {...measureRoot.style, width: rootWidth, minWidth: rootWidth, maxWidth: rootWidth}}, width, height);
        rootHeight = bounded(clampDimension(root.style, 'height', root.style.aspectRatio !== undefined && !autoW ? rootWidth / root.style.aspectRatio : reflowed.height, height), inputConstraints.height);
      } else if (!row && autoW) {
        const reflowed = natural({...measureRoot, style: {...measureRoot.style, height: rootHeight, minHeight: rootHeight, maxHeight: rootHeight}}, width, height);
        rootWidth = bounded(clampDimension(root.style, 'width', root.style.aspectRatio !== undefined && !autoH ? rootHeight * root.style.aspectRatio : reflowed.width, width), inputConstraints.width);
      }
      const rect = {x: 0, y: 0, width: rootWidth, height: rootHeight};
      arrange(root, rect, {x: 0, y: 0, width: width ?? rect.width, height: height ?? rect.height}, inputConstraints.width.mode === 'exact' || length(root.style.width, width) !== undefined, inputConstraints.height.mode === 'exact' || length(root.style.height, height) !== undefined);
      check();
      if (validateTree(input, this.limits, check).fingerprint !== tree.fingerprint) throw new LayoutError('invalid-input', 'Measurement callback mutated the input tree.');
      this.cache = cache;
      return Object.freeze({generation: ++this.generation, rects: new ReadonlyRects(rects), contentBounds: new ReadonlyRects(bounds), measuredNodes, solvedNodes});
    } finally {this.updating = false;}
  }
  invalidate(nodeIds: readonly string[]): void {
    if (this.disposed) throw new LayoutError('disposed', 'Layout session is disposed.');
    if (this.updating) throw new LayoutError('invalid-input', 'Cannot invalidate while measuring.');
    for (const id of nodeIds) this.cache.delete(id);
  }
  dispose(): void {if (this.disposed) return; this.disposed = true; this.cache.clear();}
}
