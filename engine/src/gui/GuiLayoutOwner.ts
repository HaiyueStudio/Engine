import {isGuiControl} from './GuiControlIdentity';
import type {GuiElement} from './components/GuiElement';
import {GuiDirtyFlags, type GuiRect} from './GuiTypes';
import type {GuiInvalidation, GuiInvalidationReason, GuiLayoutDelegate} from './GuiLayoutTypes';
import {captureGuiLayoutMotion, isGuiLayoutHidden, observeGuiTree, releaseGuiLayout, retainGuiLayout, withGuiAssignments} from './GuiLayoutState';
import {type GuiScrollView} from './components/GuiScrollView';
import {type GuiModal} from './components/GuiModal';
import type {GuiImageSource} from './components/GuiImage';
import {GuiActivityState} from './GuiActivityState';
import {GuiDirtyState} from './GuiDirtyState';
import {GUI_LAYOUT_STYLE_MUTATION,GUI_TEXT_LAYOUT_POLICY,guiLayoutStyleChange,guiTextContentChange,guiTextNeedsCoordinates,rememberGuiInvalidation} from './GuiInvalidationState';

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
  const style = element.style;
  if (Object.getPrototypeOf(style) === Object.prototype && !('icon' in style) && !('nineSlice' in style) && !('toJSON' in style)) {
    return [style, null, null];
  }
  const {icon, nineSlice, ...plain} = style;
  // Borrowed handles are opaque. Inspect only identity and actual pixel inputs,
  // never caller metadata, DOM ownership graphs or GPU internals.
  return [plain, sourceKey(icon), nineSlice ? [sourceKey(nineSlice.source), nineSlice.sourceWidth,
    nineSlice.sourceHeight, nineSlice.cuts, nineSlice.uv, nineSlice.contentInsets, nineSlice.pixelRatio, nineSlice.tint] : null];
}

