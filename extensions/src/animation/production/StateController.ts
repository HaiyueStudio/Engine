import {HyaStateMachineRuntimeV2, type StateMachineRuntimeOptions, type StateMachineRuntimeStatus} from '../../hya-state-machine/v2/StateMachineRuntime.js';
import type {RuntimeDocument, RuntimeInput, StateMachinePose} from '../../hya-state-machine/v2/runtime-types.js';
import {ProductionFrameError, type ProductionFrameTransport} from './FrameTransaction.js';

interface Candidate {
  readonly runtime: HyaStateMachineRuntimeV2;
  readonly gate: {silent: boolean; ownershipSilent: boolean};
}
interface Prepared {
  readonly candidate: Candidate; readonly raw: StateMachinePose; readonly visible: StateMachinePose;
  readonly frameClock: number; readonly replacing: boolean; readonly seek: number | undefined; readonly status: StateMachineRuntimeStatus; readonly externalTransport: boolean;
  readonly ownershipTransaction: number | undefined;
}
const nestedGenerations = new WeakMap<object, number>();

/** Composition transport adapter. Seeking reuses the original runtime with a fresh fixed-seed state. */
export class ProductionStateController {
  private current: Candidate;
  private preparing: Candidate | undefined;
  private prepared: Prepared | undefined;
  private readonly retired: Candidate[] = [];
  private readonly inputs: readonly RuntimeInput[];
  private transport: StateMachineRuntimeStatus = 'running';
  private requestedSeek: number | undefined;
  private epochValue = 0;
  private ownershipSequence = 0;
  private committedPose: StateMachinePose;
  constructor(private readonly document: RuntimeDocument, private readonly machineId: string,
    private readonly options: StateMachineRuntimeOptions = {},
    private readonly identity: Readonly<{generation: number; part: string; instance: string}> = {generation: 0, part: '', instance: ''}) {
    const machine = document.stateMachines.find(value => value.id === machineId);
    if (!machine) throw new ProductionFrameError('E_HYA_RUNTIME_REFERENCE', machineId, 'state machine is absent');
    this.options = Object.freeze({...options}); this.identity = Object.freeze({...identity});
    this.inputs = machine.inputs; this.current = this.create(false, 0); this.committedPose = this.current.runtime.lastPose;
  }
  get status(): StateMachineRuntimeStatus {return this.transport;}
  get frameClock(): number {return this.prepared?.frameClock ?? (this.preparing ?? this.current).runtime.clock;}
  get clock(): number {return this.current.runtime.clock;}
  get epoch(): number {return this.epochValue;}
  get lastPose(): StateMachinePose {return this.committedPose;}
  get trace(): Readonly<{epoch: number; clock: number; status: StateMachineRuntimeStatus}> {
    return Object.freeze({epoch: this.epochValue, clock: this.clock, status: this.status});
  }
  getInput(id: string): number | boolean {this.live(); return (this.preparing ?? this.current).runtime.getInput(id);}
  setNumber(id: string, value: number): this {this.inputOwner().setNumber(id, value); return this;}
  setBoolean(id: string, value: boolean): this {this.inputOwner().setBoolean(id, value); return this;}
  setTrigger(id: string): this {this.inputOwner().setTrigger(id); return this;}
  resetTrigger(id: string): this {this.inputOwner().resetTrigger(id); return this;}
  /** Changes intent only. Clock, pose and epoch change at the next whole-frame commit. */
  seek(time: number): void {
    this.idle();
    if (!Number.isFinite(time) || time < 0) throw new ProductionFrameError('E_HYA_RUNTIME_TIME', '$.seek', 'seek requires a finite non-negative time');
    this.requestedSeek = time;
  }
  pause(): void {this.idle(); if (this.transport === 'running') {this.current.runtime.pause(); this.transport = 'paused';}}
  resume(): void {this.idle(); if (this.transport !== 'running') {this.current.runtime.resume(); this.transport = 'running';}}
  stop(): void {this.idle(); this.requestedSeek = 0; this.transport = 'stopped';}

