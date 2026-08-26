import { hashSimulationState, type SimulationStateValue } from '../simulation/StateHash';

export type ReplayInputSource = 'synthetic' | 'keyboard' | 'pointer' | 'gamepad' | 'system';
export type ReplayActionPhase = 'down' | 'value' | 'up';
export type ReplayPointerPhase = 'move' | 'down' | 'up' | 'cancel' | 'wheel';

interface ReplayEventBase {
  readonly tick: number;
  readonly order: number;
  readonly source?: ReplayInputSource;
}

export interface ReplayActionEvent extends ReplayEventBase {
  readonly kind: 'action';
  readonly action: string;
  readonly phase: ReplayActionPhase;
  readonly value?: number;
}

export interface ReplayPointerEvent extends ReplayEventBase {
  readonly kind: 'pointer';
  readonly phase: ReplayPointerPhase;
  readonly pointerId: number;
  /** Viewport-normalized horizontal coordinate from 0 to 1. */
  readonly x: number;
  /** Viewport-normalized vertical coordinate from 0 to 1. */
  readonly y: number;
  readonly button?: number;
  readonly wheelX?: number;
  readonly wheelY?: number;
}

export interface ReplayResetEvent extends ReplayEventBase {
  readonly kind: 'reset';
  readonly reason: 'blur' | 'disconnect' | 'stop' | 'restart' | 'cancel' | 'manual';
}

export type ReplayInputEvent = ReplayActionEvent | ReplayPointerEvent | ReplayResetEvent;
export type ReplayInputEventInput =
  | (Omit<ReplayActionEvent, 'order'> & { readonly order?: number })
  | (Omit<ReplayPointerEvent, 'order'> & { readonly order?: number })
  | (Omit<ReplayResetEvent, 'order'> & { readonly order?: number });

export interface InputReplayV1 {
  readonly schemaVersion: 1;
  readonly tickRateHz: number;
  readonly seed: number | string;
  readonly events: readonly ReplayInputEvent[];
}

export interface ReplayActionState {
  readonly action: string;
  readonly value: number;
  readonly pressed: boolean;
  readonly down: boolean;
  readonly up: boolean;
}

export interface ReplayPointerState {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly buttons: readonly number[];
  readonly wheelX: number;
  readonly wheelY: number;
  readonly dragging: boolean;
}

export interface ReplayInputSnapshot {
  readonly tick: number;
  readonly actions: readonly ReplayActionState[];
  readonly pointers: readonly ReplayPointerState[];
  readonly events: readonly ReplayInputEvent[];
  readonly hash: string;
}

export interface ReplayInputControllerOptions {
  maxQueuedEvents?: number;
  maxEventsPerTick?: number;
  actionThreshold?: number;
}

interface MutableActionState {
  value: number;
  down: boolean;
  up: boolean;
}

interface MutablePointerState {
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  buttons: Set<number>;
  wheelX: number;
  wheelY: number;
}

/** Tick-owned, source-neutral input state for Play and deterministic replay. */
export class ReplayInputController {
  readonly maxQueuedEvents: number;
  readonly maxEventsPerTick: number;
  readonly actionThreshold: number;

  private readonly _queued = new Map<number, ReplayInputEvent[]>();
  private readonly _actions = new Map<string, MutableActionState>();
  private readonly _pointers = new Map<number, MutablePointerState>();
  private _events: readonly ReplayInputEvent[] = Object.freeze([]);
  private _queuedCount = 0;
  private _tick = 0;
  private _nextOrder = 0;

  constructor(options: ReplayInputControllerOptions = {}) {
    this.maxQueuedEvents = integerRange(options.maxQueuedEvents ?? 20_000, 1, 1_000_000, 'maxQueuedEvents');
    this.maxEventsPerTick = integerRange(options.maxEventsPerTick ?? 256, 1, 10_000, 'maxEventsPerTick');
    this.actionThreshold = finiteRange(options.actionThreshold ?? 0.5, 0.000_001, 1, 'actionThreshold');
  }

  get tick(): number { return this._tick; }
  get queuedEventCount(): number { return this._queuedCount; }

  load(replay: InputReplayV1): this {
    validateReplay(replay, this.maxQueuedEvents, this.maxEventsPerTick);
    this.reset();
    for (const event of replay.events) this.inject(event);
    return this;
  }