function validRect(rect: GuiRect): boolean {return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0;}
function sameCoordinates(a: GuiRect, b: GuiRect): boolean {return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;}
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
function standardRectKeys(rect: GuiRect): boolean {
  const keys = Object.keys(rect);
  return keys.length === 4 && keys[0] === 'x' && keys[1] === 'y' && keys[2] === 'width' && keys[3] === 'height' && !('toJSON' in rect);
}
function sameRect(a: GuiRect, b: GuiRect): boolean {
  if (Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.width) && Number.isFinite(a.height) &&
      Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height) &&
      standardRectKeys(a) && standardRectKeys(b)) return sameCoordinates(a, b);
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameChildren(element: GuiElement, expected: readonly GuiElement[]): boolean {
  const children = element.children;
  if (children.length !== expected.length) return false;
  for (let i = 0; i < children.length; i++) if (children[i] !== expected[i]) return false;
  return true;
}
class Bounds {
  private empty = true;
  private left = Infinity;
  private top = Infinity;
  private right = -Infinity;
  private bottom = -Infinity;
  add(rect: GuiRect): void {
    this.empty = false;
    this.left = Math.min(this.left, rect.x); this.top = Math.min(this.top, rect.y);
    this.right = Math.max(this.right, rect.x + rect.width); this.bottom = Math.max(this.bottom, rect.y + rect.height);
  }
  rect(fallback: GuiRect): GuiRect {
    return this.empty ? fallback : {x: this.left, y: this.top, width: this.right - this.left, height: this.bottom - this.top};
  }
}
function inputKey(element: GuiElement): string {
  return JSON.stringify([element.getLayoutOptions(), styleKey(element), element.visible, element.disabled, element.hovered, element.pressed, element.focused,
    'text' in element ? element.text : undefined, 'fontSize' in element ? element.fontSize : undefined, 'value' in element ? element.value : undefined, isGuiControl<GuiModal>(element, 'GuiModal') ? element.dialogRect : undefined]);
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
  private readonly activity:GuiActivityState;
  private readonly dirty:GuiDirtyState;
  private managed = new Map<GuiElement, {rect: GuiRect; options: {readonly display?: 'none'; readonly contentHeight?: number}}>();
  constructor(private readonly root: GuiElement, private readonly inputVersion: () => string) {
    this.activity=new GuiActivityState(root,element=>this.active(element));
    this.dirty=new GuiDirtyState(root);
    this.unobserve = observeGuiTree(root, (element, flags, reason,kind=0,structure) => {
      const generation=++this.generation;
      this.dirty.note(element,flags,kind,reason);
      const reasons: GuiInvalidationReason[] = [];
      if (reason) reasons.push(reason);
      let textLayout=!!(flags&GuiDirtyFlags.Text);
      if(textLayout&&guiTextContentChange(kind)){
        const policy=(this.delegate as unknown as {[GUI_TEXT_LAYOUT_POLICY]?:(element:GuiElement)=>boolean}|null)?.[GUI_TEXT_LAYOUT_POLICY];
        try{textLayout=this.delegate?typeof policy!=='function'||policy(element)!==false:guiTextNeedsCoordinates(element);}catch(error){this.needsLayout=true;throw error;}
      }
      if (flags & (GuiDirtyFlags.Layout | GuiDirtyFlags.Children)||textLayout) {this.needsLayout = true; reasons.push('layout');}
      if (flags & (GuiDirtyFlags.Visual | GuiDirtyFlags.Text)) reasons.push('paint');
      if (flags & GuiDirtyFlags.Input) reasons.push('input');
      const layoutStyle = flags === GuiDirtyFlags.Layout && !reason &&
        (this.delegate as (GuiLayoutDelegate & {[GUI_LAYOUT_STYLE_MUTATION]?:(node:GuiElement)=>boolean})|null)?.[GUI_LAYOUT_STYLE_MUTATION]?.(element);
      this.emit(reasons, element.rect,undefined,element,flags,layoutStyle ? guiLayoutStyleChange() : kind,generation,structure);
    }, () => {
      if (this.suspended) return;
      this.suspended = true; this.needsLayout = true;
      this.delegate?.suspend?.(); this.emit(['resource'], this.root.rect);
    },(parent,child,added,version)=>{this.dirty.invalidate();this.activity.structure(parent,child,added,version);});
  }
  private emit(reasons: readonly GuiInvalidationReason[], previousBounds: GuiRect, nextBounds?: GuiRect,source?:GuiElement,flags=GuiDirtyFlags.None,kind=0,generation=++this.generation,structure?:number): void {
    if (this.listeners.size === 0) {this.activity.reset();return;}
    const change: GuiInvalidation = Object.freeze({generation, reasons: Object.freeze([...reasons]), previousBounds: Object.freeze({...previousBounds}), ...(nextBounds ? {nextBounds: Object.freeze({...nextBounds})} : {}), activeAnimation: this.activity.value(source,flags,structure)});
    rememberGuiInvalidation(change,kind);
    for (const listener of [...this.listeners]) listener(change);
  }
  private active(element: GuiElement): boolean {
    return element.visible && !isGuiLayoutHidden(element) && !element.disabled && (('animating' in element && element.animating === true) || element.children.some(child => this.active(child)));
  }
  isDirty():boolean {return this.dirty.isDirty();}
  clearDirty(fallback:()=>void):void {this.dirty.clear(fallback);}
  needsCoordinates(fallback:()=>boolean):boolean {return this.dirty.needsCoordinates(fallback);}
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
    const dialogRects = order.filter((element): element is GuiModal => isGuiControl<GuiModal>(element, 'GuiModal')).map(element => ({target: element.dialogRect, rect: {...element.dialogRect}}));
    const metadata = new Map<GuiElement, {readonly display?: 'none'; readonly contentHeight?: number}>(), oldManaged = this.managed;
    const calculatingDelegate = this.delegate;
    let applying = false;
    this.arranging = true;
    try {
      const delegate = calculatingDelegate;
      delegate.arrange(this.root, Object.freeze({...viewport}), (element, rect, options = {}) => {
        if (!previous.has(element) || next.has(element) || !validRect(rect)) throw new Error('Invalid, duplicate or foreign GUI layout commit.');
        if (options.display !== undefined && options.display !== 'none') throw new Error('Invalid GUI layout display state.');
        if (options.contentHeight !== undefined && (!(isGuiControl<GuiScrollView>(element, 'GuiScrollView')) || !Number.isFinite(options.contentHeight) || options.contentHeight < 0)) throw new Error('Invalid GUI layout content height.');
        next.set(element, {...rect});
        metadata.set(element, {...options});
      });
      if (generation !== this.generation || delegate !== this.delegate || this.destroyed || version !== this.inputVersion()) throw new Error('GUI tree changed during layout calculation.');
      // The original preorder and copied edges already prove membership. Only
      // revisit the full validator on failure, to preserve malformed-tree errors.
      for (const element of order) {
        const expected = children.get(element)!;
        if (element.parent !== parents.get(element) || !sameChildren(element, expected)) {
          snapshot(this.root);
          throw new Error('GUI tree changed during layout calculation.');
        }
      }
      if (order.some(element => inputs.get(element) !== inputKey(element))) throw new Error('GUI tree changed during layout calculation.');
      for (const [element, rect] of previous) {
        const current = element.rect;
        if (!sameRect(rect, standardRectKeys(current) ? current : {...current})) throw new Error('GUI layout delegate mutated rectangles instead of committing.');
      }
      this.managed = new Map();
      for (const element of oldManaged.keys()) if (!next.has(element)) releaseGuiLayout(element);
      for (const [element, rect] of next) {
        const options = metadata.get(element)!, old = oldManaged.get(element);
        if (old && Object.is(old.rect.x, rect.x) && Object.is(old.rect.y, rect.y) &&
            Object.is(old.rect.width, rect.width) && Object.is(old.rect.height, rect.height) &&
            standardRectKeys(old.rect) && standardRectKeys(rect) &&
            old.options.display === options.display && Object.is(old.options.contentHeight, options.contentHeight)) {
          this.managed.set(element, old);
        } else {
          this.managed.set(element, {rect, options}); retainGuiLayout(element, rect, options);
        }
      }
      this.activity.reset(); this.dirty.invalidate();
      applying = true; withGuiAssignments(next, () => this.root.layout(viewport));
      this.needsLayout = false;
      const before = new Bounds(), after = new Bounds();
      for (const [element, rect] of previous) if (!sameRect(rect, element.rect)) {before.add(rect); after.add(element.rect);}
      this.emit(['paint'], before.rect(previous.get(this.root)!), after.rect(this.root.rect));
      return true;
    } catch (error) {
      if (this.managed !== oldManaged || this.delegate !== calculatingDelegate || this.destroyed) {
        this.releaseManaged();
        if (this.delegate === calculatingDelegate && !this.destroyed) {
          this.managed = oldManaged;
          for (const [element, value] of this.managed) retainGuiLayout(element, value.rect, value.options);
        }
      } else {this.activity.reset(); this.dirty.invalidate();}
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
    this.unobserve(); this.listeners.clear(); this.releaseManaged();
    try {delegate?.dispose();} finally {this.activity.reset();this.dirty.dispose();}
  }
  private releaseManaged(): void {for (const element of this.managed.keys()) releaseGuiLayout(element); this.managed.clear();this.activity.reset();this.dirty.invalidate();}
}
