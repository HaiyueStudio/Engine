const CURVE_LINEAR = 0;
const CURVE_STEPPED = 1;
const CURVE_BEZIER = 2;

interface CompiledNumericChannel {
  readonly values: Float32Array;
  readonly curveKinds: Uint8Array;
  readonly curves: Float32Array;
}

interface CompiledColorChannel {
  readonly values: Float32Array;
  readonly curveKinds: Uint8Array;
  readonly curves: Float32Array;
}

interface CompiledFrameTimeline {
  readonly times: Float64Array;
  readonly numericChannels: Map<string, CompiledNumericChannel>;
  readonly color: CompiledColorChannel | null;
}

interface SpineTimelineCursor {
  intervalCursor: number;
  intervalTime: number;
  discreteCursor: number;
  discreteTime: number;
}

/** Runtime-local playback cursors; compiled timeline TypedArrays remain immutable and shareable. */
export interface SpineTimelineSamplerState {
  readonly cursors: WeakMap<object, SpineTimelineCursor>;
  cursorMisses: number;
}

export interface SpineTimelineCompileStats {
  readonly timelineCount: number;
  readonly frameCount: number;
  readonly numericChannelCount: number;
}

const compiledFrames = new WeakMap<object, CompiledFrameTimeline>();
const animationDurations = new WeakMap<object, number>();

export function createSpineTimelineSamplerState(): SpineTimelineSamplerState {
  return { cursors: new WeakMap(), cursorMisses: 0 };
}

/** Eagerly compiles every frame array reachable from the animation tree. */
export function compileSpineTimelines(
  animations: Record<string, unknown>,
  samplerState?: SpineTimelineSamplerState,
): SpineTimelineCompileStats {
  let timelineCount = 0;
  let frameCount = 0;
  let numericChannelCount = 0;
  for (const animation of Object.values(animations)) {
    let duration = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        const compiled = compileFrameArray(value);
        if (compiled) {
          getTimelineCursor(value, samplerState);
          timelineCount++;
          frameCount += compiled.times.length;
          numericChannelCount += compiled.numericChannels.size;
          const lastTime = compiled.times[compiled.times.length - 1];
          if (lastTime !== undefined && lastTime > duration) duration = lastTime;
        } else {
          for (const child of value) visit(child);
        }
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const child of Object.values(value)) visit(child);
    };
    visit(animation);
    if (animation && typeof animation === 'object') animationDurations.set(animation, duration);
  }
  return { timelineCount, frameCount, numericChannelCount };
}

export function getCompiledAnimationDuration(animation: unknown): number {
  if (!animation || typeof animation !== 'object') return 0;
  const cached = animationDurations.get(animation);
  if (cached !== undefined) return cached;
  let duration = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      const compiled = getOrCompileFrames(value);
      if (compiled) {
        const lastTime = compiled.times[compiled.times.length - 1];
        if (lastTime !== undefined && lastTime > duration) duration = lastTime;
      } else {
        for (const child of value) visit(child);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) visit(child);
  };
  visit(animation);
  animationDurations.set(animation, duration);
  return duration;
}

