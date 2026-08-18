import {
  evaluateAnimation3DBlend1DWeights,
  evaluateAnimation3DBlend2DWeights,
} from './AnimationStateMachineBlendTreeWeights.js';
import type {
  CompiledAnimation3DCondition,
  CompiledAnimation3DLayer,
  CompiledAnimation3DMotion,
  CompiledAnimation3DParameter,
  CompiledAnimation3DState,
  CompiledAnimation3DStateMachine,
  CompiledAnimation3DTransition,
} from './AnimationStateMachineCompiler.js';
import type {
  Animation3DStateMachineActionHandle,
  Animation3DStateMachineMixerPort,
} from './AnimationStateMachineMixerPort.js';

const TIME_EPSILON = 1e-9;
const DEFAULT_MAX_TRANSITIONS_PER_UPDATE = 128;
const CONTROLLER_UPDATE_TRANSACTION = Symbol('AnimationStateMachineController.updateTransaction');

export type Animation3DStateMachineControllerStatus =
  | 'active'
  | 'destroyed';

export interface Animation3DStateMachineControllerOptions {
  /**
   * Bounds zero-duration transition cycles and pathological large-delta
   * updates per layer. Remaining time is still advanced after the limit is
   * reached.
   */
  readonly maxTransitionsPerUpdate?: number;
}

export interface Animation3DStateMachineLayerSnapshot {
  readonly layerId: string;
  readonly currentStateId: string;
  readonly currentTime: number;
  readonly transitionId: string | null;
  readonly sourceStateId: string | null;
  readonly destinationStateId: string | null;
  readonly transitionProgress: number;
}

interface RuntimeClip<
  TAction extends Animation3DStateMachineActionHandle,
> {
  readonly kind: 'clip';
  readonly action: TAction;
}

interface RuntimeBlend1D<
  TAction extends Animation3DStateMachineActionHandle,
> {
  readonly kind: 'blend-1d';
  readonly motion: Extract<CompiledAnimation3DMotion, { readonly kind: 'blend-1d' }>;
  readonly children: readonly RuntimeMotion<TAction>[];
  readonly weights: Float64Array;
}

interface RuntimeBlend2D<
  TAction extends Animation3DStateMachineActionHandle,
> {
  readonly kind: 'blend-2d';
  readonly motion: Extract<CompiledAnimation3DMotion, { readonly kind: 'blend-2d' }>;
  readonly children: readonly RuntimeMotion<TAction>[];
  readonly weights: Float64Array;
}

type RuntimeMotion<
  TAction extends Animation3DStateMachineActionHandle,
> =
  | RuntimeClip<TAction>
  | RuntimeBlend1D<TAction>
  | RuntimeBlend2D<TAction>;

interface StatePlayback<
  TAction extends Animation3DStateMachineActionHandle,
> {
  readonly state: CompiledAnimation3DState;
  readonly motion: RuntimeMotion<TAction>;
  time: number;
}

interface ActiveTransition<
  TAction extends Animation3DStateMachineActionHandle,
> {
  readonly definition: CompiledAnimation3DTransition;
  readonly source: StatePlayback<TAction>;
  readonly destination: StatePlayback<TAction>;
  elapsed: number;
}

interface LayerRuntime<
  TAction extends Animation3DStateMachineActionHandle,
> {
  readonly definition: CompiledAnimation3DLayer;
  current: StatePlayback<TAction>;
  transition: ActiveTransition<TAction> | null;
}

interface LayerTransactionCheckpoint<
  TAction extends Animation3DStateMachineActionHandle,
> {
  current: StatePlayback<TAction>;
  transition: ActiveTransition<TAction> | null;
  currentTime: number;
  sourceTime: number;
  destinationTime: number;
  transitionElapsed: number;
}

interface TransactionalAnimationStateMachineMixerPort {
  beginControllerTransaction(): void;
  commitControllerTransaction(): void;
  rollbackControllerTransaction(): void;
}

interface InterruptionCandidate<
  TAction extends Animation3DStateMachineActionHandle,
> {
  readonly transition: CompiledAnimation3DTransition;
  readonly anchor: StatePlayback<TAction>;
}

