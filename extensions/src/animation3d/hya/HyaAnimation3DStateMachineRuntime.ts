import { ParticleEmitter3D } from '@haiyue/engine/components';
import type { AnimationStateMachineDefinition } from '../../animation-state-machine/AnimationStateMachine.js';
import {
  AnimationStateMachineController,
  compileAnimationStateMachine,
  runAnimationStateMachineControllerUpdateTransaction,
  type AnimationStateMachineActionOptions,
  type AnimationStateMachineMixerPort,
} from '../../animation-state-machine/runtime/index.js';
import type { Animation3DClip } from '../Animation3DClip.js';
import type { Animation3DPose } from '../Animation3DPose.js';
import { Animation3DPoseBuffer } from '../Animation3DPoseBuffer.js';
import type { Animation3DStateMachineDefinition } from '../Animation3DStateMachine.js';
import {
  Animation3DStateMachineMixerAdapter,
  type Animation3DStateMachineActionRuntimeHandle,
} from '../runtime/integration/Animation3DStateMachineMixerAdapter.js';
import { Animation3DMixerRuntime } from '../runtime/mixer/Mixer.js';

const TIME_EPSILON = 1e-9;

export interface HyaAnimation3DStateMachinePartition {
  readonly id: string;
  readonly mixer: Animation3DMixerRuntime;
  readonly clips: ReadonlyMap<string, Animation3DClip>;
  /** Maps authored HYA binding ids to a model runtime's source binding ids. */
  readonly bindingIds?: ReadonlyMap<string, string>;
  readonly pose?: Animation3DPoseBuffer;
  readonly apply: (pose: Animation3DPose) => void;
}

export interface HyaAnimation3DParticleCue {
  readonly key: string;
  readonly emitter: ParticleEmitter3D;
  readonly start: number;
  readonly end: number;
}

export interface HyaAnimation3DStateMachineRuntimeOptions {
  readonly definition: AnimationStateMachineDefinition | Animation3DStateMachineDefinition;
  readonly clips: readonly Animation3DClip[];
  readonly partitions: readonly HyaAnimation3DStateMachinePartition[];
  readonly particleCues?: ReadonlyMap<string, readonly HyaAnimation3DParticleCue[]>;
}

interface PartitionRuntime {
  readonly id: string;
  readonly mixer: Animation3DMixerRuntime;
  readonly adapter: Animation3DStateMachineMixerAdapter;
  readonly clips: ReadonlyMap<string, Animation3DClip>;
  readonly bindingIds: ReadonlyMap<string, string> | undefined;
  readonly pose: Animation3DPoseBuffer;
  readonly apply: (pose: Animation3DPose) => void;
  previousTime: number;
  frameCompleted: boolean;
}

interface ParticleCommand {
  readonly key: string;
  readonly kind: 'start' | 'stop';
}

interface GroupCheckpoint {
  readonly targetTime: number;
  readonly traversal: number;
  readonly playing: boolean;
  readonly activeCueKeys: ReadonlySet<string>;
}

export class HyaAnimation3DStateMachineActionHandle {
  readonly children: readonly Animation3DStateMachineActionRuntimeHandle[];
  readonly activeCueKeys = new Set<string>();
  targetTime = 0;
  traversal = 0;
  playing = false;
  destroyed = false;
  pendingDestroy = false;

  constructor(
    readonly id: string,
    readonly clipId: string,
    readonly duration: number,
    readonly loop: AnimationStateMachineActionOptions['loop'],
    children: readonly Animation3DStateMachineActionRuntimeHandle[],
  ) {
    this.children = Object.freeze([...children]);
  }
}

/**
 * One controller-facing port spanning the scene mixer and every loaded model
 * mixer. It is the only state-machine clock; child adapters only synchronize
 * existing mixer actions and participate in the same rollback boundary.
 */
