import {LayoutError} from './types.js';
import type {LayoutNode, LayoutProfile, LayoutRect, LayoutStyle, LayoutTrack} from './types.js';
import {boxMinimum, clampDimension, distribute, edges, length, relativeRect} from './box.js';
import type {MeasureSize} from './flex.js';

export function resolveTracks(definitions: readonly LayoutTrack[], available: number, gap: number, profile: LayoutProfile, checkpoint: () => void = () => {}): number[] {
  const tracks = definitions.map(track => {
    checkpoint();
    if (typeof track === 'number' || 'percent' in track) {const size = length(track, available)!; return {min: size, max: size, fr: 0};}
    if ('fr' in track) return {min: 0, max: Infinity, fr: track.fr};
    const min = length(track.min, available)!;
    if (profile === 'hya-v1') return {min, max: min, fr: 0};
    return typeof track.max === 'object' && 'fr' in track.max ? {min, max: Infinity, fr: track.max.fr} : {min, max: Math.max(min, length(track.max as number | {percent: number}, available)!), fr: 0};
  });
  const space = Math.max(0, available - gap * Math.max(0, tracks.length - 1));
  const sizes = tracks.map(track => track.min);
  let remaining = Math.max(0, space - sizes.reduce((sum, value) => sum + value, 0));
  const bounded = new Set(tracks.map((track, i) => track.fr === 0 && track.max > track.min ? i : -1).filter(i => i >= 0));
  while (bounded.size && remaining > 1e-9) {
    checkpoint();
    const share = remaining / bounded.size;
    for (const i of bounded) {
      const added = Math.min(share, tracks[i]!.max - sizes[i]!);
      sizes[i]! += added; remaining -= added;
      if (sizes[i]! >= tracks[i]!.max - 1e-9) bounded.delete(i);
    }
  }
  const active = new Set(tracks.map((track, i) => track.fr > 0 ? i : -1).filter(i => i >= 0));
  let frSpace = space - sizes.reduce((sum, size, i) => sum + (active.has(i) ? 0 : size), 0);
  while (active.size) {
    checkpoint();
    const weights = [...active].reduce((sum, i) => sum + tracks[i]!.fr, 0);
    // A total fr smaller than 1 consumes only that fraction of the free space.
    const unit = Math.max(0, frSpace) / Math.max(1, weights);
    const clamped = [...active].filter(i => unit * tracks[i]!.fr < tracks[i]!.min);
    if (!clamped.length) {for (const i of active) sizes[i] = unit * tracks[i]!.fr; break;}
    for (const i of clamped) {sizes[i] = tracks[i]!.min; frSpace -= sizes[i]!; active.delete(i);}
  }
  return sizes;
}

