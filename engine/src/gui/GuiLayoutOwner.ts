import type {GuiElement} from './components/GuiElement';
import {GuiDirtyFlags, type GuiRect} from './GuiTypes';
import type {GuiInvalidation, GuiInvalidationReason, GuiLayoutDelegate} from './GuiLayoutTypes';
import {captureGuiLayoutMotion, isGuiLayoutHidden, observeGuiTree, releaseGuiLayout, retainGuiLayout, withGuiAssignments} from './GuiLayoutState';
import {GuiScrollView} from './components/GuiScrollView';
import {GuiModal} from './components/GuiModal';
import type {GuiImageSource} from './components/GuiImage';

const sourceIds = new WeakMap<object, number>();
let sourceId = 0;
function sourceKey(source: GuiImageSource | undefined): unknown {
  if (!source) return null;
  let id = sourceIds.get(source); if (id === undefined) {id = ++sourceId; sourceIds.set(source, id);}
  const image = 'texture' in source ? source.texture : source;
  return [id, 'version' in source ? source.version : 0,
    'naturalWidth' in image ? image.naturalWidth : 'width' in image ? image.width : 0,
    'naturalHeight' in image ? image.naturalHeight : 'height' in image ? image.height : 0,
    'complete' in image ? image.complete : undefined, 'currentSrc' in image ? image.currentSrc : undefined];
}

function styleKey(element: GuiElement): unknown {
  const {icon, nineSlice, ...plain} = element.style;
  // Borrowed handles are opaque. Inspect only identity and actual pixel inputs,
  // never caller metadata, DOM ownership graphs or GPU internals.
  return [plain, sourceKey(icon), nineSlice ? [sourceKey(nineSlice.source), nineSlice.sourceWidth,
    nineSlice.sourceHeight, nineSlice.cuts, nineSlice.uv, nineSlice.contentInsets, nineSlice.pixelRatio, nineSlice.tint] : null];
}

function validRect(rect: GuiRect): boolean {return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0;}
function snapshot(root: GuiElement): Map<GuiElement, GuiRect> {
  const result = new Map<GuiElement, GuiRect>();
  const pending = [{element: root, depth: 1}];
  while (pending.length) {
    const {element, depth} = pending.pop()!;
    if (depth > 128 || result.size >= 10_000) throw new Error('GUI layout tree exceeds the shared hard bounds.');
    if (result.has(element)) throw new Error('GUI layout tree contains a cycle or duplicate element.');
    result.set(element, {...element.rect});
    for (const child of [...element.children].reverse()) {if (child.parent !== element) throw new Error('GUI layout parent mismatch.'); pending.push({element: child, depth: depth + 1});}
  }
  return result;
}
function union(rects: readonly GuiRect[]): GuiRect {
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return {x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y};
}
function inputKey(element: GuiElement): string {
  return JSON.stringify([element.getLayoutOptions(), styleKey(element), element.visible, element.disabled, element.hovered, element.pressed, element.focused,
    'text' in element ? element.text : undefined, 'fontSize' in element ? element.fontSize : undefined, 'value' in element ? element.value : undefined, element instanceof GuiModal ? element.dialogRect : undefined]);
}