  /** Queue an event. Missing order is assigned monotonically for live Play injection. */
  inject(event: ReplayInputEventInput): this {
    if (this._queuedCount >= this.maxQueuedEvents) throw new RangeError(`Replay input queue exceeds ${this.maxQueuedEvents} events.`);
    const normalized = normalizeEvent(event, event.order ?? this._nextOrder++);
    if (normalized.tick <= this._tick) throw new RangeError(`Replay input tick ${normalized.tick} is not after current tick ${this._tick}.`);
    const events = this._queued.get(normalized.tick) ?? [];
    if (events.length >= this.maxEventsPerTick) throw new RangeError(`Replay input tick ${normalized.tick} exceeds ${this.maxEventsPerTick} events.`);
    if (events.some(candidate => candidate.order === normalized.order)) throw new RangeError(`Replay input tick ${normalized.tick} has duplicate order ${normalized.order}.`);
    events.push(normalized);
    this._queued.set(normalized.tick, events);
    this._queuedCount += 1;
    this._nextOrder = Math.max(this._nextOrder, normalized.order + 1);
    return this;
  }

  beginTick(tick: number): ReplayInputSnapshot {
    if (!Number.isSafeInteger(tick) || tick !== this._tick + 1) throw new RangeError(`Replay input tick must advance exactly from ${this._tick} to ${this._tick + 1}.`);
    this._tick = tick;
    for (const state of this._actions.values()) { state.down = false; state.up = false; }
    for (const state of this._pointers.values()) {
      state.previousX = state.x;
      state.previousY = state.y;
      state.wheelX = 0;
      state.wheelY = 0;
    }
    const events = this._queued.get(tick) ?? [];
    events.sort((left, right) => left.order - right.order);
    this._queued.delete(tick);
    this._queuedCount -= events.length;
    for (const event of events) this._apply(event);
    this._events = Object.freeze([...events]);
    return this.snapshot();
  }

  isPressed(action: string): boolean { return Math.abs(this._actions.get(action)?.value ?? 0) >= this.actionThreshold; }
  wasPressed(action: string): boolean { return this._actions.get(action)?.down ?? false; }
  wasReleased(action: string): boolean { return this._actions.get(action)?.up ?? false; }
  value(action: string): number { return this._actions.get(action)?.value ?? 0; }

  action(action: string): ReplayActionState {
    const state = this._actions.get(action);
    return Object.freeze({ action, value: state?.value ?? 0, pressed: this.isPressed(action), down: state?.down ?? false, up: state?.up ?? false });
  }

  pointer(pointerId = 1): ReplayPointerState {
    const state = this._pointers.get(pointerId);
    if (!state) return EMPTY_POINTER;
    return freezePointer(pointerId, state);
  }

  events(): readonly ReplayInputEvent[] { return this._events; }

  snapshot(): ReplayInputSnapshot {
    const actions = [...this._actions].sort(compareKey).map(([action, state]) => Object.freeze({
      action,
      value: state.value,
      pressed: Math.abs(state.value) >= this.actionThreshold,
      down: state.down,
      up: state.up,
    }));
    const pointers = [...this._pointers].sort((left, right) => left[0] - right[0]).map(([id, state]) => freezePointer(id, state));
    const value = {
      tick: this._tick,
      actions,
      pointers,
      events: this._events,
    } as unknown as SimulationStateValue;
    return Object.freeze({ tick: this._tick, actions: Object.freeze(actions), pointers: Object.freeze(pointers), events: this._events, hash: hashSimulationState(value) });
  }

  /** Immediate idempotent teardown. Queued events and all held input are discarded. */
  reset(): this {
    this._queued.clear();
    this._actions.clear();
    this._pointers.clear();
    this._events = Object.freeze([]);
    this._queuedCount = 0;
    this._tick = 0;
    this._nextOrder = 0;
    return this;
  }

  private _apply(event: ReplayInputEvent): void {
    if (event.kind === 'reset') { this._releaseAll(); return; }
    if (event.kind === 'action') { this._applyAction(event); return; }
    this._applyPointer(event);
  }

  private _applyAction(event: ReplayActionEvent): void {
    const state = this._actions.get(event.action) ?? { value: 0, down: false, up: false };
    const previousPressed = Math.abs(state.value) >= this.actionThreshold;
    const nextValue = event.phase === 'up' ? 0 : event.phase === 'down' ? event.value ?? 1 : event.value!;
    state.value = nextValue;
    const nextPressed = Math.abs(nextValue) >= this.actionThreshold;
    state.down ||= !previousPressed && nextPressed;
    state.up ||= previousPressed && !nextPressed;
    this._actions.set(event.action, state);
  }

  private _applyPointer(event: ReplayPointerEvent): void {
    const state = this._pointers.get(event.pointerId) ?? { x: event.x, y: event.y, previousX: event.x, previousY: event.y, buttons: new Set<number>(), wheelX: 0, wheelY: 0 };
    state.x = event.x;
    state.y = event.y;
    if (event.phase === 'down') state.buttons.add(event.button ?? 0);
    else if (event.phase === 'up') state.buttons.delete(event.button ?? 0);
    else if (event.phase === 'cancel') state.buttons.clear();
    else if (event.phase === 'wheel') {
      state.wheelX += event.wheelX ?? 0;
      state.wheelY += event.wheelY ?? 0;
    }
    this._pointers.set(event.pointerId, state);
  }

