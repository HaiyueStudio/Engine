import {isGuiControl} from '../GuiControlIdentity';
import { World } from '../../ecs/World';
import { GuiRoot } from '../components/GuiRoot';
import { GuiElement } from '../components/GuiElement';
import { type GuiSelect } from '../components/GuiSelect';
import { type GuiModal } from '../components/GuiModal';
import { requiredItemAt } from '../../math/arrayAccess';
import {isGuiLayoutHidden} from '../GuiLayoutState';

export function hitTestGui(_world: World | null, roots: Set<GuiRoot>, x: number, y: number): GuiElement | null {
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
    const root = requiredItemAt(ordered, i, 'GUI roots'), hit = root.hitTest(x, y);
    if (hit === root.root && root.root.pointerFilter === 'pass') continue;
    if (hit) return hit;
  }
  return null;
}

function hitTestVisibleModal(element: GuiElement, x: number, y: number): GuiElement | null {
    if (!element.visible || isGuiLayoutHidden(element) || element.disabled) return null;
  for (let i = element.children.length - 1; i >= 0; i--) {
    const hit = hitTestVisibleModal(requiredItemAt(element.children, i, 'GUI child elements'), x, y);
    if (hit) return hit;
  }
  return isGuiControl<GuiModal>(element, 'GuiModal') ? element.hitTest(x, y) : null;
}

function hitTestOpenSelectPopup(element: GuiElement, x: number, y: number): GuiSelect | null {
    if (!element.visible || isGuiLayoutHidden(element) || element.disabled) return null;
  for (let i = element.children.length - 1; i >= 0; i--) {
    const hit = hitTestOpenSelectPopup(requiredItemAt(element.children, i, 'GUI child elements'), x, y);
    if (hit) return hit;
  }
  if (isGuiControl<GuiSelect>(element, 'GuiSelect') && element.open && element.containsPointIncludingPopup(x, y)) return element;
  return null;
}