class HyaAnimation3DStateMachineMixerPort implements
  AnimationStateMachineMixerPort<HyaAnimation3DStateMachineActionHandle> {
  private readonly _clips = new Map<string, Animation3DClip>();
  private readonly _particles = new Map<string, ParticleEmitter3D>();
  private readonly _owners = new Map<string, string[]>();
  private readonly _handles = new Set<HyaAnimation3DStateMachineActionHandle>();
  private readonly _transactionCreated: HyaAnimation3DStateMachineActionHandle[] = [];
  private readonly _transactionPendingDestroy: HyaAnimation3DStateMachineActionHandle[] = [];
  private readonly _transactionCheckpoints = new Map<HyaAnimation3DStateMachineActionHandle, GroupCheckpoint>();
  private readonly _transactionCommands: ParticleCommand[] = [];
  private _transactionOwners = new Map<string, string[]>();
  private _nextHandleId = 1;
  private _transactionNextHandleId = 1;
  private _transactionActive = false;
  private _destroyed = false;

  constructor(
    readonly partitions: readonly PartitionRuntime[],
    clips: readonly Animation3DClip[],
    private readonly _particleCues: ReadonlyMap<string, readonly HyaAnimation3DParticleCue[]>,
  ) {
    for (const clip of clips) this._clips.set(clip.id, clip);
    for (const cues of _particleCues.values()) {
      for (const cue of cues) this._particles.set(cue.key, cue.emitter);
    }
  }

  get liveActionCount(): number { return this._handles.size; }

  get sideEffectOwnerCount(): number {
    let count = 0;
    for (const owners of this._owners.values()) count += owners.length;
    return count;
  }

  createAction(
    clipId: string,
    options: AnimationStateMachineActionOptions,
  ): HyaAnimation3DStateMachineActionHandle {
    this._requireActive();
    const clip = this._clips.get(clipId);
    if (!clip) throw new RangeError(`Unknown HYA Animation3D state-machine clip "${clipId}".`);
    const children: Animation3DStateMachineActionRuntimeHandle[] = [];
    try {
      for (const partition of this.partitions) {
        if (partition.clips.has(clipId)) {
          children.push(partition.adapter.createAction(
            clipId,
            translateActionOptions(options, partition.bindingIds),
          ));
        }
      }
    } catch (error) {
      let childIndex = 0;
      for (const partition of this.partitions) {
        if (!partition.clips.has(clipId) || childIndex >= children.length) continue;
        partition.adapter.destroyAction(children[childIndex++]!);
      }
      throw error;
    }
    const handle = new HyaAnimation3DStateMachineActionHandle(
      `hya-animation3d-state-machine:${this._nextHandleId++}`,
      clipId,
      clip.duration,
      options.loop,
      children,
    );
    this._handles.add(handle);
    if (this._transactionActive) this._transactionCreated.push(handle);
    return handle;
  }

  play(handle: HyaAnimation3DStateMachineActionHandle): void {
    this._requireHandle(handle);
    forEachChild(this.partitions, handle, (adapter, child) => adapter.play(child));
    if (handle.playing) return;
    handle.playing = true;
    this._syncParticleCues(handle, true);
  }

  stop(handle: HyaAnimation3DStateMachineActionHandle): void {
    this._requireHandle(handle);
    forEachChild(this.partitions, handle, (adapter, child) => adapter.stop(child));
    if (!handle.playing) return;
    handle.playing = false;
    this._releaseAllParticleCues(handle);
  }

  fade(
    handle: HyaAnimation3DStateMachineActionHandle,
    targetWeight: number,
    durationSeconds: number,
  ): void {
    this._requireHandle(handle);
    forEachChild(this.partitions, handle, (adapter, child) => adapter.fade(child, targetWeight, durationSeconds));
  }

  setWeight(handle: HyaAnimation3DStateMachineActionHandle, weight: number): void {
    this._requireHandle(handle);
    forEachChild(this.partitions, handle, (adapter, child) => adapter.setWeight(child, weight));
  }

  setTime(handle: HyaAnimation3DStateMachineActionHandle, timeSeconds: number): void {
    this._requireHandle(handle);
    forEachChild(this.partitions, handle, (adapter, child) => adapter.setTime(child, timeSeconds));
    const previousTraversal = handle.traversal;
    const position = playbackPosition(timeSeconds, handle.duration, handle.loop);
    handle.targetTime = timeSeconds;
    handle.traversal = position.traversal;
    if (!handle.playing) return;
    this._syncParticleCues(handle, false, position.localTime);
    if (position.traversal !== previousTraversal) this._restartDominantParticleCues(handle);
  }

  setTimeScale(handle: HyaAnimation3DStateMachineActionHandle, timeScale: number): void {
    this._requireHandle(handle);
    forEachChild(this.partitions, handle, (adapter, child) => adapter.setTimeScale(child, timeScale));
  }

  destroyAction(handle: HyaAnimation3DStateMachineActionHandle): void {
    if (handle.destroyed) return;
    this._requireHandle(handle);
    if (handle.playing) {
      handle.playing = false;
      this._releaseAllParticleCues(handle);
    }
    forEachChild(this.partitions, handle, (adapter, child) => adapter.destroyAction(child));
    if (this._transactionActive) {
      if (!handle.pendingDestroy) {
        handle.pendingDestroy = true;
        this._transactionPendingDestroy.push(handle);
      }
      return;
    }
    this._destroyGroupNow(handle);
  }

  beginControllerTransaction(): void {
    this._requireActive();
    if (this._transactionActive) throw new Error('HYA Animation3D state-machine transaction is already active.');
    this._transactionActive = true;
    this._transactionCreated.length = 0;
    this._transactionPendingDestroy.length = 0;
    this._transactionCheckpoints.clear();
    this._transactionCommands.length = 0;
    this._transactionOwners = cloneOwners(this._owners);
    this._transactionNextHandleId = this._nextHandleId;
    for (const handle of this._handles) {
      this._transactionCheckpoints.set(handle, {
        targetTime: handle.targetTime,
        traversal: handle.traversal,
        playing: handle.playing,
        activeCueKeys: new Set(handle.activeCueKeys),
      });
    }
    const begun: Animation3DStateMachineMixerAdapter[] = [];
    try {
      for (const partition of this.partitions) {
        partition.adapter.beginControllerTransaction();
        begun.push(partition.adapter);
      }
    } catch (error) {
      for (let index = begun.length - 1; index >= 0; index--) begun[index]!.rollbackControllerTransaction();
      this._transactionActive = false;
      this._clearTransaction();
      throw error;
    }
  }

  commitControllerTransaction(): void {
    if (!this._transactionActive) throw new Error('HYA Animation3D state-machine has no active transaction.');
    for (const partition of this.partitions) partition.adapter.commitControllerTransaction();
    this._transactionActive = false;
    for (const command of this._transactionCommands) this._applyParticleCommand(command);
    for (const handle of this._transactionPendingDestroy) this._destroyGroupNow(handle);
    this._clearTransaction();
  }

  rollbackControllerTransaction(): void {
    if (!this._transactionActive) return;
    this._transactionActive = false;
    for (let index = this.partitions.length - 1; index >= 0; index--) {
      this.partitions[index]!.adapter.rollbackControllerTransaction();
    }
    for (const handle of this._transactionCreated) {
      handle.destroyed = true;
      this._handles.delete(handle);
    }
    for (const [handle, checkpoint] of this._transactionCheckpoints) {
      if (handle.destroyed) continue;
      handle.targetTime = checkpoint.targetTime;
      handle.traversal = checkpoint.traversal;
      handle.playing = checkpoint.playing;
      handle.pendingDestroy = false;
      handle.activeCueKeys.clear();
      for (const key of checkpoint.activeCueKeys) handle.activeCueKeys.add(key);
    }
    this._owners.clear();
    for (const [key, owners] of this._transactionOwners) this._owners.set(key, [...owners]);
    this._nextHandleId = this._transactionNextHandleId;
    this._clearTransaction();
  }

  destroy(): void {
    if (this._destroyed) return;
    this.rollbackControllerTransaction();
    for (const handle of [...this._handles]) {
      if (handle.playing) this.stop(handle);
      forEachChild(this.partitions, handle, (adapter, child) => adapter.destroyAction(child));
      this._destroyGroupNow(handle);
    }
    for (const partition of this.partitions) partition.adapter.destroy();
    for (const emitter of this._particles.values()) stopParticle(emitter);
    this._owners.clear();
    this._destroyed = true;
  }

  private _syncParticleCues(
    handle: HyaAnimation3DStateMachineActionHandle,
    entering: boolean,
    localTime = playbackPosition(handle.targetTime, handle.duration, handle.loop).localTime,
  ): void {
    for (const cue of this._particleCues.get(handle.clipId) ?? []) {
      const active = particleCueActive(cue, localTime, handle.duration);
      const owned = handle.activeCueKeys.has(cue.key);
      if (active && !owned) this._acquireParticleCue(handle, cue);
      else if (!active && owned) this._releaseParticleCue(handle, cue.key);
      else if (entering && active && owned) this._recordParticleCommand({ key: cue.key, kind: 'start' });
    }
  }

  private _acquireParticleCue(
    handle: HyaAnimation3DStateMachineActionHandle,
    cue: HyaAnimation3DParticleCue,
  ): void {
    handle.activeCueKeys.add(cue.key);
    const owners = this._owners.get(cue.key) ?? [];
    if (!this._owners.has(cue.key)) this._owners.set(cue.key, owners);
    const existing = owners.indexOf(handle.id);
    if (existing >= 0) owners.splice(existing, 1);
    owners.push(handle.id);
    this._recordParticleCommand({ key: cue.key, kind: 'start' });
  }

  private _releaseParticleCue(handle: HyaAnimation3DStateMachineActionHandle, key: string): void {
    handle.activeCueKeys.delete(key);
    const owners = this._owners.get(key);
    if (!owners) return;
    const index = owners.indexOf(handle.id);
    const wasDominant = index === owners.length - 1;
    if (index >= 0) owners.splice(index, 1);
    if (owners.length === 0) {
      this._owners.delete(key);
      this._recordParticleCommand({ key, kind: 'stop' });
    } else if (wasDominant) this._recordParticleCommand({ key, kind: 'start' });
  }

  private _releaseAllParticleCues(handle: HyaAnimation3DStateMachineActionHandle): void {
    for (const key of [...handle.activeCueKeys]) this._releaseParticleCue(handle, key);
  }

  private _restartDominantParticleCues(handle: HyaAnimation3DStateMachineActionHandle): void {
    for (const key of handle.activeCueKeys) {
      const owners = this._owners.get(key);
      if (owners?.[owners.length - 1] === handle.id) this._recordParticleCommand({ key, kind: 'start' });
    }
  }

  private _recordParticleCommand(command: ParticleCommand): void {
    if (this._transactionActive) this._transactionCommands.push(command);
    else this._applyParticleCommand(command);
  }

  private _applyParticleCommand(command: ParticleCommand): void {
    const emitter = this._particles.get(command.key);
    if (!emitter) return;
    if (command.kind === 'stop') stopParticle(emitter);
    else {
      emitter.emitting = true;
      emitter.restart(true);
      emitter.playing = true;
    }
  }

  private _destroyGroupNow(handle: HyaAnimation3DStateMachineActionHandle): void {
    handle.playing = false;
    handle.pendingDestroy = false;
    handle.destroyed = true;
    handle.activeCueKeys.clear();
    this._handles.delete(handle);
  }

  private _clearTransaction(): void {
    this._transactionCreated.length = 0;
    this._transactionPendingDestroy.length = 0;
    this._transactionCheckpoints.clear();
    this._transactionCommands.length = 0;
    this._transactionOwners.clear();
  }

  private _requireHandle(handle: HyaAnimation3DStateMachineActionHandle): void {
    this._requireActive();
    if (handle.destroyed || !this._handles.has(handle)) {
      throw new Error('HYA Animation3D state-machine action is no longer valid.');
    }
  }

  private _requireActive(): void {
    if (this._destroyed) throw new Error('HYA Animation3D state-machine mixer port has been destroyed.');
  }
}

