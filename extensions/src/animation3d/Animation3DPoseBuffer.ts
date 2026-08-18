import type { Animation3DBinding } from './Animation3DBinding.js';
import type {
  Animation3DMutablePose,
  Animation3DPose,
  Animation3DPoseChannel,
  Animation3DPoseEvent,
} from './Animation3DPose.js';

class ReusablePoseChannel implements Animation3DPoseChannel {
  binding: Animation3DBinding;
  value: Float32Array;

  constructor(binding: Animation3DBinding) {
    this.binding = binding;
    this.value = new Float32Array(binding.valueSize);
  }

  write(binding: Animation3DBinding, source: ArrayLike<number>): void {
    this.binding = binding;
    if (this.value.length !== binding.valueSize) {
      this.value = new Float32Array(binding.valueSize);
    }
    for (let index = 0; index < binding.valueSize; index++) {
      this.value[index] = source[index] ?? 0;
    }
  }
}

/**
 * Reusable caller-owned mixer output.
 *
 * Channel records and value arrays are pooled after first use. seal() returns
 * this object as the read-only pose view rather than allocating a snapshot.
 */
export class Animation3DPoseBuffer implements Animation3DMutablePose, Animation3DPose {
  private readonly _channelPool: ReusablePoseChannel[] = [];
  private readonly _channels: ReusablePoseChannel[] = [];
  private readonly _events: Animation3DPoseEvent[] = [];
  private _sequence = 0;
  private _mixerTime = 0;
  private _sealed = true;

  get sequence(): number { return this._sequence; }
  get mixerTime(): number { return this._mixerTime; }
  get channels(): readonly Animation3DPoseChannel[] { return this._channels; }
  get events(): readonly Animation3DPoseEvent[] { return this._events; }

  reset(mixerTime: number): void {
    if (!Number.isFinite(mixerTime)) {
      throw new RangeError(`Animation3D pose mixerTime must be finite; received ${mixerTime}.`);
    }
    this._mixerTime = mixerTime;
    this._channels.length = 0;
    this._events.length = 0;
    this._sealed = false;
  }

  write(binding: Animation3DBinding, value: ArrayLike<number>): void {
    if (value.length < binding.valueSize) {
      throw new RangeError(
        `Animation3D pose channel "${binding.id}" requires ${binding.valueSize} values; received ${value.length}.`,
      );
    }
    const index = this._channels.length;
    let channel = this._channelPool[index];
    if (!channel) {
      channel = new ReusablePoseChannel(binding);
      this._channelPool.push(channel);
    }
    channel.write(binding, value);
    this._channels.push(channel);
  }

  emit(event: Animation3DPoseEvent): void {
    this._events.push(event);
  }

  seal(): Animation3DPose {
    if (!this._sealed) {
      this._sequence++;
      this._sealed = true;
    }
    return this;
  }
}
