import type {GamepadControlSample} from '../../input/GamepadInputLayers';
import type {GuiElement} from '../components/GuiElement';
import type {GuiRoot} from '../components/GuiRoot';
import type {GuiRect, GuiActionEvent} from '../GuiTypes';
import type {GuiDragPreview} from './GuiDragPreview';

/** Private seam shared by ordinary input and semantic dragging on one surface. */
export interface GuiInputParticipant {
  roots(): readonly GuiElement[];
  enabled(): boolean;
  rawGamepad?(sample:GamepadControlSample,target:GuiElement):boolean;
  rawKeyboard?(event:KeyboardEvent,target:GuiElement):boolean;
  keyboard(event: KeyboardEvent): boolean;
  action(action: GuiActionEvent['action'], source: GuiActionEvent['source']): boolean;
  text(event: Event): boolean;
  preventDefault(): boolean;
  cancel(): void;
  rect(element: GuiElement): Readonly<GuiRect>;
  pick(event: {clientX: number; clientY: number}): GuiElement | null;
  pointer(event: PointerEvent, hit?: GuiElement | null): boolean;
  wheel(event: WheelEvent): boolean;
  valid(element: GuiElement): boolean;
  cancelPointer(id: number, preserveCapture?: boolean): void;
  releasePointer(id: number): void;
  leavePointer(event: PointerEvent): void;
  ownsTextTarget?(target: EventTarget | null): boolean;
  hostPoint(event: {clientX: number; clientY: number}): {x: number; y: number} | null;
  localPoint(point: Readonly<{x: number; y: number}>): {x: number; y: number; inside: boolean} | null;
  pickHost(point: Readonly<{x: number; y: number}>): GuiElement | null;
  visibleRect(element: GuiElement): GuiRect | null;
  reveal(element: GuiElement): void;
  rootFor(element: GuiElement): GuiRoot | null;
  preview(): GuiDragPreview | null;
}
