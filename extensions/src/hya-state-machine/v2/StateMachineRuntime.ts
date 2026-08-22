import { ChannelMixerV2 } from './ChannelMixer.js';
import { NestedRuntimeOwnerV2 } from './NestedOwner.js';
import { sampleInterpolation, TimelineSamplerV2 } from './TimelineSampler.js';
import type {
  ChannelOwnershipPort, Comparator, DeterministicInvocationPort, NestedRuntimeFactory, PlaybackMode, RuntimeChannel, RuntimeCondition,
  RuntimeDocument, RuntimeEffect, RuntimeInput, RuntimeLayer, RuntimeMachine, RuntimeMotion, RuntimeState,
  RuntimeTransition, RuntimeValue, SideEffectPort, StateMachinePose, TimelineEffectOccurrence,
} from './runtime-types.js';

export type StateMachineRuntimeStatus = 'running' | 'paused' | 'stopped' | 'disposed';
export interface StateMachineLayerTrace {
  readonly layerId: string; readonly stateId: string | null; readonly localTime: number;
  readonly transitionId: string | null; readonly transitionProgress: number; readonly exited: boolean;
}
export interface StateMachineTrace {
  readonly clock: number; readonly status: StateMachineRuntimeStatus; readonly settled: boolean;
  readonly layers: readonly StateMachineLayerTrace[]; readonly pendingTriggers: readonly string[];
}

interface ActiveTransition {
  readonly definition: RuntimeTransition; readonly sourceId: string; readonly destinationId: string;
  elapsed: number; sourceTime: number; destinationTime: number;
}
interface LayerRuntime {
  readonly definition: RuntimeLayer; readonly states: ReadonlyMap<string, RuntimeState>;
  stateId: string | null; localTime: number; transition: ActiveTransition | null; exited: boolean;
}
interface TransitionMatch { readonly transition: RuntimeTransition; readonly triggers: ReadonlySet<string> }
interface InterruptionMatch extends TransitionMatch { readonly anchorId: string; readonly anchorTime: number }
interface Snapshot {
  readonly clock: number; readonly status: StateMachineRuntimeStatus; readonly settled: boolean;
  readonly inputs: readonly (readonly [string, number | boolean])[]; readonly triggers: readonly string[];
  readonly effectSequence: number; readonly randomState: number; readonly layers: readonly Readonly<{ stateId: string | null; localTime: number; exited: boolean; transition: ActiveTransition | null }>[];
  readonly pendingEffects: readonly TimelineEffectOccurrence[];
}

export interface StateMachineRuntimeOptions {
  readonly invocationPort?: DeterministicInvocationPort; readonly sideEffectPort?: SideEffectPort;
  readonly ownershipPort?: ChannelOwnershipPort;
  readonly nestedFactory?: NestedRuntimeFactory; readonly maxTransitionsPerUpdate?: number;
  readonly randomSeed?: number;
}

export class HyaStateMachineRuntimeV2 {
  readonly sampler: TimelineSamplerV2;
  readonly mixer: ChannelMixerV2;
  readonly nestedOwner: NestedRuntimeOwnerV2;
  private readonly _machine: RuntimeMachine;
  private readonly _channels = new Map<string, RuntimeChannel>();
  private readonly _inputs = new Map<string, RuntimeInput>();
  private readonly _values = new Map<string, number | boolean>();
  private readonly _triggers = new Set<string>();
  private readonly _layers: LayerRuntime[];
  private readonly _invocation: DeterministicInvocationPort | undefined;
  private readonly _maxTransitions: number;
  private readonly _pendingEffects: TimelineEffectOccurrence[] = [];
  private _effectSequence = 0;
  private readonly _initialRandomState: number;
  private _randomState: number;
  private _clock = 0;
  private _status: StateMachineRuntimeStatus = 'running';
  private _settled = false;
  private _lastPose: StateMachinePose = Object.freeze({ sequence: 0, channels: Object.freeze([]), effects: Object.freeze([]), settled: false });

