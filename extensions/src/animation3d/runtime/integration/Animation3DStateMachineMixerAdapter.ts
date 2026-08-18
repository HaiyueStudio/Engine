import type { Animation3DClip } from '../../Animation3DClip.js';
import { Animation3DError } from '../../Animation3DError.js';
import type { Animation3DMutablePose } from '../../Animation3DPose.js';
import type {
  AnimationStateMachineActionOptions,
  AnimationStateMachineMixerPort,
} from '../../../animation-state-machine/runtime/AnimationStateMachineMixerPort.js';
import {
  Animation3DActionRuntime,
  type Animation3DActionSynchronizedState,
} from '../mixer/Action.js';
import { Animation3DMixerRuntime } from '../mixer/Mixer.js';

let nextAdapterId = 1;

/**
 * Resolves the serializable clip ids stored in state-machine definitions.
 * Returned clips remain resolver/caller-owned.
 */
export interface Animation3DStateMachineClipResolver {
  resolve(clipId: string): Animation3DClip | null;
}

export class Animation3DStateMachineActionRuntimeHandle {
  readonly duration: number;
  readonly clipId: string;
  readonly layerId: string;
  readonly stateId: string;
  readonly action: Animation3DActionRuntime;

  targetTime = 0;
  appliedTime = 0;
  playing = false;
  destroyed = false;
  pendingDestroy = false;

  private readonly _actionCheckpoint: Animation3DActionSynchronizedState;
  private _checkpointTargetTime = 0;
  private _checkpointAppliedTime = 0;
  private _checkpointPlaying = false;

  constructor(
    clipId: string,
    options: AnimationStateMachineActionOptions,
    action: Animation3DActionRuntime,
  ) {
    this.duration = action.clip.duration;
    this.clipId = clipId;
    this.layerId = options.layerId;
    this.stateId = options.stateId;
    this.action = action;
    this._actionCheckpoint = action.createSynchronizedState();
  }

  captureTransactionState(): void {
    this._checkpointTargetTime = this.targetTime;
    this._checkpointAppliedTime = this.appliedTime;
    this._checkpointPlaying = this.playing;
    this.action.captureSynchronizedState(this._actionCheckpoint);
  }

  restoreTransactionState(): void {
    this.targetTime = this._checkpointTargetTime;
    this.appliedTime = this._checkpointAppliedTime;
    this.playing = this._checkpointPlaying;
    this.pendingDestroy = false;
    this.action.restoreSynchronizedState(this._actionCheckpoint);
  }
}

/**
 * Adapts the dimension-neutral state-machine port to the real 3D mixer.
 *
 * The controller owns every action playhead. The adapter applies its absolute
 * times to actions while a synchronized mixer frame is open; it never calls
 * mixer.update(), so the mixer clock cannot advance the same actions again.
 */