/**
 * Deterministic, mixer-agnostic runtime controller for a compiled definition.
 * All string resolution happens in the compiler or at setter/query boundaries.
 */
export class Animation3DStateMachineController<
  TAction extends Animation3DStateMachineActionHandle =
    Animation3DStateMachineActionHandle,
> {
  readonly compiled: CompiledAnimation3DStateMachine;
  readonly port: Animation3DStateMachineMixerPort<TAction>;
  readonly maxTransitionsPerUpdate: number;

  lastUpdateTransitionCount = 0;
  transitionLimitReached = false;

  private readonly _parameterValues: Float64Array;
  private readonly _transactionParameterValues: Float64Array;
  private readonly _layers: LayerRuntime<TAction>[] = [];
  private readonly _layerTransactionCheckpoints: LayerTransactionCheckpoint<TAction>[] = [];
  private _transactionLastUpdateTransitionCount = 0;
  private _transactionLimitReached = false;
  private _transactionActive = false;
  private _status: Animation3DStateMachineControllerStatus = 'active';

  constructor(
    compiled: CompiledAnimation3DStateMachine,
    port: Animation3DStateMachineMixerPort<TAction>,
    options: Animation3DStateMachineControllerOptions = {},
  ) {
    const maxTransitions =
      options.maxTransitionsPerUpdate ?? DEFAULT_MAX_TRANSITIONS_PER_UPDATE;
    if (!Number.isSafeInteger(maxTransitions) || maxTransitions <= 0) {
      throw new RangeError('maxTransitionsPerUpdate must be a positive safe integer.');
    }
    this.compiled = compiled;
    this.port = port;
    this.maxTransitionsPerUpdate = maxTransitions;
    this._parameterValues = new Float64Array(compiled.parameters.length);
    this._transactionParameterValues = new Float64Array(compiled.parameters.length);
    this._restoreParameterDefaults();
    try {
      for (const layer of compiled.layers) {
        const current = this._createPlayback(
          layer,
          layer.states[layer.initialStateIndex]!,
          0,
        );
        this._layers.push({ definition: layer, current, transition: null });
      }
      this._synchronizeAllLayers();
    } catch (error) {
      this._destroyAllLayers();
      this._status = 'destroyed';
      throw error;
    }
  }

  get status(): Animation3DStateMachineControllerStatus {
    return this._status;
  }

  get layerSnapshots(): readonly Animation3DStateMachineLayerSnapshot[] {
    return Object.freeze(this._layers.map(layer => this._snapshotLayer(layer)));
  }

  getLayerSnapshot(layerId: string): Animation3DStateMachineLayerSnapshot {
    const layerIndex = this.compiled.layerIndexById.get(layerId);
    if (layerIndex === undefined) throw new ReferenceError(`Unknown layer "${layerId}".`);
    const runtime = this._layers[layerIndex];
    if (!runtime) throw new Error('State-machine controller is destroyed.');
    return this._snapshotLayer(runtime);
  }

  setFloat(name: string, value: number): this {
    if (!Number.isFinite(value)) throw new RangeError('Float parameters must be finite.');
    this._setTypedParameter(name, 'float', value);
    return this;
  }

  setInteger(name: string, value: number): this {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('Integer parameters must be safe integers.');
    }
    this._setTypedParameter(name, 'integer', value);
    return this;
  }

  setBoolean(name: string, value: boolean): this {
    if (typeof value !== 'boolean') throw new TypeError('Boolean parameters require a boolean.');
    this._setTypedParameter(name, 'boolean', value ? 1 : 0);
    return this;
  }

  setTrigger(name: string): this {
    this._setTypedParameter(name, 'trigger', 1);
    return this;
  }

  resetTrigger(name: string): this {
    this._setTypedParameter(name, 'trigger', 0);
    return this;
  }

  getParameter(name: string): number | boolean {
    const parameter = this._resolveParameter(name);
    const value = this._parameterValues[parameter.index]!;
    return parameter.type === 'boolean' || parameter.type === 'trigger'
      ? value !== 0
      : value;
  }

  update(deltaSeconds: number): this {
    this[CONTROLLER_UPDATE_TRANSACTION](deltaSeconds);
    return this;
  }

  /** @internal Keeps controller and transactional mixer ports atomic through final pose evaluation. */
  [CONTROLLER_UPDATE_TRANSACTION](
    deltaSeconds: number,
    beforeUpdate?: () => void,
    complete?: () => unknown,
  ): unknown {
    this._requireActive();
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('State-machine deltaSeconds must be finite and non-negative.');
    }
    if (this._transactionActive) {
      throw new Error('State-machine controller update transaction is already active.');
    }

    const transactionalPort = resolveTransactionalPort(this.port);
    this._captureUpdateTransaction();
    this._transactionActive = true;
    let portTransactionActive = false;
    try {
      if (transactionalPort) {
        transactionalPort.beginControllerTransaction();
        portTransactionActive = true;
      }
      beforeUpdate?.();
      this.lastUpdateTransitionCount = 0;
      this.transitionLimitReached = false;
      for (const layer of this._layers) this._updateLayer(layer, deltaSeconds);
      const result = complete?.();
      transactionalPort?.commitControllerTransaction();
      portTransactionActive = false;
      this._transactionActive = false;
      return result;
    } catch (error) {
      this._restoreUpdateTransaction();
      this._transactionActive = false;
      if (portTransactionActive) {
        try {
          transactionalPort!.rollbackControllerTransaction();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'State-machine update and rollback both failed.',
          );
        }
      }
      throw error;
    }
  }

  /**
   * Restores defaults and initial states. Repeated reset calls are safe and
   * leave the same observable controller state.
   */
  reset(): this {
    if (this._status === 'destroyed') return this;
    this._destroyAllLayers();
    this._restoreParameterDefaults();
    this.lastUpdateTransitionCount = 0;
    this.transitionLimitReached = false;
    for (const layer of this.compiled.layers) {
      const current = this._createPlayback(
        layer,
        layer.states[layer.initialStateIndex]!,
        0,
      );
      this._layers.push({ definition: layer, current, transition: null });
    }
    this._synchronizeAllLayers();
    return this;
  }

  /** Stops and releases all port actions. Idempotent. */
  destroy(): void {
    if (this._status === 'destroyed') return;
    this._destroyAllLayers();
    this._status = 'destroyed';
  }

  private _updateLayer(layer: LayerRuntime<TAction>, deltaSeconds: number): void {
    let remaining = deltaSeconds;
    let layerTransitionCount = 0;
    let inspectImmediateTransitions = true;
    while (remaining > TIME_EPSILON || inspectImmediateTransitions) {
      inspectImmediateTransitions = false;
      if (layerTransitionCount >= this.maxTransitionsPerUpdate) {
        this.transitionLimitReached = true;
        this._advanceWithoutTransitions(layer, remaining);
        remaining = 0;
        break;
      }

      if (layer.transition) {
        const interruption = this._findInterruption(layer);
        if (interruption) {
          this._interruptTransition(layer, interruption);
          layerTransitionCount++;
          this.lastUpdateTransitionCount++;
          inspectImmediateTransitions = true;
          continue;
        }
        const active = layer.transition;
        const timeToCompletion = Math.max(
          0,
          active.definition.duration - active.elapsed,
        );
        if (timeToCompletion <= TIME_EPSILON) {
          this._completeTransition(layer);
          inspectImmediateTransitions = true;
          continue;
        }
        if (remaining <= TIME_EPSILON) break;
        const step = Math.min(remaining, timeToCompletion);
        this._advancePlayback(active.source, step);
        this._advancePlayback(active.destination, step);
        active.elapsed = Math.min(
          active.definition.duration,
          active.elapsed + step,
        );
        remaining = Math.max(0, remaining - step);
        this._synchronizeLayer(layer);
        if (
          active.elapsed + TIME_EPSILON >= active.definition.duration
          && layer.transition === active
        ) {
          this._completeTransition(layer);
          inspectImmediateTransitions = true;
        }
        continue;
      }

      const candidate = this._findEligibleTransition(
        layer.definition,
        layer.current,
        -1,
      );
      if (candidate) {
        this._startTransition(layer, layer.current, candidate);
        layerTransitionCount++;
        this.lastUpdateTransitionCount++;
        inspectImmediateTransitions = true;
        continue;
      }
      if (remaining <= TIME_EPSILON) break;
      const wait = this._timeUntilNextExitTransition(layer);
      const step = Number.isFinite(wait)
        ? Math.min(remaining, Math.max(wait, TIME_EPSILON))
        : remaining;
      this._advancePlayback(layer.current, step);
      remaining = Math.max(0, remaining - step);
      this._synchronizeLayer(layer);
      if (Number.isFinite(wait) && step + TIME_EPSILON >= wait) {
        inspectImmediateTransitions = true;
      }
    }
    this._synchronizeLayer(layer);
  }

  private _captureUpdateTransaction(): void {
    this._transactionParameterValues.set(this._parameterValues);
    this._transactionLastUpdateTransitionCount = this.lastUpdateTransitionCount;
    this._transactionLimitReached = this.transitionLimitReached;
    for (let index = 0; index < this._layers.length; index++) {
      const layer = this._layers[index]!;
      const transition = layer.transition;
      let checkpoint = this._layerTransactionCheckpoints[index];
      if (!checkpoint) {
        checkpoint = {
          current: layer.current,
          transition,
          currentTime: 0,
          sourceTime: 0,
          destinationTime: 0,
          transitionElapsed: 0,
        };
        this._layerTransactionCheckpoints.push(checkpoint);
      }
      checkpoint.current = layer.current;
      checkpoint.transition = transition;
      checkpoint.currentTime = layer.current.time;
      checkpoint.sourceTime = transition?.source.time ?? 0;
      checkpoint.destinationTime = transition?.destination.time ?? 0;
      checkpoint.transitionElapsed = transition?.elapsed ?? 0;
    }
  }

  private _restoreUpdateTransaction(): void {
    this._parameterValues.set(this._transactionParameterValues);
    this.lastUpdateTransitionCount = this._transactionLastUpdateTransitionCount;
    this.transitionLimitReached = this._transactionLimitReached;
    for (let index = 0; index < this._layers.length; index++) {
      const layer = this._layers[index]!;
      const checkpoint = this._layerTransactionCheckpoints[index]!;
      layer.current = checkpoint.current;
      layer.transition = checkpoint.transition;
      checkpoint.current.time = checkpoint.currentTime;
      if (checkpoint.transition) {
        checkpoint.transition.source.time = checkpoint.sourceTime;
        checkpoint.transition.destination.time = checkpoint.destinationTime;
        checkpoint.transition.elapsed = checkpoint.transitionElapsed;
      }
    }
  }

  private _findEligibleTransition(
    layer: CompiledAnimation3DLayer,
    playback: StatePlayback<TAction>,
    excludedTransitionIndex: number,
  ): CompiledAnimation3DTransition | null {
    for (const transition of layer.transitions) {
      if (transition.index === excludedTransitionIndex) continue;
      if (
        transition.fromStateIndex !== -1
        && transition.fromStateIndex !== playback.state.index
      ) continue;
      if (!this._conditionsPass(transition.conditions)) continue;
      if (
        transition.hasExitTime
        && !this._exitTimeReached(playback, transition.exitTime)
      ) continue;
      return transition;
    }
    return null;
  }

  private _findInterruption(
    layer: LayerRuntime<TAction>,
  ): InterruptionCandidate<TAction> | null {
    const active = layer.transition!;
    const strategy = active.definition.interruption;
    if (strategy === 'none') return null;
    const source = (): InterruptionCandidate<TAction> | null => {
      const transition = this._findEligibleTransition(
        layer.definition,
        active.source,
        active.definition.index,
      );
      return transition ? { transition, anchor: active.source } : null;
    };
    const destination = (): InterruptionCandidate<TAction> | null => {
      const transition = this._findEligibleTransition(
        layer.definition,
        active.destination,
        active.definition.index,
      );
      return transition ? { transition, anchor: active.destination } : null;
    };
    if (strategy === 'source') return source();
    if (strategy === 'destination') return destination();
    if (strategy === 'source-then-destination') return source() ?? destination();
    return destination() ?? source();
  }

  private _startTransition(
    layer: LayerRuntime<TAction>,
    source: StatePlayback<TAction>,
    transition: CompiledAnimation3DTransition,
  ): void {
    const destinationState = layer.definition.states[transition.toStateIndex]!;
    const destination = this._createPlayback(
      layer.definition,
      destinationState,
      transition.destinationOffset,
    );
    // Consume only after destination action creation succeeds and the
    // transition can actually become active.
    this._consumeTriggers(transition);
    const active: ActiveTransition<TAction> = {
      definition: transition,
      source,
      destination,
      elapsed: 0,
    };
    layer.transition = active;
    this._fadePlayback(source, 0, transition.duration);
    this._fadePlayback(
      destination,
      layer.definition.weight,
      transition.duration,
    );
    this._synchronizeLayer(layer);
    if (transition.duration <= TIME_EPSILON) this._completeTransition(layer);
  }

  private _interruptTransition(
    layer: LayerRuntime<TAction>,
    candidate: InterruptionCandidate<TAction>,
  ): void {
    const active = layer.transition!;
    const discarded = candidate.anchor === active.source
      ? active.destination
      : active.source;
    this._destroyPlayback(discarded);
    layer.current = candidate.anchor;
    layer.transition = null;
    this._startTransition(layer, candidate.anchor, candidate.transition);
  }

  private _completeTransition(layer: LayerRuntime<TAction>): void {
    const active = layer.transition;
    if (!active) return;
    this._destroyPlayback(active.source);
    layer.current = active.destination;
    layer.transition = null;
    this._synchronizeLayer(layer);
  }

  private _timeUntilNextExitTransition(layer: LayerRuntime<TAction>): number {
    let earliest = Infinity;
    for (const transition of layer.definition.transitions) {
      if (
        transition.fromStateIndex !== -1
        && transition.fromStateIndex !== layer.current.state.index
      ) continue;
      if (!transition.hasExitTime || !this._conditionsPass(transition.conditions)) continue;
      earliest = Math.min(
        earliest,
        this._timeUntilExit(layer.current, transition.exitTime),
      );
    }
    return earliest;
  }

  private _exitTimeReached(
    playback: StatePlayback<TAction>,
    exitTime: number,
  ): boolean {
    const duration = this._playbackDuration(playback);
    if (duration <= TIME_EPSILON) return true;
    const normalizedTime = playback.time / duration;
    if (playback.state.loop === 'once' || exitTime >= 1) {
      return normalizedTime + TIME_EPSILON >= exitTime;
    }
    const cycleTime = normalizedTime - Math.floor(normalizedTime);
    return cycleTime + TIME_EPSILON >= exitTime;
  }

  private _timeUntilExit(
    playback: StatePlayback<TAction>,
    exitTime: number,
  ): number {
    if (this._exitTimeReached(playback, exitTime)) return 0;
    const duration = this._playbackDuration(playback);
    if (duration <= TIME_EPSILON) return 0;
    const speed = this._playbackSpeed(playback);
    if (speed <= TIME_EPSILON) return Infinity;
    const normalizedTime = playback.time / duration;
    let targetNormalized: number;
    if (playback.state.loop === 'once' || exitTime >= 1) {
      targetNormalized = exitTime;
    } else {
      targetNormalized = Math.floor(normalizedTime) + exitTime;
      if (targetNormalized <= normalizedTime + TIME_EPSILON) targetNormalized += 1;
    }
    return Math.max(0, (targetNormalized * duration - playback.time) / speed);
  }

  private _conditionsPass(
    conditions: readonly CompiledAnimation3DCondition[],
  ): boolean {
    for (const condition of conditions) {
      const actual = this._parameterValues[condition.parameterIndex]!;
      const expected = condition.value;
      if (condition.operator === 'greater' && !(actual > expected)) return false;
      if (
        condition.operator === 'greater-or-equal'
        && !(actual >= expected)
      ) return false;
      if (condition.operator === 'less' && !(actual < expected)) return false;
      if (
        condition.operator === 'less-or-equal'
        && !(actual <= expected)
      ) return false;
      if (condition.operator === 'equal' && actual !== expected) return false;
      if (condition.operator === 'not-equal' && actual === expected) return false;
      if (condition.operator === 'is-true' && actual === 0) return false;
      if (condition.operator === 'is-false' && actual !== 0) return false;
      if (condition.operator === 'triggered' && actual === 0) return false;
    }
    return true;
  }

  private _consumeTriggers(transition: CompiledAnimation3DTransition): void {
    for (const parameterIndex of transition.triggerParameterIndices) {
      this._parameterValues[parameterIndex] = 0;
    }
  }

  private _createPlayback(
    layer: CompiledAnimation3DLayer,
    state: CompiledAnimation3DState,
    normalizedOffset: number,
  ): StatePlayback<TAction> {
    const createdActions: TAction[] = [];
    try {
      const motion = this._createRuntimeMotion(layer, state, state.motion, createdActions);
      const playback: StatePlayback<TAction> = { state, motion, time: 0 };
      playback.time = normalizedOffset * this._playbackDuration(playback);
      this._forEachAction(motion, action => {
        this.port.setWeight(action, 0);
        this.port.setTime(action, playback.time);
        this.port.setTimeScale(action, this._playbackSpeed(playback));
        this.port.play(action);
      });
      return playback;
    } catch (error) {
      for (let index = createdActions.length - 1; index >= 0; index--) {
        const action = createdActions[index]!;
        this.port.stop(action);
        this.port.destroyAction(action);
      }
      throw error;
    }
  }

  private _createRuntimeMotion(
    layer: CompiledAnimation3DLayer,
    state: CompiledAnimation3DState,
    motion: CompiledAnimation3DMotion,
    createdActions: TAction[],
  ): RuntimeMotion<TAction> {
    if (motion.kind === 'clip') {
      const action = this.port.createAction(motion.clipId, {
        layerId: layer.id,
        stateId: state.id,
        loop: state.loop,
        blendMode: layer.blendMode,
        mask: layer.mask,
      });
      if (!Number.isFinite(action.duration) || action.duration < 0) {
        throw new RangeError(
          `Mixer port returned an invalid duration for clip "${motion.clipId}".`,
        );
      }
      createdActions.push(action);
      return { kind: 'clip', action };
    }
    const children = motion.children.map(child =>
      this._createRuntimeMotion(layer, state, child.motion, createdActions));
    return motion.kind === 'blend-1d'
      ? {
          kind: 'blend-1d',
          motion,
          children,
          weights: new Float64Array(children.length),
        }
      : {
          kind: 'blend-2d',
          motion,
          children,
          weights: new Float64Array(children.length),
        };
  }

  private _advancePlayback(
    playback: StatePlayback<TAction>,
    deltaSeconds: number,
  ): void {
    playback.time += deltaSeconds * this._playbackSpeed(playback);
  }

  private _advanceWithoutTransitions(
    layer: LayerRuntime<TAction>,
    deltaSeconds: number,
  ): void {
    if (deltaSeconds <= TIME_EPSILON) return;
    const active = layer.transition;
    if (!active) {
      this._advancePlayback(layer.current, deltaSeconds);
      this._synchronizeLayer(layer);
      return;
    }
    const timeToCompletion = Math.max(0, active.definition.duration - active.elapsed);
    const transitionStep = Math.min(deltaSeconds, timeToCompletion);
    this._advancePlayback(active.source, transitionStep);
    this._advancePlayback(active.destination, transitionStep);
    active.elapsed += transitionStep;
    const afterCompletion = deltaSeconds - transitionStep;
    if (active.elapsed + TIME_EPSILON >= active.definition.duration) {
      this._completeTransition(layer);
      if (afterCompletion > TIME_EPSILON) {
        this._advancePlayback(layer.current, afterCompletion);
      }
    }
    this._synchronizeLayer(layer);
  }

  private _synchronizeAllLayers(): void {
    for (const layer of this._layers) this._synchronizeLayer(layer);
  }

  private _synchronizeLayer(layer: LayerRuntime<TAction>): void {
    const active = layer.transition;
    if (!active) {
      this._applyPlayback(layer.current, layer.definition.weight);
      return;
    }
    const progress = active.definition.duration <= TIME_EPSILON
      ? 1
      : Math.max(0, Math.min(1, active.elapsed / active.definition.duration));
    this._applyPlayback(
      active.source,
      layer.definition.weight * (1 - progress),
    );
    this._applyPlayback(
      active.destination,
      layer.definition.weight * progress,
    );
  }

  private _applyPlayback(
    playback: StatePlayback<TAction>,
    parentWeight: number,
  ): void {
    const speed = this._playbackSpeed(playback);
    this._applyMotion(
      playback.motion,
      parentWeight,
      playback.time,
      speed,
    );
  }

  private _applyMotion(
    motion: RuntimeMotion<TAction>,
    parentWeight: number,
    time: number,
    timeScale: number,
  ): void {
    if (motion.kind === 'clip') {
      this.port.setWeight(motion.action, parentWeight);
      this.port.setTime(motion.action, time);
      this.port.setTimeScale(motion.action, timeScale);
      return;
    }
    this._evaluateDirectWeights(motion);
    for (let index = 0; index < motion.children.length; index++) {
      this._applyMotion(
        motion.children[index]!,
        parentWeight * motion.weights[index]!,
        time,
        timeScale,
      );
    }
  }

  private _playbackDuration(playback: StatePlayback<TAction>): number {
    return this._motionDuration(playback.motion);
  }

  private _motionDuration(motion: RuntimeMotion<TAction>): number {
    if (motion.kind === 'clip') return motion.action.duration;
    this._evaluateDirectWeights(motion);
    let duration = 0;
    for (let index = 0; index < motion.children.length; index++) {
      duration += motion.weights[index]! * this._motionDuration(motion.children[index]!);
    }
    return duration;
  }

  private _playbackSpeed(playback: StatePlayback<TAction>): number {
    const parameterScale = playback.state.speedParameterIndex < 0
      ? 1
      : this._parameterValues[playback.state.speedParameterIndex]!;
    return playback.state.speed * parameterScale;
  }

  private _evaluateDirectWeights(
    motion: RuntimeBlend1D<TAction> | RuntimeBlend2D<TAction>,
  ): void {
    if (motion.kind === 'blend-1d') {
      evaluateAnimation3DBlend1DWeights(
        motion.motion,
        this._parameterValues[motion.motion.parameterIndex]!,
        motion.weights,
      );
    } else {
      evaluateAnimation3DBlend2DWeights(
        motion.motion,
        this._parameterValues[motion.motion.parameterXIndex]!,
        this._parameterValues[motion.motion.parameterYIndex]!,
        motion.weights,
      );
    }
  }

  private _fadePlayback(
    playback: StatePlayback<TAction>,
    targetParentWeight: number,
    durationSeconds: number,
  ): void {
    this._fadeMotion(playback.motion, targetParentWeight, durationSeconds);
  }

  private _fadeMotion(
    motion: RuntimeMotion<TAction>,
    parentWeight: number,
    durationSeconds: number,
  ): void {
    if (motion.kind === 'clip') {
      this.port.fade(motion.action, parentWeight, durationSeconds);
      return;
    }
    this._evaluateDirectWeights(motion);
    for (let index = 0; index < motion.children.length; index++) {
      this._fadeMotion(
        motion.children[index]!,
        parentWeight * motion.weights[index]!,
        durationSeconds,
      );
    }
  }

  private _destroyPlayback(playback: StatePlayback<TAction>): void {
    this._forEachAction(playback.motion, action => {
      this.port.stop(action);
      this.port.destroyAction(action);
    });
  }

  private _destroyAllLayers(): void {
    for (const layer of this._layers) {
      if (layer.transition) {
        this._destroyPlayback(layer.transition.source);
        this._destroyPlayback(layer.transition.destination);
      } else {
        this._destroyPlayback(layer.current);
      }
    }
    this._layers.length = 0;
  }

  private _forEachAction(
    motion: RuntimeMotion<TAction>,
    visitor: (action: TAction) => void,
  ): void {
    if (motion.kind === 'clip') {
      visitor(motion.action);
      return;
    }
    for (const child of motion.children) this._forEachAction(child, visitor);
  }

  private _snapshotLayer(
    layer: LayerRuntime<TAction>,
  ): Animation3DStateMachineLayerSnapshot {
    const active = layer.transition;
    return Object.freeze({
      layerId: layer.definition.id,
      currentStateId: active?.source.state.id ?? layer.current.state.id,
      currentTime: active?.source.time ?? layer.current.time,
      transitionId: active?.definition.id ?? null,
      sourceStateId: active?.source.state.id ?? null,
      destinationStateId: active?.destination.state.id ?? null,
      transitionProgress: active
        ? (
            active.definition.duration <= TIME_EPSILON
              ? 1
              : Math.max(0, Math.min(1, active.elapsed / active.definition.duration))
          )
        : 0,
    });
  }

  private _setTypedParameter(
    name: string,
    expectedType: CompiledAnimation3DParameter['type'],
    value: number,
  ): void {
    this._requireActive();
    const parameter = this._resolveParameter(name);
    if (parameter.type !== expectedType) {
      throw new TypeError(
        `Parameter "${name}" is ${parameter.type}, not ${expectedType}.`,
      );
    }
    this._parameterValues[parameter.index] = value;
  }

  private _resolveParameter(name: string): CompiledAnimation3DParameter {
    const parameterIndex = this.compiled.parameterIndexByName.get(name);
    if (parameterIndex === undefined) throw new ReferenceError(`Unknown parameter "${name}".`);
    return this.compiled.parameters[parameterIndex]!;
  }

  private _restoreParameterDefaults(): void {
    for (const parameter of this.compiled.parameters) {
      this._parameterValues[parameter.index] = parameter.defaultValue;
    }
  }

  private _requireActive(): void {
    if (this._status === 'destroyed') {
      throw new Error('Animation3D state-machine controller is destroyed.');
    }
  }
}