  constructor(document: RuntimeDocument, machineId: string, options: StateMachineRuntimeOptions = {}) {
    const machine = document.stateMachines.find(candidate => candidate.id === machineId);
    if (!machine) throw runtimeError('E_STATE_MACHINE_RUNTIME_REFERENCE', `Unknown state machine ${machineId}.`);
    this._machine = machine; this._invocation = options.invocationPort; this._maxTransitions = options.maxTransitionsPerUpdate ?? 1024;
    this._initialRandomState = normalizeSeed(options.randomSeed ?? 0x9e3779b9); this._randomState = this._initialRandomState;
    if (!Number.isSafeInteger(this._maxTransitions) || this._maxTransitions < 1) throw runtimeError('E_STATE_MACHINE_RUNTIME_LIMIT', 'maxTransitionsPerUpdate must be positive.');
    for (const channel of document.channels) this._channels.set(channel.id, channel);
    for (const input of machine.inputs) { this._inputs.set(input.id, input); if (input.type !== 'trigger') this._values.set(input.id, input.defaultValue!); }
    this.sampler = new TimelineSamplerV2(document); this.mixer = new ChannelMixerV2(options.sideEffectPort, options.ownershipPort); this.nestedOwner = new NestedRuntimeOwnerV2(document.components ?? [], options.nestedFactory);
    this._layers = [...machine.layers].sort((left, right) => left.order - right.order).map(layer => ({ definition: layer, states: new Map(layer.states.map(state => [state.id, state])), stateId: entryTarget(layer), localTime: 0, transition: null, exited: false }));
    for (const layer of this._layers) if (layer.stateId) this._queueEffects(layer.definition.id, `state:${layer.stateId}:entry`, layer.states.get(layer.stateId)?.entryEffects, 'start');
  }

  get status(): StateMachineRuntimeStatus { return this._status; }
  get settled(): boolean { return this._settled; }
  get clock(): number { return this._clock; }
  get lastPose(): StateMachinePose { return this._lastPose; }
  get trace(): StateMachineTrace { return Object.freeze({ clock: this._clock, status: this._status, settled: this._settled, layers: Object.freeze(this._layers.map(layerTrace)), pendingTriggers: Object.freeze([...this._triggers].sort()) }); }

  setNumber(id: string, value: number): this { this._requireInput(id, ['number', 'integer']); if (!Number.isFinite(value) || this._inputs.get(id)!.type === 'integer' && !Number.isSafeInteger(value)) throw runtimeError('E_STATE_MACHINE_RUNTIME_INPUT', `Invalid numeric input ${id}.`); this._setValue(id, value); return this; }
  setBoolean(id: string, value: boolean): this { this._requireInput(id, ['boolean']); if (typeof value !== 'boolean') throw runtimeError('E_STATE_MACHINE_RUNTIME_INPUT', `Invalid boolean input ${id}.`); this._setValue(id, value); return this; }
  setTrigger(id: string): this { this._requireInput(id, ['trigger']); this._triggers.add(id); this._settled = false; return this; }
  resetTrigger(id: string): this { this._requireInput(id, ['trigger']); this._triggers.delete(id); return this; }
  getInput(id: string): number | boolean { const input = this._inputs.get(id); if (!input) throw runtimeError('E_STATE_MACHINE_RUNTIME_INPUT', `Unknown input ${id}.`); return input.type === 'trigger' ? this._triggers.has(id) : this._values.get(id)!; }

  update(deltaSeconds: number): StateMachinePose {
    this._requireActive(); if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw runtimeError('E_STATE_MACHINE_RUNTIME_TIME', 'Update delta must be finite and non-negative.');
    if (this._status === 'stopped') return this._lastPose;
    const delta = this._status === 'paused' ? 0 : deltaSeconds, snapshot = this._snapshot(), transaction = this.mixer.begin();
    try {
      this._invocation?.begin(transaction); this.nestedOwner.beginTransaction(transaction); const consumed = new Set<string>(), activeNested = new Set<string>(), nestedSettled: boolean[] = [];
      if (this._status !== 'paused') for (const layer of this._layers) this._advanceLayer(layer, delta, consumed);
      for (const layer of this._layers) this._sampleLayer(layer, delta, consumed, activeNested, nestedSettled);
      this.nestedOwner.reconcile(activeNested);
      for (const effect of this._pendingEffects) this.mixer.submitEffect(effect);
      const settled = this._layers.every(layer => layer.transition === null) && nestedSettled.every(Boolean) && this._triggers.size === 0;
      const pose = this.mixer.commit(settled); this._invocation?.commit(transaction); this.nestedOwner.commitTransaction(transaction);
      for (const trigger of consumed) this._triggers.delete(trigger);
      this._pendingEffects.length = 0; this._clock += delta; this._settled = settled; this._lastPose = pose; return pose;
    } catch (error) {
      this.mixer.rollback(); try { this._invocation?.rollback(transaction); } finally { this.nestedOwner.rollbackTransaction(transaction); this._restore(snapshot); } throw error;
    }
  }