export function sampleCompiledTimeline(
  frames: unknown[],
  time: number,
  key: string,
  fallback: number,
  _duration = 0,
  _loop = false,
  samplerState?: SpineTimelineSamplerState,
): number {
  const timeline = getOrCompileFrames(frames);
  if (!timeline || timeline.times.length === 0) return fallback;
  const channel = timeline.numericChannels.get(key) ?? timeline.numericChannels.get('value');
  if (!channel) return fallback;
  const lastIndex = timeline.times.length - 1;
  const firstTime = timeline.times[0] ?? 0;
  if (time < firstTime) return fallback;
  const lastTime = timeline.times[lastIndex] ?? 0;
  if (time >= lastTime) return finiteOrFallback(channel.values[lastIndex], fallback);
  const previousIndex = findIntervalIndex(timeline, time, getTimelineCursor(frames, samplerState));
  const nextIndex = Math.min(lastIndex, previousIndex + 1);
  const start = finiteOrFallback(channel.values[previousIndex], fallback);
  const end = finiteOrFallback(channel.values[nextIndex], fallback);
  const previousTime = timeline.times[previousIndex] ?? 0;
  const nextTime = timeline.times[nextIndex] ?? previousTime;
  if (nextIndex === previousIndex || nextTime === previousTime) return start;
  const curveKind = channel.curveKinds[previousIndex] ?? CURVE_LINEAR;
  if (curveKind === CURVE_STEPPED) return start;
  if (curveKind === CURVE_BEZIER) {
    return sampleBezierChannel(time, previousTime, start, channel.curves, previousIndex * 4, nextTime, end);
  }
  const alpha = clampUnit((time - previousTime) / (nextTime - previousTime));
  return start + (end - start) * alpha;
}

/** Returns the last frame whose time is <= sample time, or -1 before the first frame. */
export function findCompiledFrameIndex(
  frames: unknown[] | undefined,
  time: number,
  samplerState?: SpineTimelineSamplerState,
): number {
  const timeline = getOrCompileFrames(frames);
  if (!timeline || timeline.times.length === 0 || time < (timeline.times[0] ?? 0)) return -1;
  const lastIndex = timeline.times.length - 1;
  if (time >= (timeline.times[lastIndex] ?? 0)) {
    const state = getTimelineCursor(frames, samplerState);
    if (state) {
      state.discreteCursor = lastIndex;
      state.discreteTime = time;
    }
    return lastIndex;
  }
  const state = getTimelineCursor(frames, samplerState);
  let cursor = state?.discreteCursor ?? 0;
  if (
    state
    && time >= state.discreteTime
    && cursor >= 0
    && cursor < lastIndex
    && time >= (timeline.times[cursor] ?? 0)
  ) {
    while (cursor < lastIndex && (timeline.times[cursor + 1] ?? Infinity) <= time) cursor++;
  } else {
    cursor = upperBound(timeline.times, time) - 1;
  }
  if (state) {
    state.discreteCursor = Math.max(0, cursor);
    state.discreteTime = time;
  }
  return cursor;
}

export function sampleCompiledColor(
  frames: unknown[],
  time: number,
  fallback: ArrayLike<number>,
  out: [number, number, number, number],
  samplerState?: SpineTimelineSamplerState,
): [number, number, number, number] {
  const timeline = getOrCompileFrames(frames);
  if (!timeline?.color || timeline.times.length === 0) return copyColor(fallback, out);
  const channel = timeline.color;
  const lastIndex = timeline.times.length - 1;
  const firstTime = timeline.times[0] ?? 0;
  if (time < firstTime) return copyColor(fallback, out);
  const lastTime = timeline.times[lastIndex] ?? 0;
  if (time >= lastTime) return copyCompiledColor(channel, lastIndex, fallback, out);
  const previousIndex = findIntervalIndex(timeline, time, getTimelineCursor(frames, samplerState));
  const nextIndex = Math.min(lastIndex, previousIndex + 1);
  const previousTime = timeline.times[previousIndex] ?? 0;
  const nextTime = timeline.times[nextIndex] ?? previousTime;
  for (let colorChannel = 0; colorChannel < 4; colorChannel++) {
    const start = finiteOrFallback(channel.values[previousIndex * 4 + colorChannel], fallback[colorChannel] ?? 1);
    const end = finiteOrFallback(channel.values[nextIndex * 4 + colorChannel], fallback[colorChannel] ?? 1);
    if (nextIndex === previousIndex || nextTime === previousTime) {
      out[colorChannel] = start;
      continue;
    }
    const curveIndex = previousIndex * 4 + colorChannel;
    const curveKind = channel.curveKinds[curveIndex] ?? CURVE_LINEAR;
    if (curveKind === CURVE_STEPPED) out[colorChannel] = start;
    else if (curveKind === CURVE_BEZIER) {
      out[colorChannel] = sampleBezierChannel(
        time,
        previousTime,
        start,
        channel.curves,
        curveIndex * 4,
        nextTime,
        end,
      );
    } else {
      const alpha = clampUnit((time - previousTime) / (nextTime - previousTime));
      out[colorChannel] = start + (end - start) * alpha;
    }
  }
  return out;
}

