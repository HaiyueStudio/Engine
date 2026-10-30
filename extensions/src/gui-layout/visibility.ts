import type {GuiElement} from '@haiyue/engine/gui';
import type {GuiLayoutStyle} from './types.js';
import {presetStyle} from './presets.js';

const overrides = new WeakMap<GuiElement, {style: GuiLayoutStyle; owner: {active: boolean}}>();
/** The adapter's pending display:none also applies before Engine commits rectangles. */
export function rememberLayoutVisibility(element: GuiElement, style: GuiLayoutStyle, owner: {active: boolean}): void {
  overrides.set(element, {style, owner});
}
export function layoutStyleVisible(element: GuiElement): boolean {
  const entry = overrides.get(element);
  return (entry?.owner.active ? entry.style.display ?? presetStyle(element)?.display : presetStyle(element)?.display) !== 'none';
}