type Placement = {column: number; row: number; columnSpan: number; rowSpan: number};
function placements(nodes: readonly LayoutNode[], columns: number, rows: number, maxCells: number, checkpoint: () => void): Map<string, Placement> {
  const placed = new Map<string, Placement>(), occupied = new Set<number>();
  const free = (p: Placement): boolean => {
    checkpoint();
    for (let y = p.row; y < p.row + p.rowSpan; y++) for (let x = p.column; x < p.column + p.columnSpan; x++) if (occupied.has(y * columns + x)) return false;
    return true;
  };
  const commit = (node: LayoutNode, p: Placement): void => {
    if (p.column + p.columnSpan > columns || p.row + p.rowSpan > rows || p.columnSpan * p.rowSpan > maxCells) throw new LayoutError('invalid-input', 'Grid placement exceeds explicit tracks or occupancy bound.', node.id);
    if (!free(p)) throw new LayoutError('invalid-input', 'Overlapping explicit Grid placement.', node.id);
    for (let y = p.row; y < p.row + p.rowSpan; y++) for (let x = p.column; x < p.column + p.columnSpan; x++) occupied.add(y * columns + x);
    if (occupied.size > maxCells) throw new LayoutError('limit', 'Grid occupancy budget exceeded.', node.id);
    placed.set(node.id, p);
  };
  for (const node of nodes) {
    checkpoint();
    const p = node.style.placement;
    if (p?.column !== undefined && p.row !== undefined) commit(node, {column: p.column, row: p.row, columnSpan: p.columnSpan ?? 1, rowSpan: p.rowSpan ?? 1});
  }
  // Sparse row-major placement: the cursor never returns to fill an earlier hole.
  let cursor = 0, attempts = 0, autoStarted = false;
  const rowCursors = new Map<number, number>();
  const pending = [...nodes.filter(node => node.style.placement?.row !== undefined), ...nodes.filter(node => node.style.placement?.row === undefined)];
  for (const node of pending) {
    checkpoint();
    if (placed.has(node.id)) continue;
    const p = node.style.placement, columnSpan = p?.columnSpan ?? 1, rowSpan = p?.rowSpan ?? 1;
    if (columnSpan > columns || rowSpan > rows) throw new LayoutError('invalid-input', 'Grid span exceeds explicit tracks.', node.id);
    let found: Placement | undefined;
    if (p?.row === undefined && !autoStarted) {cursor = 0; autoStarted = true;}
    const start = p?.row !== undefined ? p.row * columns + (rowCursors.get(p.row) ?? 0) : cursor;
    for (let i = start; i < columns * rows; i++) {
      if (++attempts > maxCells * 4) throw new LayoutError('limit', 'Grid placement search budget exceeded.', node.id);
      if ((attempts & 255) === 0) checkpoint();
      const candidate = {column: i % columns, row: Math.floor(i / columns), columnSpan, rowSpan};
      if ((p?.column !== undefined && p.column !== candidate.column) || (p?.row !== undefined && p.row !== candidate.row)) continue;
      if (candidate.column + columnSpan <= columns && candidate.row + rowSpan <= rows && free(candidate)) {found = candidate; cursor = i + columnSpan; break;}
    }
    if (!found) throw new LayoutError('invalid-input', 'No space in the explicit Grid.', node.id);
    commit(node, found);
    if (p?.row !== undefined) rowCursors.set(p.row, found.column + columnSpan);
  }
  return placed;
}
function offsets(values: readonly number[], gap: number): number[] {
  let cursor = 0;
  return values.map(value => {const result = cursor; cursor += value + gap; return result;});
}
/** Internal adapters may supply already-decoded cells; public sessions always use strict placement. */
export function arrangeGrid(style: LayoutStyle, content: LayoutRect, nodes: readonly LayoutNode[], measure: MeasureSize, profile: LayoutProfile, maxCells: number, checkpoint: () => void = () => {}, decodedCells?: ReadonlyMap<string, Placement>): Map<string, LayoutRect> {
  const columnGap = profile === 'hya-v1' ? 0 : length(style.columnGap, content.width) ?? 0, rowGap = profile === 'hya-v1' ? 0 : length(style.rowGap, content.height) ?? 0;
  const columns = resolveTracks(style.columns ?? [{fr: 1}], content.width, columnGap, profile, checkpoint), rows = resolveTracks(style.rows ?? [{fr: 1}], content.height, rowGap, profile, checkpoint);
  const inline = distribute(style.justifyContent ?? 'start', content.width, columns.reduce((sum, n) => sum + n, 0) + columnGap * Math.max(0, columns.length - 1), columns.length);
  const block = distribute(style.alignContent ?? 'start', content.height, rows.reduce((sum, n) => sum + n, 0) + rowGap * Math.max(0, rows.length - 1), rows.length);
  const actualColumnGap = columnGap + inline.between, actualRowGap = rowGap + block.between;
  const x = offsets(columns, actualColumnGap).map(n => n + inline.start), y = offsets(rows, actualRowGap).map(n => n + block.start), result = new Map<string, LayoutRect>();
  const placed = decodedCells ?? placements(nodes, columns.length, rows.length, maxCells, checkpoint);
  for (const node of nodes) {
    checkpoint();
    const p = placed.get(node.id);
    if (!p || ![p.column, p.row, p.columnSpan, p.rowSpan].every(Number.isSafeInteger) || p.column < 0 || p.row < 0 || p.columnSpan < 1 || p.rowSpan < 1 || p.column + p.columnSpan > columns.length || p.row + p.rowSpan > rows.length) throw new LayoutError('invalid-input', 'Invalid decoded Grid cell.', node.id);
    const width = columns.slice(p.column, p.column + p.columnSpan).reduce((sum, v) => sum + v, 0) + actualColumnGap * (p.columnSpan - 1);
    const height = rows.slice(p.row, p.row + p.rowSpan).reduce((sum, v) => sum + v, 0) + actualRowGap * (p.rowSpan - 1);
    const left = style.writingDirection === 'rtl' ? content.width - x[p.column]! - width : x[p.column]!;
    let rect: LayoutRect = {x: content.x + left, y: content.y + y[p.row]!, width, height};
    {
      const m = edges(node.style.margin, content.width, content.height);
      const ownWidth = length(node.style.width, content.width), ownHeight = length(node.style.height, content.height);
      const align = node.style.alignSelf && node.style.alignSelf !== 'auto' ? node.style.alignSelf : style.alignItems ?? (node.style.aspectRatio === undefined ? 'stretch' : 'start');
      const w = clampDimension(node.style, 'width', ownWidth ?? Math.max(0, width - m.left - m.right), content.width, boxMinimum(node.style, 'width', content.width));
      const intrinsic = measure(node, w, undefined, true, {width: content.width, height: content.height});
      const intrinsicHeight = node.style.aspectRatio === undefined ? intrinsic.height : w / node.style.aspectRatio;
      const h = clampDimension(node.style, 'height', ownHeight ?? (align === 'stretch' ? Math.max(0, height - m.top - m.bottom) : intrinsicHeight), content.height, boxMinimum(node.style, 'height', content.width));
      const extra = Math.max(0, height - m.top - m.bottom - h);
      rect = relativeRect({x: rect.x + (style.writingDirection === 'rtl' ? width - m.right - w : m.left), y: rect.y + m.top + (align === 'center' ? extra / 2 : align === 'end' ? extra : 0), width: w, height: h}, node.style, content);
    }
    result.set(node.id, rect);
  }
  return result;
}