  evaluate(): StateMachinePose { return this.update(0); }

  seek(timeSeconds: number): StateMachinePose {
    this._requireActive(); if (!Number.isFinite(timeSeconds) || timeSeconds < 0) throw runtimeError('E_STATE_MACHINE_RUNTIME_TIME', 'Seek time must be finite and non-negative.');
    const values = new Map(this._values), triggers = new Set(this._triggers), status = this._status;
    this.reset(); for (const [id, value] of values) this._values.set(id, value); for (const id of triggers) this._triggers.add(id); this._status = status === 'stopped' ? 'running' : status;
    const pose = this.update(timeSeconds); this._status = status; return pose;
  }

  pause(): void { this._requireActive(); if (this._status === 'running') { this._status = 'paused'; this.mixer.pause(); this.nestedOwner.pause(); } }
  resume(): void { this._requireActive(); if (this._status !== 'running') { this._status = 'running'; this.mixer.resume(); this.nestedOwner.resume(); this._settled = false; } }
  stop(): void { this._requireActive(); this.reset(); this._status = 'stopped'; this.mixer.stop(); this.nestedOwner.stop(); }
  reset(): void {
    this._requireActive(); this.mixer.reset(); this.nestedOwner.reset(); this._clock = 0; this._effectSequence = 0; this._randomState = this._initialRandomState; this._pendingEffects.length = 0; this._triggers.clear(); this._status = 'running'; this._settled = false;
    this._values.clear(); for (const input of this._machine.inputs) if (input.type !== 'trigger') this._values.set(input.id, input.defaultValue!);
    for (const layer of this._layers) { layer.stateId = entryTarget(layer.definition); layer.localTime = 0; layer.transition = null; layer.exited = false; if (layer.stateId) this._queueEffects(layer.definition.id, `state:${layer.stateId}:entry`, layer.states.get(layer.stateId)?.entryEffects, 'start'); }
  }
  dispose(): void { if (this._status === 'disposed') return; this.mixer.dispose(); this.sampler.dispose(); this.nestedOwner.dispose(); this._pendingEffects.length = 0; this._status = 'disposed'; }

  private _advanceLayer(layer: LayerRuntime, delta: number, consumed: Set<string>): void {
    if (layer.exited || layer.stateId === null) return;
    let remaining = delta, transitions = 0;
    while (true) {
      if (++transitions > this._maxTransitions) throw runtimeError('E_STATE_MACHINE_RUNTIME_LIMIT', `Layer ${layer.definition.id} exceeded transition limit.`);
      if (layer.transition) {
        const interruption = this._findInterruption(layer, layer.transition);
        if (interruption) {
          layer.transition = null; layer.stateId = interruption.anchorId; layer.localTime = interruption.anchorTime;
          this._startTransition(layer, interruption, consumed); continue;
        }
        const active = layer.transition, timeToCompletion = Math.max(0, active.definition.duration - active.elapsed);
        if (timeToCompletion <= 1e-12) { this._finishTransition(layer, active); continue; }
        if (remaining <= 1e-12) return;
        const advance = Math.min(remaining, timeToCompletion); active.elapsed += advance; if (!active.definition.pauseWhenExiting) active.sourceTime += advance; active.destinationTime += advance; remaining -= advance; layer.localTime = active.sourceTime;
        if (active.elapsed + 1e-12 >= active.definition.duration) { this._finishTransition(layer, active); continue; }
        return;
      }
      const match = this._selectTransition(layer);
      if (match) { this._startTransition(layer, match, consumed); continue; }
      if (remaining <= 1e-12) return;
      const wait = this._timeUntilNextExitTransition(layer), advance = Number.isFinite(wait) ? Math.min(remaining, Math.max(wait, 1e-12)) : remaining;
      layer.localTime += advance; remaining -= advance;
      if (!Number.isFinite(wait) || advance + 1e-12 < wait) return;
    }
  }

