import type {
  Animation2DBinding,
  Animation2DDiscreteTrack,
  Animation2DNumericTrack,
  Animation2DTrack,
} from './Types.js';

/**
 * Stateful allocation-free sampler. Rotation values are radians and LINEAR
 * sampling follows the shortest signed arc in [-PI, PI).
 */
export class Animation2DSampler {
  readonly track: Animation2DTrack;
  readonly output: Float32Array;
  discreteValue: unknown;

  private _cursor = 0;

  constructor(track: Animation2DTrack) {
    validateTrack(track);
    this.track = track;
    this.output = new Float32Array(isNumericBinding(track.binding)
      ? track.binding.valueSize!
      : 0);
  }

  sample(timeSeconds: number, out: Float32Array = this.output): Float32Array | unknown {
    if (!Number.isFinite(timeSeconds)) {
      throw new RangeError(`Animation2D sample time must be finite; received ${timeSeconds}.`);
    }
    const keyIndex = this._findKey(timeSeconds);
    if (!isNumericBinding(this.track.binding)) {
      this.discreteValue = (this.track as Animation2DDiscreteTrack).values[keyIndex];
      return this.discreteValue;
    }

    const track = this.track as Animation2DNumericTrack;
    const size = track.binding.valueSize!;
    if (out.length < size) {
      throw new RangeError(`Animation2D sampler output requires ${size} values; received ${out.length}.`);
    }
    const times = track.times;
    if (keyIndex >= times.length - 1 || track.interpolation === 'step') {
      copyNumericKey(track, keyIndex, out);
      return out;
    }
    const startTime = times[keyIndex]!;
    const linearAlpha = (timeSeconds - startTime) / (times[keyIndex + 1]! - startTime);
    const alpha = track.interpolation === 'cubic-bezier'
      ? sampleCubicEasing(track.easings!, keyIndex, linearAlpha)
      : linearAlpha;
    const startOffset = keyIndex * size;
    const endOffset = startOffset + size;
    if (track.binding.strategy === 'rotation') {
      const start = track.values[startOffset]!;
      const delta = wrapAngle(track.values[endOffset]! - start);
      out[0] = wrapAngle(start + delta * alpha);
      return out;
    }
    if (track.spatialTangents) {
      const tangentOffset = keyIndex * 4;
      for (let component = 0; component < 2; component++) {
        const start = track.values[startOffset + component]!;
        const end = track.values[endOffset + component]!;
        out[component] = cubicSpatialCoordinate(
          alpha,
          start,
          start + track.spatialTangents[tangentOffset + component]!,
          end + track.spatialTangents[tangentOffset + 2 + component]!,
          end,
        );
      }
      return out;
    }
    for (let component = 0; component < size; component++) {
      const start = track.values[startOffset + component]!;
      out[component] = start
        + (track.values[endOffset + component]! - start) * alpha;
    }
    return out;
  }

  resetCursor(): void {
    this._cursor = 0;
  }

  private _findKey(timeSeconds: number): number {
    const times = this.track.times;
    const last = times.length - 1;
    if (last === 0 || timeSeconds <= times[0]!) {
      this._cursor = 0;
      return 0;
    }
    if (timeSeconds >= times[last]!) {
      this._cursor = Math.max(0, last - 1);
      return last;
    }
    let cursor = Math.min(this._cursor, last - 1);
    if (timeSeconds >= times[cursor]! && timeSeconds < times[cursor + 1]!) return cursor;
    if (timeSeconds >= times[cursor + 1]!) {
      while (cursor + 1 < last && timeSeconds >= times[cursor + 1]!) cursor++;
      this._cursor = cursor;
      return cursor;
    }
    let low = 0;
    let high = cursor;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (timeSeconds < times[middle]!) {
        high = middle - 1;
      } else if (timeSeconds >= times[middle + 1]!) {
        low = middle + 1;
      } else {
        this._cursor = middle;
        return middle;
      }
    }
    this._cursor = Math.max(0, low);
    return this._cursor;
  }
}

export function wrapAngle(value: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = (value + Math.PI) % twoPi;
  if (wrapped < 0) wrapped += twoPi;
  return wrapped - Math.PI;
}

export function isNumericBinding(binding: Animation2DBinding): boolean {
  return binding.strategy === 'continuous' || binding.strategy === 'rotation';
}

function copyNumericKey(
  track: Animation2DNumericTrack,
  keyIndex: number,
  out: Float32Array,
): void {
  const size = track.binding.valueSize!;
  const offset = keyIndex * size;
  for (let component = 0; component < size; component++) {
    out[component] = track.values[offset + component]!;
  }
  if (track.binding.strategy === 'rotation') out[0] = wrapAngle(out[0]!);
}

