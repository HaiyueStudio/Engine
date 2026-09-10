import { System, type World } from '@haiyue/engine/ecs';
import { CartesianTransform3D, Transform2D } from '@haiyue/engine/components';
import { EventEmitter } from '@haiyue/engine/core';
import { JoystickView } from './JoystickView';
import type {
  JoystickPoint, JoystickRegion, JoystickViewport, VirtualJoystickEventMap,
  VirtualJoystickOptions, VirtualJoystickState, VirtualJoystickSurface,
} from './contracts';

type Options = Required<Omit<VirtualJoystickOptions, 'shouldActivate'>> & Pick<VirtualJoystickOptions, 'shouldActivate'>;
const DEFAULT_CENTER = ({ width, height }: JoystickViewport): JoystickPoint => ({
  x: Math.min(110, width / 4), y: height - Math.min(110, height / 4),
});
const DEFAULT_REGION = ({ width, height }: JoystickViewport): JoystickRegion => ({
  x: 0, y: height / 2, width: width / 2, height: height / 2,
});

/**
 * Single-owner multitouch joystick. Add as a non-render System, or call step(dtMs)
 * exactly once per frame. Set touch-action:none on the browser input surface.
 * The supplied target is moved in parent-local coordinates without collision solving.
 */
export class VirtualJoystickControls extends System {
  readonly events = new EventEmitter<VirtualJoystickEventMap>();
  private readonly surface: VirtualJoystickSurface;
  private readonly document: Document | null;
  private readonly window: Window | null;
  private options: Options;
  private view: JoystickView | null = null;
  private pointerId: number | null = null;
  private center: JoystickPoint = { x: 0, y: 0 };
  private point: JoystickPoint = { x: 0, y: 0 };
  private bounds = '';
  private disposed = false;

  constructor(surface: VirtualJoystickSurface, options: VirtualJoystickOptions = {}) {
    super(() => false);
    this.name = 'VirtualJoystickControls';
    this.priority = -100;
    this.surface = surface;
    this.document = surface.ownerDocument ?? null;
    this.window = this.document?.defaultView ?? null;
    this.options = normalize(options);
    this.refreshLayout();
    this.createView();
    surface.addEventListener('pointerdown', this.onDown, { passive: false });
    surface.addEventListener('pointermove', this.onMove, { passive: false });
    surface.addEventListener('pointerup', this.onUp);
    surface.addEventListener('pointercancel', this.onCancel);
    surface.addEventListener('lostpointercapture', this.onCancel);
    this.window?.addEventListener('blur', this.onBlur);
    // Also handles a release outside a surface without native pointer capture.
    this.window?.addEventListener('pointerup', this.onUp);
    this.window?.addEventListener('pointercancel', this.onCancel);
    this.document?.addEventListener('visibilitychange', this.onVisibility);
  }

  override get disabled(): boolean { return super.disabled; }
  override set disabled(value: boolean) {
    super.disabled = value;
    // System's constructor invokes this setter before subclass fields exist.
    if (this.surface) {
      if (value) this.cancel();
      this.updateView();
    }
  }

  /** Retainable immutable snapshot; caller mutation cannot alter future movement. */
  get state(): VirtualJoystickState {
    const active = this.pointerId !== null;
    const dx = active ? this.point.x - this.center.x : 0;
    const dy = active ? this.point.y - this.center.y : 0;
    const rawDistance = Math.hypot(dx, dy);
    const distance = Math.min(rawDistance, this.options.maxDistance);
    const ratio = distance / this.options.maxDistance;
    const strength = Math.max(0, (ratio - this.options.deadZone) / (1 - this.options.deadZone));
    const unitX = rawDistance > 0 ? dx / rawDistance : 0;
    const unitY = rawDistance > 0 ? dy / rawDistance : 0;
    return Object.freeze({
      active, pointerId: this.pointerId, center: Object.freeze({ ...this.center }),
      direction: Object.freeze({ x: strength > 0 ? unitX : 0, y: strength > 0 ? unitY : 0 }),
      offset: Object.freeze({ x: unitX * distance, y: unitY * distance }),
      rawDistance, distance, strength, angle: strength > 0 ? Math.atan2(dy, dx) : 0,
    });
  }

  /** Atomic parameter update. A valid update cancels the current gesture. */
  configure(options: VirtualJoystickOptions): this {
    if (this.disposed) return this;
    const next = normalize({ ...this.options, ...options });
    const viewport = this.surface.getBoundingClientRect();
    resolvePoint(next.center, viewport);
    resolveRegion(next.region, viewport);
    this.cancel();
    this.options = next;
    this.refreshLayout();
    this.createView();
    return this;
  }

  /** Cancel from native suspend/unload hooks; idempotent, returns thumb to center. */
  cancel(): this { this.finish('cancel'); return this; }

