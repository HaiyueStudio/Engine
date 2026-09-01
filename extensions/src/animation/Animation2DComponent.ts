import type { AnimationSource, ParsedAnimation } from '@haiyue/animation-spec';
import { parseAnimation } from '@haiyue/animation-spec';
import { Component, type Entity, type World } from '@haiyue/engine';
import { ComponentLifecycleFlags, UniqueCheckType } from '@haiyue/engine/ecs';
import type { Animation2DRuntime } from './Animation2DRuntime';
import type { Animation2DExtensionRegistry } from './Animation2DExtensionRegistry';

export interface Animation2DComponentOptions {
  autoplay?: boolean;
  loop?: boolean;
  /** Seconds from which playback repeats after the first complete pass. */
  loopStartTime?: number;
  /** Exclusive end of the repeated range; later timeline content remains available for an exit pass. */
  loopEndTime?: number;
  speed?: number;
  startTime?: number;
  runtimeExtensions?: Animation2DExtensionRegistry;
}

export interface Animation2DNodeOverride {
  /** Local node position in the HYA canvas coordinate system (screen-y-down). */
  readonly position?: readonly [number, number];
  /** Runtime opacity replacement in the inclusive 0..1 range. */
  readonly opacity?: number;
  /** Overrides authored/timeline visibility while present. */
  readonly enabled?: boolean;
}

export interface Animation2DRuntimeStats {
  readonly nodeCount: number;
  readonly visualCount: number;
  readonly unsupportedComponentCount: number;
  readonly pendingResourceCount: number;
  readonly failedResourceCount: number;
  readonly textCount: number;
  readonly particleCount: number;
  readonly audioCount: number;
}

export class Animation2DComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Animation2DComponent');
  static override Lifecycle = ComponentLifecycleFlags.EntityRemoveComponent | ComponentLifecycleFlags.EntityRemoveFromWorld;

  readonly animation: ParsedAnimation;
  playing: boolean;
  loop: boolean;
  readonly loopStartTime: number;
  readonly loopEndTime: number;
  speed: number;
  currentTime: number;
  completed = false;
  readonly runtimeExtensions: Animation2DExtensionRegistry | undefined;
  readonly _nodeOverrides = new Map<string, Animation2DNodeOverride>();
  _runtime: Animation2DRuntime | null = null;
  _needsApply = true;
  _forceParticleSeek = false;

  constructor(source: AnimationSource | ParsedAnimation, options: Animation2DComponentOptions = {}) {
    super('Animation2DComponent');
    this.animation = isParsed(source) ? source : parseAnimation(source);
    this.playing = options.autoplay ?? true;
    this.loop = options.loop ?? this.animation.endBehavior === 'loop';
    this.loopStartTime = normalizeLoopStartTime(options.loopStartTime ?? 0, this.animation.duration);
    this.loopEndTime = normalizeLoopEndTime(options.loopEndTime ?? this.animation.duration, this.loopStartTime, this.animation.duration);
    this.speed = finiteSpeed(options.speed ?? 1);
    this.currentTime = clampTime(options.startTime ?? 0, this.animation.duration);
    this.runtimeExtensions = options.runtimeExtensions;
  }

  get runtimeStats(): Animation2DRuntimeStats {
    return this._runtime?.stats ?? {
      nodeCount: 0,
      visualCount: 0,
      unsupportedComponentCount: 0,
      pendingResourceCount: 0,
      failedResourceCount: 0,
      textCount: 0,
      particleCount: 0,
      audioCount: 0,
    };
  }

  play(): this {
    if (this.completed) {
      this.currentTime = 0;
      this._needsApply = true;
      this._forceParticleSeek = true;
    }
    this.playing = true;
    this.completed = false;
    this._runtime?.setPlaying(true);
    return this;
  }

  pause(): this {
    this.playing = false;
    this._runtime?.setPlaying(false);
    return this;
  }

  seek(seconds: number): this {
    this.currentTime = clampTime(seconds, this.animation.duration);
    this.completed = false;
    this._needsApply = true;
    this._forceParticleSeek = true;
    return this;
  }

  setSpeed(speed: number): this {
    this.speed = finiteSpeed(speed);
    return this;
  }

  setNodeOverride(nodeId: string, override: Animation2DNodeOverride): this {
    if (!this.animation.nodes.some(node => node.id === nodeId)) throw new ReferenceError(`Animation node "${nodeId}" does not exist.`);
    const position = override.position;
    if (position && (position.length !== 2 || position.some(value => !Number.isFinite(value)))) {
      throw new RangeError('Animation2D node override position must contain two finite values.');
    }
    if (override.opacity !== undefined && (!Number.isFinite(override.opacity) || override.opacity < 0 || override.opacity > 1)) {
      throw new RangeError('Animation2D node override opacity must be within 0..1.');
    }
    if (override.enabled !== undefined && typeof override.enabled !== 'boolean') {
      throw new TypeError('Animation2D node override enabled must be boolean.');
    }
    this._nodeOverrides.set(nodeId, Object.freeze({
      ...(position ? { position: Object.freeze([position[0], position[1]] as const) } : {}),
      ...(override.opacity === undefined ? {} : { opacity: override.opacity }),
      ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
    }));
    this._needsApply = true;
    return this;
  }

  clearNodeOverride(nodeId: string): this {
    if (this._nodeOverrides.delete(nodeId)) this._needsApply = true;
    return this;
  }

  clearNodeOverrides(): this {
    if (this._nodeOverrides.size > 0) {
      this._nodeOverrides.clear();
      this._needsApply = true;
    }
    return this;
  }

  onEntityRemoveComponent(_entity: Entity, component: Component): void {
    if (component === this) this._disposeRuntime();
  }

  onEntityRemoveFromWorld(_entity: Entity, _world: World): void {
    this._disposeRuntime();
  }

  override clone(): Animation2DComponent {
    const clone = new Animation2DComponent(this.animation, {
      autoplay: this.playing,
      loop: this.loop,
      loopStartTime: this.loopStartTime,
      loopEndTime: this.loopEndTime,
      speed: this.speed,
      startTime: this.currentTime,
      ...(this.runtimeExtensions ? { runtimeExtensions: this.runtimeExtensions } : {}),
    });
    clone.disabled = this.disabled;
    for (const [nodeId, override] of this._nodeOverrides) clone.setNodeOverride(nodeId, override);
    return clone;
  }

  _disposeRuntime(): void {
    this._runtime?.destroy();
    this._runtime = null;
  }
}

function isParsed(source: AnimationSource | ParsedAnimation): source is ParsedAnimation {
  return typeof source === 'object' && source !== null && 'source' in source;
}

function finiteSpeed(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Animation2DComponent speed must be finite and non-negative.');
  return value;
}

function clampTime(value: number, duration: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Animation2DComponent time must be finite.');
  return Math.max(0, Math.min(duration, value));
}

function normalizeLoopStartTime(value: number, duration: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= duration) {
    throw new RangeError('Animation2DComponent loopStartTime must be finite, non-negative, and less than duration.');
  }
  return value;
}

function normalizeLoopEndTime(value: number, loopStartTime: number, duration: number): number {
  if (!Number.isFinite(value) || value <= loopStartTime || value > duration) {
    throw new RangeError('Animation2DComponent loopEndTime must be finite, greater than loopStartTime, and no greater than duration.');
  }
  return value;
}
