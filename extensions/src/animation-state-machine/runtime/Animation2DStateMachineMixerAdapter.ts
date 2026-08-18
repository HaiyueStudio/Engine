import {
  Animation2DActionRuntime,
  type Animation2DActionSynchronizedState,
} from '../../animation/runtime/mixer/Action.js';
import { Animation2DMixerRuntime } from '../../animation/runtime/mixer/Mixer.js';
import type {
  AnimationStateMachineActionOptions,
  AnimationStateMachineMixerPort,
} from './AnimationStateMachineMixerPort.js';

export class Animation2DStateMachineActionRuntimeHandle {
  readonly duration: number;
  readonly clipId: string;
  readonly action: Animation2DActionRuntime;

  targetTime = 0;
  playing = false;
  destroyed = false;
  pendingDestroy = false;

  private readonly _checkpoint: Animation2DActionSynchronizedState;
  private _checkpointTargetTime = 0;
  private _checkpointPlaying = false;

  constructor(clipId: string, action: Animation2DActionRuntime) {
    this.duration = action.duration;
    this.clipId = clipId;
    this.action = action;
    this._checkpoint = action.createSynchronizedState();
  }

  captureTransactionState(): void {
    this._checkpointTargetTime = this.targetTime;
    this._checkpointPlaying = this.playing;
    this.action.captureSynchronizedState(this._checkpoint);
  }

  restoreTransactionState(): void {
    this.targetTime = this._checkpointTargetTime;
    this.playing = this._checkpointPlaying;
    this.pendingDestroy = false;
    this.action.restoreSynchronizedState(this._checkpoint);
  }
}

/**
 * Transactional state-machine owner for the existing 2D mixer. It never
 * samples tracks itself: absolute controller playheads are synchronized into
 * the mixer actions, and the caller evaluates the ordinary shared pose buffer.
 */
export class Animation2DStateMachineMixerAdapter implements
  AnimationStateMachineMixerPort<Animation2DStateMachineActionRuntimeHandle> {
  private readonly _handles = new Set<Animation2DStateMachineActionRuntimeHandle>();
  private readonly _transactionHandles: Animation2DStateMachineActionRuntimeHandle[] = [];
  private readonly _transactionCreated: Animation2DStateMachineActionRuntimeHandle[] = [];
  private readonly _transactionPendingDestroy: Animation2DStateMachineActionRuntimeHandle[] = [];
  private _transactionActive = false;
  private _destroyed = false;

  constructor(readonly mixer: Animation2DMixerRuntime) {}

  get liveActionCount(): number { return this._handles.size; }
  get liveBindingCount(): number { return this.mixer.liveBindingCount; }

  createAction(
    clipId: string,
    options: AnimationStateMachineActionOptions,
  ): Animation2DStateMachineActionRuntimeHandle {
    this._requireActive();
    const handle = new Animation2DStateMachineActionRuntimeHandle(
      clipId,
      this.mixer.createAction(clipId, options),
    );
    this._handles.add(handle);
    if (this._transactionActive) this._transactionCreated.push(handle);
    return handle;
  }

  play(handle: Animation2DStateMachineActionRuntimeHandle): void {
    this._requireHandle(handle);
    this.mixer.play(handle.action);
    handle.playing = true;
  }

  stop(handle: Animation2DStateMachineActionRuntimeHandle): void {
    this._requireHandle(handle);
    this.mixer.stop(handle.action);
    handle.playing = false;
  }

  fade(
    handle: Animation2DStateMachineActionRuntimeHandle,
    _targetWeight: number,
    _durationSeconds: number,
  ): void {
    this._requireHandle(handle);
    // The controller is the unique transition clock and applies exact weights.
  }

  setWeight(handle: Animation2DStateMachineActionRuntimeHandle, weight: number): void {
    this._requireHandle(handle);
    this.mixer.setWeight(handle.action, weight);
  }

  setTime(handle: Animation2DStateMachineActionRuntimeHandle, timeSeconds: number): void {
    this._requireHandle(handle);
    handle.targetTime = timeSeconds;
    this.mixer.setTime(handle.action, timeSeconds);
  }

  setTimeScale(handle: Animation2DStateMachineActionRuntimeHandle, timeScale: number): void {
    this._requireHandle(handle);
    this.mixer.setTimeScale(handle.action, timeScale);
  }

  destroyAction(handle: Animation2DStateMachineActionRuntimeHandle): void {
    if (handle.destroyed) return;
    this._requireHandle(handle);
    if (this._transactionActive) {
      if (!handle.pendingDestroy) {
        handle.pendingDestroy = true;
        this._transactionPendingDestroy.push(handle);
      }
      return;
    }
    this._destroyHandleNow(handle);
  }

  beginControllerTransaction(): void {
    this._requireActive();
    if (this._transactionActive) {
      throw new Error('Animation2D state-machine adapter transaction is already active.');
    }
    this._transactionActive = true;
    this._transactionHandles.length = 0;
    this._transactionCreated.length = 0;
    this._transactionPendingDestroy.length = 0;
    for (const handle of this._handles) {
      handle.captureTransactionState();
      this._transactionHandles.push(handle);
    }
  }

  commitControllerTransaction(): void {
    if (!this._transactionActive) {
      throw new Error('Animation2D state-machine adapter has no active transaction.');
    }
    this._transactionActive = false;
    for (const handle of this._transactionPendingDestroy) this._destroyHandleNow(handle);
    this._clearTransaction();
  }

  rollbackControllerTransaction(): void {
    if (!this._transactionActive) return;
    this._transactionActive = false;
    for (let index = this._transactionCreated.length - 1; index >= 0; index--) {
      this._destroyHandleNow(this._transactionCreated[index]!);
    }
    for (const handle of this._transactionHandles) {
      if (!handle.destroyed) handle.restoreTransactionState();
    }
    this._clearTransaction();
  }

  destroy(): void {
    if (this._destroyed) return;
    this.rollbackControllerTransaction();
    for (const handle of [...this._handles]) this._destroyHandleNow(handle);
    this._destroyed = true;
  }

  private _destroyHandleNow(handle: Animation2DStateMachineActionRuntimeHandle): void {
    if (handle.destroyed) return;
    this.mixer.removeAction(handle.action);
    handle.playing = false;
    handle.pendingDestroy = false;
    handle.destroyed = true;
    this._handles.delete(handle);
  }

  private _clearTransaction(): void {
    this._transactionHandles.length = 0;
    this._transactionCreated.length = 0;
    this._transactionPendingDestroy.length = 0;
  }

  private _requireHandle(handle: Animation2DStateMachineActionRuntimeHandle): void {
    this._requireActive();
    if (handle.destroyed || !this._handles.has(handle)) {
      throw new Error('Animation2D state-machine action belongs to another adapter or was destroyed.');
    }
  }

  private _requireActive(): void {
    if (this._destroyed) throw new Error('Animation2D state-machine adapter has been destroyed.');
  }
}