  private _releaseAll(): void {
    for (const state of this._actions.values()) {
      if (Math.abs(state.value) >= this.actionThreshold) state.up = true;
      state.value = 0;
    }
    for (const state of this._pointers.values()) state.buttons.clear();
  }
}

function validateReplay(replay: InputReplayV1, maxQueuedEvents: number, maxEventsPerTick: number): void {
  if (!replay || replay.schemaVersion !== 1 || !Number.isFinite(replay.tickRateHz) || replay.tickRateHz < 1 || replay.tickRateHz > 1_000
    || (typeof replay.seed !== 'string' && !Number.isSafeInteger(replay.seed)) || !Array.isArray(replay.events) || replay.events.length > maxQueuedEvents) {
    throw new TypeError('Input replay envelope is invalid.');
  }
  const counts = new Map<number, number>();
  for (const event of replay.events) {
    const normalized = normalizeEvent(event, event.order);
    const count = (counts.get(normalized.tick) ?? 0) + 1;
    if (count > maxEventsPerTick) throw new RangeError(`Replay input tick ${normalized.tick} exceeds ${maxEventsPerTick} events.`);
    counts.set(normalized.tick, count);
  }
}

function normalizeEvent(event: ReplayInputEventInput, order: number): ReplayInputEvent {
  if (!event || !Number.isSafeInteger(event.tick) || event.tick < 1) throw new TypeError('Replay input event tick must be a positive integer.');
  integerRange(order, 0, Number.MAX_SAFE_INTEGER, 'event order');
  if (event.source !== undefined && !['synthetic', 'keyboard', 'pointer', 'gamepad', 'system'].includes(event.source)) throw new TypeError('Replay input event source is invalid.');
  if (event.kind === 'reset') {
    if (!['blur', 'disconnect', 'stop', 'restart', 'cancel', 'manual'].includes(event.reason)) throw new TypeError('Replay reset reason is invalid.');
    return Object.freeze({ kind: 'reset', tick: event.tick, order, ...(event.source === undefined ? {} : { source: event.source }), reason: event.reason });
  }
  if (event.kind === 'action') {
    if (typeof event.action !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u.test(event.action) || !['down', 'value', 'up'].includes(event.phase)) throw new TypeError('Replay action event is invalid.');
    const value = event.phase === 'value' ? finiteRange(event.value!, -1, 1, 'action value') : event.value === undefined ? undefined : finiteRange(event.value, -1, 1, 'action value');
    return Object.freeze({ kind: 'action', tick: event.tick, order, ...(event.source === undefined ? {} : { source: event.source }), action: event.action, phase: event.phase, ...(value === undefined ? {} : { value }) });
  }
  if (event.kind !== 'pointer' || !['move', 'down', 'up', 'cancel', 'wheel'].includes(event.phase)) throw new TypeError('Replay pointer event is invalid.');
  integerRange(event.pointerId, 0, 1_000_000, 'pointerId');
  finiteRange(event.x, 0, 1, 'pointer x');
  finiteRange(event.y, 0, 1, 'pointer y');
  if (event.button !== undefined) integerRange(event.button, 0, 31, 'pointer button');
  if (event.wheelX !== undefined) finiteRange(event.wheelX, -1_000_000, 1_000_000, 'wheelX');
  if (event.wheelY !== undefined) finiteRange(event.wheelY, -1_000_000, 1_000_000, 'wheelY');
  return Object.freeze({
    kind: 'pointer', tick: event.tick, order, ...(event.source === undefined ? {} : { source: event.source }),
    phase: event.phase, pointerId: event.pointerId, x: event.x, y: event.y,
    ...(event.button === undefined ? {} : { button: event.button }),
    ...(event.wheelX === undefined ? {} : { wheelX: event.wheelX }),
    ...(event.wheelY === undefined ? {} : { wheelY: event.wheelY }),
  });
}

function freezePointer(pointerId: number, state: MutablePointerState): ReplayPointerState {
  return Object.freeze({
    pointerId,
    x: state.x,
    y: state.y,
    deltaX: state.x - state.previousX,
    deltaY: state.y - state.previousY,
    buttons: Object.freeze([...state.buttons].sort((left, right) => left - right)),
    wheelX: state.wheelX,
    wheelY: state.wheelY,
    dragging: state.buttons.size > 0,
  });
}

const EMPTY_POINTER: ReplayPointerState = Object.freeze({ pointerId: 1, x: 0, y: 0, deltaX: 0, deltaY: 0, buttons: Object.freeze([]), wheelX: 0, wheelY: 0, dragging: false });

function compareKey(left: readonly [string, unknown], right: readonly [string, unknown]): number { return left[0].localeCompare(right[0]); }
function finiteRange(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be a finite number from ${minimum} to ${maximum}.`); return value; }
function integerRange(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`); return value; }
