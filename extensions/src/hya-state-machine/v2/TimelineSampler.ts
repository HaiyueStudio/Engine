import type {
  PlaybackMode, RuntimeChannel, RuntimeClip, RuntimeDocument, RuntimeInterpolation, RuntimeKeyframe,
  RuntimeTrack, RuntimeValue, TimelineContribution, TimelineEffectOccurrence, TimelineSample,
} from './runtime-types.js';

export interface TimelineSampleOptions {
  readonly playback?: PlaybackMode; readonly previousRawTime?: number; readonly timeRemap?: number;
  readonly weight?: number; readonly layerOrder?: number; readonly actionOrder?: number;
  readonly blendMode?: 'override' | 'additive'; readonly mask?: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }>;
}

export class TimelineSamplerV2 {
  private readonly _channels = new Map<string, RuntimeChannel>();
  private readonly _clips = new Map<string, RuntimeClip>();
  private _disposed = false;

  constructor(document: RuntimeDocument) {
    for (const channel of document.channels) this._channels.set(channel.id, channel);
    for (const clip of document.clips) this._clips.set(clip.id, clip);
  }

  clip(id: string): RuntimeClip {
    this._requireActive(); const clip = this._clips.get(id); if (!clip) throw runtimeError('E_STATE_MACHINE_RUNTIME_REFERENCE', `Unknown clip ${id}.`); return clip;
  }

  sample(clipId: string, rawTime: number, options: TimelineSampleOptions = {}): TimelineSample {
    this._requireActive(); if (!Number.isFinite(rawTime)) throw runtimeError('E_STATE_MACHINE_RUNTIME_TIME', 'Timeline time must be finite.');
    const clip = this.clip(clipId), playback = options.playback ?? 'one-shot';
    let localTime = options.timeRemap === undefined ? mapPlaybackTime(rawTime, clip.duration, playback) : clamp(options.timeRemap, 0, clip.duration);
    if (clip.quantize && clip.fps) localTime = Math.min(clip.duration, Math.round(localTime * clip.fps) / clip.fps);
    if (clip.workArea) localTime = clamp(localTime, clip.workArea.start, clip.workArea.end);
    const contributions: TimelineContribution[] = [], effects: TimelineEffectOccurrence[] = [];
    for (const track of clip.tracks) {
      const channel = this._channels.get(track.channel); if (!channel) throw runtimeError('E_STATE_MACHINE_RUNTIME_REFERENCE', `Unknown channel ${track.channel}.`);
      if (!matchesMask(channel.id, options.mask)) continue;
      if (channel.valueKind === 'callback') {
        if (options.previousRawTime !== undefined && options.timeRemap === undefined) effects.push(...effectOccurrences(clip, track, channel, options.previousRawTime, rawTime, playback));
        continue;
      }
      contributions.push({
        channel, value: sampleTrack(track, localTime, channel.numericMode), weight: options.weight ?? 1,
        layerOrder: options.layerOrder ?? 0, actionOrder: options.actionOrder ?? 0,
        blendMode: options.blendMode ?? 'override',
      });
    }
    if (options.previousRawTime !== undefined) effects.sort((left, right) => rawTime >= options.previousRawTime! ? left.occurrenceTime - right.occurrenceTime || left.keyIndex - right.keyIndex : right.occurrenceTime - left.occurrenceTime || right.keyIndex - left.keyIndex);
    return { localTime, contributions, effects };
  }

  dispose(): void { if (this._disposed) return; this._disposed = true; this._channels.clear(); this._clips.clear(); }
  private _requireActive(): void { if (this._disposed) throw runtimeError('E_STATE_MACHINE_RUNTIME_DISPOSED', 'Timeline sampler was disposed.'); }
}

export function mapPlaybackTime(rawTime: number, duration: number, playback: PlaybackMode): number {
  if (!(duration > 0)) return 0;
  if (playback === 'one-shot') return clamp(rawTime, 0, duration);
  if (playback === 'loop') return modulo(rawTime, duration);
  const phase = modulo(rawTime, duration * 2); return phase <= duration ? phase : duration * 2 - phase;
}

export function sampleInterpolation(interpolation: RuntimeInterpolation | undefined, alpha: number): number {
  const t = clamp(alpha, 0, 1), kind = interpolation?.kind ?? 'linear';
  if (kind === 'hold') return 0; if (kind === 'linear' || kind === 'cubic-value') return t;
  if (kind === 'cubic-ease') return cubicEase(t, interpolation!.controls!);
  const amplitude = interpolation?.amplitude ?? 1, period = interpolation?.period ?? 0.3, easing = interpolation?.easing ?? 'out';
  const elasticOut = (value: number): number => value === 0 || value === 1 ? value : amplitude * 2 ** (-10 * value) * Math.sin((value - period / 4) * Math.PI * 2 / period) + 1;
  if (easing === 'out') return elasticOut(t); if (easing === 'in') return 1 - elasticOut(1 - t);
  return t < 0.5 ? (1 - elasticOut(1 - t * 2)) / 2 : (1 + elasticOut(t * 2 - 1)) / 2;
}

function sampleTrack(track: RuntimeTrack, time: number, numericMode: RuntimeChannel['numericMode']): RuntimeValue {
  const normalize = (value: RuntimeValue): RuntimeValue => numericMode === 'angle-radians' && typeof value === 'number' ? wrapAngle(value) : cloneValue(value);
  const keys = track.keys; if (time <= keys[0]!.time) return normalize(keys[0]!.value); const last = keys.length - 1; if (time >= keys[last]!.time) return normalize(keys[last]!.value);
  let low = 0, high = last - 1; while (low <= high) { const middle = (low + high) >>> 1; if (time < keys[middle]!.time) high = middle - 1; else if (time >= keys[middle + 1]!.time) low = middle + 1; else return interpolateKeys(keys[middle]!, keys[middle + 1]!, time, numericMode); }
  return normalize(keys[Math.max(0, low)]!.value);
}

