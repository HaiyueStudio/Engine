import type { Animation3DMixer } from '../../Animation3DMixer.js';
import type { Animation3DMixerRuntime } from './Mixer.js';

const MIXER_RUNTIMES = new WeakMap<
  Animation3DMixer,
  Animation3DMixerRuntime
>();

/** @internal Connects the public facade to controller-only runtime operations. */
export function registerAnimation3DMixerRuntime(
  mixer: Animation3DMixer,
  runtime: Animation3DMixerRuntime,
): void {
  MIXER_RUNTIMES.set(mixer, runtime);
}

/** @internal Used only by the state-machine facade integration. */
export function animation3DMixerRuntime(
  mixer: Animation3DMixer,
): Animation3DMixerRuntime {
  const runtime = MIXER_RUNTIMES.get(mixer);
  if (!runtime) {
    throw new TypeError('Expected an Animation3DMixer facade instance.');
  }
  return runtime;
}
