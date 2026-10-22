import type {GuiElement} from './components/GuiElement';
import {GuiDirtyFlags, type GuiRect} from './GuiTypes';

type Sink = (element: GuiElement, flags: GuiDirtyFlags, reason?: 'resource' | 'animation') => void;
const sinks = new WeakMap<GuiElement, Sink>();
const disposals = new WeakMap<GuiElement, Set<() => void>>();
export function observeGuiRootDisposal(root: GuiElement, listener: () => void): () => void {
  let listeners = disposals.get(root); if (!listeners) {listeners = new Set(); disposals.set(root, listeners);}
  listeners.add(listener);
  return () => {listeners.delete(listener); if (!listeners.size && disposals.get(root) === listeners) disposals.delete(root);};
}
export function disposeGuiRootObservers(root: GuiElement): void {
  const listeners = disposals.get(root); disposals.delete(root);
  const errors: unknown[] = [];
  for (const listener of listeners ?? []) {try {listener();} catch (error) {errors.push(error);}}
  if (errors.length) throw new AggregateError(errors, 'GUI root resource cleanup failed.');
}
const suspensions = new WeakMap<GuiElement, () => void>();
const assignments = new WeakMap<GuiElement, GuiRect>();
const managed = new WeakSet<GuiElement>();
const retained = new WeakMap<GuiElement, GuiRect>();
const hidden = new WeakSet<GuiElement>();
const contentHeights = new WeakMap<GuiElement, number>();
const scrollOffsets = new WeakMap<GuiElement, () => number>();
const motionSnapshots = new WeakMap<GuiElement, () => () => void>();

export function observeGuiTree(root: GuiElement, sink: Sink, suspend: () => void): () => void {
  sinks.set(root, sink);
  suspensions.set(root, suspend);
  return () => {if (sinks.get(root) === sink) {sinks.delete(root); suspensions.delete(root);}};
}
export function suspendGuiLayout(root: GuiElement): void {suspensions.get(root)?.();}
export function notifyGuiActivity(element: GuiElement): void {
  for (let parent: GuiElement | null = element; parent; parent = parent.parent) sinks.get(parent)?.(element, GuiDirtyFlags.None, 'animation');
}
export function notifyGuiInvalidation(element: GuiElement, flags: GuiDirtyFlags): void {
  for (let parent: GuiElement | null = element; parent; parent = parent.parent) sinks.get(parent)?.(element, flags);
}
export function assignedGuiRect(element: GuiElement): GuiRect | undefined {
  const rect = assignments.get(element) ?? retained.get(element);
  if (!rect) return undefined;
  let offset = 0;
  for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) offset += scrollOffsets.get(ancestor)?.() ?? 0;
  return {...rect, y: rect.y - offset};
}
export function isGuiLayoutManaged(element: GuiElement): boolean {return managed.has(element);}
export function isGuiLayoutHidden(element: GuiElement): boolean {return hidden.has(element);}
export function guiLayoutContentHeight(element: GuiElement): number | undefined {return contentHeights.get(element);}
export function registerGuiScrollOffset(element: GuiElement, offset: () => number, capture: () => () => void): void {scrollOffsets.set(element, offset); motionSnapshots.set(element, capture);}
export function captureGuiLayoutMotion(element: GuiElement): (() => void) | undefined {return motionSnapshots.get(element)?.();}
export function retainGuiLayout(element: GuiElement, rect: GuiRect, options: {readonly display?: 'none'; readonly contentHeight?: number} = {}): void {
  managed.add(element); retained.set(element, {...rect});
  if (options.display === 'none') hidden.add(element); else hidden.delete(element);
  if (options.contentHeight !== undefined) contentHeights.set(element, options.contentHeight); else contentHeights.delete(element);
}
export function releaseGuiLayout(element: GuiElement): void {managed.delete(element); retained.delete(element); hidden.delete(element); contentHeights.delete(element);}
/** Assignment is scoped to a normal traversal so composite controls keep their own children. */
export function withGuiAssignments(rects: ReadonlyMap<GuiElement, GuiRect>, apply: () => void): void {
  for (const [element, rect] of rects) assignments.set(element, rect);
  try {apply();} finally {for (const element of rects.keys()) assignments.delete(element);}
}
