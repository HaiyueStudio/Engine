import type { RenderCommandContext } from '../core/RenderCommandContext';

export interface FrameRingGenerationInfo {
  readonly generation: number;
  readonly capacity: number;
  readonly framesInFlight: number;
  readonly slotCount: number;
}

export interface FrameRingResourceOptions<T> {
  readonly label: string;
  readonly create: (info: FrameRingGenerationInfo) => T;
  readonly destroy: (resource: T) => void;
  readonly initialCapacity?: number;
  readonly maximumCapacity?: number;
  readonly framesInFlight?: number;
  /** Capacity multiplier used for growth. Defaults to 2. */
  readonly growthFactor?: number;
  /** Required/capacity ratio below which shrink hysteresis advances. Defaults to 0.25. */
  readonly shrinkThreshold?: number;
  /** Consecutive low-water frames required before shrinking. Defaults to 120. */
  readonly shrinkDelayFrames?: number;
}

export interface FrameRingResourceStats {
  readonly generation: number;
  readonly capacity: number;
  readonly maximumCapacity: number;
  readonly framesInFlight: number;
  readonly frameIndex: number;
  readonly slotCount: number;
  readonly retiringGenerations: number;
  readonly lowWaterFrames: number;
}

interface FrameRingGeneration<T> extends FrameRingGenerationInfo {
  readonly resource: T;
  destroyed: boolean;
  used: boolean;
}

const DEFAULT_FRAMES_IN_FLIGHT = 3;
const DEFAULT_GROWTH_FACTOR = 2;
const DEFAULT_SHRINK_THRESHOLD = 0.25;
const DEFAULT_SHRINK_DELAY_FRAMES = 120;

/**
 * Owns one capacity-sized resource generation and maps frame/view pairs to
 * stable slots. Replaced generations retire only after prior queue work has
 * completed, so callers never need append-only generation arrays.
 */
export class FrameRingResource<T> {
  private readonly _label: string;
  private readonly _create: (info: FrameRingGenerationInfo) => T;
  private readonly _destroy: (resource: T) => void;
  private readonly _initialCapacity: number;
  private readonly _maximumCapacity: number;
  private readonly _framesInFlight: number;
  private readonly _growthFactor: number;
  private readonly _shrinkThreshold: number;
  private readonly _shrinkDelayFrames: number;
  private readonly _retiring = new Set<FrameRingGeneration<T>>();
  private _current: FrameRingGeneration<T>;
  private _nextGeneration = 1;
  private _frameIndex = -1;
  private _lowWaterFrames = 0;

  constructor(options: FrameRingResourceOptions<T>) {
    this._label = options.label;
    this._create = options.create;
    this._destroy = options.destroy;
    this._initialCapacity = positiveInteger(options.initialCapacity ?? 1, 'initialCapacity');
    this._maximumCapacity = positiveInteger(
      options.maximumCapacity ?? Number.MAX_SAFE_INTEGER,
      'maximumCapacity',
    );
    if (this._initialCapacity > this._maximumCapacity) {
      throw new RangeError(`${this._label} initialCapacity exceeds maximumCapacity.`);
    }
    this._framesInFlight = positiveInteger(options.framesInFlight ?? DEFAULT_FRAMES_IN_FLIGHT, 'framesInFlight');
    this._growthFactor = finiteGreaterThanOne(options.growthFactor ?? DEFAULT_GROWTH_FACTOR, 'growthFactor');
    this._shrinkThreshold = finiteRatio(options.shrinkThreshold ?? DEFAULT_SHRINK_THRESHOLD, 'shrinkThreshold');
    this._shrinkDelayFrames = positiveInteger(
      options.shrinkDelayFrames ?? DEFAULT_SHRINK_DELAY_FRAMES,
      'shrinkDelayFrames',
    );
    this._current = this._createGeneration(this._initialCapacity);
  }

  get resource(): T { return this._current.resource; }
  get generation(): number { return this._current.generation; }
  get capacity(): number { return this._current.capacity; }
  get maximumCapacity(): number { return this._maximumCapacity; }
  get framesInFlight(): number { return this._framesInFlight; }
  get frameIndex(): number { return this._frameIndex; }

  /** Selects a generation and advances to the next protected frame region. */
  beginFrame(requiredCapacity: number, context?: RenderCommandContext): void {
    const required = positiveInteger(Math.max(1, Math.ceil(requiredCapacity)), 'requiredCapacity');
    if (required > this._maximumCapacity) {
      throw new RangeError(`${this._label} capacity ${required} exceeds maximumCapacity ${this._maximumCapacity}.`);
    }
    let nextCapacity = this._current.capacity;
    if (required > nextCapacity) {
      nextCapacity = Math.min(
        this._maximumCapacity,
        Math.max(required, Math.ceil(nextCapacity * this._growthFactor)),
      );
      this._lowWaterFrames = 0;
    } else if (required <= Math.floor(nextCapacity * this._shrinkThreshold)) {
      this._lowWaterFrames++;
      if (this._lowWaterFrames >= this._shrinkDelayFrames) {
        nextCapacity = Math.max(
          this._initialCapacity,
          required,
          Math.ceil(required * this._growthFactor),
        );
        this._lowWaterFrames = 0;
      }
    } else {
      this._lowWaterFrames = 0;
    }
    if (nextCapacity !== this._current.capacity) this._replaceGeneration(nextCapacity, context);
    this._frameIndex = (this._frameIndex + 1) % this._framesInFlight;
    this._current.used = true;
  }