export class Animation3DStateMachineMixerAdapter implements
  AnimationStateMachineMixerPort<Animation3DStateMachineActionRuntimeHandle> {
  readonly mixer: Animation3DMixerRuntime;
  readonly clipResolver: Animation3DStateMachineClipResolver;

  private readonly _handles = new Set<Animation3DStateMachineActionRuntimeHandle>();
  private readonly _transactionHandles: Animation3DStateMachineActionRuntimeHandle[] = [];
  private readonly _transactionCreated: Animation3DStateMachineActionRuntimeHandle[] = [];
  private readonly _transactionPendingDestroy: Animation3DStateMachineActionRuntimeHandle[] = [];
  private readonly _actionIdPrefix: string;
  private _nextActionId = 1;
  private _transactionNextActionId = 1;
  private _frameOut: Animation3DMutablePose | null = null;
  private _controllerTransactionActive = false;
  private _destroyed = false;

  constructor(
    mixer: Animation3DMixerRuntime,
    clipResolver: Animation3DStateMachineClipResolver,
  ) {
    this.mixer = mixer;
    this.clipResolver = clipResolver;
    this._actionIdPrefix = `animation3d-state-machine:${nextAdapterId++}`;
  }

  get liveActionCount(): number {
    return this._handles.size;
  }

  createAction(
    clipId: string,
    options: AnimationStateMachineActionOptions,
  ): Animation3DStateMachineActionRuntimeHandle {
    this._requireActive();
    const clip = this.clipResolver.resolve(clipId);
    if (!clip) {
      throw new Animation3DError(
        'resolver-miss',
        `Animation3D clip resolver could not resolve "${clipId}".`,
        { resolver: 'clip', clipId },
      );
    }
    const action = this.mixer.createAction(clip, {
      id: `${this._actionIdPrefix}:${this._nextActionId++}`,
      loop: options.loop,
      repetitions: options.loop === 'once' ? 1 : Infinity,
      clampWhenFinished: true,
      weight: 0,
      blendMode: options.blendMode,
      ...(options.mask ? { mask: options.mask } : {}),
    }) as Animation3DActionRuntime;
    const handle = new Animation3DStateMachineActionRuntimeHandle(
      clipId,
      options,
      action,
    );
    this._handles.add(handle);
    if (this._controllerTransactionActive) this._transactionCreated.push(handle);
    return handle;
  }

  play(action: Animation3DStateMachineActionRuntimeHandle): void {
    this._requireHandle(action);
    action.action.play();
    action.playing = true;
  }

  stop(action: Animation3DStateMachineActionRuntimeHandle): void {
    this._requireHandle(action);
    action.action.stop();
    action.playing = false;
  }

  fade(
    action: Animation3DStateMachineActionRuntimeHandle,
    _targetWeight: number,
    _durationSeconds: number,
  ): void {
    this._requireHandle(action);
    // The controller computes exact source/destination weights for every
    // transition segment. Scheduling an action-local fade here would multiply
    // that weight and introduce a second transition clock.
  }

  setWeight(
    action: Animation3DStateMachineActionRuntimeHandle,
    weight: number,
  ): void {
    this._requireHandle(action);
    action.action.weight = weight;
  }

  setTime(
    action: Animation3DStateMachineActionRuntimeHandle,
    timeSeconds: number,
  ): void {
    this._requireHandle(action);
    action.targetTime = timeSeconds;
    if (!action.playing) {
      action.action.seekSynchronizedTime(timeSeconds);
      action.appliedTime = timeSeconds;
      return;
    }
    if (this._frameOut) this._applyTime(action, this._frameOut);
  }

  setTimeScale(
    action: Animation3DStateMachineActionRuntimeHandle,
    timeScale: number,
  ): void {
    this._requireHandle(action);
    action.action.timeScale = timeScale;
  }

  destroyAction(action: Animation3DStateMachineActionRuntimeHandle): void {
    if (action.destroyed) return;
    if (!this._handles.has(action)) {
      throw new Error('Animation3D state-machine action belongs to another adapter.');
    }
    if (this._controllerTransactionActive) {
      if (action.pendingDestroy) return;
      action.pendingDestroy = true;
      this._transactionPendingDestroy.push(action);
      return;
    }
    this._destroyHandleNow(action);
  }

  /** @internal Called by the shared controller transaction boundary. */
  beginControllerTransaction(): void {
    this._requireActive();
    if (this._controllerTransactionActive) {
      throw new Error('Animation3D state-machine adapter transaction is already active.');
    }
    this._controllerTransactionActive = true;
    this._transactionNextActionId = this._nextActionId;
    this._transactionHandles.length = 0;
    this._transactionCreated.length = 0;
    this._transactionPendingDestroy.length = 0;
    for (const handle of this._handles) {
      handle.captureTransactionState();
      this._transactionHandles.push(handle);
    }
  }

  /** @internal Makes deferred action destruction observable atomically. */
  commitControllerTransaction(): void {
    if (!this._controllerTransactionActive) {
      throw new Error('Animation3D state-machine adapter has no active transaction.');
    }
    this._controllerTransactionActive = false;
    for (let index = 0; index < this._transactionPendingDestroy.length; index++) {
      this._destroyHandleNow(this._transactionPendingDestroy[index]!);
    }
    this._clearControllerTransaction();
  }

  /** @internal Removes new actions and restores exact event/playhead state. */
  rollbackControllerTransaction(): void {
    if (!this._controllerTransactionActive) return;
    this._controllerTransactionActive = false;
    for (let index = this._transactionCreated.length - 1; index >= 0; index--) {
      this._destroyHandleNow(this._transactionCreated[index]!);
    }
    for (let index = 0; index < this._transactionHandles.length; index++) {
      const handle = this._transactionHandles[index]!;
      if (!handle.destroyed) handle.restoreTransactionState();
    }
    this._nextActionId = this._transactionNextActionId;
    this._clearControllerTransaction();
  }

  beginFrame(out: Animation3DMutablePose): void {
    this._requireActive();
    if (this._frameOut) {
      throw new Error('Animation3D state-machine adapter already has an active frame.');
    }
    this._frameOut = out;
    for (const handle of this._handles) {
      if (handle.playing) this._applyTime(handle, out);
    }
  }

  endFrame(out: Animation3DMutablePose): void {
    if (this._frameOut !== out) {
      throw new Error('Animation3D state-machine adapter output does not match its active frame.');
    }
    this._frameOut = null;
  }

  cancelFrame(out: Animation3DMutablePose): void {
    if (this._frameOut === out) this._frameOut = null;
  }

  /**
   * Releases adapter-created actions only. The mixer, clips, and clip resolver
   * are externally owned and are never destroyed by this adapter.
   */
  destroy(): void {
    if (this._destroyed) return;
    this.rollbackControllerTransaction();
    this._frameOut = null;
    for (const handle of this._handles) this._destroyHandleNow(handle);
    this._destroyed = true;
  }

  private _applyTime(
    handle: Animation3DStateMachineActionRuntimeHandle,
    out: Animation3DMutablePose,
  ): void {
    handle.action.synchronizeTime(handle.targetTime, out);
    handle.appliedTime = handle.targetTime;
  }

  private _destroyHandleNow(action: Animation3DStateMachineActionRuntimeHandle): void {
    if (action.destroyed) return;
    if (action.playing) action.action.stop();
    this.mixer.removeAction(action.action);
    action.playing = false;
    action.pendingDestroy = false;
    action.destroyed = true;
    this._handles.delete(action);
  }

  private _clearControllerTransaction(): void {
    for (let index = 0; index < this._transactionPendingDestroy.length; index++) {
      this._transactionPendingDestroy[index]!.pendingDestroy = false;
    }
    this._transactionHandles.length = 0;
    this._transactionCreated.length = 0;
    this._transactionPendingDestroy.length = 0;
  }

  private _requireActive(): void {
    if (this._destroyed) {
      throw new Error('Animation3D state-machine mixer adapter has been destroyed.');
    }
  }

  private _requireHandle(
    handle: Animation3DStateMachineActionRuntimeHandle,
  ): void {
    this._requireActive();
    if (handle.destroyed || !this._handles.has(handle)) {
      throw new Error('Animation3D state-machine action is no longer valid.');
    }
  }
}
