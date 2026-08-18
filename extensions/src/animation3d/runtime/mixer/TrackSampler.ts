import type { Animation3DTrack } from '../../Animation3DTrack.js';
import { Animation3DError } from '../../Animation3DError.js';

const SLERP_LINEAR_THRESHOLD = 0.9995;

/**
 * Stateful, allocation-free sampler for one immutable track.
 *
 * The sampler owns one reusable output buffer and a key cursor optimized for
 * coherent playback. Callers may provide another destination when needed.
 */
export class Animation3DTrackSampler {
  readonly track: Animation3DTrack;
  readonly valueSize: number;
  readonly output: Float32Array;

  private _cursor = 0;

  constructor(track: Animation3DTrack) {
    validateAnimation3DTrack(track);
    this.track = track;
    this.valueSize = track.binding.valueSize;
    this.output = new Float32Array(this.valueSize);
  }

  sample(timeSeconds: number, out: Float32Array = this.output): Float32Array {
    if (!Number.isFinite(timeSeconds)) {
      throw new RangeError(`Animation3D track sample time must be finite; received ${timeSeconds}.`);
    }
    if (out.length < this.valueSize) {
      throw new RangeError(
        `Animation3D track output requires ${this.valueSize} values; received ${out.length}.`,
      );
    }

    const times = this.track.times;
    const keyCount = times.length;
    if (keyCount === 1 || timeSeconds <= times[0]!) {
      this._copyKeyValue(0, out);
      this._cursor = 0;
      return out;
    }
    const lastIndex = keyCount - 1;
    if (timeSeconds >= times[lastIndex]!) {
      this._copyKeyValue(lastIndex, out);
      this._cursor = Math.max(0, lastIndex - 1);
      return out;
    }

    const keyIndex = this._findInterval(timeSeconds);
    if (this.track.interpolation === 'step') {
      this._copyKeyValue(keyIndex, out);
      return out;
    }

    const startTime = times[keyIndex]!;
    const endTime = times[keyIndex + 1]!;
    const alpha = (timeSeconds - startTime) / (endTime - startTime);
    if (this.track.interpolation === 'cubic-spline') {
      this._sampleCubic(keyIndex, endTime - startTime, alpha, out);
    } else if (this.track.binding.valueType === 'quaternion') {
      this._sampleQuaternionLinear(keyIndex, alpha, out);
    } else {
      this._sampleLinear(keyIndex, alpha, out);
    }
    return out;
  }

  resetCursor(): void {
    this._cursor = 0;
  }

