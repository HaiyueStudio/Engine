import {isRegionRenderTarget,getRegionProjection} from '../../core/RegionRenderTarget';
import { GuiSwitch } from '../components/GuiSwitch';
import { GuiToast } from '../components/GuiToast';
import { GuiScrollView } from '../components/GuiScrollView';
import { GuiHelpDialog, setGuiHelpDialogTextMetrics } from '../components/GuiHelpDialog';
import type { IEngine } from '../../core/IEngine';
import { System } from '../../ecs/System';
import { World } from '../../ecs/World';
import { GuiElement } from '../components/GuiElement';
import { GuiButton } from '../components/GuiButton';
import { GuiInput } from '../components/GuiInput';
import { GuiLabel, setGuiLabelMeasuredTextWidth } from '../components/GuiLabel';
import { GuiRadio } from '../components/GuiRadio';
import { GuiRoot } from '../components/GuiRoot';
import { GuiSelect } from '../components/GuiSelect';
import { GuiFocusManager } from '../input/GuiFocusManager';
import { hitTestGui } from '../input/GuiHitTest';
import {GuiDirtyFlags, type GuiPointerEvent} from '../GuiTypes';
import { GuiRenderer } from '../rendering/GuiRenderer';
import {bindGuiMeasureOwner, guiMeasureFontVersion, requestGuiFontReload} from '../GuiMeasure';
import {isGuiLayoutHidden, isGuiLayoutManaged, suspendGuiLayout} from '../GuiLayoutState';
import { getCachedRenderPassDescriptor } from '../../core/renderPassDescriptor';
import { beginRenderCommandPass } from '../../core/RenderCommandContext';
import type { RenderCommandContext } from '../../core/RenderCommandContext';
import { getRenderViewPassOptions } from '../../core/RenderView';
import { cloneRenderPassDescriptor } from '../../core/renderPassDescriptor';
import type { RenderPipelineEntryOptions } from '../../renderer/RenderPipeline';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import type {RenderRegion} from '../../core/RenderRegion';
import {getRenderRegionState} from '../../core/RenderRegionState';
import type {RenderViewSnapshot} from '../../core/RenderView';
import {GuiPixelResources} from '../GuiPixelResources';
import {InputMap} from '../../input/InputMap';
import type {GuiActionEvent} from '../GuiTypes';
import {GuiInputDomain, type GuiInputParticipant} from '../input/GuiInputDomain';
import {createGuiSyntheticPointer} from '../input/GuiActivation';
import {guiInputProjection,guiInputPoint,guiInputHostRect} from '../input/GuiInputProjection';
import type {GuiTextInputHost} from '../input/GuiTextInputHost';
import {GuiTextInputConnection} from '../input/GuiTextInputConnection';
import {GuiBrowserTextInputHost} from '../input/GuiBrowserTextInputHost';
import {guiInputPresentation} from '../input/GuiInputPresentation';
import {GuiCaretClock} from '../input/GuiCaretClock';
import {GuiTextViewport} from '../input/GuiTextViewport';

interface PendingGuiPointerEvent {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  native: PointerEvent | null;
  timestamp?: number;
  x: number;
  y: number;
  routedHit?: GuiElement | null;
}

interface PendingGuiWheelEvent {
  native: WheelEvent | null;
  x: number;
  y: number;
  deltaY: number;
}

interface CachedCanvasRect {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
}

export interface GuiFontOptions {
  /** Synchronous Canvas 2D factory for non-DOM hosts. */
  readonly canvasFactory?: (width: number, height: number) => HTMLCanvasElement;
  /** Optional tightly packed RGBA8 atlas readback; Engine owns the uploaded GPU texture. */
  readonly readAtlasPixels?: (canvas: HTMLCanvasElement) => Uint8Array;

  readonly chars?: string;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly padding?: number;
  readonly atlasSize?: number;
}

export interface GuiSystemOptions {
  /** Platform-owned responder. Named public host types are integrated by G13. */
  textInputHost?:GuiTextInputHost|'browser';
  onViewportInset?:(inset:{top:number;right:number;bottom:number;left:number})=>void;
  /** Bind UI action names through the same InputMap abstraction used by scene actions. */
  navigationMap?: InputMap;
  /** Explicit ownership when multiple GUI systems render independent regions/overlays in one World. */
  roots?: ReadonlySet<GuiRoot>;
  preventDefault?: boolean;
  /** 'clear' resets the canvas; 'load' composites GUI on top of earlier render systems. Defaults to 'load'. */
  loadOp?: 'clear' | 'load';
  /** Optional runtime bitmap-font atlas. Include every glyph used by this GUI. */
  font?: GuiFontOptions;
}

export class GuiSystem extends System {
  override get disabled(): boolean { return super.disabled; }
  override set disabled(value: boolean) {
    const changed = super.disabled !== value;
    super.disabled = value;
    if (changed && value && this.inputDomain) {this.cancelInput();this.inputDomain.refresh();}
  }
  readonly focus: GuiFocusManager;
  private readonly inputDomain: GuiInputDomain;
  private readonly inputParticipant: GuiInputParticipant;
  private readonly unregisterInput: () => void;
  private inputView: RenderViewSnapshot | undefined;
  private inputWorld: World | null = null;
  private inputConsumed = false;
  private inputSuspended = false;

