import {isGuiControl} from '../GuiControlIdentity';
import {type GuiInput} from '../components/GuiInput';
import {type GuiSlider} from '../components/GuiSlider';
import {type GuiScrollView} from '../components/GuiScrollView';
import type {GuiElement} from '../components/GuiElement';
import {isGuiLayoutHidden} from '../GuiLayoutState';
import type {GuiRect} from '../GuiTypes';
import {guiInputHostRect, type GuiInputProjection} from './GuiInputProjection';

export function guiWithin(element: GuiElement, ancestor: GuiElement | null): boolean {
  if (!ancestor) return true;
  for (let current: GuiElement | null = element; current; current = current.parent) if (current === ancestor) return true;
  return false;
}
export function guiDragSourceFrom(hit: GuiElement | null): GuiElement | null {
  for (let element = hit; element; element = element.parent) {
    if (element.dragSource) return element;
    // Editing, value adjustment and the scroll viewport retain their own gestures.
    if (isGuiControl<GuiInput>(element, 'GuiInput') || isGuiControl<GuiSlider>(element, 'GuiSlider') || isGuiControl<GuiScrollView>(element, 'GuiScrollView')) return null;
  }
  return null;
}
export function guiScrollAncestor(element: GuiElement): GuiScrollView | null {
  for (let parent = element.parent; parent; parent = parent.parent) if (isGuiControl<GuiScrollView>(parent, 'GuiScrollView')) return parent;
  return null;
}
export function revealGuiElement(element: GuiElement): void {
  for (let parent = element.parent; parent; parent = parent.parent) if (isGuiControl<GuiScrollView>(parent, 'GuiScrollView')) {
    const top = element.rect.y - parent.rect.y, bottom = top + element.rect.height - parent.rect.height;
    if (top < 0) parent.scrollBy(top); else if (bottom > 0) parent.scrollBy(bottom);
  }
}
export function visibleGuiHostRect(element: GuiElement, projection: GuiInputProjection): GuiRect | null {
  let result = guiInputHostRect(element.rect, projection);
  const clip = (rect: Readonly<GuiRect>): void => {
    const x = Math.max(result.x, rect.x), y = Math.max(result.y, rect.y);
    result = {x, y, width: Math.max(0, Math.min(result.x + result.width, rect.x + rect.width) - x),
      height: Math.max(0, Math.min(result.y + result.height, rect.y + rect.height) - y)};
  };
  clip(projection.clip);
  for (let parent = element.parent; parent; parent = parent.parent) clip(guiInputHostRect(parent.rect, projection));
  return result.width > 0 && result.height > 0 ? result : null;
}
export function activeGuiNodes(roots: readonly GuiElement[]): GuiElement[] {
  const result: GuiElement[] = [], seen = new Set<GuiElement>();
  const visit = (node: GuiElement, depth: number): void => {
    if (depth > 128 || seen.size >= 10_000 || seen.has(node)) throw new RangeError('GUI drag tree exceeds shared bounds or contains a cycle.');
    seen.add(node);
    if (!node.visible || node.disabled || isGuiLayoutHidden(node)) return;
    result.push(node); for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 1);
  return result;
}
