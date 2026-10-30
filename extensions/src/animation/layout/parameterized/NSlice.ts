import type { LayoutRect, NSlicePatch, RuntimeNSlice } from './runtime-types.js';
import {computeNineSlicePatches} from '@haiyue/engine/geometry';

export function evaluateNSlice(definition: RuntimeNSlice, rect: LayoutRect, maximumPatches: number, retainMirrorOrientation = false): readonly NSlicePatch[] {
  const count = (definition.xCuts.length + 1) * (definition.yCuts.length + 1);
  if (count > maximumPatches) throw new Error('E_LAYOUT_NSLICE_LIMIT');
  const grid = computeNineSlicePatches({width: rect.width, height: rect.height,
    sourceWidth: definition.sourceSize[0], sourceHeight: definition.sourceSize[1],
    xCuts: definition.xCuts, yCuts: definition.yCuts, maxPatches: Math.ceil(maximumPatches)});
  const output: NSlicePatch[] = [];
  for (const [index, item] of grid.entries()) {
    if (output.length >= maximumPatches) throw new Error('E_LAYOUT_NSLICE_LIMIT');
    const [sourceX, sourceY, sourceWidth, sourceHeight] = item.sourceRect;
    const xs = {offset: item.rect.x, destination: item.rect.width, sourceStart: sourceX, sourceLength: sourceWidth};
    const ys = {offset: item.rect.y, destination: item.rect.height, sourceStart: sourceY, sourceLength: sourceHeight};
    const mode = definition.tileModes?.[index] ?? 'stretch';
    if (mode === 'stretch' || xs.destination <= 0 || ys.destination <= 0) output.push(patch(rect.x + xs.offset, rect.y + ys.offset, xs.destination, ys.destination, xs.sourceStart, ys.sourceStart, xs.sourceLength, ys.sourceLength, mode));
    else tile(output, rect, xs, ys, mode, maximumPatches, retainMirrorOrientation);
  }
  return Object.freeze(output);
}
interface Segment { readonly offset: number; readonly destination: number; readonly sourceStart: number; readonly sourceLength: number; }
function tile(output: NSlicePatch[], rect: LayoutRect, xs: Segment, ys: Segment, mode: 'repeat' | 'mirror', maximum: number, retainMirrorOrientation: boolean): void { const columns = Math.max(1, Math.ceil(xs.destination / xs.sourceLength)), rows = Math.max(1, Math.ceil(ys.destination / ys.sourceLength)); for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) { if (output.length >= maximum) throw new Error('E_LAYOUT_NSLICE_LIMIT'); const width = Math.min(xs.sourceLength, xs.destination - column * xs.sourceLength), height = Math.min(ys.sourceLength, ys.destination - row * ys.sourceLength), sourceX = mode === 'mirror' && column % 2 === 1 ? xs.sourceStart + xs.sourceLength - width : xs.sourceStart, sourceY = mode === 'mirror' && row % 2 === 1 ? ys.sourceStart + ys.sourceLength - height : ys.sourceStart; output.push(patch(rect.x + xs.offset + column * xs.sourceLength, rect.y + ys.offset + row * ys.sourceLength, width, height, sourceX, sourceY, width, height, mode, retainMirrorOrientation && mode === 'mirror' && column % 2 === 1, retainMirrorOrientation && mode === 'mirror' && row % 2 === 1)); } }
function patch(x: number, y: number, width: number, height: number, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number, tileMode: NSlicePatch['tileMode'], flipX = false, flipY = false): NSlicePatch { return Object.freeze({ x, y, width, height, source: [sourceX, sourceY, sourceWidth, sourceHeight] as const, tileMode, ...(flipX ? {flipX} : {}), ...(flipY ? {flipY} : {}) }); }
