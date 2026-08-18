import type { IEngine } from '../../core/IEngine';
import { System } from '../../ecs/System';
import { World } from '../../ecs/World';
import { GuiElement } from '../components/GuiElement';
import { GuiInput } from '../components/GuiInput';
import { GuiRadio } from '../components/GuiRadio';
import { GuiRoot } from '../components/GuiRoot';
import { GuiSelect } from '../components/GuiSelect';
import { GuiFocusManager } from '../input/GuiFocusManager';
import { hitTestGui } from '../input/GuiHitTest';
import { GuiPointerEvent } from '../GuiTypes';
import { GuiRenderer } from '../rendering/GuiRenderer';
import { getCachedRenderPassDescriptor } from '../../core/renderPassDescriptor';
import { beginRenderCommandPass } from '../../core/RenderCommandContext';
import type { RenderCommandContext } from '../../core/RenderCommandContext';
import { getRenderViewPassOptions } from '../../core/RenderView';
import { cloneRenderPassDescriptor } from '../../core/renderPassDescriptor';
import type { RenderPipelineEntryOptions } from '../../renderer/RenderPipeline';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';

interface PendingGuiPointerEvent {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  native: PointerEvent | null;
  x: number;
  y: number;
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

export interface GuiSystemOptions {
  preventDefault?: boolean;
  /** 'clear' resets the canvas; 'load' composites GUI on top of earlier render systems. Defaults to 'load'. */
  loadOp?: 'clear' | 'load';
}

export class GuiSystem extends System {
  readonly focus = new GuiFocusManager();