  /** Delta is milliseconds, matching World.update(). No internal RAF or timer. */
  step(deltaMilliseconds: number): this {
    nonNegative(deltaMilliseconds, 'deltaMilliseconds');
    if (this.disposed || this.disabled) return this;
    this.refreshLayout();
    const state = this.state;
    const deltaSeconds = deltaMilliseconds / 1000;
    const movementDeltaSeconds = Math.min(deltaMilliseconds, this.options.maxDeltaMilliseconds) / 1000;
    this.moveTarget(state, movementDeltaSeconds);
    this.updateView(state);
    this.events.emit('frame', { detail: Object.freeze({ ...state, deltaMilliseconds, deltaSeconds, movementDeltaSeconds }) });
    return this;
  }

  override update(_world: World, _time: number, delta: number): this {
    // The first RAF timestamp can precede FrameLoop.start()'s performance.now().
    // A clock-origin adjustment must never abort rendering or move a character backwards.
    return this.step(Math.max(0, delta));
  }

  override destroy(): this {
    if (this.disposed) return this;
    this.disposed = true;
    // Teardown is completed even if a consumer's cancel callback throws.
    try { this.cancel(); } finally {
      this.surface.removeEventListener('pointerdown', this.onDown);
      this.surface.removeEventListener('pointermove', this.onMove);
      this.surface.removeEventListener('pointerup', this.onUp);
      this.surface.removeEventListener('pointercancel', this.onCancel);
      this.surface.removeEventListener('lostpointercapture', this.onCancel);
      this.window?.removeEventListener('blur', this.onBlur);
      this.window?.removeEventListener('pointerup', this.onUp);
      this.window?.removeEventListener('pointercancel', this.onCancel);
      this.document?.removeEventListener('visibilitychange', this.onVisibility);
      this.view?.destroy();
      this.view = null;
      this.events.removeAllListeners();
      super.destroy();
    }
    return this;
  }

