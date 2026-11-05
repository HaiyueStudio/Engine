import type {GuiElement} from './components/GuiElement';
import {GuiDirtyFlags, type GuiRect} from './GuiTypes';

type Sink = (element: GuiElement, flags: GuiDirtyFlags, reason?: 'resource' | 'animation',kind?:number,structure?:number) => void;
type StructureSink=(parent:GuiElement,child:GuiElement,added:boolean,version:number)=>void;
const sinks = new WeakMap<GuiElement, Sink>();
const structures=new WeakMap<GuiElement,StructureSink>(),structureVersions=new WeakMap<GuiElement,number>();
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
interface AssignmentScope {rects: ReadonlyMap<GuiElement, GuiRect>; parent: AssignmentScope | undefined;}
let assignments: AssignmentScope | undefined;
const managed = new WeakSet<GuiElement>();
const retained = new WeakMap<GuiElement, GuiRect>();
const hidden = new WeakSet<GuiElement>();
const contentHeights = new WeakMap<GuiElement, number>();
const scrollOffsets = new WeakMap<GuiElement, () => number>();
const scrollAxes = new WeakMap<GuiElement, () => 'vertical' | 'horizontal'>();
const motionSnapshots = new WeakMap<GuiElement, () => () => void>();

export function observeGuiTree(root: GuiElement, sink: Sink, suspend: () => void,structure?:StructureSink): () => void {
  sinks.set(root, sink);
  suspensions.set(root, suspend);
  if(structure)structures.set(root,structure);
  return () => {if (sinks.get(root) === sink) {sinks.delete(root); suspensions.delete(root);structures.delete(root);}};
}
export function guiStructureVersion(element:GuiElement):number {return structureVersions.get(element)??0;}
export function notifyGuiStructure(parent:GuiElement,child:GuiElement,added:boolean):number {
  const version=guiStructureVersion(parent)+1;structureVersions.set(parent,version);
  for(let root:GuiElement|null=parent;root;root=root.parent)structures.get(root)?.(parent,child,added,version);
  return version;
}
export function suspendGuiLayout(root: GuiElement): void {suspensions.get(root)?.();}
export function notifyGuiActivity(element: GuiElement): void {
  for (let parent: GuiElement | null = element; parent; parent = parent.parent) sinks.get(parent)?.(element, GuiDirtyFlags.None, 'animation');
}
export function notifyGuiInvalidation(element: GuiElement, flags: GuiDirtyFlags,kind=0,structure?:number): void {
  for (let parent: GuiElement | null = element; parent; parent = parent.parent) sinks.get(parent)?.(element, flags,undefined,kind,structure);
}
export function assignedGuiRect(element: GuiElement): GuiRect | undefined {
  let rect: GuiRect | undefined;
  for (let scope = assignments; scope && !rect; scope = scope.parent) rect = scope.rects.get(element);
  rect ??= retained.get(element);
  if (!rect) return undefined;
  let x = 0, y = 0;
  for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) {
    const offset = scrollOffsets.get(ancestor)?.() ?? 0;
    if (scrollAxes.get(ancestor)?.() === 'horizontal') x += offset; else y += offset;
  }
  return {...rect, x: rect.x - x, y: rect.y - y};
}
export function isGuiLayoutManaged(element: GuiElement): boolean {return managed.has(element);}
export function isGuiLayoutHidden(element: GuiElement): boolean {return hidden.has(element);}
export function guiLayoutContentHeight(element: GuiElement): number | undefined {return contentHeights.get(element);}
export function registerGuiScrollOffset(element: GuiElement, offset: () => number, capture: () => () => void, axis: () => 'vertical' | 'horizontal' = () => 'vertical'): void {scrollOffsets.set(element, offset); scrollAxes.set(element, axis); motionSnapshots.set(element, capture);}
export function captureGuiLayoutMotion(element: GuiElement): (() => void) | undefined {return motionSnapshots.get(element)?.();}
export function retainGuiLayout(element: GuiElement, rect: GuiRect, options: {readonly display?: 'none'; readonly contentHeight?: number} = {}): void {
  managed.add(element); retained.set(element, {...rect});
  if (options.display === 'none') hidden.add(element); else hidden.delete(element);
  if (options.contentHeight !== undefined) contentHeights.set(element, options.contentHeight); else contentHeights.delete(element);
}
export function releaseGuiLayout(element: GuiElement): void {managed.delete(element); retained.delete(element); hidden.delete(element); contentHeights.delete(element);}
/** Assignment is scoped to a normal traversal so composite controls keep their own children. */
export function withGuiAssignments(rects: ReadonlyMap<GuiElement, GuiRect>, apply: () => void): void {
  const parent = assignments;
  assignments = {rects, parent};
  try {apply();} finally {assignments = parent;}
}
