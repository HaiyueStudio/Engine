import { World } from '../../ecs/World';
import { GuiRoot } from '../components/GuiRoot';
import { GuiElement } from '../components/GuiElement';
import { GuiSelect } from '../components/GuiSelect';
import { GuiModal } from '../components/GuiModal';
import { requiredItemAt } from '../../math/arrayAccess';

export function hitTestGui(_world: World, roots: Set<GuiRoot>, x: number, y: number): GuiElement | null {
  const ordered = Array.from(roots);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const modalHit = hitTestVisibleModal(requiredItemAt(ordered, i, 'GUI roots').root, x, y);
    if (modalHit) return modalHit;
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const popupHit = hitTestOpenSelectPopup(requiredItemAt(ordered, i, 'GUI roots').root, x, y);
    if (popupHit) return popupHit;
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const hit = requiredItemAt(ordered, i, 'GUI roots').hitTest(x, y);
    if (hit) return hit;
  }
  return null;
}

function hitTestVisibleModal(element: GuiElement, x: number, y: number): GuiElement | null {
  if (!element.visible || element.disabled) return null;
  for (let i = element.children.length - 1; i >= 0; i--) {
    const hit = hitTestVisibleModal(requiredItemAt(element.children, i, 'GUI child elements'), x, y);
    if (hit) return hit;
  }
  return element instanceof GuiModal ? element.hitTest(x, y) : null;
}

function hitTestOpenSelectPopup(element: GuiElement, x: number, y: number): GuiSelect | null {
  if (!element.visible || element.disabled) return null;
  for (let i = element.children.length - 1; i >= 0; i--) {
    const hit = hitTestOpenSelectPopup(requiredItemAt(element.children, i, 'GUI child elements'), x, y);
    if (hit) return hit;
  }
  if (element instanceof GuiSelect && element.open && element.containsPointIncludingPopup(x, y)) return element;
  return null;
}
