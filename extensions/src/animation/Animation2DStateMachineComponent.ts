import {
  parseAnimation,
  type AnimationSource,
  type HyaStateMachineExtension,
  type HyaStateMachineParameter,
  type ParsedAnimation,
} from '@haiyue/animation-spec';
import { Component, type Entity, type World } from '@haiyue/engine';
import { ComponentLifecycleFlags, UniqueCheckType } from '@haiyue/engine/ecs';
import type { AnimationStateMachineLayerSnapshot } from '../animation-state-machine/runtime/index.js';
import type { AnimationStateMachineChannelDiagnostic } from '../animation-state-machine/AnimationStateMachineChannels.js';
import type { Animation2DExtensionRegistry } from './Animation2DExtensionRegistry.js';
import type {
  Animation2DStateMachineParameterValue,
  Animation2DStateMachineRuntime,
} from './Animation2DStateMachineRuntime.js';
import type { Animation2DRuntimeStats } from './Animation2DComponent.js';
import { getHyaStateMachineExtension } from './HyaAnimation2DClipAdapter.js';

export interface Animation2DStateMachineComponentOptions {
  autoplay?: boolean;
  speed?: number;
  runtimeExtensions?: Animation2DExtensionRegistry;
}

/**
 * Plays multiple named animation ranges and a state machine from one HYA
 * asset. Transitions blend one pose onto one generated scene hierarchy.
 */
