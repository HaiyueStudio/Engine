import {markGuiStateDirty,consumeGuiChange,consumeGuiStructureChange,markGuiStructureDirty,noteGuiTextDirty} from '../GuiInvalidationState';
import {clearGuiOwnDirty} from '../GuiDirtyState';
import {notifyGuiStructure} from '../GuiLayoutState';
import {
  containsPoint,
  GuiDirtyFlags,
  GuiElementOptions,
  GuiLength,
  GuiPointerHandler,
  GuiPointerEvent,
  GuiRect,
  GuiStyle,
  DEFAULT_GUI_THEME,
  type GuiTheme,
  type GuiFocusOptions,
  type GuiPointerFilter,
  type GuiActionEvent,
} from '../GuiTypes';
import { EventEmitter } from '../../core/EventEmitter';
import { requiredItemAt } from '../../math/arrayAccess';
import {layoutGuiElementSelf, isGuiLayoutHidden, notifyGuiInvalidation} from '../GuiLayoutState';
import type {GuiSkin, GuiThemeResourceBinding, GuiThemeState} from '../GuiThemeTypes';
import {notifyGuiThemeTree, resolveGuiSkin, resolveGuiPart, bindGuiPart, setGuiVisualState, guiThemeState, releaseDetachedGuiParts,bindGuiDefaultSkin,guiElementTheme} from '../GuiThemeResolve';
import {captureGuiStyle} from '../GuiStyleLayers';
import {setGuiActivity,guiElementVisible} from '../GuiActivity';
import {guiControlHeight} from '../GuiControlSize';
import {positionGuiPopup,type GuiPopupPositionOptions} from '../GuiPopupPosition';
import {guiContentMetrics} from '../GuiContent';
import type {GuiDragSource, GuiDropTarget} from '../GuiDragTypes';

let guiElementId = 0;

export class GuiElement extends EventEmitter<Record<string, GuiPointerEvent>> {
  static readonly themeControlType: string = 'GuiElement';
  readonly themeControlType: string;
  private localThemeResource: GuiThemeResourceBinding | null;
  readonly id: string;
  parent: GuiElement | null = null;
  children: GuiElement[] = [];
  rect: GuiRect = { x: 0, y: 0, width: 0, height: 0 };
  hovered = false;
  pressed = false;
  focused = false;
  visible: boolean;
  disabled: boolean;
  style: GuiStyle;
  pointerFilter: GuiPointerFilter;
  private focusConfiguration: GuiFocusOptions;
  private onAction: ((event: GuiActionEvent) => void) | null;
  declare private dragConfiguration: GuiDragSource | null | undefined;
  declare private dropConfiguration: GuiDropTarget | null | undefined;

  protected x: GuiLength;
  protected y: GuiLength;
  protected width: GuiLength;
  protected height: GuiLength;
  protected dirtyFlags = GuiDirtyFlags.All;
  protected onPointerEnter: GuiPointerHandler | null;
  protected onPointerLeave: GuiPointerHandler | null;
  protected onPointerDown: GuiPointerHandler | null;
  protected onPointerMove: GuiPointerHandler | null;
  protected onPointerUp: GuiPointerHandler | null;
  protected onPointerCancel: GuiPointerHandler | null;
  protected onClick: GuiPointerHandler | null;

  constructor(options: GuiElementOptions = {}) {
    super();
    if(options.style?.iconPosition!==undefined&&!['left','right'].includes(options.style.iconPosition))throw new TypeError('Invalid GUI icon position.');
    this.id = options.id ?? `gui-${++guiElementId}`;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.visible = options.visible ?? true;
    this.disabled = options.disabled ?? false;
    if(options.style)captureGuiStyle(options.style);
    this.style = options.style ?? {};
    this.localThemeResource = options.themeResource ?? null;
    this.themeControlType = options.themeControlType ?? (this.constructor as typeof GuiElement).themeControlType;
    this.pointerFilter = options.pointerFilter ?? 'stop';
    this.focusConfiguration = Object.freeze({mode: 'none'});
    this.setFocusOptions(options.focus ?? {mode: 'none'});
    this.onAction = options.onAction ?? null;
    if (options.dragSource != null) this.setDragSource(options.dragSource);
    if (options.dropTarget != null) this.setDropTarget(options.dropTarget);
    this.onPointerEnter = options.onPointerEnter ?? null;
    this.onPointerLeave = options.onPointerLeave ?? null;
    this.onPointerDown = options.onPointerDown ?? null;
    this.onPointerMove = options.onPointerMove ?? null;
    this.onPointerUp = options.onPointerUp ?? null;
    this.onPointerCancel = options.onPointerCancel ?? null;
    this.onClick = options.onClick ?? null;
  }