function interpolateKeys(first: RuntimeKeyframe, second: RuntimeKeyframe, time: number, numericMode: RuntimeChannel['numericMode']): RuntimeValue {
  const interpolation = first.interpolation, linear = (time - first.time) / (second.time - first.time);
  if (!interpolation || interpolation.kind === 'hold' || !isNumericValue(first.value) || !isNumericValue(second.value)) return numericMode === 'angle-radians' && typeof first.value === 'number' ? wrapAngle(first.value) : cloneValue(first.value);
  if (interpolation.kind === 'cubic-value') {
    const a = asArray(first.value), b = asArray(second.value), out = interpolation.outTangent!, incoming = interpolation.inTangent!, t = clamp(linear, 0, 1), t2 = t * t, t3 = t2 * t;
    const values = a.map((start, index) => (2 * t3 - 3 * t2 + 1) * start + (t3 - 2 * t2 + t) * out[index]! + (-2 * t3 + 3 * t2) * b[index]! + (t3 - t2) * incoming[index]!);
    return Array.isArray(first.value) ? values : numericMode === 'angle-radians' ? wrapAngle(values[0]!) : values[0]!;
  }
  const alpha = sampleInterpolation(interpolation, linear), a = asArray(first.value), b = asArray(second.value), values = a.map((start, index) => start + (numericMode === 'angle-radians' && index === 0 ? wrapAngle(b[index]! - start) : b[index]! - start) * alpha);
  return Array.isArray(first.value) ? values : numericMode === 'angle-radians' ? wrapAngle(values[0]!) : values[0]!;
}

function effectOccurrences(clip: RuntimeClip, track: RuntimeTrack, channel: RuntimeChannel, from: number, to: number, playback: PlaybackMode): TimelineEffectOccurrence[] {
  const stationary = from === to, forward = to > from, minimum = Math.min(from, to), maximum = Math.max(from, to), occurrences: TimelineEffectOccurrence[] = [];
  for (const [keyIndex, key] of track.keys.entries()) for (const occurrence of rawOccurrences(key.time, clip.duration, playback, minimum, maximum)) {
    const crossed = stationary ? occurrence === from : forward ? occurrence > from && occurrence <= to : occurrence < from && occurrence >= to; if (!crossed) continue;
    occurrences.push({ id: `${clip.id}/${track.id}/${keyIndex}@${canonicalNumber(occurrence)}`, channel, clipId: clip.id, trackId: track.id, keyIndex, occurrenceTime: occurrence, payload: cloneValue(key.value) });
  }
  occurrences.sort((left, right) => forward ? left.occurrenceTime - right.occurrenceTime || left.keyIndex - right.keyIndex : right.occurrenceTime - left.occurrenceTime || right.keyIndex - left.keyIndex); return occurrences;
}

function rawOccurrences(keyTime: number, duration: number, playback: PlaybackMode, minimum: number, maximum: number): number[] {
  if (playback === 'one-shot' || duration <= 0) return keyTime >= minimum && keyTime <= maximum ? [keyTime] : [];
  const cycle = playback === 'loop' ? duration : duration * 2, result: number[] = [], start = Math.floor((minimum - cycle) / cycle), end = Math.ceil((maximum + cycle) / cycle);
  for (let index = start; index <= end; index++) {
    const forward = index * cycle + keyTime; if (forward >= minimum && forward <= maximum) result.push(forward);
    if (playback === 'ping-pong' && keyTime !== 0 && keyTime !== duration) { const reverse = index * cycle + cycle - keyTime; if (reverse >= minimum && reverse <= maximum) result.push(reverse); }
  }
  return result;
}

function cubicEase(x: number, controls: readonly [number, number, number, number]): number { let t = x; for (let iteration = 0; iteration < 8; iteration++) { const estimate = cubicCoordinate(t, controls[0], controls[2]) - x, derivative = cubicDerivative(t, controls[0], controls[2]); if (Math.abs(derivative) < 1e-7) break; t = clamp(t - estimate / derivative, 0, 1); } return cubicCoordinate(t, controls[1], controls[3]); }
function cubicCoordinate(t: number, first: number, second: number): number { const inverse = 1 - t; return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t; }
function cubicDerivative(t: number, first: number, second: number): number { const inverse = 1 - t; return 3 * inverse * inverse * first + 6 * inverse * t * (second - first) + 3 * t * t * (1 - second); }
function isNumericValue(value: RuntimeValue): value is number | readonly number[] { return typeof value === 'number' || Array.isArray(value); }
function asArray(value: number | readonly number[]): readonly number[] { return typeof value === 'number' ? [value] : value; }
function cloneValue(value: RuntimeValue): RuntimeValue { if (Array.isArray(value)) return [...value]; if (value && typeof value === 'object') return structuredClone(value); return value; }
function matchesMask(id: string, mask: TimelineSampleOptions['mask']): boolean { if (!mask) return true; if (mask.include && mask.include.length > 0 && !mask.include.includes(id)) return false; return !mask.exclude?.includes(id); }
function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function canonicalNumber(value: number): string { return Object.is(value, -0) ? '0' : Number(value.toFixed(9)).toString(); }
function wrapAngle(value: number): number { const period = Math.PI * 2; let result = (value + Math.PI) % period; if (result < 0) result += period; return result - Math.PI; }
function runtimeError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