  private _findInterval(timeSeconds: number): number {
    const times = this.track.times;
    let cursor = Math.min(this._cursor, times.length - 2);
    if (timeSeconds >= times[cursor]! && timeSeconds < times[cursor + 1]!) {
      return cursor;
    }

    if (timeSeconds >= times[cursor + 1]!) {
      while (cursor + 2 < times.length && timeSeconds >= times[cursor + 1]!) cursor++;
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

  private _copyKeyValue(keyIndex: number, out: Float32Array): void {
    const size = this.valueSize;
    const values = this.track.values;
    const offset = this.track.interpolation === 'cubic-spline'
      ? keyIndex * size * 3 + size
      : keyIndex * size;
    for (let component = 0; component < size; component++) {
      out[component] = values[offset + component]!;
    }
    if (this.track.binding.valueType === 'quaternion') normalizeQuaternion(out);
  }

  private _sampleLinear(keyIndex: number, alpha: number, out: Float32Array): void {
    const size = this.valueSize;
    const values = this.track.values;
    const startOffset = keyIndex * size;
    const endOffset = startOffset + size;
    for (let component = 0; component < size; component++) {
      const start = values[startOffset + component]!;
      out[component] = start + (values[endOffset + component]! - start) * alpha;
    }
  }

  private _sampleQuaternionLinear(keyIndex: number, alpha: number, out: Float32Array): void {
    const values = this.track.values;
    const startOffset = keyIndex * 4;
    const endOffset = startOffset + 4;
    const ax = values[startOffset]!;
    const ay = values[startOffset + 1]!;
    const az = values[startOffset + 2]!;
    const aw = values[startOffset + 3]!;
    let bx = values[endOffset]!;
    let by = values[endOffset + 1]!;
    let bz = values[endOffset + 2]!;
    let bw = values[endOffset + 3]!;
    let dot = ax * bx + ay * by + az * bz + aw * bw;

    if (dot < 0) {
      dot = -dot;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    dot = Math.min(1, Math.max(-1, dot));

    if (dot > SLERP_LINEAR_THRESHOLD) {
      out[0] = ax + (bx - ax) * alpha;
      out[1] = ay + (by - ay) * alpha;
      out[2] = az + (bz - az) * alpha;
      out[3] = aw + (bw - aw) * alpha;
      normalizeQuaternion(out);
      return;
    }

    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const startWeight = Math.sin((1 - alpha) * theta) / sinTheta;
    const endWeight = Math.sin(alpha * theta) / sinTheta;
    out[0] = ax * startWeight + bx * endWeight;
    out[1] = ay * startWeight + by * endWeight;
    out[2] = az * startWeight + bz * endWeight;
    out[3] = aw * startWeight + bw * endWeight;
    normalizeQuaternion(out);
  }

  private _sampleCubic(
    keyIndex: number,
    keyDuration: number,
    alpha: number,
    out: Float32Array,
  ): void {
    const size = this.valueSize;
    const values = this.track.values;
    const startGroup = keyIndex * size * 3;
    const endGroup = startGroup + size * 3;
    const startValue = startGroup + size;
    const startOutTangent = startGroup + size * 2;
    const endInTangent = endGroup;
    const endValue = endGroup + size;
    const alpha2 = alpha * alpha;
    const alpha3 = alpha2 * alpha;
    const h00 = 2 * alpha3 - 3 * alpha2 + 1;
    const h10 = alpha3 - 2 * alpha2 + alpha;
    const h01 = -2 * alpha3 + 3 * alpha2;
    const h11 = alpha3 - alpha2;

    for (let component = 0; component < size; component++) {
      out[component] = h00 * values[startValue + component]!
        + h10 * keyDuration * values[startOutTangent + component]!
        + h01 * values[endValue + component]!
        + h11 * keyDuration * values[endInTangent + component]!;
    }
    if (this.track.binding.valueType === 'quaternion') normalizeQuaternion(out);
  }
}

/** @internal Shared by clip admission and direct sampler construction. */
export function validateAnimation3DTrack(
  track: Animation3DTrack,
  clipDuration = Infinity,
): void {
  const trackId = typeof track?.id === 'string' ? track.id : '';
  const fail = (message: string): never => {
    throw new Animation3DError(
      'invalid-track',
      message,
      { trackId },
    );
  };
  if (!track || typeof track !== 'object') {
    fail('Animation3D track must be an object.');
  }
  if (trackId.trim().length === 0) {
    fail('Animation3D track id must not be empty.');
  }
  if (!track.binding || typeof track.binding !== 'object') {
    fail(`Animation3D track "${trackId}" requires a binding.`);
  }
  if (typeof track.binding.id !== 'string' || track.binding.id.trim().length === 0) {
    fail(`Animation3D track "${trackId}" binding id must not be empty.`);
  }
  validateBindingTarget(track, fail);
  const size = track.binding.valueSize;
  if (!Number.isInteger(size) || size <= 0) {
    fail(`Animation3D binding valueSize must be a positive integer; received ${size}.`);
  }
  const fixedSize = fixedBindingValueSize(track.binding.valueType);
  if (fixedSize !== null && Number.isNaN(fixedSize)) {
    fail(`Animation3D track "${trackId}" has an unsupported binding value type.`);
  }
  if (fixedSize !== null && size !== fixedSize) {
    fail(
      `Animation3D ${track.binding.valueType} binding requires ${fixedSize} values; received ${size}.`,
    );
  }
  if (track.binding.valueType === 'weights' && !Number.isSafeInteger(size)) {
    fail(`Animation3D weights binding valueSize must be a positive safe integer; received ${size}.`);
  }
  validateBindingPath(track, size, fail);
  if (
    track.interpolation !== 'step'
    && track.interpolation !== 'linear'
    && track.interpolation !== 'cubic-spline'
  ) {
    fail(`Animation3D track "${trackId}" has an unsupported interpolation.`);
  }
  if (!(track.times instanceof Float32Array)) {
    fail(`Animation3D track "${trackId}" times must be a Float32Array.`);
  }
  if (!(track.values instanceof Float32Array)) {
    fail(`Animation3D track "${trackId}" values must be a Float32Array.`);
  }
  if (track.times.length === 0) {
    fail(`Animation3D track "${trackId}" must contain at least one key.`);
  }
  for (let index = 0; index < track.times.length; index++) {
    const time = track.times[index]!;
    if (!Number.isFinite(time) || time < 0 || time > clipDuration
      || (index > 0 && time <= track.times[index - 1]!)) {
      fail(
        `Animation3D track "${trackId}" key times must be finite, non-negative, `
        + 'strictly increasing, and within the clip duration.',
      );
    }
  }
  const stride = track.interpolation === 'cubic-spline' ? size * 3 : size;
  const expectedValues = track.times.length * stride;
  if (track.values.length !== expectedValues) {
    fail(
      `Animation3D track "${trackId}" requires ${expectedValues} values; received ${track.values.length}.`,
    );
  }
  for (let index = 0; index < track.values.length; index++) {
    if (!Number.isFinite(track.values[index])) {
      fail(`Animation3D track "${trackId}" values must be finite.`);
    }
  }
  if (track.binding.valueType === 'quaternion') {
    const groupStride = track.interpolation === 'cubic-spline' ? size * 3 : size;
    const valueOffset = track.interpolation === 'cubic-spline' ? size : 0;
    for (let keyIndex = 0; keyIndex < track.times.length; keyIndex++) {
      const offset = keyIndex * groupStride + valueOffset;
      const length = Math.hypot(
        track.values[offset]!,
        track.values[offset + 1]!,
        track.values[offset + 2]!,
        track.values[offset + 3]!,
      );
      if (length <= Number.EPSILON) {
        fail(`Animation3D track "${trackId}" contains a zero-length quaternion key.`);
      }
    }
  }
}

function validateBindingTarget(
  track: Animation3DTrack,
  fail: (message: string) => never,
): void {
  const { target } = track.binding;
  if (!target || typeof target !== 'object') {
    fail(`Animation3D track "${track.id}" binding requires a target.`);
  }
  if (target.kind === 'node-id') {
    if (typeof target.nodeId !== 'string' || target.nodeId.trim().length === 0) {
      fail(`Animation3D track "${track.id}" node-id target must not be empty.`);
    }
    return;
  }
  if (target.kind === 'node-path') {
    if (!Array.isArray(target.segments)
      || target.segments.some(segment => typeof segment !== 'string')) {
      fail(`Animation3D track "${track.id}" node-path target must contain string segments.`);
    }
    return;
  }
  if (target.kind === 'slot') {
    if (typeof target.slot !== 'string' || target.slot.trim().length === 0) {
      fail(`Animation3D track "${track.id}" slot target must not be empty.`);
    }
    return;
  }
  fail(`Animation3D track "${track.id}" has an unsupported binding target.`);
}

function validateBindingPath(
  track: Animation3DTrack,
  size: number,
  fail: (message: string) => never,
): void {
  const { binding } = track;
  if (binding.path === 'transform.translation') {
    if (binding.valueType !== 'vec3' || size !== 3) {
      fail('Animation3D translation tracks require a vec3 binding.');
    }
    return;
  }
  if (binding.path === 'transform.rotation') {
    if (binding.valueType !== 'quaternion' || size !== 4) {
      fail('Animation3D rotation tracks require a quaternion binding.');
    }
    return;
  }
  if (binding.path === 'transform.scale') {
    if (binding.valueType !== 'vec3' || size !== 3) {
      fail('Animation3D scale tracks require a vec3 binding.');
    }
    return;
  }
  if (binding.path === 'morph.weights') {
    if (binding.valueType !== 'weights') {
      fail('Animation3D morph tracks require a weights binding.');
    }
    return;
  }
  if (binding.path === 'property') {
    if (String(binding.valueType) === 'weights'
      || typeof binding.component !== 'string'
      || binding.component.trim().length === 0
      || typeof binding.property !== 'string'
      || binding.property.trim().length === 0) {
      fail('Animation3D property tracks require component, property, and a fixed value type.');
    }
    return;
  }
  fail(`Animation3D track "${track.id}" has an unsupported binding path.`);
}

function fixedBindingValueSize(valueType: string): number | null {
  if (valueType === 'scalar') return 1;
  if (valueType === 'vec2') return 2;
  if (valueType === 'vec3') return 3;
  if (valueType === 'vec4' || valueType === 'quaternion') return 4;
  if (valueType === 'weights') return null;
  return Number.NaN;
}

export function normalizeQuaternion(value: Float32Array): void {
  const x = value[0]!;
  const y = value[1]!;
  const z = value[2]!;
  const w = value[3]!;
  const length = Math.hypot(x, y, z, w);
  if (length <= Number.EPSILON) {
    value[0] = 0;
    value[1] = 0;
    value[2] = 0;
    value[3] = 1;
    return;
  }
  const inverseLength = 1 / length;
  value[0] = x * inverseLength;
  value[1] = y * inverseLength;
  value[2] = z * inverseLength;
  value[3] = w * inverseLength;
}