  get dirty(): boolean {
    if (this.dirtyFlags !== GuiDirtyFlags.None) return true;
    return this.children.some((child) => child.dirty);
  }

  getDirtyFlags(): GuiDirtyFlags {
    return this.dirtyFlags;
  }
  getResolvedStyle(): GuiSkin {return resolveGuiSkin(this);}
  /** Borrowed token data as an immutable snapshot, including this element's palette overrides. */
  getTheme():Readonly<GuiTheme> {
    const base=guiElementTheme(this)??DEFAULT_GUI_THEME,skin=this.getResolvedStyle();
    return Object.freeze({...base,fontFamily:skin.fontFamily??base.fontFamily,fontSize:skin.fontSize??base.fontSize,...(skin.fontWeight===undefined?{}:{fontWeight:skin.fontWeight}),...(skin.lineHeight===undefined?{}:{lineHeight:skin.lineHeight}),colors:Object.freeze({...base.colors,...skin.palette})});
  }
  /** Default component styling remains below theme resources, named parts and explicit style. */
  setDefaultSkin(resolve:((theme:Readonly<GuiTheme>,state:GuiThemeState)=>GuiSkin)|null):()=>void {
    const release=bindGuiDefaultSkin(this,resolve);this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Layout|GuiDirtyFlags.Text);
    return()=>{release();this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Layout|GuiDirtyFlags.Text);};
  }
  isEffectivelyVisible():boolean {return guiElementVisible(this);}
  /** Uses the existing GUI clock; returning false releases this activity. No private RAF is created. */
  setActivity(tick:((deltaMs:number)=>boolean|void)|null,options:Readonly<{motion?:boolean}>={}):()=>void {return setGuiActivity(this,tick,options);}
  getPopupRect(size:Readonly<{width:number;height:number}>,options:GuiPopupPositionOptions={}):GuiRect {
    let root:GuiElement=this;while(root.parent)root=root.parent;
    const viewport=options.viewport??root.rect;
    const anchor=options.anchor??this.rect;
    if(!this.parent&&!options.viewport)return positionGuiPopup(anchor,size,{x:-1e8,y:-1e8,width:2e8,height:2e8},{...options,flip:false,shift:false});
    return positionGuiPopup(anchor,size,viewport,options);
  }
  getPartStyle(name: string, state: Partial<GuiThemeState> = {}): GuiSkin {return resolveGuiPart(this, name, state);}
  /** A borrowed descendant keeps its own explicit style above the owner's named part. */
  bindPart(name: string, child: GuiElement): () => void {return bindGuiPart(this, name, child);}
  getVisualState():GuiThemeState {return Object.freeze(guiThemeState(this));}
  setVisualState(state: Partial<Pick<GuiThemeState,'checked'|'selected'|'invalid'|'loading'|'readOnly'|'open'>>): void {if(setGuiVisualState(this, state))markGuiStateDirty(this);}
  /** Content padding stays in logical pixels and shrinks proportionally in tiny controls. */
  getContentRect(): GuiRect {
    // A root with the stock resolver and no resource/local skin has no insets.
    // Avoid rebuilding that same empty skin once per arranged child.
    if (this.parent === null && this.getResolvedStyle === GuiElement.prototype.getResolvedStyle &&
        !this.themeResource && Object.keys(this.style).length === 0) return this.rect;
    const skin = this.getResolvedStyle();
    const insets = skin.contentInsets ?? (skin.nineSlice ? guiContentMetrics(this, 0, skin.fontSize ?? 14).insets : undefined);
    if (!insets) return this.rect;
    const xScale = insets.left + insets.right > this.rect.width ? this.rect.width / (insets.left + insets.right) : 1;
    const yScale = insets.top + insets.bottom > this.rect.height ? this.rect.height / (insets.top + insets.bottom) : 1;
    return {x: this.rect.x + insets.left * xScale, y: this.rect.y + insets.top * yScale,
      width: Math.max(0, this.rect.width - (insets.left + insets.right) * xScale),
      height: Math.max(0, this.rect.height - (insets.top + insets.bottom) * yScale)};
  }

  get focusOptions(): GuiFocusOptions { return this.focusConfiguration; }
  get dragSource(): GuiDragSource | null {return this.dragConfiguration ?? null;}
  get dropTarget(): GuiDropTarget | null {return this.dropConfiguration ?? null;}
  setDragSource(binding: GuiDragSource | null): void {
    if (binding !== null && (typeof binding?.getData !== 'function' ||
        (binding.touchGesture !== undefined && !['auto', 'drag'].includes(binding.touchGesture)) ||
        ['createPreview', 'disposePreview', 'onEnd'].some(key => key in binding && typeof binding[key as keyof GuiDragSource] !== 'function')))
      throw new TypeError('Invalid GUI drag binding.');
    if (this.dragSource === binding) return;
    this.dragConfiguration = binding; this.markDirty(GuiDirtyFlags.Input | GuiDirtyFlags.Visual);
  }
  setDropTarget(binding: GuiDropTarget | null): void {
    if (binding !== null && (typeof binding?.canDrop !== 'function' || typeof binding.drop !== 'function' ||
        (binding.onHoverChange !== undefined && typeof binding.onHoverChange !== 'function')))
      throw new TypeError('Invalid GUI drop binding.');
    if (this.dropTarget === binding) return;
    this.dropConfiguration = binding; this.markDirty(GuiDirtyFlags.Input | GuiDirtyFlags.Visual);
  }
  get themeResource(): GuiThemeResourceBinding | null {return this.localThemeResource;}
  set themeResource(resource: GuiThemeResourceBinding | null) {this.setThemeResource(resource);}
  setThemeResource(resource: GuiThemeResourceBinding | null): void {
    if (resource === this.localThemeResource) return;
    this.localThemeResource = resource;
    notifyGuiThemeTree(this);
    this.markDirty(GuiDirtyFlags.Visual);
  }

  setFocusOptions(options: GuiFocusOptions): void {
    if (!['none', 'click', 'all'].includes(options.mode) ||
        (options.tabIndex !== undefined && !Number.isSafeInteger(options.tabIndex)))
      throw new TypeError('Invalid GUI focus mode or tabIndex.');
    if (options.neighbours && Object.entries(options.neighbours).some(([key,value]) =>
      !['left','right','up','down'].includes(key) || typeof value !== 'string' || !value))
      throw new TypeError('Invalid GUI focus neighbour.');
    this.focusConfiguration = Object.freeze({...options,
      ...(options.neighbours ? {neighbours: Object.freeze({...options.neighbours})} : {})});
    this.markDirty(GuiDirtyFlags.Input);
  }

  /** Control-specific actions run before navigation; consumption is independent of DOM defaults. */
  handleAction(event: GuiActionEvent): void { this.onAction?.(event); }

  getLayoutOptions(): Pick<GuiElementOptions, 'x' | 'y' | 'width' | 'height'> {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: guiControlHeight(this,this.height),
    };
  }

  markDirty(flags = GuiDirtyFlags.Visual): void {
    this.dirtyFlags |= flags;
    const kind=consumeGuiChange(this);
    noteGuiTextDirty(this,flags,kind);
    notifyGuiInvalidation(this, flags,kind,consumeGuiStructureChange(this));
    if (flags & (GuiDirtyFlags.Layout | GuiDirtyFlags.Children)) {
      for (let ancestor = this.parent; ancestor; ancestor = ancestor.parent) ancestor.dirtyFlags |= GuiDirtyFlags.Children;
    }
  }

  clearDirty(): void {
    clearGuiOwnDirty(this);
    for (const child of this.children) child.clearDirty();
  }

  add<T extends GuiElement>(child: T): T {
    for (let ancestor: GuiElement | null = this; ancestor; ancestor = ancestor.parent) if (ancestor === child) throw new Error('Cannot create a cyclic GUI tree.');
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    const structure=notifyGuiStructure(this,child,true);
    notifyGuiThemeTree(this, child);
    markGuiStructureDirty(this,structure);
    return child;
  }

  remove(child: GuiElement): boolean {
    const index = this.children.indexOf(child);
    if (index < 0) return false;
    this.children.splice(index, 1);
    child.parent = null;
    releaseDetachedGuiParts(child);
    const structure=notifyGuiStructure(this,child,false);
    notifyGuiThemeTree(this, child);
    markGuiStructureDirty(this,structure);
    return true;
  }

  findById(id: string): GuiElement | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const match = child.findById(id);
      if (match) return match;
    }
    return null;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    markGuiStateDirty(this);
  }

  setStyle(style: GuiStyle): void {
    if(style.iconPosition!==undefined&&!['left','right'].includes(style.iconPosition))throw new TypeError('Invalid GUI icon position.');
    if ((Object.keys(style) as (keyof GuiStyle)[]).every((key) => Object.is(this.style[key], style[key]))) return;
    this.style = { ...this.style, ...captureGuiStyle(style) };
    notifyGuiThemeTree(this);
    const metrics = ['padding', 'paddingY', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'states', 'parts', 'icon', 'iconPosition', 'iconSize', 'iconGap', 'contentInsets', 'nineSlice'] as const;
    this.markDirty(GuiDirtyFlags.Visual | (metrics.some(key => key in style) ? GuiDirtyFlags.Layout | GuiDirtyFlags.Text : GuiDirtyFlags.None));
  }

  layout(parentRect: GuiRect): void {
    if (!layoutGuiElementSelf(this, parentRect, this.x, this.y, this.width, guiControlHeight(this,this.height))) return;
    for (const child of this.children) child.layout(this.getContentRect());
  }

  hitTest(x: number, y: number): GuiElement | null {
    if (!this.visible || isGuiLayoutHidden(this) || this.disabled || !containsPoint(this.rect, x, y)) return null;
    const skin=this.getResolvedStyle();
    if(skin.clipRadius!==undefined){const r=this.rect,dx=x-r.x-r.width/2,dy=y-r.y-r.height/2,c=skin.cornerRadii??[skin.clipRadius,skin.clipRadius,skin.clipRadius,skin.clipRadius],radius=Math.min(c[dy>0?dx>0?2:3:dx>0?1:0]!,r.width/2,r.height/2),qx=Math.abs(dx)-r.width/2+radius,qy=Math.abs(dy)-r.height/2+radius;
      if(Math.hypot(Math.max(0,qx),Math.max(0,qy))+Math.min(Math.max(qx,qy),0)-radius>0)return null;}
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = requiredItemAt(this.children, i, 'GUI child elements').hitTest(x, y);
      if (hit) return hit;
    }
    return this.pointerFilter === 'ignore' ? null : this;
  }

  handlePointerEnter(event: GuiPointerEvent): void {
    this.hovered = true;
    markGuiStateDirty(this);
    this.onPointerEnter?.(event);
    this.emitGuiPointerEvent(event, false);
  }

  handlePointerLeave(event: GuiPointerEvent): void {
    this.hovered = false;
    markGuiStateDirty(this);
    this.onPointerLeave?.(event);
    this.emitGuiPointerEvent(event, false);
  }

  handlePointerDown(event: GuiPointerEvent): void {
    this.pressed = true;
    markGuiStateDirty(this);
    this.onPointerDown?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handlePointerMove(event: GuiPointerEvent): void {
    this.onPointerMove?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handlePointerUp(event: GuiPointerEvent): void {
    if (this.pressed) {
      this.pressed = false;
      markGuiStateDirty(this);
    }
    this.onPointerUp?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handleClick(event: GuiPointerEvent): void {
    this.onClick?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handlePointerCancel(event: GuiPointerEvent): void {
    if (this.pressed) { this.pressed = false; markGuiStateDirty(this); }
    this.onPointerCancel?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handleFocus(): void {
    if (this.focused) return;
    this.focused = true;
    markGuiStateDirty(this);
  }

  handleBlur(): void {
    if (!this.focused) return;
    this.focused = false;
    markGuiStateDirty(this);
  }

  private emitGuiPointerEvent(event: GuiPointerEvent, bubbles: boolean): void {
    if (event.stopped) return;
    const path: GuiElement[] = [];
    let current: GuiElement | null = this;
    while (current) {
      if (!event.routed || current.pointerFilter !== 'ignore') path.unshift(current);
      if (event.routed && current.pointerFilter === 'stop') break;
      current = current.parent;
    }
    const engineEvent = this.emit(event.type, {
      target: this,
      detail: event,
      path,
      bubbles,
    });
    if (engineEvent.defaultPrevented && !event.defaultPrevented) event.preventDefault();
    if (engineEvent.stopped && !event.stopped) event.stopPropagation();
  }
}
