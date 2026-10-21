import type {GuiElement} from '../components/GuiElement';
import type {GuiActionEvent, GuiPointerEvent} from '../GuiTypes';

export function createGuiSyntheticPointer(type: string, pointerId = -1): PointerEvent {
  return typeof PointerEvent === 'function'
    ? new PointerEvent(type, {cancelable: true, pointerId})
    : {type, pointerId, button: 0, buttons: 0, isTrusted: false,
      defaultPrevented: false, preventDefault(this: {defaultPrevented: boolean}) {this.defaultPrevented = true;}} as unknown as PointerEvent;
}

/** Derived click for legacy onClick callbacks. Never a physical pointer sample. */
export function activateGuiElement(target: GuiElement, action: GuiActionEvent): void {
  const x = target.rect.x + target.rect.width / 2, y = target.rect.y + target.rect.height / 2;
  const nativeEvent = createGuiSyntheticPointer('click');
  const event: GuiPointerEvent = {
    type: 'click', target, currentTarget: target, x, y,
    localX: target.rect.width / 2, localY: target.rect.height / 2,
    button: 0, buttons: 0, pointerId: -1, nativeEvent, routed: true,
    stopped: false, defaultPrevented: false,
    stopPropagation() { this.stopped = true; },
    preventDefault() { this.defaultPrevented = true; nativeEvent.preventDefault(); },
  };
  target.handleClick(event);
  action.consume();
}