  private _startTransition(layer: LayerRuntime, match: TransitionMatch, consumed: Set<string>): void {
    for (const trigger of match.triggers) { consumed.add(trigger); this._triggers.delete(trigger); }
    const transition = match.transition, sourceId = layer.stateId!, destinationId = transition.to;
    this._queueEffects(layer.definition.id, `state:${sourceId}:exit`, layer.states.get(sourceId)?.exitEffects, 'start');
    this._queueEffects(layer.definition.id, `transition:${transition.id}`, transition.effects, 'start');
    if (destinationId === '@exit') { layer.exited = true; layer.stateId = null; layer.localTime = 0; this._queueEffects(layer.definition.id, `transition:${transition.id}`, transition.effects, 'complete'); return; }
    const destinationOffset = (transition.destinationOffset ?? 0) * this._motionDuration(layer.states.get(destinationId)!.motion);
    layer.transition = { definition: transition, sourceId, destinationId, elapsed: 0, sourceTime: layer.localTime, destinationTime: destinationOffset };
  }

  private _finishTransition(layer: LayerRuntime, active: ActiveTransition): void {
    layer.stateId = active.destinationId; layer.localTime = active.destinationTime; layer.transition = null;
    this._queueEffects(layer.definition.id, `transition:${active.definition.id}`, active.definition.effects, 'complete');
    this._queueEffects(layer.definition.id, `state:${active.destinationId}:entry`, layer.states.get(active.destinationId)?.entryEffects, 'start');
  }

  private _selectTransition(layer: LayerRuntime): TransitionMatch | null { return this._selectTransitionFor(layer, layer.stateId!, layer.localTime); }

  private _selectTransitionFor(layer: LayerRuntime, stateId: string, localTime: number, excludedId?: string): TransitionMatch | null {
    for (const transition of layer.definition.transitions) {
      if (transition.id === excludedId || transition.from === '@entry' || transition.from !== '@any' && transition.from !== stateId) continue;
      if (transition.exitTime !== undefined) { const duration = this._motionDuration(layer.states.get(stateId)!.motion); if (duration <= 0 || localTime / duration + 1e-12 < transition.exitTime) continue; }
      const matched = this._matchConditionGroups(transition.conditionGroups); if (!matched) continue;
      if (transition.randomWeight !== undefined && this._random() >= transition.randomWeight) continue;
      return { transition, triggers: matched };
    }
    return null;
  }

  private _findInterruption(layer: LayerRuntime, active: ActiveTransition): InterruptionMatch | null {
    const strategy = active.definition.interruption ?? 'none'; if (strategy === 'none') return null;
    const source = (): InterruptionMatch | null => { const match = this._selectTransitionFor(layer, active.sourceId, active.sourceTime, active.definition.id); return match ? { ...match, anchorId: active.sourceId, anchorTime: active.sourceTime } : null; };
    const destination = (): InterruptionMatch | null => { const match = this._selectTransitionFor(layer, active.destinationId, active.destinationTime, active.definition.id); return match ? { ...match, anchorId: active.destinationId, anchorTime: active.destinationTime } : null; };
    if (strategy === 'source') return source(); if (strategy === 'destination') return destination(); if (strategy === 'source-then-destination') return source() ?? destination(); return destination() ?? source();
  }

  private _timeUntilNextExitTransition(layer: LayerRuntime): number {
    let earliest = Infinity; const state = layer.states.get(layer.stateId!)!;
    for (const transition of layer.definition.transitions) {
      if (transition.from === '@entry' || transition.from !== '@any' && transition.from !== layer.stateId || transition.exitTime === undefined) continue;
      if (!this._matchConditionGroups(transition.conditionGroups)) continue;
      earliest = Math.min(earliest, Math.max(0, transition.exitTime * this._motionDuration(state.motion) - layer.localTime));
    }
    return earliest;
  }