  /** Ensures capacity without advancing the frame ring. */
  ensureCapacity(requiredCapacity: number, context?: RenderCommandContext): boolean {
    const required = positiveInteger(Math.max(1, Math.ceil(requiredCapacity)), 'requiredCapacity');
    if (required <= this._current.capacity) return false;
    if (required > this._maximumCapacity) {
      throw new RangeError(`${this._label} capacity ${required} exceeds maximumCapacity ${this._maximumCapacity}.`);
    }
    const nextCapacity = Math.min(
      this._maximumCapacity,
      Math.max(required, Math.ceil(this._current.capacity * this._growthFactor)),
    );
    this._replaceGeneration(nextCapacity, context);
    return true;
  }

  /** Returns the flat slot for a view in the current frame region. */
  slot(viewIndex: number): number {
    const view = nonNegativeInteger(viewIndex, 'viewIndex');
    if (view >= this._current.capacity) {
      throw new RangeError(`${this._label} view index ${view} exceeds capacity ${this._current.capacity}.`);
    }
    this._current.used = true;
    return Math.max(0, this._frameIndex) * this._current.capacity + view;
  }

  /** Marks the current generation as referenced by encoded or submitted work. */
  markUsed(): void {
    this._current.used = true;
  }

  getStats(): FrameRingResourceStats {
    return Object.freeze({
      generation: this._current.generation,
      capacity: this._current.capacity,
      maximumCapacity: this._maximumCapacity,
      framesInFlight: this._framesInFlight,
      frameIndex: this.frameIndex,
      slotCount: this._current.slotCount,
      retiringGenerations: this._retiring.size,
      lowWaterFrames: this._lowWaterFrames,
    });
  }

  /** Destroys all live generations and restores an empty initial generation. */
  reset(): void {
    this._destroyGeneration(this._current);
    for (const generation of this._retiring) this._destroyGeneration(generation);
    this._retiring.clear();
    this._frameIndex = -1;
    this._lowWaterFrames = 0;
    this._current = this._createGeneration(this._initialCapacity);
  }

  /** Permanently releases all generations. The instance must not be reused. */
  destroy(): void {
    this._destroyGeneration(this._current);
    for (const generation of this._retiring) this._destroyGeneration(generation);
    this._retiring.clear();
    this._frameIndex = -1;
    this._lowWaterFrames = 0;
  }

  private _createGeneration(capacity: number): FrameRingGeneration<T> {
    const info: FrameRingGenerationInfo = Object.freeze({
      generation: this._nextGeneration++,
      capacity,
      framesInFlight: this._framesInFlight,
      slotCount: capacity * this._framesInFlight,
    });
    return { ...info, resource: this._create(info), destroyed: false, used: false };
  }

  private _replaceGeneration(capacity: number, context?: RenderCommandContext): void {
    const previous = this._current;
    this._current = this._createGeneration(capacity);
    this._frameIndex = -1;
    this._retireGeneration(previous, context);
  }

  private _retireGeneration(generation: FrameRingGeneration<T>, context?: RenderCommandContext): void {
    if (!generation.used) {
      this._destroyGeneration(generation);
      return;
    }
    this._retiring.add(generation);
    const retire = () => {
      if (!this._retiring.delete(generation)) return;
      this._destroyGeneration(generation);
    };
    if (context?.afterSubmit) {
      context.afterSubmit(queue => waitForQueue(queue, retire));
      return;
    }
    const queue = context?.device.queue;
    if (queue) waitForQueue(queue, retire);
    // With no submission context the generation stays owned until reset/destroy.
  }

  private _destroyGeneration(generation: FrameRingGeneration<T>): void {
    if (generation.destroyed) return;
    generation.destroyed = true;
    this._destroy(generation.resource);
  }
}

function waitForQueue(queue: GPUQueue, done: () => void): void {
  try {
    void queue.onSubmittedWorkDone().then(done, done);
  } catch {
    done();
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`FrameRingResource.${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`FrameRingResource.${label} must be a non-negative integer.`);
  return value;
}

function finiteGreaterThanOne(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 1) throw new RangeError(`FrameRingResource.${label} must be greater than one.`);
  return value;
}

function finiteRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new RangeError(`FrameRingResource.${label} must be between zero and one.`);
  return value;
}
