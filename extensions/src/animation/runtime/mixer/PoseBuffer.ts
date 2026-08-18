import type {
  Animation2DBinding,
  Animation2DEffectEvent,
  Animation2DMutablePose,
  Animation2DPose,
  Animation2DPoseChannel,
} from './Types.js';

class ReusablePoseChannel implements Animation2DPoseChannel {
  binding: Animation2DBinding;
  value: Float32Array | unknown;
  private _numeric = new Float32Array(0);

  constructor(binding: Animation2DBinding) {
    this.binding = binding;
  }

  writeNumeric(binding: Animation2DBinding, source: ArrayLike<number>): void {
    const size = numericSize(binding);
    this.binding = binding;
    if (this._numeric.length !== size) this._numeric = new Float32Array(size);
    for (let index = 0; index < size; index++) this._numeric[index] = source[index] ?? 0;
    this.value = this._numeric;
  }

  writeDiscrete(binding: Animation2DBinding, value: unknown): void {
    this.binding = binding;
    this.value = value;
  }
}

/**
 * Caller-owned frame-transient pose. Channel records, numeric storage, and
 * effect arrays are reused after warmup.
 */
export class Animation2DPoseBuffer implements Animation2DMutablePose, Animation2DPose {
  private readonly _channelPool: ReusablePoseChannel[] = [];
  private readonly _channels: ReusablePoseChannel[] = [];
  private readonly _effects: Animation2DEffectEvent[] = [];
  private _sequence = 0;
  private _mixerTime = 0;
  private _sealed = true;

  get sequence(): number { return this._sequence; }
  get mixerTime(): number { return this._mixerTime; }
  get channels(): readonly Animation2DPoseChannel[] { return this._channels; }
  get effects(): readonly Animation2DEffectEvent[] { return this._effects; }

  reset(mixerTime: number): void {
    if (!Number.isFinite(mixerTime)) {
      throw new RangeError(`Animation2D pose mixerTime must be finite; received ${mixerTime}.`);
    }
    this._mixerTime = mixerTime;
    this._channels.length = 0;
    this._effects.length = 0;
    this._sealed = false;
  }

  writeNumeric(binding: Animation2DBinding, value: ArrayLike<number>): void {
    const size = numericSize(binding);
    if (value.length < size) {
      throw new RangeError(
        `Animation2D pose channel "${binding.id}" requires ${size} values; received ${value.length}.`,
      );
    }
    const channel = this._channelAt(this._channels.length, binding);
    channel.writeNumeric(binding, value);
    this._channels.push(channel);
  }

  writeDiscrete(binding: Animation2DBinding, value: unknown): void {
    const channel = this._channelAt(this._channels.length, binding);
    channel.writeDiscrete(binding, value);
    this._channels.push(channel);
  }

  emit(effect: Animation2DEffectEvent): void {
    this._effects.push(effect);
  }

  seal(): Animation2DPose {
    if (!this._sealed) {
      this._sequence++;
      this._sealed = true;
    }
    return this;
  }

  private _channelAt(index: number, binding: Animation2DBinding): ReusablePoseChannel {
    let channel = this._channelPool[index];
    if (!channel) {
      channel = new ReusablePoseChannel(binding);
      this._channelPool.push(channel);
    }
    return channel;
  }
}

function numericSize(binding: Animation2DBinding): number {
  const size = binding.valueSize ?? 0;
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`Animation2D numeric binding "${binding.id}" requires a positive valueSize.`);
  }
  return size;
}