/** Coordinates native scene, glTF model and Particle3D channels with one controller transaction. */
export class HyaAnimation3DStateMachineRuntime {
  readonly controller!: AnimationStateMachineController<HyaAnimation3DStateMachineActionHandle>;
  private readonly _partitions: readonly PartitionRuntime[];
  private readonly _port: HyaAnimation3DStateMachineMixerPort;
  private _time = 0;
  private _destroyed = false;

  constructor(options: HyaAnimation3DStateMachineRuntimeOptions) {
    this._partitions = Object.freeze(options.partitions.map(partition => {
      const resolver = { resolve: (clipId: string): Animation3DClip | null => partition.clips.get(clipId) ?? null };
      return {
        id: partition.id,
        mixer: partition.mixer,
        adapter: new Animation3DStateMachineMixerAdapter(partition.mixer, resolver),
        clips: partition.clips,
        bindingIds: partition.bindingIds,
        pose: partition.pose ?? new Animation3DPoseBuffer(),
        apply: partition.apply,
        previousTime: 0,
        frameCompleted: false,
      } satisfies PartitionRuntime;
    }));
    this._port = new HyaAnimation3DStateMachineMixerPort(
      this._partitions,
      options.clips,
      options.particleCues ?? new Map(),
    );
    try {
      this.controller = new AnimationStateMachineController(
        compileAnimationStateMachine(options.definition),
        this._port,
      );
      this.evaluate();
    } catch (error) {
      this.controller?.destroy();
      this._port.destroy();
      this._destroyed = true;
      throw error;
    }
  }