  private engine: IEngine;
  private preventDefault: boolean;
  private pending: PendingGuiPointerEvent[] = [];
  private pendingWheel: PendingGuiWheelEvent[] = [];
  private pendingPool: PendingGuiPointerEvent[] = [];
  private pendingWheelPool: PendingGuiWheelEvent[] = [];
  private canvasRectCache: CachedCanvasRect | null = null;
  private canvasRectResetScheduled = false;
  private hovered: GuiElement | null = null;
  private pressed: GuiElement | null = null;
  private roots = new Set<GuiRoot>();
  private renderer = new GuiRenderer();
  private disposed = false;
  private composing = false;
  loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'GuiSystem' as const };
  private readonly unregisterRecovery: (() => void) | null;

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return { pass: 'shared', loadOp: this.loadOp, sort: this.priority };
  }

  constructor(engine: IEngine, options: GuiSystemOptions = {}) {
    super({ all: [GuiRoot] });
    this.name = 'GuiSystem';
    this.priority = 10000;
    this.engine = engine;
    this.preventDefault = options.preventDefault ?? true;
    this.loadOp = options.loadOp ?? 'load';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this.unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
    this.bindCanvas();
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    this.renderer.contributePipelineWarmup(plan, this.engine);
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    this.prepareRoots(world, context.view?.displayWidth, context.view?.displayHeight);
    this.dispatchPendingEvents(world);
    this.render(context);
    for (const root of this.roots) root.clearDirty();
    return this;
  }

  override destroy(): this {
    this.unregisterRecovery?.();
    this.unbindCanvas();
    this.suspendForDeviceLoss();
    return super.destroy();
  }

  suspendForDeviceLoss(): void {
    this.renderer.destroy();
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.renderer = new GuiRenderer();
  }

  private bindCanvas(): void {
    const canvas = this.engine.canvas;
    if (!canvas) return;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('compositionstart', this.onCompositionStart);
    canvas.addEventListener('compositionend', this.onCompositionEnd);
    canvas.addEventListener('copy', this.onCopy);
    canvas.addEventListener('cut', this.onCut);
    canvas.addEventListener('paste', this.onPaste);
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
  }

  private unbindCanvas(): void {
    if (this.disposed) return;
    this.disposed = true;
    const canvas = this.engine.canvas;
    if (!canvas) return;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('keydown', this.onKeyDown);
    canvas.removeEventListener('compositionstart', this.onCompositionStart);
    canvas.removeEventListener('compositionend', this.onCompositionEnd);
    canvas.removeEventListener('copy', this.onCopy);
    canvas.removeEventListener('cut', this.onCut);
    canvas.removeEventListener('paste', this.onPaste);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pushPointerEvent('pointerdown', event);
  };

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
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput)) return;
    if (this.composing || event.isComposing) return;
    if (event.altKey) return;
    const shortcut = event.metaKey || event.ctrlKey;

    if (shortcut) {
      const key = event.key.toLowerCase();
      if (key === 'a') {
        focused.selectAll();
        event.preventDefault();
        return;
      }
      if (key === 'c') {
        void this.writeClipboard(focused.selectedText);
        event.preventDefault();
        return;
      }
      if (key === 'x') {
        void this.writeClipboard(focused.selectedText);
        if (!focused.readOnly && focused.hasSelection) focused.deleteForward();
        event.preventDefault();
        return;
      }
      if (key === 'v') {
        void this.readClipboard().then(text => {
          if (text) focused.insertText(text);
        });
        event.preventDefault();
        return;
      }
      return;
    }

    if (event.key === 'Backspace') {
      focused.deleteBackward();
      event.preventDefault();
      return;
    }
    if (event.key === 'Delete') {
      focused.deleteForward();
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowLeft') {
      focused.moveCaret(-1, event.shiftKey);
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowRight') {
      focused.moveCaret(1, event.shiftKey);
      event.preventDefault();
      return;
    }
    if (event.key === 'Home') {
      focused.setCaret(0, event.shiftKey);
      event.preventDefault();
      return;
    }
    if (event.key === 'End') {
      focused.setCaret(focused.value.length, event.shiftKey);
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      focused.submit();
      event.preventDefault();
      return;
    }
    if (event.key.length === 1) {
      focused.insertText(event.key);
      event.preventDefault();
    }
  };

  private onCompositionStart = (): void => {
    this.composing = true;
  };

  private onCompositionEnd = (event: CompositionEvent): void => {
    this.composing = false;
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput) || focused.readOnly) return;
    if (event.data) focused.insertText(event.data);
    event.preventDefault();
  };

  private onCopy = (event: ClipboardEvent): void => {
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput) || !focused.hasSelection) return;
    event.clipboardData?.setData('text/plain', focused.selectedText);
    event.preventDefault();
  };

  private onCut = (event: ClipboardEvent): void => {
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput) || !focused.hasSelection || focused.readOnly) return;
    event.clipboardData?.setData('text/plain', focused.selectedText);
    focused.deleteForward();
    event.preventDefault();
  };

  private onPaste = (event: ClipboardEvent): void => {
    const focused = this.focus.focused;
    if (!(focused instanceof GuiInput) || focused.readOnly) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) focused.insertText(text);
    event.preventDefault();
  };

  private pushPointerEvent(type: PendingGuiPointerEvent['type'], event: PointerEvent): void {
    if (this.preventDefault) event.preventDefault();
    const canvas = this.engine.canvas;
    if (!canvas) return;
    const rect = this.getCachedCanvasRect(canvas);
    const pending = this.pendingPool.pop() ?? { type, native: null, x: 0, y: 0 };
    pending.type = type;
    pending.native = event;
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

  private dispatchPointerEvent(world: World, pending: PendingGuiPointerEvent): void {
    const native = pending.native;
    if (!native) return;
    this.renderer.prepare(this.engine);
    const hit = hitTestGui(world, this.roots, pending.x, pending.y);
    if (pending.type === 'pointermove') this.updateHover(hit, pending);

    if (pending.type === 'pointerdown') {
      this.closePopupsExcept(hit, pending.x, pending.y);
      this.updateHover(hit, pending);
      this.pressed = hit;
      this.focus.focus(hit);
      if (hit) {
        this.engine.canvas?.focus();
        this.engine.canvas?.setPointerCapture?.(native.pointerId);
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
      const target = this.pressed ?? hit;
      if (target instanceof GuiInput && target.selecting) this.updateInputCaretFromPointer(target, pending, true);
      if (target) target.handlePointerUp(this.makeEvent('pointerup', target, pending, native));
      if (pending.type === 'pointerup' && target && target === hit) {
        target.handleClick(this.makeEvent('click', target, pending, native));
      }
      this.engine.canvas?.releasePointerCapture?.(native.pointerId);
      this.pressed = null;
    }
  }

  private updateInputCaretFromPointer(input: GuiInput, pending: PendingGuiPointerEvent, extendSelection: boolean): void {
    const fontSize = this.findThemeFontSize(input);
    const padding = input.style.padding ?? 8;
    const index = input.getCaretIndexAt(
      pending.x - input.rect.x,
      text => this.renderer.measureTextWidth(text, fontSize),
      padding,
    );
    if (extendSelection) input.setCaret(index, true);
    else input.setSelection(index, index);
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

  private dispatchWheelEvent(world: World, pending: PendingGuiWheelEvent): void {
    const native = pending.native;
    if (!native) return;
    const hit = hitTestGui(world, this.roots, pending.x, pending.y);
    if (hit instanceof GuiSelect && hit.open && hit.containsPointIncludingPopup(pending.x, pending.y)) {
      hit.scrollBy(pending.deltaY);
      native.preventDefault();
    }
  }

  private makeEvent(
    type: GuiPointerEvent['type'],
    target: GuiElement,
    pending: PendingGuiPointerEvent,
    native: PointerEvent,
  ): GuiPointerEvent {
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
      stopped: false,
      defaultPrevented: native.defaultPrevented,
      stopPropagation() {
        event.stopped = true;
      },
      preventDefault() {
        event.defaultPrevented = true;
        native.preventDefault();
      },
    };
    return event;
  }

  private prepareRoots(world: World, width = this.engine.displayWidth, height = this.engine.displayHeight): void {
    this.roots.clear();
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      const root = entity.getComponent(GuiRoot);
      if (!root) continue;
      root.layout(width, height);
      if (root.root.dirty) GuiRadio.rebuildGroupRegistry(root.root);
      else GuiRadio.ensureGroupRegistry(root.root);
      this.roots.add(root);
    }
  }

  private dispatchPendingEvents(world: World): void {
    const events = this.pending;
    for (const event of events) this.dispatchPointerEvent(world, event);
    for (const event of events) {
      event.native = null;
      this.pendingPool.push(event);
    }
    events.length = 0;
    const wheelEvents = this.pendingWheel;
    for (const event of wheelEvents) this.dispatchWheelEvent(world, event);
    for (const event of wheelEvents) {
      event.native = null;
      this.pendingWheelPool.push(event);
    }
    wheelEvents.length = 0;
    this.canvasRectCache = null;
  }

  private render(context: RenderCommandContext): void {
    if (this.roots.size === 0) return;

    if (!context.passEncoder) {
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
    this.renderer.render(
      passEncoder,
      this.roots,
      this.engine,
      context.view?.reverseZ ?? this.engine.reverseZ,
      context.view?.sampleCount ?? this.engine.msaaSamples,
    );
    if (ownsPass) passEncoder.end();
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