  private _matchConditionGroups(groups: RuntimeTransition['conditionGroups']): ReadonlySet<string> | null {
    if (groups.length === 0) return new Set();
    for (const group of groups) { const triggers = new Set<string>(); let matches = true; for (const condition of group) { if (!this._conditionMatches(condition)) { matches = false; break; } if (condition.kind === 'trigger') triggers.add(condition.input); } if (matches) return triggers; }
    return null;
  }

  private _conditionMatches(condition: RuntimeCondition): boolean {
    if (condition.kind === 'trigger') return this._triggers.has(condition.input);
    if (condition.kind === 'input') return compare(this._values.get(condition.input)!, condition.comparator, condition.value);
    if (!this._invocation) throw runtimeError('E_STATE_MACHINE_INVOCATION_PORT_REQUIRED', `Condition ${condition.protocol}/${condition.port} requires an invocation port.`);
    const result = this._invocation.invoke({ protocol: condition.protocol, port: condition.port, arguments: condition.arguments ?? {} });
    return condition.kind === 'custom' ? result === true : compare(result, condition.comparator, condition.value);
  }

  private _sampleLayer(layer: LayerRuntime, delta: number, consumed: Set<string>, activeNested: Set<string>, nestedSettled: boolean[]): void {
    if (layer.exited || layer.stateId === null) return;
    const layerWeight = clamp(layer.definition.weightInput ? Number(this._values.get(layer.definition.weightInput)) : layer.definition.weight ?? 1, 0, 1), blendMode = layer.definition.mode ?? 'override';
    if (layer.transition) {
      const active = layer.transition, progress = active.definition.duration === 0 ? 1 : clamp(active.elapsed / active.definition.duration, 0, 1), alpha = sampleInterpolation(active.definition.interpolation, progress);
      this._sampleMotion(active.definition.exitMotion ?? layer.states.get(active.sourceId)!.motion, active.sourceTime, active.sourceTime - (active.definition.pauseWhenExiting ? 0 : delta), layerWeight * (1 - alpha), layer, 0, blendMode, consumed, activeNested, nestedSettled);
      this._sampleMotion(layer.states.get(active.destinationId)!.motion, active.destinationTime, active.destinationTime - delta, layerWeight * alpha, layer, 1, blendMode, consumed, activeNested, nestedSettled);
    } else this._sampleMotion(layer.states.get(layer.stateId)!.motion, layer.localTime, layer.localTime - delta, layerWeight, layer, 0, blendMode, consumed, activeNested, nestedSettled);
  }