  private engine: IEngine;
  private preventDefault: boolean;
  private readonly navigationMap: InputMap;
  private pending: PendingGuiPointerEvent[] = [];
  private pendingWheel: PendingGuiWheelEvent[] = [];
  private pendingPool: PendingGuiPointerEvent[] = [];
  private pendingWheelPool: PendingGuiWheelEvent[] = [];
  private canvasRectCache: CachedCanvasRect | null = null;
  private canvasRectResetScheduled = false;
  private hovered: GuiElement | null = null;
  private pressed: GuiElement | null = null;
  private readonly capturedPointers = new Set<number>();
  private scrollGesture: {
    view: GuiScrollView; pointerId: number; startY: number; startOffset: number; dragging: boolean;
    samples: { time: number; offset: number }[]; lastMove: number; direction: number;
  } | null = null;
  private readonly pointerStates = new Map<number, {pressed: GuiElement | null; hovered: GuiElement | null; scrollGesture: GuiSystem['scrollGesture']; last: PendingGuiPointerEvent}>();
  private roots = new Set<GuiRoot>();
  private renderer: GuiRenderer;
  private readonly font: GuiFontOptions;
  private disposed = false;
  private fontEventsCleanup: (() => void) | null = null;
  private fontEventsGeneration = 0;
  private autoWidthKeys = new WeakMap<GuiLabel, string>();
  private motionFrames = new WeakMap<object, number>();
  private composing = false;
  private compositionTarget:GuiInput|null=null;
  private compositionGeneration=0;
  private textConnection:GuiTextInputConnection|null=null;
  private readonly textSubscriptions:(()=>void)[]=[];
  private readonly caretClock=new GuiCaretClock(input=>this.focus.focused===input&&this.inputParticipant.enabled()&&this.validPointerTarget(input));
  private textViewportInset={top:0,right:0,bottom:0,left:0};
  private readonly textViewport=new GuiTextViewport();
  loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'GuiSystem' as const };
  private readonly unregisterRecovery: (() => void) | null;
  private readonly rootFilter:ReadonlySet<GuiRoot>|undefined;
  private readonly regionSubscriptions=new Map<GuiRoot,()=>void>();
  private region:RenderRegion|null=null;
  private readonly pixelResources=new GuiPixelResources(image=>{this.renderer.invalidateImageSource(image.source);image.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Visual)});

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return { pass: 'shared', loadOp: this.loadOp, sort: this.priority };
  }

  constructor(engine: IEngine, options: GuiSystemOptions = {}) {
    super({ all: [GuiRoot] });
    const browserDocument=engine.canvas?.ownerDocument??globalThis.document;
    if(options.textInputHost==='browser'&&!browserDocument)throw new Error('Browser text input requires a DOM document; Native hosts must supply a platform responder.');
    this.name = 'GuiSystem';
    this.priority = 10000;
    this.engine = engine;
    this.preventDefault = options.preventDefault ?? true;
    this.navigationMap = options.navigationMap ?? InputMap.guiNavigation();
    this.loadOp = options.loadOp ?? 'load';
    this.font = Object.freeze({ ...options.font });
    this.rootFilter=options.roots;
    this.renderer = new GuiRenderer(this.font);
    this.inputDomain = GuiInputDomain.for(engine.canvas ?? engine, engine.canvas);
    this.focus = this.inputDomain.focus;
    this.inputParticipant = {
      roots: () => this.inputRoots().map(root => root.root),
      enabled: () => !this.disabled && !this.disposed && !this.inputSuspended && !this.inputWorld?.disabled && (!this.region || !!getRenderRegionState(this.region)?.snapshot().visible),
      keyboard: event => {const result=this.handleKeyboardEvent(event);this.synchronizeTextInput();return result;},
      action: (action,source) => {const result=this.handleAction(action,source);this.synchronizeTextInput();return result;},
      text: event => {
        if (!(this.focus.focused instanceof GuiInput)) return false;
        if (event.type === 'compositionstart') this.onCompositionStart();
        else if (event.type === 'compositionupdate') this.onCompositionUpdate(event as CompositionEvent);
        else if (event.type === 'compositionend') this.onCompositionEnd(event as CompositionEvent);
        else if (event.type === 'copy') this.onCopy(event as ClipboardEvent);
        else if (event.type === 'cut') this.onCut(event as ClipboardEvent);
        else if (event.type === 'paste') this.onPaste(event as ClipboardEvent);
        this.synchronizeTextInput();
        return true;
      },
      preventDefault: () => this.preventDefault,
      cancel: () => this.cancelInput(),
      rect: element => {const projection=this.inputProjection();return projection?guiInputHostRect(element.rect,projection):element.rect;},
      pick: event => this.pickPointer(event),
      pointer: (event,hit) => this.routePointer(event,hit),
      wheel: event => this.routeWheel(event),
      valid: element => this.validPointerTarget(element),
      cancelPointer: id => this.cancelPointer(id),
      leavePointer: event => this.leavePointer(event),
      ownsTextTarget:target=>this.textConnection?.ownsTarget(target)??false,
    };
    this.unregisterInput = this.inputDomain.register(this.inputParticipant);
    if(options.textInputHost){
      const host=options.textInputHost==='browser'?new GuiBrowserTextInputHost(browserDocument!,()=>engine.canvas?.focus({preventScroll:true}),()=>{const r=engine.canvas?.getBoundingClientRect();return r?{x:r.left,y:r.top,width:r.width,height:r.height}:{x:0,y:0,width:browserDocument!.defaultView!.innerWidth,height:browserDocument!.defaultView!.innerHeight};}):options.textInputHost;
      this.textConnection=new GuiTextInputConnection(host,{
        valid:target=>this.inputParticipant.enabled()&&this.validPointerTarget(target),
        caretRect:target=>this.textCaretRect(target),
        viewportInset:inset=>{this.textViewportInset={...inset};if(!inset.top&&!inset.right&&!inset.bottom&&!inset.left)this.textViewport.clear();this.textConnection?.target?.markDirty(GuiDirtyFlags.Input);options.onViewportInset?.(inset);},
        blur:target=>{if(this.focus.focused===target)this.focus.blur();},
        command:command=>{
          const target=this.focus.focused;
          if(!(target instanceof GuiInput))return;
          if(command==='undo')target.undo();else if(command==='redo')target.redo();
          else if(command==='left'||command==='right'||command==='extendLeft'||command==='extendRight')target.moveCaret(command==='left'||command==='extendLeft'?-1:1,command==='extendLeft'||command==='extendRight');
          else if(command==='deleteBackward')target.deleteBackward();else if(command==='deleteForward')target.deleteForward();
          else if(command==='submit')target.submit();else this.dispatchAction(command==='cancel'?'cancel':command,'keyboard');
          this.synchronizeTextInput();
        },
      });
    }
    this.textSubscriptions.push(this.focus.subscribeBeforeBlur(()=>{
      this.compositionTarget?.cancelComposition();this.compositionTarget=null;this.composing=false;
      const target=this.textConnection?.target;
      this.textConnection?.close(!!target&&this.inputParticipant.enabled()&&this.validPointerTarget(target));
    }),this.focus.subscribe(()=>this.synchronizeTextInput()));
    this.recoveryLabel = `${this.name}:${this.id}`;
    this.unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
    this.bindCanvas();
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    this.renderer.contributePipelineWarmup(plan, this.engine);
  }

  /** CPU/input preflight runs even when the retained pixels do not need another draw. */
  prepareFrame(world:World,_time:number,delta:number,view:RenderViewSnapshot,region:RenderRegion):void {
    this.inputView=view;
    this.inputDomain.touch(this.inputParticipant);
    if(this.disabled){this.stopAnimations();return}
    if(this.region!==region){this.releaseFrame();this.region=region}
    this.inputSuspended=false;
    const roots:GuiRoot[]=[];
    for(const entity of this.entitySet.get(world)??[]){const root=entity.getComponent(GuiRoot);if(root&&(!this.rootFilter||this.rootFilter.has(root)))roots.push(root)}
    for(const [root,unsubscribe]of this.regionSubscriptions)if(!roots.includes(root)){unsubscribe();this.regionSubscriptions.delete(root)}
    for(const root of roots)if(!this.regionSubscriptions.has(root))this.regionSubscriptions.set(root,root.onInvalidation(change=>{
      if(!getRenderRegionState(region)?.isDisposed&&change.reasons.some(r=>r==='layout'||r==='paint'||r==='resource'||r==='animation'))region.invalidate('GUI content');
    }));
    this.pixelResources.sync(roots);this.prepareRoots(world,view.displayWidth,view.displayHeight);this.advanceMotion(world,delta,world.frameData);this.dispatchPendingEvents(world);
    if(this.animating)region.invalidate('GUI animation');
  }
  releaseFrame():void {this.inputSuspended=true;this.cancelInput();for(const unsubscribe of this.regionSubscriptions.values())unsubscribe();this.regionSubscriptions.clear();this.region=null;this.pixelResources.release();this.inputDomain.refresh();}

  record(world: World, context: RenderCommandContext): this {
    this.inputView=context.view;
    if(!this.region)this.inputDomain.touch(this.inputParticipant);
    if (this.disabled) {this.stopAnimations(); return this;}
    this.inputSuspended=false;
    this.prepareRoots(world, context.view?.displayWidth, context.view?.displayHeight);
    // RenderIntegration owns this system and disables ordinary autoUpdate.
    // Use the shared frame identity so multiple views never advance motion twice.
    const frame = context.frameData ?? world.frameData;
    this.advanceMotion(world, frame.delta, frame);
    this.dispatchPendingEvents(world);
    this.render(context);
    for (const root of this.roots) root.clearDirty();
    return this;
  }

  /** Demand-rendering hosts should keep requesting frames while this is true. */
  get animating(): boolean {
    const active = (element: GuiElement): boolean => element.visible && !isGuiLayoutHidden(element) && !element.disabled &&
      (((element instanceof GuiScrollView || element instanceof GuiSwitch || element instanceof GuiToast) && element.animating) || element.children.some(active));
    for (const root of this.roots) if (active(root.root)) return true;
    return false;
  }

  override update(world: World, time: number, delta: number): this {
    if (this.disabled) { this.stopAnimations(); return this; }
    this.advanceMotion(world, delta);
    return super.update(world, time, delta);
  }

  private advanceMotion(world: World, delta: number, frame = world.frameData): void {
    if (frame.frameId > 0 && this.motionFrames.get(frame) === frame.frameId) return;
    this.motionFrames.set(frame, frame.frameId);
    const advance = (element: GuiElement, parentActive: boolean): void => {
      const active = parentActive && element.visible && !isGuiLayoutHidden(element) && !element.disabled;
      if (element instanceof GuiScrollView) {
        if (active) element.advanceAnimation(delta); else element.stopInertia();
      } else if (element instanceof GuiSwitch) {
        if (active) element.advanceAnimation(delta); else if (element.animating) element.finishAnimation();
      } else if (element instanceof GuiToast) {
        if (active) element.advanceAnimation(delta); else element.hide();
      }
      for (const child of element.children) advance(child, active);
    };
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      const root = entity.getComponent(GuiRoot);
      if (root&&(!this.rootFilter||this.rootFilter.has(root))) advance(root.root, true);
    }
  }

  stopAnimations(): void {
    this.releaseFrame();
    this.autoWidthKeys = new WeakMap();
    this.fontEventsCleanup?.(); this.fontEventsCleanup = null;
    for (const root of this.roots) {suspendGuiLayout(root.root); this.walkGui(root.root, element => {
      if (element instanceof GuiScrollView) element.stopInertia();
      else if (element instanceof GuiSwitch && element.animating) element.finishAnimation();
      else if (element instanceof GuiToast) element.hide();
    });}
  }

  override destroy(): this {
    this.caretClock.stop();
    for(const unsubscribe of this.textSubscriptions)unsubscribe();this.textSubscriptions.length=0;
    this.textConnection?.dispose();this.textConnection=null;
    this.unregisterInput();
    this.unregisterRecovery?.();
    this.unbindCanvas();
    this.suspendForDeviceLoss();
    return super.destroy();
  }

  suspendForDeviceLoss(): void {
    this.cancelInput();
    this.stopAnimations();
    this.scrollGesture = null;
    if (this.pressed) this.pressed.pressed = false;
    this.pressed = null;
    this.pending.length = this.pendingWheel.length = 0;
    this.renderer.destroy();
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.renderer = new GuiRenderer(this.font);
  }

  private bindCanvas(): void {
    this.ensureFontEvents();
    const canvas = this.engine.canvas;
    if (!canvas) return;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
  }

  private unbindCanvas(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fontEventsCleanup?.(); this.fontEventsCleanup = null;
    const canvas = this.engine.canvas;
    if (!canvas) return;
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pushPointerEvent('pointerdown', event);
  };

  private ensureFontEvents(): void {
    if (this.disposed || this.fontEventsCleanup || typeof document === 'undefined' || !document.fonts) return;
    const fonts = document.fonts, generation = ++this.fontEventsGeneration;
    requestGuiFontReload(this.renderer);
    const loaded = (): void => {
      if (this.disposed || generation !== this.fontEventsGeneration) return;
      requestGuiFontReload(this.renderer);
      for (const root of this.roots) root.root.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
    };
    fonts.addEventListener('loadingdone', loaded); fonts.addEventListener('loadingerror', loaded);
    // An already-loaded FontFaceSet was used by the synchronous atlas preparation.
    // Scheduling its resolved promise again would invalidate the first cached frame.
    if(fonts.status!=='loaded')void fonts.ready.then(loaded, loaded);
    this.fontEventsCleanup = () => {this.fontEventsGeneration++; fonts.removeEventListener('loadingdone', loaded); fonts.removeEventListener('loadingerror', loaded);};
  }

  private onPointerMove = (event: PointerEvent): void => {
    this.pushPointerEvent('pointermove', event);
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pushPointerEvent('pointerup', event);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.pushPointerEvent('pointercancel', event);
  };

  private onWheel = (event: WheelEvent): void => {
    const canvas = this.engine.canvas;
    if (!canvas) return;
    const rect = this.getCachedCanvasRect(canvas);
    const pending = this.pendingWheelPool.pop() ?? { native: null, x: 0, y: 0, deltaY: 0 };
    pending.native = event;
    pending.x = event.clientX - rect.left;
    pending.y = event.clientY - rect.top;
    pending.deltaY = event.deltaY;
    this.pendingWheel.push(pending);
    event.preventDefault();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.handleKeyboardEvent(event) && this.preventDefault) event.preventDefault();
  };

  private handleKeyboardEvent(event: KeyboardEvent): boolean {
    if (this.disabled || this.disposed) return false;
    this.focus.reconcile();
    const focused = this.focus.focused;
    if (focused instanceof GuiInput && (this.composing || focused.isComposing || event.isComposing)) return true;
    if(focused instanceof GuiInput&&focused.multiline&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&(event.key==='ArrowUp'||event.key==='ArrowDown')){
      const root=[...this.roots].find(root=>root.findById(focused.id)===focused),size=this.findThemeFontSize(focused);
      const presentation=guiInputPresentation(focused,text=>this.renderer.measureTextWidth(text,size,root),size,this.renderer.measureTextLineHeight(size,root));
      focused.setCaret(presentation.indexAt(presentation.caret.x,presentation.caret.y+(event.key==='ArrowUp'?-1:1)*presentation.lineHeight+presentation.lineHeight/2),event.shiftKey);return true;
    }
    const code = event.code || (event.key === ' ' ? 'Space' : event.key);
    if (!event.ctrlKey && !event.metaKey && !event.altKey &&
        (!(focused instanceof GuiInput) || ['Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(code))) {
      const chord = code === 'Tab' && event.shiftKey ? 'Shift+Tab' : code;
      for (const action of ['next','previous','left','right','up','down','confirm','cancel'] as const) {
        if (this.navigationMap.matches(action, key => key === chord)) {
          const handled = event.repeat && (action === 'confirm' || action === 'cancel')
            ? !!this.focus.focused || !!this.focus.modal : this.dispatchAction(action, 'keyboard');
          if (handled) return true;
        }
      }
    }
    if (!(focused instanceof GuiInput)) return false;
    if (this.composing || event.isComposing) return true;
    if (event.altKey) return false;
    const shortcut = event.metaKey || event.ctrlKey;

    if (shortcut) {
      const key = event.key.toLowerCase();
      if(key==='z'){if(event.shiftKey)focused.redo();else focused.undo();return true;}
      if(key==='y'){focused.redo();return true;}
      if (key === 'a') {
        focused.selectAll();
        return true;
      }
      if (key === 'c') {
          if(focused.inputType!=='password')void this.writeClipboard(focused.selectedText);
        return true;
      }
      if (key === 'x') {
          if(focused.inputType==='password')return true;
        void this.writeClipboard(focused.selectedText);
        if (!focused.readOnly && focused.hasSelection) focused.deleteForward();
        return true;
      }
      if (key === 'v') {
        const generation = this.focus.generation;
        void this.readClipboard().then(text => {
            if (text && this.focus.generation === generation && this.focus.focused === focused && !focused.isComposing && !this.disposed){focused.insertText(text);this.synchronizeTextInput();}
        });
        return true;
      }
      return false;
    }

    if (event.key === 'Backspace') {
      focused.deleteBackward();
      return true;
    }
    if (event.key === 'Delete') {
      focused.deleteForward();
      return true;
    }
    if (event.key === 'ArrowLeft') {
      focused.moveCaret(-1, event.shiftKey);
      return true;
    }
    if (event.key === 'ArrowRight') {
      focused.moveCaret(1, event.shiftKey);
      return true;
    }
    if (event.key === 'Home') {
      focused.setCaret(0, event.shiftKey);
      return true;
    }
    if (event.key === 'End') {
      focused.setCaret(focused.value.length, event.shiftKey);
      return true;
    }
    if (event.key === 'Enter') {
      if(focused.multiline)focused.insertText('\n');else if (!event.repeat) focused.submit();
      return true;
    }
    if (event.key.length === 1) {
      focused.insertText(event.key);
      return true;
    }
    return false;
  }

  /** Hosts feed already sampled UI actions here; this method never polls devices. */
  dispatchAction(action: GuiActionEvent['action'], source: GuiActionEvent['source'] = 'keyboard'): boolean {
    if(this.disabled||this.disposed)return false;
    return this.inputDomain.dispatchAction(action,source);
  }

  private handleAction(action: GuiActionEvent['action'], source: GuiActionEvent['source']): boolean {
    if (this.disabled || this.disposed) return false;
    this.focus.reconcile();
    let consumed = false;
    const event: GuiActionEvent = {action, source, get consumed() { return consumed; }, consume() { consumed = true; }};
    const modal = this.focus.modal;
    for (let node=this.focus.focused; node && !consumed; node=node.parent) {
      node.handleAction(event);
      if (node === modal) break;
    }
    if (!consumed) {
      if (action === 'next' || action === 'previous') consumed = !!this.focus.next(action === 'previous');
      else if (action === 'left' || action === 'right' || action === 'up' || action === 'down') consumed = !!this.focus.move(action);
      else if (action === 'cancel' && modal) { modal.close('cancel'); consumed = true; }
    }
    this.focus.reconcile();
    const focused=this.focus.focused;
    for(let parent=focused?.parent;parent;parent=parent.parent)if(parent instanceof GuiScrollView&&focused) {
      const top=focused.rect.y-parent.rect.y,bottom=top+focused.rect.height-parent.rect.height;
      if(top<0)parent.scrollBy(top);else if(bottom>0)parent.scrollBy(bottom);
    }
    return consumed || !!modal;
  }

  private cancelInput(): void {
    this.caretClock.stop();
    this.textViewport.clear();
    this.textConnection?.close(false);
    this.compositionTarget?.cancelComposition();this.compositionTarget=null;
    for (const id of [...this.pointerStates.keys()]) this.cancelPointer(id);
    if (this.pressed) {this.pressed.pressed = false;this.pressed.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);}
    if (this.hovered) {this.hovered.hovered = false;this.hovered.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);}
    const focused = this.focus.focused;
    if (focused instanceof GuiInput && [...this.roots].some(root => root.findById(focused.id) === focused)) focused.selecting = false;
    for (const pointerId of this.capturedPointers) this.releasePointerCapture(pointerId);
    if (this.scrollGesture) {this.scrollGesture.view.stopInertia();this.releasePointerCapture(this.scrollGesture.pointerId);}
    this.scrollGesture = null;this.pressed = this.hovered = null;this.composing = false;
    for (const event of this.pending) if (event.native) this.releasePointerCapture(event.native.pointerId);
    this.pending.length = this.pendingWheel.length = 0;
  }

  private cancelPointer(id: number): void {
    const state = this.pointerStates.get(id);
    if (!state) return;
    this.pointerStates.delete(id);
    const native = createGuiSyntheticPointer('pointercancel', id), pending = {...state.last, type:'pointercancel' as const, native};
    if (state.pressed) state.pressed.handlePointerCancel(this.makeEvent('pointercancel', state.pressed, pending, native));
    if (state.hovered) state.hovered.handlePointerLeave(this.makeEvent('pointerleave', state.hovered, pending, native));
    state.scrollGesture?.view.stopInertia();this.releasePointerCapture(id);
    if (this.pressed === state.pressed) this.pressed = null;
    if (this.hovered === state.hovered) this.hovered = null;
    if (this.scrollGesture === state.scrollGesture) this.scrollGesture = null;
  }

  private onCompositionStart = (): void => {
    const target=this.focus.focused;if(!(target instanceof GuiInput)||target.readOnly)return;
    this.composing = true;
    this.compositionTarget=target;this.compositionGeneration=this.focus.generation;target.beginComposition();
  };

  private onCompositionUpdate = (event:CompositionEvent): void => {
    if(this.compositionTarget&&this.focus.focused===this.compositionTarget&&this.focus.generation===this.compositionGeneration)this.compositionTarget.updateComposition(event.data??'');
  };

  private onCompositionEnd = (event: CompositionEvent): void => {
    this.composing = false;
    const focused=this.compositionTarget;this.compositionTarget=null;
    if(!focused||this.focus.focused!==focused||this.focus.generation!==this.compositionGeneration){focused?.cancelComposition();return;}
    if(event.data)focused.commitComposition(event.data);else focused.cancelComposition();
    if (this.preventDefault) event.preventDefault();
  };

  private onCopy = (event: ClipboardEvent): void => {
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput) || !focused.hasSelection) return;
    if(focused.inputType==='password'){event.preventDefault();return;}
    event.clipboardData?.setData('text/plain', focused.selectedText);
    if (this.preventDefault) event.preventDefault();
  };

  private onCut = (event: ClipboardEvent): void => {
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput) || !focused.hasSelection || focused.readOnly) return;
    if(focused.inputType==='password'){event.preventDefault();return;}
    event.clipboardData?.setData('text/plain', focused.selectedText);
    focused.deleteForward();
    if (this.preventDefault) event.preventDefault();
  };

  private onPaste = (event: ClipboardEvent): void => {
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput) || focused.readOnly) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) focused.insertText(text);
    if (this.preventDefault) event.preventDefault();
  };

  private pushPointerEvent(type: PendingGuiPointerEvent['type'], event: PointerEvent): void {
    if (this.preventDefault) event.preventDefault();
    const canvas = this.engine.canvas;
    if (!canvas) return;
    const rect = this.getCachedCanvasRect(canvas);
    const pending = this.pendingPool.pop() ?? { type, native: null, x: 0, y: 0 };
    pending.type = type;
    pending.native = event;
    pending.timestamp = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    pending.x = event.clientX - rect.left;
    pending.y = event.clientY - rect.top;
    this.pending.push(pending);
  }

  private getCachedCanvasRect(canvas: HTMLCanvasElement): CachedCanvasRect {
    if (this.canvasRectCache?.canvas === canvas) return this.canvasRectCache;
    const rect = canvas.getBoundingClientRect();
    this.canvasRectCache = { canvas, left: rect.left, top: rect.top };
    if (!this.canvasRectResetScheduled && typeof requestAnimationFrame === 'function') {
      this.canvasRectResetScheduled = true;
      requestAnimationFrame(() => {
        this.canvasRectCache = null;
        this.canvasRectResetScheduled = false;
      });
    }
    return this.canvasRectCache;
  }

  private dispatchPointerEvent(world: World | null, pending: PendingGuiPointerEvent): void {
    const id = pending.native?.pointerId ?? 0;
    const state = this.pointerStates.get(id);
    this.pressed = state?.pressed ?? null;this.hovered = state?.hovered ?? null;this.scrollGesture = state?.scrollGesture ?? null;
    this.dispatchPointerState(world, pending);
    if (pending.type === 'pointercancel' || pending.type === 'pointerup' && pending.native?.pointerType === 'touch') this.pointerStates.delete(id);
    else this.pointerStates.set(id, {pressed:this.pressed,hovered:this.hovered,scrollGesture:this.scrollGesture,last:{...pending}});
    // Keep the active gesture visible to lifecycle/motion code when an unrelated finger moves.
    if (!this.pressed && !this.scrollGesture) {
      const active = [...this.pointerStates.values()].find(state => state.pressed || state.scrollGesture);
      if (active) {this.pressed = active.pressed;this.scrollGesture = active.scrollGesture;}
    }
  }

  private dispatchPointerState(world: World | null, pending: PendingGuiPointerEvent): void {
    const native = pending.native;
    if (!native) return;
    this.renderer.prepare(this.engine);
    const hit = pending.routedHit === undefined ? hitTestGui(world, this.roots, pending.x, pending.y) : pending.routedHit;
    const timestamp = pending.timestamp ?? (Number.isFinite(native.timeStamp) ? native.timeStamp : performance.now());
    const gesture = this.scrollGesture;
    if (gesture && native.pointerId !== gesture.pointerId) return;
    if (gesture && (pending.type === 'pointermove' || pending.type === 'pointerup' || pending.type === 'pointercancel')) {
      if (pending.type === 'pointermove' && (gesture.dragging || Math.abs(pending.y - gesture.startY) > 6)) {
        if (!gesture.dragging) {
          gesture.dragging = true;
          if (this.pressed) this.pressed.handlePointerCancel(this.makeEvent('pointercancel', this.pressed, pending, native));
          this.pressed = null;
          this.focus.blur();
          this.updateHover(null, pending);
        }
        gesture.view.scrollTo(gesture.startOffset + gesture.startY - pending.y);
        this.sampleScroll(gesture, timestamp);
      }
      if (gesture.dragging) {
        if (pending.type === 'pointerup' || pending.type === 'pointercancel') {
          if (pending.type === 'pointerup') {
            gesture.view.scrollTo(gesture.startOffset + gesture.startY - pending.y);
            this.sampleScroll(gesture, timestamp);
            const first = gesture.samples[0]!, duration = timestamp - first.time;
            if (timestamp - gesture.lastMove <= 100 && duration > 0)
              gesture.view.fling((gesture.view.scrollY - first.offset) * 1000 / duration);
          } else gesture.view.stopInertia();
          this.scrollGesture = null;
          this.releasePointerCapture(native.pointerId);
        }
        return;
      }
      if (pending.type === 'pointerup' || pending.type === 'pointercancel') this.scrollGesture = null;
    }
    if (pending.type === 'pointermove') this.updateHover(hit, pending);

    if (pending.type === 'pointerdown') {
      this.closePopupsExcept(hit, pending.x, pending.y);
      this.updateHover(hit, pending);
      this.pressed = hit;
      const scroll = this.scrollAncestor(hit);
      const stopping = scroll?.animating ?? false;
      scroll?.stopInertia();
      this.scrollGesture = scroll ? {
        view: scroll, pointerId: native.pointerId, startY: pending.y, startOffset: scroll.scrollY,
        dragging: stopping, samples: [{ time: timestamp, offset: scroll.scrollY }], lastMove: timestamp, direction: 0,
      } : null;
      // A tap during momentum only stops the list; it must not toggle the row under the finger.
      if (stopping) { this.pressed = null; this.focus.blur(); this.updateHover(null, pending); return; }
      this.focus.focus(hit);
      if (hit) {
        // A text responder already owns native focus. Focusing the canvas here
        // would immediately blur and destroy the session just opened above.
        if(!this.textConnection?.connected)this.engine.canvas?.focus();
        // Input may have completed before this frame drains its event queue.
        // Capturing an ended touch throws on Native and browsers alike.
        const latest = this.pending.findLast(event => event.native?.pointerId === native.pointerId);
        if (native.isTrusted !== false && latest?.type !== 'pointerup' && latest?.type !== 'pointercancel') {
          this.engine.canvas?.setPointerCapture?.(native.pointerId);
          this.capturedPointers.add(native.pointerId);
        }
        if (hit instanceof GuiInput) this.updateInputCaretFromPointer(hit, pending, false);
        hit.handlePointerDown(this.makeEvent('pointerdown', hit, pending, native));
      } else {
        this.focus.blur();
      }
      return;
    }

    if (pending.type === 'pointermove') {
      const target = this.pressed ?? hit;
      if (target instanceof GuiInput && target.selecting) this.updateInputCaretFromPointer(target, pending, true);
      if (target) target.handlePointerMove(this.makeEvent('pointermove', target, pending, native));
      return;
    }

    if (pending.type === 'pointerup' || pending.type === 'pointercancel') {
      if (pending.type === 'pointerup') this.updateHover(hit,pending);
      const target = this.pressed;
      if (target instanceof GuiInput && target.selecting) this.updateInputCaretFromPointer(target, pending, true);
      if (target) {
        if (pending.type === 'pointercancel') target.handlePointerCancel(this.makeEvent('pointercancel', target, pending, native));
        else target.handlePointerUp(this.makeEvent('pointerup', target, pending, native));
      }
      if (pending.type === 'pointerup' && target && target === hit) {
        target.handleClick(this.makeEvent('click', target, pending, native));
      }
      this.releasePointerCapture(native.pointerId);
      this.pressed = null;
      // Touch has no hover after contact ends, even without a later pointermove.
      if (native.pointerType === 'touch' || pending.type === 'pointercancel') this.updateHover(null, pending);
      if (native.pointerType === 'touch' && target instanceof GuiButton && this.focus.focused === target) this.focus.blur();
    }
  }

  private updateInputCaretFromPointer(input: GuiInput, pending: PendingGuiPointerEvent, extendSelection: boolean): void {
    const fontSize = this.findThemeFontSize(input);
    const root = [...this.roots].find(root => root.findById(input.id) === input);
    const presentation=guiInputPresentation(input,text=>this.renderer.measureTextWidth(text,fontSize,root),fontSize,this.renderer.measureTextLineHeight(fontSize,root));
    const index=presentation.indexAt(pending.x,pending.y);
    if (extendSelection) input.setCaret(index, true);
    else input.setSelection(index, index);
    this.synchronizeTextInput();
  }

  private releasePointerCapture(pointerId: number): void {
    this.capturedPointers.delete(pointerId);
    const canvas = this.engine.canvas;
    if (canvas?.hasPointerCapture && !canvas.hasPointerCapture(pointerId)) return;
    canvas?.releasePointerCapture?.(pointerId);
  }

  private findThemeFontSize(element: GuiElement): number {
    let current: GuiElement | null = element;
    while (current.parent) current = current.parent;
    for (const root of this.roots) {
      if (root.root === current) return root.theme.fontSize;
    }
    return 14;
  }

  private async writeClipboard(text: string): Promise<void> {
    if (!text || typeof navigator === 'undefined') return;
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard API may be blocked outside a trusted browser gesture.
    }
  }

  private async readClipboard(): Promise<string> {
    if (typeof navigator === 'undefined') return '';
    try {
      return await navigator.clipboard?.readText() ?? '';
    } catch {
      return '';
    }
  }

  private updateHover(next: GuiElement | null, pending: PendingGuiPointerEvent): void {
    if (this.hovered === next) return;
    if (this.hovered) {
      const native = pending.native;
      if (native) this.hovered.handlePointerLeave(this.makeEvent('pointerleave', this.hovered, pending, native));
    }
    this.hovered = next;
    if (this.hovered) {
      const native = pending.native;
      if (native) this.hovered.handlePointerEnter(this.makeEvent('pointerenter', this.hovered, pending, native));
    }
  }

  private sampleScroll(gesture: NonNullable<GuiSystem['scrollGesture']>, time: number): void {
    const previous = gesture.samples.at(-1)!;
    const movement = gesture.view.scrollY - previous.offset;
    if (movement) {
      const direction = Math.sign(movement);
      if (gesture.direction && direction !== gesture.direction) gesture.samples = [previous];
      gesture.direction = direction;
      gesture.lastMove = time;
    }
    // Retain a short recent window, including the release pause; do not reuse stale fling speed.
    while (gesture.samples.length > 1 && time - gesture.samples[0]!.time > 100) gesture.samples.shift();
    if (time > previous.time) gesture.samples.push({ time, offset: gesture.view.scrollY });
    else previous.offset = gesture.view.scrollY;
  }

  private scrollAncestor(element: GuiElement | null): GuiScrollView | null {
    for (let node=element;node;node=node.parent) if (node instanceof GuiScrollView && node.maxScrollY>0) return node;
    return null;
  }

  private dispatchWheelEvent(world: World | null, pending: PendingGuiWheelEvent): void {
    const native = pending.native;
    if (!native) return;
    const hit = hitTestGui(world, this.roots, pending.x, pending.y);
    if (hit instanceof GuiSelect && hit.open && hit.containsPointIncludingPopup(pending.x, pending.y)) {
      hit.scrollBy(pending.deltaY);
      this.inputConsumed=true;
      if(this.preventDefault)native.preventDefault();
      return;
    }
    let scroll = this.scrollAncestor(hit);
    const delta = pending.deltaY * (native.deltaMode === 1 ? 16 : native.deltaMode === 2 ? (scroll?.rect.height ?? 1) : 1);
    while (scroll) {
      const previous = scroll.scrollY;
      scroll.scrollBy(delta);
      if (scroll.scrollY !== previous) {this.inputConsumed=true;break;}
      scroll = this.scrollAncestor(scroll.parent);
    }
  }

  private makeEvent(
    type: GuiPointerEvent['type'],
    target: GuiElement,
    pending: PendingGuiPointerEvent,
    native: PointerEvent,
  ): GuiPointerEvent {
    const system=this;
    const event: GuiPointerEvent = {
      type,
      target,
      currentTarget: target,
      x: pending.x,
      y: pending.y,
      localX: pending.x - target.rect.x,
      localY: pending.y - target.rect.y,
      button: native.button,
      buttons: native.buttons,
      pointerId: native.pointerId,
      nativeEvent: native,
      routed: true,
      stopped: false,
      defaultPrevented: native.defaultPrevented,
      stopPropagation() {
        event.stopped = true;
        system.inputConsumed = true;
      },
      preventDefault() {
        event.defaultPrevented = true;
        native.preventDefault();
      },
    };
    return event;
  }

  /** Scene/default actions run only after every GUI layer declines the event. */
  onUnhandledInput(callback: (event: Event) => boolean | void): () => void {return this.inputDomain.subscribeUnhandled(callback);}

  private inputProjection() {
    const root=[...this.roots][0];
    const width=this.engine.displayWidth??root?.viewport.width??1,height=this.engine.displayHeight??root?.viewport.height??1;
    const region=this.region?getRenderRegionState(this.region)?.snapshot().bounds:undefined;
    return guiInputProjection(width,height,this.inputView,region);
  }
  private inputPoint(event: {clientX:number;clientY:number}) {
    const canvas=this.engine.canvas,projection=this.inputProjection();
    if(!canvas||!projection)return null;
    const rect=canvas.getBoundingClientRect();
    return guiInputPoint(event.clientX,event.clientY,{x:rect.left,y:rect.top,width:rect.width,height:rect.height},projection);
  }
  private pickPointer(event: {clientX:number;clientY:number}): GuiElement | null {
    const point=this.inputPoint(event);
    return point?.inside?hitTestGui(null,new Set(this.inputRoots()),point.x,point.y):null;
  }
  private routePointer(native: PointerEvent,hit?:GuiElement|null): boolean {
    const point=this.inputPoint(native);if(!point)return false;
    this.inputConsumed=false;
    this.dispatchPointerEvent(null,{type:native.type as PendingGuiPointerEvent['type'],native,x:point.x,y:point.y,routedHit:hit===undefined?this.pickPointer(native):hit});
    return this.inputConsumed;
  }
  private routeWheel(native: WheelEvent): boolean {
    const point=this.inputPoint(native);if(!point?.inside)return false;
    this.inputConsumed=false;this.dispatchWheelEvent(null,{native,x:point.x,y:point.y,deltaY:native.deltaY});return this.inputConsumed;
  }
  private validPointerTarget(element:GuiElement): boolean {
    let root=element;
    for(let node:GuiElement|null=element;node;node=node.parent){if(!node.visible||node.disabled||isGuiLayoutHidden(node))return false;root=node;}
    return this.inputRoots().some(r=>r.root===root);
  }
  private leavePointer(native:PointerEvent):void {
    const state=this.pointerStates.get(native.pointerId),point=this.inputPoint(native);
    if(!state?.hovered||!point)return;
    const hovered=state.hovered;state.hovered=null;
    hovered.handlePointerLeave(this.makeEvent('pointerleave',hovered,{type:'pointermove',native,x:point.x,y:point.y},native));
    if(this.hovered===hovered)this.hovered=null;
  }

  private prepareRoots(world: World, width = this.engine.displayWidth, height = this.engine.displayHeight): void {
    this.inputWorld=world;
    this.ensureFontEvents();
    const previous = new Set(this.roots);
    this.roots.clear();
    this.renderer.prepare(this.engine);
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      const root = entity.getComponent(GuiRoot);
      if (!root) continue;
      if (this.rootFilter&&!this.rootFilter.has(root)) continue;
      previous.delete(root);
      bindGuiMeasureOwner(root, this.renderer);
      this.measureAutoWidthLabels(root.root, root.theme.fontSize, root);
      root.layout(width, height);
      if (root.root.dirty) GuiRadio.rebuildGroupRegistry(root.root);
      else GuiRadio.ensureGroupRegistry(root.root);
      this.roots.add(root);
    }
    for (const root of previous) suspendGuiLayout(root.root);
    this.inputDomain.refresh();
    this.synchronizeTextInput();
  }

  private synchronizeTextInput():void {
    const target=this.focus.focused;
    if(!(target instanceof GuiInput))this.textViewport.clear();
    this.caretClock.synchronize(target instanceof GuiInput?target:null);
    this.textConnection?.synchronize(target instanceof GuiInput&&this.inputParticipant.enabled()&&this.validPointerTarget(target)?target:null);
  }
  private textCaretRect(input:GuiInput){
    const root=[...this.roots].find(root=>root.findById(input.id)===input),size=this.findThemeFontSize(input);
    const presentation=()=>guiInputPresentation(input,text=>this.renderer.measureTextWidth(text,size,root),size,this.renderer.measureTextLineHeight(size,root));
    let local=presentation().caret;
    const projection=this.inputProjection(),canvas=this.engine.canvas;
    if(!projection||!canvas)return local;
    const rect=canvas.getBoundingClientRect(),inset=this.textViewportInset;
    const left=rect.left+inset.left,top=rect.top+inset.top,right=rect.left+rect.width-inset.right,bottom=rect.top+rect.height-inset.bottom;
    const toLocal=(x:number,y:number)=>guiInputPoint(x,y,{x:rect.left,y:rect.top,width:rect.width,height:rect.height},projection);
    const a=toLocal(left,top),b=toLocal(right,bottom);
    if(a&&b){this.textViewport.reveal(input,local,{x:a.x,y:a.y,width:Math.max(0,b.x-a.x),height:Math.max(0,b.y-a.y)});local=presentation().caret;}
    const host=guiInputHostRect(local,projection);
    return {x:rect.left+host.x*rect.width/projection.hostWidth,y:rect.top+host.y*rect.height/projection.hostHeight,width:host.width*rect.width/projection.hostWidth,height:host.height*rect.height/projection.hostHeight};
  }

  private inputRoots(): GuiRoot[] {
    const entities=this.inputWorld?this.entitySet.get(this.inputWorld):null;
    return [...this.roots].filter(root=>!root.destroyed&&(!this.inputWorld||[...(entities??[])].some(entity=>entity.getComponent(GuiRoot)===root)));
  }

  private measureAutoWidthLabels(element: GuiElement, themeFontSize: number, root: GuiRoot): void {
    const version = guiMeasureFontVersion(root);
    if (element instanceof GuiHelpDialog) setGuiHelpDialogTextMetrics(element,(text,size)=>this.renderer.measureTextWidth(text,size,root), version);
    if (element instanceof GuiLabel && element.autoWidth && !isGuiLayoutManaged(element)) {
      const key = JSON.stringify([version, element.text, element.fontSize ?? themeFontSize]);
      if (this.autoWidthKeys.get(element) !== key) {
      setGuiLabelMeasuredTextWidth(
        element,
        this.renderer.measureTextWidth(element.text, element.fontSize ?? themeFontSize, root),
      );
      this.autoWidthKeys.set(element, key);
      }
    }
    for (const child of element.children) this.measureAutoWidthLabels(child, themeFontSize, root);
  }

  private dispatchPendingEvents(world: World): void {
    const events = this.pending;
    const state=this.region?getRenderRegionState(this.region):undefined;
    const region=state&&!state.isDisposed?state.snapshot():undefined;
    for (const event of events) {
      if(region){event.x-=region.bounds.x;event.y-=region.bounds.y;}
      if(!region||region.visible)this.dispatchPointerEvent(world, event);
    }
    for (const event of events) {
      event.native = null;
      this.pendingPool.push(event);
    }
    events.length = 0;
    const wheelEvents = this.pendingWheel;
    for (const event of wheelEvents) {
      if(region){event.x-=region.bounds.x;event.y-=region.bounds.y;}
      if(!region||region.visible)this.dispatchWheelEvent(world, event);
    }
    for (const event of wheelEvents) {
      event.native = null;
      this.pendingWheelPool.push(event);
    }
    wheelEvents.length = 0;
    this.canvasRectCache = null;
  }

  private render(context: RenderCommandContext): void {
    if (this.roots.size === 0) return;

    if (!context.passEncoder && !isRegionRenderTarget(context.view?.target)) {
      context.descriptor = context.view
        ? cloneRenderPassDescriptor(
            context.view.target.getRenderPassDescriptor(getRenderViewPassOptions(context.view)),
            this.loadOp,
          )
        : getCachedRenderPassDescriptor(this.engine, this.loadOp);
      context.loadOp = this.loadOp;
      const depthAttachment = context.descriptor.depthStencilAttachment;
      if (depthAttachment) {
        depthAttachment.depthStoreOp = 'store';
      }
    }

    const { passEncoder, ownsPass } = beginRenderCommandPass(context);
    const view=context.view,viewport=getRegionProjection(view)??view?.viewport;
    let surface=view?{width:view.displayWidth,height:view.displayHeight,format:view.target.format,originX:0,originY:0}:null;
    if(view&&viewport&&viewport.width>0&&viewport.height>0){
      // Keep fractional translation in the vertex projection rather than relying
      // on fractional viewport edge coverage.
      const sx=viewport.width/view.displayWidth,sy=viewport.height/view.displayHeight;
      surface={width:view.target.width/sx,height:view.target.height/sy,format:view.target.format,originX:-viewport.x/sx,originY:-viewport.y/sy};
      passEncoder.setViewport(0,0,view.target.width,view.target.height,0,1);
      const scissor=view.scissor;
      const x=Math.max(0,Math.floor(viewport.x),scissor?.x??0),y=Math.max(0,Math.floor(viewport.y),scissor?.y??0);
      const right=Math.min(view.target.width,Math.ceil(viewport.x+viewport.width),scissor?scissor.x+scissor.width:view.target.width),bottom=Math.min(view.target.height,Math.ceil(viewport.y+viewport.height),scissor?scissor.y+scissor.height:view.target.height);
      passEncoder.setScissorRect(x,y,Math.max(0,right-x),Math.max(0,bottom-y));
    }else if(view?.scissor){const s=view.scissor;passEncoder.setScissorRect(s.x,s.y,s.width,s.height)}
    try{this.renderer.render(
      passEncoder,
      this.roots,
      this.engine,
      context.view?.reverseZ ?? this.engine.reverseZ,
      context.view?.sampleCount ?? this.engine.msaaSamples,
      surface,
      context,
    );}finally{
      if(!ownsPass&&view&&viewport&&viewport.width>0&&viewport.height>0){
        const restore=view.viewport??{x:0,y:0,width:view.target.width,height:view.target.height};
        passEncoder.setViewport(restore.x,restore.y,restore.width,restore.height,restore.minDepth??0,restore.maxDepth??1);
        const scissor=view.scissor??{x:0,y:0,width:view.target.width,height:view.target.height};
        passEncoder.setScissorRect(scissor.x,scissor.y,scissor.width,scissor.height);
      }
      if(ownsPass)passEncoder.end();
    }
  }

  private closePopupsExcept(hit: GuiElement | null, x: number, y: number): void {
    for (const root of this.roots) {
      this.walkGui(root.root, (element) => {
        if (!(element instanceof GuiSelect) || !element.open) return;
        if (element === hit && element.containsPointIncludingPopup(x, y)) return;
        element.setOpen(false);
      });
    }
  }

  private walkGui(element: GuiElement, visitor: (element: GuiElement) => void): void {
    visitor(element);
    for (const child of element.children) this.walkGui(child, visitor);
  }
}