  get time(): number { return this._time; }
  get liveActionCount(): number { return this._port.liveActionCount; }
  get liveBindingCount(): number {
    let count = 0;
    for (const partition of this._partitions) count += partition.mixer.liveBindingCount;
    return count;
  }
  get sideEffectOwnerCount(): number { return this._port.sideEffectOwnerCount; }

  update(deltaSeconds: number): void {
    this._requireActive();
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('HYA Animation3D state-machine deltaSeconds must be finite and non-negative.');
    }
    this._runFrame(deltaSeconds);
  }

  evaluate(): void {
    this._requireActive();
    this._runFrame(0);
  }

  reset(): void {
    this._requireActive();
    this.controller.reset();
    this._time = 0;
    this.evaluate();
  }

  destroy(): void {
    if (this._destroyed) return;
    this.controller.destroy();
    this._port.destroy();
    this._destroyed = true;
  }

  private _runFrame(deltaSeconds: number): void {
    const nextTime = this._time + deltaSeconds;
    this._openFrames(nextTime);
    let poses: readonly Animation3DPose[];
    try {
      poses = runAnimationStateMachineControllerUpdateTransaction(
        this.controller,
        deltaSeconds,
        () => {
          for (const partition of this._partitions) partition.adapter.beginFrame(partition.pose);
        },
        () => {
          for (const partition of this._partitions) partition.adapter.endFrame(partition.pose);
          const result: Animation3DPose[] = [];
          for (const partition of this._partitions) {
            result.push(partition.mixer.endSynchronizedFrame(partition.pose));
            partition.frameCompleted = true;
          }
          return result;
        },
      );
    } catch (error) {
      this._cancelFrames();
      throw error;
    }
    for (const partition of this._partitions) partition.frameCompleted = false;
    this._time = nextTime;
    for (let index = 0; index < this._partitions.length; index++) {
      this._partitions[index]!.apply(poses[index]!);
    }
  }

  private _openFrames(time: number): void {
    const opened: PartitionRuntime[] = [];
    try {
      for (const partition of this._partitions) {
        partition.previousTime = partition.mixer.time;
        partition.frameCompleted = false;
        partition.mixer.beginSynchronizedFrame(time, partition.pose);
        opened.push(partition);
      }
    } catch (error) {
      for (let index = opened.length - 1; index >= 0; index--) {
        opened[index]!.mixer.cancelSynchronizedFrame(opened[index]!.pose);
      }
      throw error;
    }
  }

  private _cancelFrames(): void {
    for (const partition of this._partitions) partition.adapter.cancelFrame(partition.pose);
    for (let index = this._partitions.length - 1; index >= 0; index--) {
      const partition = this._partitions[index]!;
      if (partition.frameCompleted) {
        partition.mixer.rollbackCompletedSynchronizedFrame(partition.previousTime);
        partition.frameCompleted = false;
      } else partition.mixer.cancelSynchronizedFrame(partition.pose);
    }
  }

  private _requireActive(): void {
    if (this._destroyed) throw new Error('HYA Animation3D state-machine runtime has been destroyed.');
  }
}