export class Animation2DStateMachineComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Animation2DStateMachineComponent');
  static override Lifecycle = ComponentLifecycleFlags.EntityRemoveComponent
    | ComponentLifecycleFlags.EntityRemoveFromWorld;

  readonly animation: ParsedAnimation;
  readonly stateMachineExtension: HyaStateMachineExtension;
  readonly runtimeExtensions: Animation2DExtensionRegistry | undefined;
  playing: boolean;
  speed: number;
  _runtime: Animation2DStateMachineRuntime | null = null;
  _needsUpdate = true;

  private readonly _parametersByName: ReadonlyMap<string, HyaStateMachineParameter>;
  private readonly _parameterValues = new Map<string, Animation2DStateMachineParameterValue>();

  constructor(
    source: AnimationSource | ParsedAnimation,
    options: Animation2DStateMachineComponentOptions = {},
  ) {
    super('Animation2DStateMachineComponent');
    this.animation = isParsed(source) ? source : parseAnimation(source);
    this.stateMachineExtension = getHyaStateMachineExtension(this.animation);
    this.runtimeExtensions = options.runtimeExtensions;
    this.playing = options.autoplay ?? true;
    this.speed = finiteSpeed(options.speed ?? 1);
    this._parametersByName = new Map(
      this.stateMachineExtension.stateMachine.parameters.map(parameter => [parameter.name, parameter]),
    );
  }

  get runtimeStats(): Animation2DRuntimeStats {
    return this._runtime?.stats ?? EMPTY_RUNTIME_STATS;
  }

  get layerSnapshots(): readonly AnimationStateMachineLayerSnapshot[] {
    if (this._runtime) return this._runtime.layerSnapshots;
    return Object.freeze(this.stateMachineExtension.stateMachine.layers.map(layer => Object.freeze({
      layerId: layer.id,
      currentStateId: layer.initialStateId,
      currentTime: 0,
      transitionId: null,
      sourceStateId: null,
      destinationStateId: null,
      transitionProgress: 0,
    })));
  }

  get channelDiagnostics(): readonly AnimationStateMachineChannelDiagnostic[] {
    return this._runtime?.diagnostics ?? EMPTY_CHANNEL_DIAGNOSTICS;
  }

  get liveActionCount(): number { return this._runtime?.liveActionCount ?? 0; }
  get liveBindingCount(): number { return this._runtime?.liveBindingCount ?? 0; }
  get sideEffectOwnerCount(): number { return this._runtime?.sideEffectOwnerCount ?? 0; }

  play(): this {
    this.playing = true;
    this._runtime?.setPlaying(true);
    this._needsUpdate = true;
    return this;
  }

  pause(): this {
    this.playing = false;
    this._runtime?.setPlaying(false);
    return this;
  }

  setSpeed(speed: number): this {
    this.speed = finiteSpeed(speed);
    return this;
  }

  setFloat(name: string, value: number): this {
    if (!Number.isFinite(value)) throw new RangeError('Float parameters must be finite.');
    this._setParameter(name, 'float', value);
    this._runtime?.controller.setFloat(name, value);
    return this;
  }

  setInteger(name: string, value: number): this {
    if (!Number.isSafeInteger(value)) throw new RangeError('Integer parameters must be safe integers.');
    this._setParameter(name, 'integer', value);
    this._runtime?.controller.setInteger(name, value);
    return this;
  }

  setBoolean(name: string, value: boolean): this {
    if (typeof value !== 'boolean') throw new TypeError('Boolean parameters require a boolean.');
    this._setParameter(name, 'boolean', value);
    this._runtime?.controller.setBoolean(name, value);
    return this;
  }

  setTrigger(name: string): this {
    this._setParameter(name, 'trigger', true);
    this._runtime?.controller.setTrigger(name);
    return this;
  }

  resetTrigger(name: string): this {
    this._setParameter(name, 'trigger', false);
    this._runtime?.controller.resetTrigger(name);
    return this;
  }

  getParameter(name: string): number | boolean {
    const parameter = this._requireParameter(name);
    if (this._runtime) return this._runtime.controller.getParameter(name);
    if (this._parameterValues.has(name)) return this._parameterValues.get(name)!;
    return parameter.type === 'trigger' ? false : parameter.defaultValue;
  }

  reset(): this {
    this._parameterValues.clear();
    this._runtime?.reset();
    this._needsUpdate = this._runtime === null;
    return this;
  }

  onEntityRemoveComponent(_entity: Entity, component: Component): void {
    if (component === this) this._disposeRuntime();
  }

  onEntityRemoveFromWorld(_entity: Entity, _world: World): void {
    this._disposeRuntime();
  }

  override clone(): Animation2DStateMachineComponent {
    const clone = new Animation2DStateMachineComponent(this.animation, {
      autoplay: this.playing,
      speed: this.speed,
      ...(this.runtimeExtensions ? { runtimeExtensions: this.runtimeExtensions } : {}),
    });
    for (const parameter of this.stateMachineExtension.stateMachine.parameters) {
      clone._parameterValues.set(parameter.name, this.getParameter(parameter.name));
    }
    clone.disabled = this.disabled;
    return clone;
  }

  _getParameterValues(): ReadonlyMap<string, Animation2DStateMachineParameterValue> {
    return this._parameterValues;
  }

  _disposeRuntime(): void {
    if (!this._runtime) return;
    for (const parameter of this.stateMachineExtension.stateMachine.parameters) {
      this._parameterValues.set(parameter.name, this._runtime.controller.getParameter(parameter.name));
    }
    this._runtime.destroy();
    this._runtime = null;
    this._needsUpdate = true;
  }

  private _setParameter(
    name: string,
    type: HyaStateMachineParameter['type'],
    value: Animation2DStateMachineParameterValue,
  ): void {
    const parameter = this._requireParameter(name);
    if (parameter.type !== type) {
      throw new TypeError(`State-machine parameter "${name}" is ${parameter.type}, not ${type}.`);
    }
    this._parameterValues.set(name, value);
    this._needsUpdate = true;
  }

  private _requireParameter(name: string): HyaStateMachineParameter {
    const parameter = this._parametersByName.get(name);
    if (!parameter) throw new ReferenceError(`Unknown state-machine parameter "${name}".`);
    return parameter;
  }
}

const EMPTY_RUNTIME_STATS: Animation2DRuntimeStats = Object.freeze({
  nodeCount: 0,
  visualCount: 0,
  unsupportedComponentCount: 0,
  pendingResourceCount: 0,
  failedResourceCount: 0,
  textCount: 0,
  particleCount: 0,
  audioCount: 0,
});
const EMPTY_CHANNEL_DIAGNOSTICS: readonly AnimationStateMachineChannelDiagnostic[] = Object.freeze([]);

function isParsed(source: AnimationSource | ParsedAnimation): source is ParsedAnimation {
  return typeof source === 'object' && source !== null && 'source' in source;
}

function finiteSpeed(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Animation2D state-machine speed must be finite and non-negative.');
  }
  return value;
}