  prepareTransportFrame(delta: number, bind: (()=>void) | undefined, transport: ProductionFrameTransport): StateMachinePose {return this.prepareFrame(delta,bind,transport);}
  prepareFrame(delta: number, bind?: () => void, intent?: ProductionFrameTransport): StateMachinePose {
    this.idle();
    if (!Number.isFinite(delta) || delta < 0) throw new ProductionFrameError('E_HYA_RUNTIME_TIME', '$.delta', 'state delta requires a finite non-negative time');
    const seek = intent?.relocation ? intent.time : this.requestedSeek, replacing = seek !== undefined, status = intent?.status ?? this.transport, silent = intent?.relocation !== 'restart';
    if (replacing && !Number.isSafeInteger(this.epochValue + 1)) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.epoch', 'state epoch exhausted');
    const candidate = replacing ? this.create(silent, this.epochValue + 1, true) : this.current;
    if (replacing) {
      for (const input of this.inputs) {
        if (input.type === 'trigger') continue;
        const value = this.current.runtime.getInput(input.id);
        if (input.type === 'boolean') candidate.runtime.setBoolean(input.id, value as boolean);
        else candidate.runtime.setNumber(input.id, value as number);
      }
    }
    this.preparing = candidate;
    let ownershipTransaction: number | undefined;
    try {
      const frameDelta = replacing ? seek : status === 'running' ? delta : 0;
      const frameClock = candidate.runtime.clock + (intent ? frameDelta : candidate.runtime.status === 'running' ? frameDelta : 0);
      const raw = candidate.runtime.prepareFrame(frameDelta, () => {
        bind?.();
        // A seek uses the current committed/bound values, never historical or queued triggers.
        if (replacing) for (const input of this.inputs) if (input.type === 'trigger') candidate.runtime.resetTrigger(input.id);
      }, intent ? {sampling:replacing || status === 'running' ? 'running' : 'paused', committed:intent.status} : undefined);
      if (replacing) {
        const previous = new Map(this.committedPose.channels.map(value => [value.channel.id, value.value]));
        const next = new Map(raw.channels.map(value => [value.channel.id, value.value]));
        const changes = this.document.channels.filter(channel => channel.policy === 'ownership').map(channel => ({channel,
          previous: previous.get(channel.id) ?? channel.defaultValue ?? null, next: next.get(channel.id) ?? channel.defaultValue ?? null,
        })).filter(change => JSON.stringify(change.previous) !== JSON.stringify(change.next));
        if (changes.length) {
          const port = this.options.ownershipPort;
          if (!port) throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT', '$.ownership', 'silent relocation requires an ownership port');
          const transaction = ++this.ownershipSequence;
          port.begin(transaction); ownershipTransaction = transaction;
          for (const change of changes) port.transfer(Object.freeze(change));
        }
      }
      const visible = replacing && silent ? Object.freeze({...raw, effects: Object.freeze([])}) : raw;
      this.prepared = {candidate, raw, visible, frameClock, replacing, seek, status, externalTransport:intent !== undefined, ownershipTransaction}; return visible;
    } catch (error) {
      try {if (ownershipTransaction !== undefined) this.options.ownershipPort!.rollback(ownershipTransaction);}
      finally {if (replacing) candidate.runtime.dispose();}
      throw error;
    } finally {this.preparing = undefined;}
  }
  commitPreparedFrame(pose: StateMachinePose): StateMachinePose {
    const step = this.requirePrepared(pose);
    step.candidate.runtime.commitPreparedFrame(step.raw);
    if (step.ownershipTransaction !== undefined) this.options.ownershipPort!.commit(step.ownershipTransaction);
    this.live();
    if (step.replacing) {
      this.retired.push(this.current); this.current = step.candidate; this.epochValue++;
      this.current.gate.silent = false; this.current.gate.ownershipSilent = false;
      this.requestedSeek = undefined;
      if (!step.externalTransport && this.transport !== 'running') this.current.runtime.pause();
    }
    this.transport = step.status; this.committedPose = step.visible; this.prepared = undefined; return step.visible;
  }
  rollbackPreparedFrame(pose: StateMachinePose): void {
    const step = this.requirePrepared(pose); this.prepared = undefined;
    try {step.candidate.runtime.rollbackPreparedFrame(step.raw);}
    finally {
      try {if (step.ownershipTransaction !== undefined) this.options.ownershipPort!.rollback(step.ownershipTransaction);}
      finally {if (step.replacing) step.candidate.runtime.dispose();}
    }
  }
  /** Retired nested instances are released only after the whole frame has committed. */
  publishPreparedFrame(): void {
    const failures: unknown[] = [];
    for (const value of this.retired.splice(0)) {try {value.runtime.dispose();} catch (error) {failures.push(error);}}
    if (failures.length) throw new AggregateError(failures, 'Retired state instances could not be released');
  }
  dispose(): void {
    if (this.transport === 'disposed') return;
    const step = this.prepared; this.prepared = undefined; this.requestedSeek = undefined;
    this.transport = 'disposed';
    const candidates = new Set([this.current, ...this.retired.splice(0), ...(step?.replacing ? [step.candidate] : []), ...(this.preparing ? [this.preparing] : [])]);
    const failures: unknown[] = [];
    if (step?.ownershipTransaction !== undefined) {try {this.options.ownershipPort!.rollback(step.ownershipTransaction);} catch (error) {failures.push(error);}}
    for (const candidate of candidates) {try {candidate.runtime.dispose();} catch (error) {failures.push(error);}}
    if (failures.length) throw new AggregateError(failures, 'State controller disposal failed');
  }
  private create(silent: boolean, epoch: number, ownershipSilent = silent): Candidate {
    const gate: Candidate['gate'] = {silent, ownershipSilent}, side = this.options.sideEffectPort, ownership = this.options.ownershipPort;
    // Ports belong to the whole composition. A replaced machine must never reset,
    // stop or dispose a host shared by other machines/players.
    const sideEffectPort = side && {
      begin: (id: number) => {if (!gate.silent) side.begin(id);},
      invoke: (effect: Parameters<typeof side.invoke>[0]) => {if (!gate.silent) side.invoke(Object.freeze({...effect,
        id: JSON.stringify([this.identity.generation, epoch, this.identity.part, this.identity.instance, this.machineId, effect.id])}));},
      commit: (id: number) => {if (!gate.silent) side.commit(id);}, rollback: (id: number) => {if (!gate.silent) side.rollback(id);},
      reset() {}, pause() {}, resume() {}, stop() {}, dispose() {},
    };
    const ownershipPort = ownership && {begin: (id: number) => {if (!gate.ownershipSilent) ownership.begin(id);},
      transfer: (change: Parameters<typeof ownership.transfer>[0]) => {if (!gate.ownershipSilent) ownership.transfer(change);},
      commit: (id: number) => {if (!gate.ownershipSilent) ownership.commit(id);}, rollback: (id: number) => {if (!gate.ownershipSilent) ownership.rollback(id);}, reset() {}, dispose() {}};
    const factory = this.options.nestedFactory;
    const nestedFactory = factory && {create: (component: Parameters<typeof factory.create>[0]) => {
      const generation = (nestedGenerations.get(factory) ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.nested.generation', 'nested host generation exhausted');
      // Fresh mixers intentionally rewind their logical counters. Physical host
      // generations remain monotonic, including abandoned candidates and peers.
      nestedGenerations.set(factory, generation); return factory.create(component, generation);
    }};
    const runtime = new HyaStateMachineRuntimeV2(this.document, this.machineId, {...this.options,
      ...(sideEffectPort ? {sideEffectPort} : {}), ...(ownershipPort ? {ownershipPort} : {}), ...(nestedFactory ? {nestedFactory} : {})});
    return {runtime, gate};
  }
  private inputOwner(): HyaStateMachineRuntimeV2 {this.live(); if (this.prepared) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', '$.state', 'state frame is already prepared'); return (this.preparing ?? this.current).runtime;}
  private requirePrepared(pose: StateMachinePose): Prepared {
    this.live(); if (!this.prepared || this.prepared.visible !== pose) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.state', 'state pose identity does not match'); return this.prepared;
  }
  private live(): void {if (this.transport === 'disposed') throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.state', 'state controller is disposed');}
  private idle(): void {this.live(); if (this.preparing || this.prepared) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', '$.state', 'state frame is already active');}
}