function compileFrameArray(frames: unknown[]): CompiledFrameTimeline | null {
  if (frames.length === 0 || compiledFrames.has(frames)) return compiledFrames.get(frames) ?? null;
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  }
  const records = frames as Array<Record<string, unknown>>;
  const times = new Float64Array(records.length);
  const numericKeys = new Set<string>();
  let hasColor = false;
  for (let frameIndex = 0; frameIndex < records.length; frameIndex++) {
    const frame = records[frameIndex];
    if (!frame) continue;
    times[frameIndex] = finiteNumber(frame.time, 0);
    for (const [key, value] of Object.entries(frame)) {
      if (key === 'time' || key === 'curve') continue;
      if (key === 'color' && typeof value === 'string') hasColor = true;
      else if (typeof value === 'number') numericKeys.add(key);
    }
  }
  const numericChannels = new Map<string, CompiledNumericChannel>();
  for (const key of numericKeys) numericChannels.set(key, compileNumericChannel(records, key));
  const timeline: CompiledFrameTimeline = {
    times,
    numericChannels,
    color: hasColor ? compileColorChannel(records) : null,
  };
  compiledFrames.set(frames, timeline);
  return timeline;
}

function compileNumericChannel(frames: Array<Record<string, unknown>>, key: string): CompiledNumericChannel {
  const values = new Float32Array(frames.length);
  const curveKinds = new Uint8Array(frames.length);
  const curves = new Float32Array(frames.length * 4);
  const curveOffset = getCurveOffset(key);
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex];
    const value = frame?.[key] ?? frame?.value;
    values[frameIndex] = typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
    compileCurve(frame?.curve, curveOffset, curveKinds, frameIndex, curves, frameIndex * 4);
  }
  return { values, curveKinds, curves };
}

function compileColorChannel(frames: Array<Record<string, unknown>>): CompiledColorChannel {
  const values = new Float32Array(frames.length * 4);
  values.fill(Number.NaN);
  const curveKinds = new Uint8Array(frames.length * 4);
  const curves = new Float32Array(frames.length * 16);
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex];
    writeHexColor(frame?.color, values, frameIndex * 4);
    for (let channel = 0; channel < 4; channel++) {
      const curveIndex = frameIndex * 4 + channel;
      compileCurve(frame?.curve, channel * 4, curveKinds, curveIndex, curves, curveIndex * 4);
    }
  }
  return { values, curveKinds, curves };
}

function compileCurve(
  curve: unknown,
  sourceOffset: number,
  kinds: Uint8Array,
  kindIndex: number,
  curves: Float32Array,
  targetOffset: number,
): void {
  if (curve === 'stepped') {
    kinds[kindIndex] = CURVE_STEPPED;
    return;
  }
  if (!Array.isArray(curve) || curve.length < sourceOffset + 4) return;
  kinds[kindIndex] = CURVE_BEZIER;
  curves[targetOffset] = finiteNumber(curve[sourceOffset], 0);
  curves[targetOffset + 1] = finiteNumber(curve[sourceOffset + 1], 0);
  curves[targetOffset + 2] = finiteNumber(curve[sourceOffset + 2], 0);
  curves[targetOffset + 3] = finiteNumber(curve[sourceOffset + 3], 0);
}

function getOrCompileFrames(frames: unknown[] | undefined): CompiledFrameTimeline | null {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  return compiledFrames.get(frames) ?? compileFrameArray(frames);
}