/** Engine owns validation and commit. An optional adapter owns only rectangle calculation. */
export class GuiLayoutOwner {
  private delegate: GuiLayoutDelegate | null = null;
  private readonly listeners = new Set<(change: GuiInvalidation) => void>();
  private readonly unobserve: () => void;
  private generation = 0;
  private needsLayout = true;
  private arranging = false;
  private destroyed = false;
  private suspended = false;
  private managed = new Map<GuiElement, {rect: GuiRect; options: {readonly display?: 'none'; readonly contentHeight?: number}}>();
  constructor(private readonly root: GuiElement, private readonly inputVersion: () => string) {
    this.unobserve = observeGuiTree(root, (element, flags, reason) => {
      const reasons: GuiInvalidationReason[] = [];
      if (reason) reasons.push(reason);
      if (flags & (GuiDirtyFlags.Layout | GuiDirtyFlags.Text | GuiDirtyFlags.Children)) {this.needsLayout = true; reasons.push('layout');}
      if (flags & (GuiDirtyFlags.Visual | GuiDirtyFlags.Text)) reasons.push('paint');
      if (flags & GuiDirtyFlags.Input) reasons.push('input');
      this.emit(reasons, element.rect);
    }, () => {
      if (this.suspended) return;
      this.suspended = true; this.needsLayout = true;
      this.delegate?.suspend?.(); this.emit(['resource'], this.root.rect);
    });
  }
  private emit(reasons: readonly GuiInvalidationReason[], previousBounds: GuiRect, nextBounds?: GuiRect): void {
    if (this.listeners.size === 0) {this.generation++; return;}
    const change: GuiInvalidation = Object.freeze({generation: ++this.generation, reasons: Object.freeze([...reasons]), previousBounds: Object.freeze({...previousBounds}), ...(nextBounds ? {nextBounds: Object.freeze({...nextBounds})} : {}), activeAnimation: this.active(this.root)});
    for (const listener of [...this.listeners]) listener(change);
  }
  private active(element: GuiElement): boolean {
    return element.visible && !isGuiLayoutHidden(element) && !element.disabled && (('animating' in element && element.animating === true) || element.children.some(child => this.active(child)));
  }
  subscribe(listener: (change: GuiInvalidation) => void): () => void {
    if (this.destroyed) throw new Error('GUI root is destroyed.');
    this.listeners.add(listener); return () => {this.listeners.delete(listener);};
  }
  install(delegate: GuiLayoutDelegate): () => void {
    if (this.destroyed || this.delegate) throw new Error('GUI root already has a layout delegate or is destroyed.');
    if (!delegate || typeof delegate.arrange !== 'function' || typeof delegate.measure !== 'function' || typeof delegate.dispose !== 'function' || (delegate.suspend !== undefined && typeof delegate.suspend !== 'function')) throw new Error('Invalid GUI layout delegate.');
    this.delegate = delegate; this.needsLayout = true;
    try {this.root.markDirty(GuiDirtyFlags.Layout);} catch (error) {
      this.delegate = null;
      try {delegate.dispose();} catch (cleanup) {throw new AggregateError([error, cleanup], 'GUI layout installation and rollback failed.');}
      throw error;
    }
    let removed = false;
    return () => {
      if (removed) return; removed = true;
      if (this.delegate !== delegate) return;
      this.delegate = null; this.needsLayout = true;
      this.releaseManaged();
      try {delegate.dispose();} finally {this.root.markDirty(GuiDirtyFlags.Layout);}
    };
  }
  layout(viewport: GuiRect): boolean {
    if (!this.delegate) return false;
    if (!this.needsLayout) return true;
    if (this.arranging) throw new Error('Reentrant GUI layout is not allowed.');
    this.suspended = false;
    const previous = snapshot(this.root), generation = this.generation, next = new Map<GuiElement, GuiRect>();
    const version = this.inputVersion(), order = [...previous.keys()], inputs = new Map(order.map(element => [element, inputKey(element)]));
    const children = new Map(order.map(element => [element, [...element.children]])), parents = new Map(order.map(element => [element, element.parent]));
    const motions = order.map(captureGuiLayoutMotion).filter((restore): restore is () => void => restore !== undefined);
    const dialogRects = order.filter((element): element is GuiModal => element instanceof GuiModal).map(element => ({target: element.dialogRect, rect: {...element.dialogRect}}));
    const metadata = new Map<GuiElement, {readonly display?: 'none'; readonly contentHeight?: number}>(), oldManaged = new Map(this.managed);
    const calculatingDelegate = this.delegate;
    let applying = false;
    this.arranging = true;
    try {
      const delegate = calculatingDelegate;
      delegate.arrange(this.root, Object.freeze({...viewport}), (element, rect, options = {}) => {
        if (!previous.has(element) || next.has(element) || !validRect(rect)) throw new Error('Invalid, duplicate or foreign GUI layout commit.');
        if (options.display !== undefined && options.display !== 'none') throw new Error('Invalid GUI layout display state.');
        if (options.contentHeight !== undefined && (!(element instanceof GuiScrollView) || !Number.isFinite(options.contentHeight) || options.contentHeight < 0)) throw new Error('Invalid GUI layout content height.');
        next.set(element, {...rect});
        metadata.set(element, {...options});
      });
      if (generation !== this.generation || delegate !== this.delegate || this.destroyed || version !== this.inputVersion()) throw new Error('GUI tree changed during layout calculation.');
      const current = snapshot(this.root);
      if (current.size !== previous.size || [...current.keys()].some((element, index) => order[index] !== element || inputs.get(element) !== inputKey(element))) throw new Error('GUI tree changed during layout calculation.');
      for (const [element, rect] of current) if (JSON.stringify(rect) !== JSON.stringify(previous.get(element))) throw new Error('GUI layout delegate mutated rectangles instead of committing.');
      this.releaseManaged();
      for (const [element, rect] of next) {const options = metadata.get(element)!; this.managed.set(element, {rect, options}); retainGuiLayout(element, rect, options);}
      applying = true; withGuiAssignments(next, () => this.root.layout(viewport));
      this.needsLayout = false;
      const changed = [...previous].filter(([element, rect]) => JSON.stringify(rect) !== JSON.stringify(element.rect));
      this.emit(['paint'], changed.length ? union(changed.map(([, rect]) => rect)) : previous.get(this.root)!, changed.length ? union(changed.map(([element]) => element.rect)) : this.root.rect);
      return true;
    } catch (error) {
      this.releaseManaged();
      if (this.delegate === calculatingDelegate && !this.destroyed) {
        this.managed = oldManaged;
        for (const [element, value] of this.managed) retainGuiLayout(element, value.rect, value.options);
      }
      if (applying) {
        for (const element of order) {
          for (const child of element.children) if (!previous.has(child) && child.parent === element) child.parent = null;
          element.children = children.get(element)!; element.parent = parents.get(element)!;
        }
      }
      for (const restore of motions) restore();
      for (const {target, rect} of dialogRects) Object.assign(target, rect);
      for (const [element, rect] of previous) element.rect = rect;
      this.needsLayout = true; throw error;
    } finally {this.arranging = false;}
  }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true;
    const delegate = this.delegate; this.delegate = null;
    this.unobserve(); this.listeners.clear(); this.releaseManaged(); delegate?.dispose();
  }
  private releaseManaged(): void {for (const element of this.managed.keys()) releaseGuiLayout(element); this.managed.clear();}
}