function validateTrack(track: Animation2DTrack): void {
  if (!track.id) throw new RangeError('Animation2D track id must not be empty.');
  if (!track.binding.id) throw new RangeError('Animation2D binding id must not be empty.');
  if (track.times.length === 0) {
    throw new RangeError(`Animation2D track "${track.id}" must contain at least one key.`);
  }
  for (let index = 0; index < track.times.length; index++) {
    const time = track.times[index]!;
    if (!Number.isFinite(time) || (index > 0 && time <= track.times[index - 1]!)) {
      throw new RangeError(`Animation2D track "${track.id}" times must be finite and strictly increasing.`);
    }
  }
  if (isNumericBinding(track.binding)) {
    const numericTrack = track as Animation2DNumericTrack;
    const size = track.binding.valueSize ?? 0;
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`Animation2D numeric binding "${track.binding.id}" requires a positive valueSize.`);
    }
    if (track.binding.strategy === 'rotation' && size !== 1) {
      throw new RangeError(`Animation2D rotation binding "${track.binding.id}" must have valueSize 1.`);
    }
    const expected = track.times.length * size;
    if (!(track.values instanceof Float32Array) || track.values.length !== expected) {
      throw new RangeError(`Animation2D track "${track.id}" requires ${expected} numeric values.`);
    }
    if (numericTrack.interpolation === 'cubic-bezier') {
      const expectedEasings = Math.max(0, track.times.length - 1) * 4;
      if (!(numericTrack.easings instanceof Float32Array) || numericTrack.easings.length !== expectedEasings) {
        throw new RangeError(`Animation2D track "${track.id}" requires ${expectedEasings} cubic easing values.`);
      }
      for (let index = 0; index < numericTrack.easings.length; index += 4) {
        const x1 = numericTrack.easings[index]!;
        const x2 = numericTrack.easings[index + 2]!;
        if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
          throw new RangeError(`Animation2D track "${track.id}" cubic easing x controls must be in [0, 1].`);
        }
      }
    } else if (numericTrack.easings !== undefined) {
      throw new RangeError(`Animation2D track "${track.id}" easings require cubic-bezier interpolation.`);
    }
    if (numericTrack.spatialTangents !== undefined) {
      const expectedTangents = Math.max(0, track.times.length - 1) * 4;
      if (track.binding.path !== 'transform.position' || size !== 2) {
        throw new RangeError(`Animation2D track "${track.id}" spatialTangents require transform.position/2.`);
      }
      if (numericTrack.interpolation === 'step') {
        throw new RangeError(`Animation2D track "${track.id}" spatialTangents cannot use step.`);
      }
      if (!(numericTrack.spatialTangents instanceof Float32Array)
        || numericTrack.spatialTangents.length !== expectedTangents) {
        throw new RangeError(`Animation2D track "${track.id}" requires ${expectedTangents} spatialTangents.`);
      }
    }
    return;
  }
  if (track.interpolation !== 'step') {
    throw new RangeError(`Animation2D ${track.binding.strategy} track "${track.id}" must use step interpolation.`);
  }
  if (track.values.length !== track.times.length) {
    throw new RangeError(`Animation2D track "${track.id}" requires one discrete value per key.`);
  }
}

function sampleCubicEasing(easings: Float32Array, segment: number, x: number): number {
  const offset = segment * 4;
  const x1 = easings[offset]!;
  const y1 = easings[offset + 1]!;
  const x2 = easings[offset + 2]!;
  const y2 = easings[offset + 3]!;
  let parameter = x;
  for (let iteration = 0; iteration < 6; iteration++) {
    const estimate = cubicCoordinate(parameter, x1, x2) - x;
    const derivative = cubicDerivative(parameter, x1, x2);
    if (Math.abs(derivative) < 1e-6) break;
    parameter = Math.min(1, Math.max(0, parameter - estimate / derivative));
  }
  return cubicCoordinate(parameter, y1, y2);
}

function cubicCoordinate(value: number, first: number, second: number): number {
  const inverse = 1 - value;
  return 3 * inverse * inverse * value * first
    + 3 * inverse * value * value * second
    + value * value * value;
}

function cubicDerivative(value: number, first: number, second: number): number {
  const inverse = 1 - value;
  return 3 * inverse * inverse * first
    + 6 * inverse * value * (second - first)
    + 3 * value * value * (1 - second);
}

function cubicSpatialCoordinate(
  value: number,
  start: number,
  first: number,
  second: number,
  end: number,
): number {
  const inverse = 1 - value;
  return inverse * inverse * inverse * start
    + 3 * inverse * inverse * value * first
    + 3 * inverse * value * value * second
    + value * value * value * end;
}
