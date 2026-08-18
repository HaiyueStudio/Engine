import type { Animation3DMutablePose, Animation3DPose } from '../../Animation3DPose.js';
import {
  Animation3DStateMachineController,
  runAnimationStateMachineControllerUpdateTransaction,
  type Animation3DStateMachineControllerOptions,
} from '../state-machine/Animation3DStateMachineController.js';
import type {
  CompiledAnimation3DStateMachine,
} from '../state-machine/Animation3DStateMachineCompiler.js';
import { Animation3DMixerRuntime } from '../mixer/Mixer.js';
import {
  Animation3DStateMachineMixerAdapter,
  type Animation3DStateMachineActionRuntimeHandle,
  type Animation3DStateMachineClipResolver,
} from './Animation3DStateMachineMixerAdapter.js';

export type Animation3DStateMachineMixerIntegrationState =
  | 'active'
  | 'destroyed';

/**
 * Closed-loop runtime for a compiled state machine and the real 3D mixer.
 *
 * The state-machine controller is the unique playback-clock owner. A frame
 * advances the controller once, synchronizes absolute action playheads, then
 * asks the mixer to evaluate without advancing any action time.
 */
export class Animation3DStateMachineMixerIntegration {
  readonly mixer: Animation3DMixerRuntime;
  readonly adapter: Animation3DStateMachineMixerAdapter;
  readonly controller: Animation3DStateMachineController<
    Animation3DStateMachineActionRuntimeHandle
  >;

  private _state: Animation3DStateMachineMixerIntegrationState = 'active';
  private _time = 0;
  private _transactionOut: Animation3DMutablePose | null = null;
  private readonly _beginControllerUpdate = (): void => {
    this.adapter.beginFrame(this._requireTransactionOut());
  };
  private readonly _completeControllerUpdate = (): Animation3DPose => {
    const out = this._requireTransactionOut();
    this.adapter.endFrame(out);
    return this.mixer.endSynchronizedFrame(out);
  };

  constructor(
    compiled: CompiledAnimation3DStateMachine,
    mixer: Animation3DMixerRuntime,
    clipResolver: Animation3DStateMachineClipResolver,
    controllerOptions: Animation3DStateMachineControllerOptions = {},
  ) {
    this.mixer = mixer;
    this.adapter = new Animation3DStateMachineMixerAdapter(mixer, clipResolver);
    try {
      this.controller = new Animation3DStateMachineController(
        compiled,
        this.adapter,
        controllerOptions,
      );
    } catch (error) {
      this.adapter.destroy();
      this._state = 'destroyed';
      throw error;
    }
  }

  get state(): Animation3DStateMachineMixerIntegrationState {
    return this._state;
  }

  get time(): number {
    return this._time;
  }

  update(
    deltaSeconds: number,
    out: Animation3DMutablePose,
  ): Animation3DPose {
    this._requireActive();
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError(
        'Animation3D state-machine deltaSeconds must be finite and non-negative.',
      );
    }
    const nextTime = this._time + deltaSeconds;
    this.mixer.beginSynchronizedFrame(nextTime, out);
    this._transactionOut = out;
    try {
      const pose = runAnimationStateMachineControllerUpdateTransaction(
        this.controller,
        deltaSeconds,
        this._beginControllerUpdate,
        this._completeControllerUpdate,
      );
      this._time = nextTime;
      return pose;
    } catch (error) {
      this.adapter.cancelFrame(out);
      this.mixer.cancelSynchronizedFrame(out);
      throw error;
    } finally {
      this._transactionOut = null;
    }
  }

  /**
   * Re-evaluates the current controller-owned time without advancing it.
   */
  evaluate(out: Animation3DMutablePose): Animation3DPose {
    this._requireActive();
    this.mixer.beginSynchronizedFrame(this._time, out);
    this.adapter.beginControllerTransaction();
    try {
      this.adapter.beginFrame(out);
      this.adapter.endFrame(out);
      const pose = this.mixer.endSynchronizedFrame(out);
      this.adapter.commitControllerTransaction();
      return pose;
    } catch (error) {
      this.adapter.cancelFrame(out);
      this.mixer.cancelSynchronizedFrame(out);
      this.adapter.rollbackControllerTransaction();
      throw error;
    }
  }

  reset(out: Animation3DMutablePose): Animation3DPose {
    this._requireActive();
    this.controller.reset();
    this._time = 0;
    return this.evaluate(out);
  }

  /**
   * Stops and removes every controller action. External mixer/clip resources
   * remain caller-owned. Repeated calls are safe.
   */
  destroy(): void {
    if (this._state === 'destroyed') return;
    this.controller.destroy();
    this.adapter.destroy();
    this._state = 'destroyed';
  }

  private _requireActive(): void {
    if (this._state !== 'active') {
      throw new Error('Animation3D state-machine mixer integration has been destroyed.');
    }
  }

  private _requireTransactionOut(): Animation3DMutablePose {
    if (!this._transactionOut) {
      throw new Error('Animation3D state-machine integration has no active transaction output.');
    }
    return this._transactionOut;
  }
}
