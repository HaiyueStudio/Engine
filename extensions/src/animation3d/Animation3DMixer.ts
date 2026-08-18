import type {
  Animation3DBindingResolver,
} from './Animation3DBinding.js';
import type {
  Animation3DAction,
  Animation3DActionOptions,
} from './Animation3DAction.js';
import type { Animation3DClip } from './Animation3DClip.js';
import type {
  Animation3DMutablePose,
  Animation3DPose,
} from './Animation3DPose.js';
import { Animation3DMixerRuntime } from './runtime/mixer/Mixer.js';
import {
  registerAnimation3DMixerRuntime,
} from './runtime/mixer/Animation3DMixerRuntimeStore.js';

export type Animation3DMixerState =
  | 'active'
  | 'destroyed';

/**
 * Public mixer facade. Controller-only clock/transaction hooks remain on the
 * internal runtime and are intentionally absent from this surface.
 */
export class Animation3DMixer {
  #runtime: Animation3DMixerRuntime;

  constructor(resolver: Animation3DBindingResolver) {
    this.#runtime = new Animation3DMixerRuntime(resolver);
    registerAnimation3DMixerRuntime(this, this.#runtime);
  }

  get state(): Animation3DMixerState { return this.#runtime.state; }
  get resolver(): Animation3DBindingResolver { return this.#runtime.resolver; }
  get actions(): readonly Animation3DAction[] { return this.#runtime.actions; }
  get time(): number { return this.#runtime.time; }
  get timeScale(): number { return this.#runtime.timeScale; }
  set timeScale(value: number) { this.#runtime.timeScale = value; }

  createAction(
    clip: Animation3DClip,
    options?: Animation3DActionOptions,
  ): Animation3DAction {
    return this.#runtime.createAction(clip, options);
  }

  getAction(actionId: string): Animation3DAction | null {
    return this.#runtime.getAction(actionId);
  }

  removeAction(action: Animation3DAction | string): boolean {
    return this.#runtime.removeAction(action);
  }

  stopAllActions(): this {
    this.#runtime.stopAllActions();
    return this;
  }

  update(
    deltaSeconds: number,
    out: Animation3DMutablePose,
  ): Animation3DPose {
    return this.#runtime.update(deltaSeconds, out);
  }

  evaluate(out: Animation3DMutablePose): Animation3DPose {
    return this.#runtime.evaluate(out);
  }

  setTime(
    timeSeconds: number,
    out: Animation3DMutablePose,
  ): Animation3DPose {
    return this.#runtime.setTime(timeSeconds, out);
  }

  destroy(): void {
    this.#runtime.destroy();
  }
}