  private refreshLayout(): void {
    const rect = this.surface.getBoundingClientRect();
    const key = `${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
    if (this.bounds && this.bounds !== key) this.cancel();
    this.bounds = key;
    if (this.pointerId === null) {
      const viewport = { width: rect.width, height: rect.height };
      this.center = resolvePoint(this.options.center, viewport);
    }
  }

  private createView(): void {
    this.view?.destroy();
    this.view = this.options.guiRoot
      ? new JoystickView(this.options.guiRoot, this.options.baseStyle, this.options.knobStyle) : null;
    this.updateView();
  }

  private updateView(state = this.state): void {
    this.view?.update(state, this.options.maxDistance, this.options.knobRadius,
      !this.disabled && !this.disposed && (state.active || (this.options.mode === 'fixed' && this.options.showIdle)));
  }

  private local(event: PointerEvent): JoystickPoint | null {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    const rect = this.surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private readonly onDown = (native: Event): void => {
    const event = native as PointerEvent;
    // GuiSystem prevents browser scrolling on all canvas pointers. That is not an
    // input-ownership claim: use region/shouldActivate to arbitrate game input.
    if (this.disposed || this.disabled || this.pointerId !== null
      || (event.button !== undefined && event.button !== 0)) return;
    this.refreshLayout();
    const point = this.local(event);
    if (!point || !Number.isFinite(event.pointerId)) return;
    const rect = this.surface.getBoundingClientRect();
    const region = resolveRegion(this.options.region, rect);
    if (point.x < 0 || point.y < 0 || point.x > rect.width || point.y > rect.height
      || point.x < region.x || point.y < region.y || point.x > region.x + region.width || point.y > region.y + region.height) return;
    if (this.options.mode === 'fixed' && Math.hypot(point.x - this.center.x, point.y - this.center.y)
      > (this.options.activationRadius ?? this.options.maxDistance + this.options.knobRadius)) return;
    if (this.options.shouldActivate?.(point, event) === false) return;
    if (this.options.mode === 'floating') this.center = { ...point };
    this.point = point;
    this.pointerId = event.pointerId;
    try { this.surface.setPointerCapture?.(event.pointerId); } catch { /* Synthetic/host pointers may not support capture. */ }
    event.preventDefault();
    this.updateView();
    this.events.emit('start', { detail: this.state });
  };

  private readonly onMove = (native: Event): void => {
    const event = native as PointerEvent;
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;
    this.refreshLayout();
    if (this.pointerId === null) return;
    const point = this.local(event);
    if (point) this.point = point;
    event.preventDefault();
  };

  private readonly onUp = (event: Event): void => {
    if (this.pointerId !== null && (event as PointerEvent).pointerId === this.pointerId) this.finish('end');
  };
  private readonly onCancel = (event: Event): void => {
    if (this.pointerId !== null && (event as PointerEvent).pointerId === this.pointerId) this.cancel();
  };
  private readonly onBlur = (): void => { this.cancel(); };
  private readonly onVisibility = (): void => { if (this.document?.hidden) this.cancel(); };

  private finish(type: 'end' | 'cancel'): void {
    const id = this.pointerId;
    if (id === null) return;
    this.pointerId = null;
    this.point = { ...this.center };
    try { this.surface.releasePointerCapture?.(id); } catch { /* Capture may already be lost. */ }
    this.updateView();
    this.events.emit(type, { detail: this.state });
  }

  private moveTarget(state: VirtualJoystickState, dt: number): void {
    const { target, plane, moveSpeed, analog, rotateToDirection, rotationOffset, turnSpeed, movementRotation } = this.options;
    if (!target || target.destroyed || target.disabled || state.strength === 0 || dt === 0) return;
    const c = Math.cos(movementRotation), s = Math.sin(movementRotation);
    const dx = state.direction.x, dy = state.direction.y;
    const amount = moveSpeed * dt * (analog ? state.strength : 1);
    if (plane === 'xz') {
      const transform = target.getComponent(CartesianTransform3D);
      if (!transform || transform.disabled) return;
      const x = c * dx + s * dy, z = -s * dx + c * dy;
      const p = transform.position, r = transform.rotation;
      transform.setPosition(p[0]! + x * amount, p[1]!, p[2]! + z * amount);
      if (rotateToDirection) transform.setRotation(r[0]!, turn(r[1]!, Math.atan2(-x, -z) + rotationOffset, turnSpeed * dt), r[2]!);
    } else {
      const transform = target.getComponent(Transform2D);
      if (!transform || transform.disabled) return;
      const x = c * dx + s * dy, y = s * dx - c * dy;
      transform.setPosition(transform.x + x * amount, transform.y + y * amount);
      if (rotateToDirection) transform.rotation = turn(transform.rotation, Math.atan2(y, x) + rotationOffset, turnSpeed * dt);
    }
  }
}

function turn(current: number, desired: number, max: number): number {
  const difference = Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
  return current + Math.max(-max, Math.min(max, difference));
}
function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`VirtualJoystickControls ${name} must be finite and non-negative.`);
  return value;
}
function positive(value: number, name: string): number {
  nonNegative(value, name);
  if (value === 0) throw new RangeError(`VirtualJoystickControls ${name} must be positive.`);
  return value;
}
function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`VirtualJoystickControls ${name} must be finite.`);
  return value;
}
function resolvePoint(value: Options['center'], viewport: JoystickViewport): JoystickPoint {
  const p = typeof value === 'function' ? value(viewport) : value;
  return { x: finite(p.x, 'center.x'), y: finite(p.y, 'center.y') };
}
function resolveRegion(value: Options['region'], viewport: JoystickViewport): JoystickRegion {
  const r = typeof value === 'function' ? value(viewport) : value;
  return { x: finite(r.x, 'region.x'), y: finite(r.y, 'region.y'),
    width: nonNegative(r.width, 'region.width'), height: nonNegative(r.height, 'region.height') };
}
function normalize(input: VirtualJoystickOptions): Options {
  const mode = input.mode ?? 'floating', plane = input.plane ?? 'xz';
  if (mode !== 'fixed' && mode !== 'floating') throw new RangeError('VirtualJoystickControls invalid mode.');
  if (plane !== 'xz' && plane !== 'xy') throw new RangeError('VirtualJoystickControls invalid plane.');
  const deadZone = nonNegative(input.deadZone ?? 0.1, 'deadZone');
  if (deadZone >= 1) throw new RangeError('VirtualJoystickControls deadZone must be less than 1.');
  const target = input.target ?? null;
  if (target && (target.destroyed || !(plane === 'xz' ? target.getComponent(CartesianTransform3D) : target.getComponent(Transform2D)))) {
    throw new TypeError(`VirtualJoystickControls target requires a live ${plane === 'xz' ? 'CartesianTransform3D' : 'Transform2D'}.`);
  }
  const center = input.center ?? DEFAULT_CENTER, region = input.region ?? DEFAULT_REGION;
  if (typeof center !== 'function') resolvePoint(center, { width: 0, height: 0 });
  if (typeof region !== 'function') resolveRegion(region, { width: 0, height: 0 });
  return {
    mode, plane, target, center: typeof center === 'function' ? center : { ...center },
    region: typeof region === 'function' ? region : { ...region }, deadZone,
    maxDistance: positive(input.maxDistance ?? 64, 'maxDistance'),
    activationRadius: input.activationRadius == null ? null : positive(input.activationRadius, 'activationRadius'),
    moveSpeed: nonNegative(input.moveSpeed ?? 4, 'moveSpeed'), analog: input.analog ?? true,
    rotateToDirection: input.rotateToDirection ?? true,
    turnSpeed: input.turnSpeed === Infinity || input.turnSpeed === undefined ? Infinity : nonNegative(input.turnSpeed, 'turnSpeed'),
    rotationOffset: finite(input.rotationOffset ?? 0, 'rotationOffset'),
    movementRotation: finite(input.movementRotation ?? 0, 'movementRotation'),
    maxDeltaMilliseconds: positive(input.maxDeltaMilliseconds ?? 100, 'maxDeltaMilliseconds'),
    guiRoot: input.guiRoot ?? null, knobRadius: positive(input.knobRadius ?? 24, 'knobRadius'),
    showIdle: input.showIdle ?? true, baseStyle: { ...input.baseStyle }, knobStyle: { ...input.knobStyle },
    ...(input.shouldActivate ? { shouldActivate: input.shouldActivate } : {}),
  };
}
