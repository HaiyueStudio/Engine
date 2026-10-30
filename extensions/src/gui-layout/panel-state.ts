import {LayoutError} from '../layout.js';
import type {GuiElement} from '@haiyue/engine/gui';
import {layoutStyleVisible} from './visibility.js';

export function finiteNonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new LayoutError('invalid-input', `${name} must be finite and nonnegative.`);
  return value;
}
export function ratioValue(value: number): number {
  if (!Number.isFinite(value)) throw new LayoutError('invalid-input', 'Split ratio must be finite.');
  return Math.max(0, Math.min(1, value));
}
export function stateRecord(value: unknown, type: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LayoutError('invalid-input', 'Invalid GUI panel state.');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.type !== type || Object.keys(record).some(key => !keys.includes(key)))
    throw new LayoutError('invalid-input', 'Unsupported GUI panel state or unexpected field.');
  return record;
}
export function within(node: GuiElement | null, parent: GuiElement): node is GuiElement {
  for (let current = node; current; current = current.parent) if (current === parent) return true;
  return false;
}
export function firstFocusable(node: GuiElement): GuiElement | null {
  if (!node.visible || node.disabled || !layoutStyleVisible(node)) return null;
  if (node.focusOptions.mode === 'all') return node;
  for (const child of node.children) {const found = firstFocusable(child); if (found) return found;}
  return null;
}