  private _sampleMotion(motion: RuntimeMotion, time: number, previous: number, weight: number, layer: LayerRuntime, actionOrder: number, blendMode: 'override' | 'additive', consumed: Set<string>, activeNested: Set<string>, nestedSettled: boolean[]): void {
    if (!(weight > 0)) return;
    if (motion.kind === 'clip') {
      const clip = this.sampler.clip(motion.clip), speed = (motion.speed ?? 1) * (motion.speedInput ? Number(this._values.get(motion.speedInput)) : 1), playback = motion.playback ?? 'one-shot';
      let raw = time * speed, priorRaw = previous * speed; if (speed < 0 && playback === 'one-shot') { raw += clip.duration; priorRaw += clip.duration; }
      const remap = motion.timeRemapInput ? Number(this._values.get(motion.timeRemapInput)) : undefined;
      this.mixer.submit(this.sampler.sample(motion.clip, raw, {
        playback, previousRawTime: priorRaw,
        ...(remap === undefined ? {} : { timeRemap: remap }),
        weight, layerOrder: layer.definition.order, actionOrder, blendMode,
        ...(layer.definition.mask === undefined ? {} : { mask: layer.definition.mask }),
      })); return;
    }
    if (motion.kind === 'blend-1d') {
      const value = Number(this._values.get(motion.input)), weights = blend1DWeights(motion.children.map(child => child.threshold), value);
      motion.children.forEach((child, index) => this._sampleMotion(child.motion, time, previous, weight * weights[index]!, layer, actionOrder + index, blendMode, consumed, activeNested, nestedSettled)); return;
    }
    if (motion.kind === 'blend-2d') {
      const weights = blend2DWeights(motion.children.map(child => child.position), [Number(this._values.get(motion.inputX)), Number(this._values.get(motion.inputY))], motion.algorithm);
      motion.children.forEach((child, index) => this._sampleMotion(child.motion, time, previous, weight * weights[index]!, layer, actionOrder + index, blendMode, consumed, activeNested, nestedSettled)); return;
    }
    if (motion.kind === 'blend-additive') {
      this._sampleMotion(motion.base, time, previous, weight, layer, actionOrder, blendMode, consumed, activeNested, nestedSettled);
      motion.children.forEach((child, index) => this._sampleMotion(child.motion, time, previous, weight * clamp(child.weightInput ? Number(this._values.get(child.weightInput)) : child.weight ?? 0, 0, 1), layer, actionOrder + index + 1, 'additive', consumed, activeNested, nestedSettled)); return;
    }
    activeNested.add(motion.component); const instance = this.nestedOwner.acquire(motion.component);
    for (const [port, input] of Object.entries(motion.inputBindings ?? {})) { const definition = this._inputs.get(input)!; if (definition.type === 'trigger') { const fired = this._triggers.has(input); instance.setInput(port, fired); if (fired) { consumed.add(input); this._triggers.delete(input); } } else instance.setInput(port, this._values.get(input)!); }
    const playing = motion.playingInput === undefined || this._values.get(motion.playingInput) === true; if (playing) instance.resume(); else instance.pause();
    const nestedTime = motion.timeRemapInput ? Number(this._values.get(motion.timeRemapInput)) : time * (motion.speed ?? 1), sample = instance.evaluate(nestedTime, playing ? time - previous : 0), mix = motion.mixInput === undefined ? 1 : clamp(Number(this._values.get(motion.mixInput)), 0, 1); nestedSettled.push(sample.settled);
    for (const contribution of sample.contributions) this.mixer.submitContribution({ ...contribution, weight: contribution.weight * weight * mix, layerOrder: layer.definition.order, actionOrder, blendMode });
    for (const effect of sample.effects ?? []) this.mixer.submitEffect(effect);
  }

  private _motionDuration(motion: RuntimeMotion): number {
    if (motion.kind === 'clip') return this.sampler.clip(motion.clip).duration;
    if (motion.kind === 'nested') return 0;
    if (motion.kind === 'blend-additive') return Math.max(this._motionDuration(motion.base), ...motion.children.map(child => this._motionDuration(child.motion)));
    return Math.max(...motion.children.map(child => this._motionDuration(child.motion)));
  }

  private _queueEffects(layerId: string, owner: string, effects: readonly RuntimeEffect[] | undefined, phase: RuntimeEffect['phase']): void {
    for (const [index, effect] of (effects ?? []).entries()) if (effect.phase === phase) { const channel = this._channels.get(effect.channel); if (!channel) throw runtimeError('E_STATE_MACHINE_RUNTIME_REFERENCE', `Unknown effect channel ${effect.channel}.`); this._pendingEffects.push({ id: `${this._machine.id}/${layerId}/${owner}/${index}#${++this._effectSequence}`, channel, clipId: this._machine.id, trackId: owner, keyIndex: index, occurrenceTime: this._clock, payload: effect.payload ?? null }); }
  }

  private _snapshot(): Snapshot { return { clock: this._clock, status: this._status, settled: this._settled, inputs: [...this._values], triggers: [...this._triggers], effectSequence: this._effectSequence, randomState: this._randomState, pendingEffects: [...this._pendingEffects], layers: this._layers.map(layer => ({ stateId: layer.stateId, localTime: layer.localTime, exited: layer.exited, transition: layer.transition ? { ...layer.transition } : null })) }; }
  private _restore(snapshot: Snapshot): void { this._clock = snapshot.clock; this._status = snapshot.status; this._settled = snapshot.settled; this._effectSequence = snapshot.effectSequence; this._randomState = snapshot.randomState; this._pendingEffects.length = 0; this._pendingEffects.push(...snapshot.pendingEffects); this._values.clear(); for (const [id, value] of snapshot.inputs) this._values.set(id, value); this._triggers.clear(); for (const id of snapshot.triggers) this._triggers.add(id); snapshot.layers.forEach((state, index) => { const layer = this._layers[index]!; layer.stateId = state.stateId; layer.localTime = state.localTime; layer.exited = state.exited; layer.transition = state.transition ? { ...state.transition } : null; }); }
  private _random(): number { let value = this._randomState; value ^= value << 13; value ^= value >>> 17; value ^= value << 5; this._randomState = value >>> 0; return this._randomState / 0x1_0000_0000; }
  private _setValue(id: string, value: number | boolean): void { if (!Object.is(this._values.get(id), value)) { this._values.set(id, value); this._settled = false; } }
  private _requireInput(id: string, types: readonly RuntimeInput['type'][]): void { const input = this._inputs.get(id); if (!input || !types.includes(input.type)) throw runtimeError('E_STATE_MACHINE_RUNTIME_INPUT', `Input ${id} must be ${types.join('|')}.`); }
  private _requireActive(): void { if (this._status === 'disposed') throw runtimeError('E_STATE_MACHINE_RUNTIME_DISPOSED', 'State-machine runtime was disposed.'); }
}

