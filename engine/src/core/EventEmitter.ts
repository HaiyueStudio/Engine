import { EngineError, EngineErrorCode } from './EngineError';

export type EventListener<TTarget = unknown, TDetail = unknown> = (event: EngineEvent<TTarget, TDetail>) => void;
export type EventPhase = 'none' | 'capture' | 'target' | 'bubble';
type EventDetail<TEvents extends object, TEvent extends string> = TEvent extends keyof TEvents ? TEvents[TEvent] : unknown;

export interface EventListenerOptions {
  once?: boolean;
  priority?: number;
  capture?: boolean;
}

export interface EmitEventOptions<TTarget = unknown, TDetail = unknown> {
  target?: TTarget;
  detail?: TDetail | undefined;
  bubbles?: boolean;
  capture?: boolean;
  path?: EventEmitter<object>[];
}

interface ListenerRecord {
  fn: EventListener<unknown, unknown>;
  once: boolean;
  active: boolean;
  priority: number;
  capture: boolean;
  order: number;
}

export class EngineEvent<TTarget = unknown, TDetail = unknown> {
  readonly type: string;
  readonly target: TTarget;
  currentTarget: TTarget | null = null;
  eventPhase: EventPhase = 'none';
  stopped = false;
  defaultPrevented = false;
  readonly detail: TDetail;
  readonly nativeEvent: Event | undefined;

  constructor(type: string, options: { target: TTarget; detail?: TDetail | undefined; nativeEvent?: Event | undefined }) {
    this.type = type;
    this.target = options.target;
    this.detail = options.detail as TDetail;
    this.nativeEvent = options.nativeEvent;
  }

  stopPropagation(): void {
    this.stopped = true;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
    this.nativeEvent?.preventDefault();
  }
}

export class EventEmitter<TEvents extends object = Record<string, unknown>> {
  private _listeners = new Map<string, ListenerRecord[]>();
  private _emittingDepth = 0;
  private _needsCompaction = false;
  private _needsSort = false;
  private _listenerOrder = 0;

  on<TEvent extends string>(event: TEvent, listener: EventListener<this, EventDetail<TEvents, TEvent>>, options: EventListenerOptions = {}): this {
    this._addListener(event, listener as unknown as EventListener<unknown, unknown>, options);
    return this;
  }

  off<TEvent extends string>(event: TEvent, listener: EventListener<this, EventDetail<TEvents, TEvent>>): this {
    const list = this._listeners.get(event);
    if (!list) return this;
    for (const [i, record] of list.entries()) {
      if (record.fn !== listener) continue;
      if (this._emittingDepth > 0) {
        record.active = false;
        this._needsCompaction = true;
      } else {
        list.splice(i, 1);
        if (list.length === 0) this._listeners.delete(event);
      }
      break;
    }
    return this;
  }

  once<TEvent extends string>(event: TEvent, listener: EventListener<this, EventDetail<TEvents, TEvent>>, options: Omit<EventListenerOptions, 'once'> = {}): this {
    this._addListener(event, listener as unknown as EventListener<unknown, unknown>, { ...options, once: true });
    return this;
  }

  emit<TEvent extends string, TTarget = this>(
    event: TEvent | EngineEvent<TTarget, EventDetail<TEvents, TEvent>>,
    options: EmitEventOptions<TTarget, EventDetail<TEvents, TEvent>> = {},
  ): EngineEvent<TTarget, EventDetail<TEvents, TEvent>> {
    const path = options.path?.length ? options.path : [this];
    const targetEmitter = path[path.length - 1] ?? this;
    const target = options.target ?? targetEmitter as TTarget;
    const engineEvent = typeof event === 'string'
      ? new EngineEvent<TTarget, EventDetail<TEvents, TEvent>>(event, { target, detail: options.detail })
      : event;

    if (options.capture !== false && path.length > 1) {
      for (let i = 0; i < path.length - 1 && !engineEvent.stopped; i++) {
        const emitter = path[i];
        if (!emitter) throw invalidEventPath(engineEvent.type, 'capture', i, path.length);
        emitter._emitEngineEvent(engineEvent, 'capture', true);
      }
    }

    if (!engineEvent.stopped) {
      targetEmitter._emitEngineEvent(engineEvent, 'target', null);
    }

    if (options.bubbles && !engineEvent.stopped && path.length > 1) {
      for (let i = path.length - 2; i >= 0 && !engineEvent.stopped; i--) {
        const emitter = path[i];
        if (!emitter) throw invalidEventPath(engineEvent.type, 'bubble', i, path.length);
        emitter._emitEngineEvent(engineEvent, 'bubble', false);
      }
    }

    engineEvent.currentTarget = null;
    engineEvent.eventPhase = 'none';
    return engineEvent;
  }

  listenerCount(event: string): number {
    const list = this._listeners.get(event);
    if (!list) return 0;
    let count = 0;
    for (const record of list) if (record.active) count++;
    return count;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) {
      this._listeners.clear();
      this._needsCompaction = false;
      this._needsSort = false;
      return this;
    }
    this._listeners.delete(event);
    return this;
  }

  private _addListener(event: string, listener: EventListener<unknown, unknown>, options: EventListenerOptions): void {
    let list = this._listeners.get(event);
    if (!list) {
      list = [];
      this._listeners.set(event, list);
    }
    list.push({
      fn: listener,
      once: options.once === true,
      active: true,
      priority: options.priority ?? 0,
      capture: options.capture === true,
      order: this._listenerOrder++,
    });
    if (this._emittingDepth > 0) this._needsSort = true;
    else list.sort(compareListenerRecords);
  }

  private _emitEngineEvent(event: EngineEvent, phase: EventPhase, capture: boolean | null): void {
    const list = this._listeners.get(event.type);
    if (!list) return;
    this._emittingDepth++;
    event.currentTarget = this;
    event.eventPhase = phase;
    try {
      const emitLength = list.length;
      for (let i = 0; i < emitLength && !event.stopped; i++) {
        const record = list[i];
        if (!record) continue;
        if (!record.active) continue;
        if (capture !== null && record.capture !== capture) continue;
        if (record.once) this._deactivateRecord(record);
        record.fn(event);
      }
    } finally {
      this._emittingDepth--;
      if (this._emittingDepth === 0) this._flushListenerMaintenance();
    }
  }

  private _deactivateRecord(record: ListenerRecord): void {
    record.active = false;
    this._needsCompaction = true;
  }

  private _compactListeners(): void {
    this._needsCompaction = false;
    for (const [event, list] of this._listeners) {
      let write = 0;
      for (const record of list) {
        if (!record.active) continue;
        list[write++] = record;
      }
      list.length = write;
      if (write === 0) this._listeners.delete(event);
    }
  }

  private _flushListenerMaintenance(): void {
    if (this._needsCompaction) this._compactListeners();
    if (!this._needsSort) return;
    this._needsSort = false;
    for (const list of this._listeners.values()) list.sort(compareListenerRecords);
  }
}

function invalidEventPath(eventType: string, phase: 'capture' | 'bubble', index: number, pathLength: number): EngineError {
  return new EngineError(
    EngineErrorCode.EventPathInvalid,
    `Event path contains an empty ${phase} entry at ${index}.`,
    {
      context: { eventType, phase, index, pathLength },
      path: `event.path[${index}]`,
      hint: 'Remove empty entries and keep the target emitter as the final path item.',
      docsPath: 'errors/E_EVENT_PATH_INVALID',
    },
  );
}

function compareListenerRecords(a: ListenerRecord, b: ListenerRecord): number {
  return b.priority - a.priority || a.order - b.order;
}