function findIntervalIndex(
  timeline: CompiledFrameTimeline,
  time: number,
  state: SpineTimelineCursor | null,
): number {
  const times = timeline.times;
  const lastInterval = Math.max(0, times.length - 2);
  let cursor = Math.min(lastInterval, state?.intervalCursor ?? 0);
  if (
    state
    && time >= state.intervalTime
    && time >= (times[cursor] ?? 0)
    && time <= (times[cursor + 1] ?? Infinity)
  ) {
    state.intervalTime = time;
    return cursor;
  }
  if (state && time >= state.intervalTime && time >= (times[cursor] ?? 0)) {
    while (cursor < lastInterval && (times[cursor + 1] ?? Infinity) < time) cursor++;
  } else {
    cursor = Math.max(0, lowerBound(times, time) - 1);
  }
  if (state) {
    state.intervalCursor = cursor;
    state.intervalTime = time;
  }
  return cursor;
}

function getTimelineCursor(
  frames: object | undefined,
  samplerState: SpineTimelineSamplerState | undefined,
): SpineTimelineCursor | null {
  if (!frames || !samplerState) return null;
  let cursor = samplerState.cursors.get(frames);
  if (!cursor) {
    cursor = { intervalCursor: 0, intervalTime: -Infinity, discreteCursor: 0, discreteTime: -Infinity };
    samplerState.cursors.set(frames, cursor);
    samplerState.cursorMisses++;
  }
  return cursor;
}

function lowerBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Infinity) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] ?? Infinity) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sampleBezierChannel(
  time: number,
  time1: number,
  value1: number,
  curves: Float32Array,
  curveOffset: number,
  time2: number,
  value2: number,
): number {
  const cx1 = curves[curveOffset] ?? time1;
  const cy1 = curves[curveOffset + 1] ?? value1;
  const cx2 = curves[curveOffset + 2] ?? time2;
  const cy2 = curves[curveOffset + 3] ?? value2;
  let low = 0;
  let high = 1;
  let parameter = 0;
  for (let iteration = 0; iteration < 12; iteration++) {
    parameter = (low + high) * 0.5;
    if (cubicBezier(time1, cx1, cx2, time2, parameter) < time) low = parameter;
    else high = parameter;
  }
  parameter = (low + high) * 0.5;
  return cubicBezier(value1, cy1, cy2, value2, parameter);
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, time: number): number {
  const inverse = 1 - time;
  return inverse * inverse * inverse * p0
    + 3 * inverse * inverse * time * p1
    + 3 * inverse * time * time * p2
    + time * time * time * p3;
}

function copyCompiledColor(
  channel: CompiledColorChannel,
  frameIndex: number,
  fallback: ArrayLike<number>,
  out: [number, number, number, number],
): [number, number, number, number] {
  for (let colorChannel = 0; colorChannel < 4; colorChannel++) {
    out[colorChannel] = finiteOrFallback(
      channel.values[frameIndex * 4 + colorChannel],
      fallback[colorChannel] ?? 1,
    );
  }
  return out;
}

function copyColor(source: ArrayLike<number>, out: [number, number, number, number]): [number, number, number, number] {
  out[0] = source[0] ?? 1;
  out[1] = source[1] ?? 1;
  out[2] = source[2] ?? 1;
  out[3] = source[3] ?? 1;
  return out;
}

function writeHexColor(value: unknown, out: Float32Array, offset: number): void {
  if (typeof value !== 'string' || value.length < 8) return;
  out[offset] = parseInt(value.slice(0, 2), 16) / 255;
  out[offset + 1] = parseInt(value.slice(2, 4), 16) / 255;
  out[offset + 2] = parseInt(value.slice(4, 6), 16) / 255;
  out[offset + 3] = parseInt(value.slice(6, 8), 16) / 255;
}

function getCurveOffset(key: string): number {
  return key === 'y' || key === 'scaleY' || key === 'softness' ? 4 : 0;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteOrFallback(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}