/**
 * @internal Extends one controller update transaction through caller-owned
 * pose evaluation. It is intentionally not re-exported from package entries.
 */
export function runAnimationStateMachineControllerUpdateTransaction<
  TAction extends Animation3DStateMachineActionHandle,
  TResult,
>(
  controller: Animation3DStateMachineController<TAction>,
  deltaSeconds: number,
  beforeUpdate: () => void,
  complete: () => TResult,
): TResult {
  return controller[CONTROLLER_UPDATE_TRANSACTION](
    deltaSeconds,
    beforeUpdate,
    complete,
  ) as TResult;
}

function resolveTransactionalPort(
  port: Animation3DStateMachineMixerPort<Animation3DStateMachineActionHandle>,
): TransactionalAnimationStateMachineMixerPort | null {
  const candidate = port as Animation3DStateMachineMixerPort<Animation3DStateMachineActionHandle>
    & Partial<TransactionalAnimationStateMachineMixerPort>;
  const hasBegin = typeof candidate.beginControllerTransaction === 'function';
  const hasCommit = typeof candidate.commitControllerTransaction === 'function';
  const hasRollback = typeof candidate.rollbackControllerTransaction === 'function';
  const implemented = Number(hasBegin) + Number(hasCommit) + Number(hasRollback);
  if (implemented === 0) return null;
  if (implemented !== 3) {
    throw new TypeError(
      'A transactional state-machine mixer port must implement begin, commit, and rollback.',
    );
  }
  return candidate as TransactionalAnimationStateMachineMixerPort;
}

/** Factory kept internal to the runtime directory. */
export function createAnimation3DStateMachineController<
  TAction extends Animation3DStateMachineActionHandle,
>(
  compiled: CompiledAnimation3DStateMachine,
  port: Animation3DStateMachineMixerPort<TAction>,
  options?: Animation3DStateMachineControllerOptions,
): Animation3DStateMachineController<TAction> {
  return new Animation3DStateMachineController(compiled, port, options);
}