function forEachChild(
  partitions: readonly PartitionRuntime[],
  handle: HyaAnimation3DStateMachineActionHandle,
  visit: (adapter: Animation3DStateMachineMixerAdapter, child: Animation3DStateMachineActionRuntimeHandle) => void,
): void {
  let childIndex = 0;
  for (const partition of partitions) {
    if (!partition.clips.has(handle.clipId)) continue;
    visit(partition.adapter, handle.children[childIndex++]!);
  }
}

function cloneOwners(source: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, owners] of source) result.set(key, [...owners]);
  return result;
}

function translateActionOptions(
  options: AnimationStateMachineActionOptions,
  bindingIds: ReadonlyMap<string, string> | undefined,
): AnimationStateMachineActionOptions {
  if (!options.mask || !bindingIds || bindingIds.size === 0) return options;
  const translate = (ids: readonly string[] | undefined): readonly string[] | undefined => {
    if (!ids) return undefined;
    return Object.freeze(ids.map(id => bindingIds.get(id) ?? id));
  };
  const include = translate(options.mask.include);
  const exclude = translate(options.mask.exclude);
  return {
    ...options,
    mask: Object.freeze({
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
    }),
  };
}

function playbackPosition(
  time: number,
  duration: number,
  loop: AnimationStateMachineActionOptions['loop'],
): { readonly localTime: number; readonly traversal: number } {
  if (duration <= TIME_EPSILON || loop === 'once') {
    return { localTime: Math.min(duration, Math.max(0, time)), traversal: 0 };
  }
  const traversal = Math.floor(time / duration);
  let localTime = time - traversal * duration;
  if (localTime < 0) localTime += duration;
  if (loop === 'ping-pong' && Math.abs(traversal % 2) === 1) localTime = duration - localTime;
  return { localTime, traversal };
}

function particleCueActive(
  cue: HyaAnimation3DParticleCue,
  time: number,
  duration: number,
): boolean {
  const atTerminalEnd = Math.abs(cue.end - duration) <= TIME_EPSILON
    && Math.abs(time - duration) <= TIME_EPSILON;
  return time >= cue.start - TIME_EPSILON
    && (time < cue.end - TIME_EPSILON || atTerminalEnd);
}

function stopParticle(emitter: ParticleEmitter3D): void {
  emitter.playing = false;
  emitter.emitting = false;
  emitter.clear();
}
