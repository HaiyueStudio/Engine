import {LayoutError} from './types.js';
import type {LayoutConstraints, LayoutLimits, LayoutNode, LayoutStyle} from './types.js';

export const DEFAULT_LIMITS: LayoutLimits = Object.freeze({maxNodes: 10_000, maxDepth: 128, maxMeasureEntriesPerNode: 8, maxConstraintPasses: 4});
const choices: Readonly<Record<string, readonly string[]>> = {
  display: ['flex', 'grid', 'none'], position: ['relative', 'absolute'],
  direction: ['row', 'row-reverse', 'column', 'column-reverse'], writingDirection: ['ltr', 'rtl'], wrap: ['nowrap', 'wrap', 'wrap-reverse'],
  justifyContent: ['start', 'end', 'center', 'space-between', 'space-around', 'space-evenly'],
  alignItems: ['start', 'end', 'center', 'stretch'], alignSelf: ['auto', 'start', 'end', 'center', 'stretch'],
  alignContent: ['start', 'end', 'center', 'stretch', 'space-between', 'space-around', 'space-evenly'],
};
const lengths = ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'basis'] as const;
const scalar = ['grow', 'shrink', 'aspectRatio', 'rowGap', 'columnGap'];
const edgeKeys = ['margin', 'padding', 'border', 'inset'] as const;
const known = new Set([...Object.keys(choices), ...lengths, ...scalar, ...edgeKeys, 'columns', 'rows', 'placement']);
function object(value: unknown, id?: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Expected a data object.', id);
}
function fail(message: string, id?: string): never {throw new LayoutError('invalid-input', message, id);}
function nonnegative(value: unknown, id?: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('Expected a finite nonnegative number.', id);
}
function validateLength(value: unknown, id: string, negative = false, auto = true, percent = true): void {
  if (auto && value === 'auto') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (!negative && value < 0)) fail('Invalid length.', id);
    return;
  }
  object(value, id);
  if (!percent || Object.keys(value).length !== 1 || typeof value.percent !== 'number' || !Number.isFinite(value.percent) || (!negative && value.percent < 0)) fail('Invalid percentage length.', id);
}
function validateTrack(value: unknown, id: string): void {
  if (typeof value === 'number') return nonnegative(value, id);
  object(value, id);
  const keys = Object.keys(value);
  if (keys.length === 1 && 'percent' in value) return validateLength(value, id, false, false);
  if (keys.length === 1 && 'fr' in value) return nonnegative(value.fr, id);
  if (keys.length !== 2 || !('min' in value) || !('max' in value)) fail('Unsupported Grid track.', id);
  validateLength(value.min, id, false, false);
  if (typeof value.max === 'object' && value.max !== null && 'fr' in value.max) validateTrack(value.max, id);
  else validateLength(value.max, id, false, false);
}
function validateStyle(style: unknown, id: string, limits: LayoutLimits): asserts style is LayoutStyle {
  object(style, id);
  for (const [key, value] of Object.entries(style)) {
    if (!known.has(key)) fail('Unsupported layout field: ' + key, id);
    if (value === undefined) continue;
    if (choices[key]) {if (!choices[key]!.includes(value as string)) fail('Invalid ' + key, id);}
    else if (lengths.includes(key as typeof lengths[number])) validateLength(value, id);
    else if (key === 'grow' || key === 'shrink' || key === 'aspectRatio') {
      nonnegative(value, id); if (key === 'aspectRatio' && value === 0) fail('aspectRatio must be positive.', id);
    } else if (key === 'rowGap' || key === 'columnGap') validateLength(value, id, false, false);
    else if (edgeKeys.includes(key as typeof edgeKeys[number])) {
      object(value, id);
      for (const [side, length] of Object.entries(value)) {
        if (!['top', 'right', 'bottom', 'left'].includes(side)) fail('Invalid edge name.', id);
        if (length !== undefined) validateLength(length, id, key === 'margin' || key === 'inset', key === 'inset', key !== 'border');
      }
    } else if (key === 'columns' || key === 'rows') {
      if (!Array.isArray(value) || !value.length) fail('Grid tracks must be a nonempty explicit array.', id);
      if (value.length > limits.maxNodes) throw new LayoutError('limit', 'Grid track budget exceeded.', id);
      for (const track of value) validateTrack(track, id);
    } else if (key === 'placement') {
      object(value, id);
      for (const [name, n] of Object.entries(value)) {
        if (!['column', 'row', 'columnSpan', 'rowSpan'].includes(name)) fail('Invalid placement field.', id);
        if (n !== undefined && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < (name.endsWith('Span') ? 1 : 0))) fail('Invalid placement index/span.', id);
      }
    }
  }
}
export function limitsFrom(input: Partial<LayoutLimits> = {}): LayoutLimits {
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_LIMITS, key)) fail('Unknown limit: ' + key);
  const limits = {...DEFAULT_LIMITS, ...input};
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof LayoutLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) fail('Limit outside the supported hard bound: ' + key);
  }
  return Object.freeze(limits);
}
export function validateConstraints(constraints: LayoutConstraints): void {
  object(constraints);
  for (const name of ['width', 'height'] as const) {
    const axis = constraints[name]; object(axis);
    if (!['exact', 'at-most', 'unbounded'].includes(axis.mode)) fail('Invalid measurement constraint.');
    if (axis.mode !== 'unbounded') nonnegative(axis.value);
    else if (axis.value !== undefined) fail('Unbounded constraints must not contain a value.');
  }
}
/** Clone before invoking user measurement. Inputs never become mutable solver state. */
export function validateTree(root: LayoutNode, limits: LayoutLimits, checkpoint: () => void = () => {}): {root: LayoutNode; ids: Set<string>; fingerprint: string} {
  const active = new Set<LayoutNode>(), ids = new Set<string>();
  function visit(node: LayoutNode, depth: number, inheritedDirection: 'ltr' | 'rtl' = 'ltr'): LayoutNode {
    checkpoint();
    object(node);
    if (active.has(node)) throw new LayoutError('cycle', 'Cyclic layout tree.', node.id);
    if (depth > limits.maxDepth || ids.size >= limits.maxNodes) throw new LayoutError('limit', 'Layout tree budget exceeded.', node.id);
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) fail('Missing or duplicate node ID.', node.id);
    if (!Number.isSafeInteger(node.contentVersion) || node.contentVersion < 0) fail('Invalid content version.', node.id);
    validateStyle(node.style, node.id, limits);
    if (node.children !== undefined && !Array.isArray(node.children)) fail('children must be an array.', node.id);
    ids.add(node.id); active.add(node);
    const writingDirection = node.style.writingDirection ?? inheritedDirection;
    const children = (node.children ?? []).map(child => visit(child, depth + 1, writingDirection));
    active.delete(node);
    return Object.freeze({id: node.id, contentVersion: node.contentVersion, style: Object.freeze({...JSON.parse(JSON.stringify(node.style)) as LayoutStyle, writingDirection}), children: Object.freeze(children)});
  }
  const cloned = visit(root, 1);
  return {root: cloned, ids, fingerprint: JSON.stringify(cloned)};
}