function entryTarget(layer: RuntimeLayer): string { const entry = layer.transitions.find(transition => transition.from === '@entry'); if (!entry || entry.to.startsWith('@')) throw runtimeError('E_STATE_MACHINE_RUNTIME_GRAPH', `Layer ${layer.id} has no valid entry transition.`); return entry.to; }
function layerTrace(layer: LayerRuntime): StateMachineLayerTrace { return Object.freeze({ layerId: layer.definition.id, stateId: layer.stateId, localTime: layer.localTime, transitionId: layer.transition?.definition.id ?? null, transitionProgress: layer.transition ? layer.transition.definition.duration === 0 ? 1 : clamp(layer.transition.elapsed / layer.transition.definition.duration, 0, 1) : 0, exited: layer.exited }); }
function compare(left: RuntimeValue, comparator: Comparator, right: RuntimeValue): boolean { if (comparator === 'equal') return valuesEqual(left, right); if (comparator === 'not-equal') return !valuesEqual(left, right); if (typeof left !== 'number' || typeof right !== 'number') return false; if (comparator === 'greater') return left > right; if (comparator === 'greater-or-equal') return left >= right; if (comparator === 'less') return left < right; return left <= right; }
function valuesEqual(left: RuntimeValue, right: RuntimeValue): boolean { if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => Object.is(value, right[index])); return Object.is(left, right); }
function blend1DWeights(thresholds: readonly number[], value: number): number[] { const weights = thresholds.map(() => 0); if (value <= thresholds[0]!) { weights[0] = 1; return weights; } const last = thresholds.length - 1; if (value >= thresholds[last]!) { weights[last] = 1; return weights; } for (let index = 0; index < last; index++) if (value >= thresholds[index]! && value <= thresholds[index + 1]!) { const alpha = (value - thresholds[index]!) / (thresholds[index + 1]! - thresholds[index]!); weights[index] = 1 - alpha; weights[index + 1] = alpha; break; } return weights; }
function blend2DWeights(positions: readonly (readonly [number, number])[], point: readonly [number, number], algorithm: 'cartesian' | 'directional'): number[] { const distances = positions.map(position => { const dx = position[0] - point[0], dy = position[1] - point[1]; if (algorithm === 'cartesian') return Math.hypot(dx, dy); const positionAngle = Math.atan2(position[1], position[0]), pointAngle = Math.atan2(point[1], point[0]), angle = Math.abs(Math.atan2(Math.sin(positionAngle - pointAngle), Math.cos(positionAngle - pointAngle))), magnitude = Math.abs(Math.hypot(...position) - Math.hypot(...point)); return angle + magnitude; }); const exact = distances.findIndex(distance => distance < 1e-9); if (exact >= 0) return distances.map((_, index) => index === exact ? 1 : 0); const inverse = distances.map(distance => 1 / Math.max(distance, 1e-9)), total = inverse.reduce((sum, value) => sum + value, 0); return inverse.map(value => value / total); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function normalizeSeed(value: number): number { if (!Number.isSafeInteger(value)) throw runtimeError('E_STATE_MACHINE_RUNTIME_INPUT', 'randomSeed must be a safe integer.'); const seed = value >>> 0; return seed === 0 ? 0x6d2b79f5 : seed; }
function runtimeError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
