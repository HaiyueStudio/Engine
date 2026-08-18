import {
  ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
  HYA_STATE_MACHINE_EXTENSION_ID,
  parseHyaStateMachineExtension,
  type AnimationAudioComponent,
  type AnimationComponent,
  type AnimationNode,
  type AnimationParticle2DComponent,
  type AnimationSprite2DComponent,
  type AnimationVectorShapeComponent,
  type AnimationVectorValueTrack,
  type HyaAnimationClipRange,
  type HyaStateMachineExtension,
  type ParsedAnimation,
  type ParsedAnimationTrack,
} from '@haiyue/animation-spec';
import type {
  Animation2DBinding,
  Animation2DClip,
  Animation2DDiscreteTrack,
  Animation2DEffectCue,
  Animation2DNumericTrack,
} from './runtime/mixer/index.js';
import {
  AnimationStateMachineChannelError,
  assertAudioStateMachineCompatible,
  hyaStateMachineChannelCapability,
  type AnimationStateMachineChannelDiagnostic,
} from '../animation-state-machine/AnimationStateMachineChannels.js';

// HYA v2 keeps track times in Float32 while clip ranges remain JSON numbers.
// At ordinary multi-second timestamps the Float32 ULP is already larger than
// 1e-7, so boundary comparisons must absorb that representation difference.
const TIME_EPSILON = 1e-6;

/** Returns the canonical built-in state-machine payload from a parsed HYA document. */
export function getHyaStateMachineExtension(
  animation: ParsedAnimation,
): HyaStateMachineExtension {
  const value = animation.extensions[HYA_STATE_MACHINE_EXTENSION_ID];
  if (value === undefined) {
    throw new RangeError(
      `HYA document does not contain the built-in "${HYA_STATE_MACHINE_EXTENSION_ID}" extension.`,
    );
  }
  return parseHyaStateMachineExtension(value, animation.duration);
}

/**
 * Adapts named ranges from one HYA composition into source-independent 2D
 * clips. The returned clips share no scene objects; one pose is applied to one
 * Animation2DRuntime hierarchy by the state-machine runtime.
 */
export function createHyaAnimation2DClips(
  animation: ParsedAnimation,
  extension: HyaStateMachineExtension = getHyaStateMachineExtension(animation),
): readonly Animation2DClip[] {
  assertChannelCompatibleDocument(animation, extension);
  const nodesById = new Map(animation.nodes.map(node => [node.id, node]));
  return Object.freeze(extension.clips.map(range => createClip(animation, range, nodesById)));
}

export interface HyaAnimation2DEffectPayload {
  readonly targetId: string;
  readonly slot: number;
  readonly sourcePath: string;
  readonly component: Readonly<AnimationParticle2DComponent | AnimationAudioComponent>;
}

function createClip(
  animation: ParsedAnimation,
  range: HyaAnimationClipRange,
  nodesById: ReadonlyMap<string, Readonly<AnimationNode>>,
): Animation2DClip {
  const runtimeDuration = Math.fround(range.duration);
  const tracks: Array<Animation2DNumericTrack | Animation2DDiscreteTrack> = [];
  const effects: Animation2DEffectCue[] = [];
  for (let index = 0; index < animation.tracks.length; index++) {
    const source = animation.tracks[index]!;
    const node = nodesById.get(source.node)!;
    tracks.push(sliceNumericTrack(source, node, range, runtimeDuration, index));
  }
  for (let index = 0; index < animation.nodes.length; index++) {
    const node = animation.nodes[index]!;
    tracks.push(createVisibilityTrack(node, range, animation.duration, index));
    appendComponentChannels(node, index, range, runtimeDuration, tracks, effects, animation.duration);
  }
  return Object.freeze({
    format: 'haiyue-animation2d-clip@1',
    id: range.id,
    name: range.name ?? range.id,
    duration: runtimeDuration,
    tracks: Object.freeze(tracks),
    ...(effects.length === 0 ? {} : { effects: Object.freeze(effects) }),
  });
}

function appendComponentChannels(
  node: Readonly<AnimationNode>,
  nodeIndex: number,
  range: HyaAnimationClipRange,
  runtimeDuration: number,
  tracks: Array<Animation2DNumericTrack | Animation2DDiscreteTrack>,
  effects: Animation2DEffectCue[],
  compositionDuration: number,
): void {
  let particleSlot = 0;
  let audioSlot = 0;
  const components = node.components ?? [];
  for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
    const component = components[componentIndex]!;
    const path = `$.nodes[${nodeIndex}].components[${componentIndex}]`;
    if (component.type === 'sprite2d') {
      const sprite = component as Readonly<AnimationSprite2DComponent>;
      if (!sprite.uvRectTrack) continue;
      tracks.push(sliceStepVectorTrack(
        sprite.uvRectTrack,
        range,
        runtimeDuration,
        `${range.id}:component:${nodeIndex}:${componentIndex}:sprite-uv`,
        Object.freeze({
          id: `${node.id}.components.${componentIndex}.sprite.uv-rect`,
          targetId: node.id,
          path: `components.${componentIndex}.sprite.uv-rect`,
          strategy: 'discrete',
          defaultValue: Object.freeze([...(sprite.uvRect ?? [0, 0, 1, 1])]),
        }),
      ));
    } else if (component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID) {
      const vector = component as Readonly<AnimationVectorShapeComponent>;
      if (!vector.morph) continue;
      tracks.push(sliceComponentNumericTrack(
        vector.morph,
        range,
        runtimeDuration,
        `${range.id}:component:${nodeIndex}:${componentIndex}:vector-morph`,
        Object.freeze({
          id: `${node.id}.components.${componentIndex}.vector.morph`,
          targetId: node.id,
          path: `components.${componentIndex}.vector.morph`,
          strategy: 'continuous',
          valueSize: vector.morph.valueSize,
          defaultValue: vector.morphRelative
            ? new Float32Array(vector.morph.valueSize)
            : Object.freeze(Array.from(vector.values)),
        }),
        `${path}.morph`,
      ));
    } else if (component.type === 'org.haiyue.vector-path-morph@1') {
      const morph = component as unknown as AnimationVectorValueTrack;
      tracks.push(sliceComponentNumericTrack(
        morph,
        range,
        runtimeDuration,
        `${range.id}:component:${nodeIndex}:${componentIndex}:path-morph`,
        Object.freeze({
          id: `${node.id}.components.${componentIndex}.path.morph`,
          targetId: node.id,
          path: `components.${componentIndex}.path.morph`,
          strategy: 'continuous',
          valueSize: morph.valueSize,
          defaultValue: Object.freeze(Array.from(morph.values).slice(0, morph.valueSize)),
        }),
        path,
      ));
    }

    if (component.type === 'particle2d') {
      appendEffectCue(
        'particle',
        component as Readonly<AnimationParticle2DComponent>,
        particleSlot++,
        node,
        path,
        range,
        effects,
        compositionDuration,
      );
    } else if (component.type === 'audio') {
      appendEffectCue(
        'audio',
        component as Readonly<AnimationAudioComponent>,
        audioSlot++,
        node,
        path,
        range,
        effects,
        compositionDuration,
      );
    }
  }
}

function appendEffectCue(
  kind: 'particle' | 'audio',
  component: Readonly<AnimationParticle2DComponent | AnimationAudioComponent>,
  slot: number,
  node: Readonly<AnimationNode>,
  sourcePath: string,
  range: HyaAnimationClipRange,
  effects: Animation2DEffectCue[],
  compositionDuration: number,
): void {
  const nodeStart = node.start ?? 0;
  const nodeEnd = nodeStart + (node.duration ?? compositionDuration - nodeStart);
  const start = Math.max(nodeStart, range.start);
  const end = Math.min(nodeEnd, range.start + range.duration);
  if (end <= start + TIME_EPSILON) return;
  const payload: HyaAnimation2DEffectPayload = Object.freeze({
    targetId: node.id,
    slot,
    sourcePath,
    component,
  });
  effects.push(Object.freeze({
    id: `${range.id}:${kind}:${node.id}:${slot}`,
    kind,
    start: Math.max(0, Math.fround(start - range.start)),
    end: Math.min(Math.fround(range.duration), Math.fround(end - range.start)),
    loopBehavior: kind === 'particle' ? 'restart' : 'continue',
    payload,
  }));
}

function sliceNumericTrack(
  source: ParsedAnimationTrack,
  node: Readonly<AnimationNode>,
  range: HyaAnimationClipRange,
  runtimeDuration: number,
  sourceIndex: number,
): Animation2DNumericTrack {
  const globalTimes = collectTrackTimes(source, range);
  const times = new Float32Array(globalTimes.length);
  const values = new Float32Array(globalTimes.length * source.valueSize);
  for (let key = 0; key < globalTimes.length; key++) {
    times[key] = key === 0
      ? 0
      : key === globalTimes.length - 1
        ? runtimeDuration
        : Math.min(runtimeDuration, Math.max(0, Math.fround(globalTimes[key]! - range.start)));
    sampleTrack(source, globalTimes[key]!, values, key * source.valueSize);
  }
  assertStrictFloatTimes(times, `${range.id}:${source.node}:${source.property}`);

  const binding = createNumericBinding(source, node);
  const interpolation = source.times.length < 2 ? 'step' : source.interpolation;
  const easings = interpolation === 'cubic-bezier'
    ? sliceEasings(source, globalTimes)
    : undefined;
  const spatialTangents = source.spatialTangents
    ? sliceSpatialTangents(source, globalTimes)
    : undefined;
  return Object.freeze({
    id: `${range.id}:track:${sourceIndex}`,
    binding,
    interpolation,
    times,
    values,
    ...(easings ? { easings } : {}),
    ...(spatialTangents ? { spatialTangents } : {}),
  });
}

function createNumericBinding(
  track: ParsedAnimationTrack,
  node: Readonly<AnimationNode>,
): Animation2DBinding {
  const transform = node.transform;
  const path = track.property === 'opacity'
    ? 'opacity'
    : `transform.${track.property}`;
  const defaultValue = track.property === 'position'
    ? transform?.position ?? [0, 0]
    : track.property === 'scale'
      ? transform?.scale ?? [1, 1]
      : track.property === 'rotation'
        ? [transform?.rotation ?? 0]
        : [transform?.opacity ?? 1];
  return Object.freeze({
    id: `${node.id}.${path}`,
    targetId: node.id,
    path,
    strategy: track.property === 'rotation' ? 'rotation' : 'continuous',
    valueSize: track.valueSize,
    defaultValue: Object.freeze(Array.from(defaultValue)),
  });
}

function sliceComponentNumericTrack(
  source: Readonly<AnimationVectorValueTrack>,
  range: HyaAnimationClipRange,
  runtimeDuration: number,
  id: string,
  binding: Animation2DBinding,
  debugPath: string,
): Animation2DNumericTrack {
  const track = vectorTrackAsParsedTrack(source, debugPath);
  const globalTimes = collectTrackTimes(track, range);
  const times = new Float32Array(globalTimes.length);
  const values = new Float32Array(globalTimes.length * source.valueSize);
  for (let key = 0; key < globalTimes.length; key++) {
    times[key] = key === 0
      ? 0
      : key === globalTimes.length - 1
        ? runtimeDuration
        : Math.min(runtimeDuration, Math.max(0, Math.fround(globalTimes[key]! - range.start)));
    sampleTrack(track, globalTimes[key]!, values, key * source.valueSize);
  }
  assertStrictFloatTimes(times, id);
  const interpolation = source.times.length < 2 ? 'step' : source.interpolation;
  const easings = interpolation === 'cubic-bezier'
    ? sliceEasings(track, globalTimes)
    : undefined;
  return Object.freeze({
    id,
    binding,
    interpolation,
    times,
    values,
    ...(easings ? { easings } : {}),
  });
}

function sliceStepVectorTrack(
  source: Readonly<AnimationVectorValueTrack>,
  range: HyaAnimationClipRange,
  runtimeDuration: number,
  id: string,
  binding: Animation2DBinding,
): Animation2DDiscreteTrack {
  const globalTimes = collectVectorTrackTimes(source, range);
  const times = new Float32Array(globalTimes.length);
  const values: unknown[] = [];
  for (let key = 0; key < globalTimes.length; key++) {
    times[key] = key === 0
      ? 0
      : key === globalTimes.length - 1
        ? runtimeDuration
        : Math.min(runtimeDuration, Math.max(0, Math.fround(globalTimes[key]! - range.start)));
    const frame = findArraySegment(source.times, globalTimes[key]!);
    const offset = frame * source.valueSize;
    const sampled = new Float32Array(source.valueSize);
    for (let component = 0; component < source.valueSize; component++) {
      sampled[component] = source.values[offset + component] ?? 0;
    }
    values.push(sampled);
  }
  assertStrictFloatTimes(times, id);
  return Object.freeze({
    id,
    binding,
    interpolation: 'step',
    times,
    values: Object.freeze(values),
  });
}

function collectVectorTrackTimes(
  track: Readonly<AnimationVectorValueTrack>,
  range: HyaAnimationClipRange,
): number[] {
  const end = range.start + range.duration;
  const result = [range.start];
  for (let index = 0; index < track.times.length; index++) {
    const time = track.times[index]!;
    if (time > range.start + TIME_EPSILON && time < end - TIME_EPSILON) result.push(time);
  }
  result.push(end);
  return result;
}

function vectorTrackAsParsedTrack(
  source: Readonly<AnimationVectorValueTrack>,
  debugPath: string,
): ParsedAnimationTrack {
  return {
    node: debugPath,
    property: 'opacity',
    interpolation: source.interpolation,
    times: source.times instanceof Float32Array ? source.times : Float32Array.from(source.times),
    values: source.values instanceof Float32Array ? source.values : Float32Array.from(source.values),
    valueSize: source.valueSize as ParsedAnimationTrack['valueSize'],
    ...(source.easings === undefined ? {} : {
      easings: source.easings instanceof Float32Array
        ? source.easings
        : Float32Array.from(source.easings),
    }),
  };
}

function findArraySegment(times: ArrayLike<number>, time: number): number {
  if (times.length <= 1 || time <= times[0]!) return 0;
  if (time >= times[times.length - 1]!) return times.length - 1;
  let low = 0;
  let high = times.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! <= time) low = middle;
    else high = middle;
  }
  return low;
}

function createVisibilityTrack(
  node: Readonly<AnimationNode>,
  range: HyaAnimationClipRange,
  compositionDuration: number,
  nodeIndex: number,
): Animation2DDiscreteTrack {
  const nodeStart = node.start ?? 0;
  const nodeEnd = nodeStart + (node.duration ?? compositionDuration - nodeStart);
  const globalTimes = [range.start];
  if (nodeStart > range.start + TIME_EPSILON && nodeStart < range.start + range.duration - TIME_EPSILON) {
    globalTimes.push(nodeStart);
  }
  if (nodeEnd > range.start + TIME_EPSILON && nodeEnd < range.start + range.duration - TIME_EPSILON) {
    globalTimes.push(nodeEnd);
  }
  globalTimes.sort((left, right) => left - right);
  const times = new Float32Array(globalTimes.length);
  const values = new Array<boolean>(globalTimes.length);
  for (let index = 0; index < globalTimes.length; index++) {
    const globalTime = globalTimes[index]!;
    times[index] = Math.fround(globalTime - range.start);
    values[index] = globalTime >= nodeStart - TIME_EPSILON && globalTime < nodeEnd - TIME_EPSILON;
  }
  assertStrictFloatTimes(times, `${range.id}:${node.id}:visibility`);
  return Object.freeze({
    id: `${range.id}:visibility:${nodeIndex}`,
    binding: Object.freeze({
      id: `${node.id}.visibility`,
      targetId: node.id,
      path: 'visibility',
      strategy: 'discrete',
      defaultValue: true,
    }),
    interpolation: 'step',
    times,
    values: Object.freeze(values),
  });
}

function collectTrackTimes(
  track: ParsedAnimationTrack,
  range: HyaAnimationClipRange,
): number[] {
  const end = range.start + range.duration;
  const result = [range.start];
  for (let index = 0; index < track.times.length; index++) {
    const time = track.times[index]!;
    if (time > range.start + TIME_EPSILON && time < end - TIME_EPSILON) result.push(time);
  }
  result.push(end);
  return result;
}

function sampleTrack(
  track: ParsedAnimationTrack,
  time: number,
  output: Float32Array,
  outputOffset: number,
): void {
  const segment = findSegment(track.times, time);
  const startOffset = segment * track.valueSize;
  const endOffset = Math.min(segment + 1, track.times.length - 1) * track.valueSize;
  let progress = 0;
  if (segment < track.times.length - 1 && track.interpolation !== 'step') {
    const start = track.times[segment]!;
    const end = track.times[segment + 1]!;
    const linear = Math.min(1, Math.max(0, (time - start) / Math.max(TIME_EPSILON, end - start)));
    progress = track.interpolation === 'cubic-bezier'
      ? cubicBezierYForX(track.easings!, segment, linear)
      : linear;
  }
  if (track.spatialTangents && segment < track.times.length - 1) {
    const tangentOffset = segment * 4;
    for (let component = 0; component < 2; component++) {
      const start = track.values[startOffset + component]!;
      const end = track.values[endOffset + component]!;
      output[outputOffset + component] = spatialCoordinate(
        progress,
        start,
        start + track.spatialTangents[tangentOffset + component]!,
        end + track.spatialTangents[tangentOffset + 2 + component]!,
        end,
      );
    }
    return;
  }
  for (let component = 0; component < track.valueSize; component++) {
    const start = track.values[startOffset + component]!;
    output[outputOffset + component] = start
      + (track.values[endOffset + component]! - start) * progress;
  }
}

function sliceSpatialTangents(track: ParsedAnimationTrack, globalTimes: readonly number[]): Float32Array {
  const result = new Float32Array(Math.max(0, globalTimes.length - 1) * 4);
  for (let interval = 0; interval < globalTimes.length - 1; interval++) {
    const startTime = globalTimes[interval]!;
    const endTime = globalTimes[interval + 1]!;
    const midpoint = (startTime + endTime) * 0.5;
    const sourceSegment = findSegment(track.times, midpoint);
    if (sourceSegment >= track.times.length - 1) continue;
    const sourceStartTime = track.times[sourceSegment]!;
    const sourceEndTime = track.times[sourceSegment + 1]!;
    if (endTime <= sourceStartTime + TIME_EPSILON || startTime >= sourceEndTime - TIME_EPSILON) continue;
    const linearStart = clamp01((startTime - sourceStartTime) / (sourceEndTime - sourceStartTime));
    const linearEnd = clamp01((endTime - sourceStartTime) / (sourceEndTime - sourceStartTime));
    const progressStart = track.interpolation === 'cubic-bezier'
      ? cubicBezierYForX(track.easings!, sourceSegment, linearStart)
      : linearStart;
    const progressEnd = track.interpolation === 'cubic-bezier'
      ? cubicBezierYForX(track.easings!, sourceSegment, linearEnd)
      : linearEnd;
    const valueOffset = sourceSegment * 2;
    const tangentOffset = sourceSegment * 4;
    const delta = progressEnd - progressStart;
    for (let component = 0; component < 2; component++) {
      const start = track.values[valueOffset + component]!;
      const end = track.values[valueOffset + 2 + component]!;
      const control1 = start + track.spatialTangents![tangentOffset + component]!;
      const control2 = end + track.spatialTangents![tangentOffset + 2 + component]!;
      const derivativeStart = spatialDerivative(progressStart, start, control1, control2, end);
      const derivativeEnd = spatialDerivative(progressEnd, start, control1, control2, end);
      result[interval * 4 + component] = derivativeStart * delta / 3;
      result[interval * 4 + 2 + component] = -derivativeEnd * delta / 3;
    }
  }
  return result;
}

function spatialCoordinate(value: number, start: number, first: number, second: number, end: number): number {
  const inverse = 1 - value;
  return inverse * inverse * inverse * start
    + 3 * inverse * inverse * value * first
    + 3 * inverse * value * value * second
    + value * value * value * end;
}

function spatialDerivative(value: number, start: number, first: number, second: number, end: number): number {
  const inverse = 1 - value;
  return 3 * inverse * inverse * (first - start)
    + 6 * inverse * value * (second - first)
    + 3 * value * value * (end - second);
}

function sliceEasings(track: ParsedAnimationTrack, globalTimes: readonly number[]): Float32Array {
  const result = new Float32Array(Math.max(0, globalTimes.length - 1) * 4);
  for (let interval = 0; interval < globalTimes.length - 1; interval++) {
    const startTime = globalTimes[interval]!;
    const endTime = globalTimes[interval + 1]!;
    const firstSourceTime = track.times[0]!;
    const lastSourceTime = track.times[track.times.length - 1]!;
    if (track.times.length < 2
      || endTime <= firstSourceTime + TIME_EPSILON
      || startTime >= lastSourceTime - TIME_EPSILON) {
      result.set([1 / 3, 1 / 3, 2 / 3, 2 / 3], interval * 4);
      continue;
    }
    const sourceSegment = findSegment(track.times, (startTime + endTime) * 0.5);
    const sourceStart = track.times[sourceSegment]!;
    const sourceEnd = track.times[sourceSegment + 1]!;
    const duration = sourceEnd - sourceStart;
    const xStart = Math.min(1, Math.max(0, (startTime - sourceStart) / duration));
    const xEnd = Math.min(1, Math.max(0, (endTime - sourceStart) / duration));
    const easingOffset = sourceSegment * 4;
    const subcurve = sliceCubicBezier(
      track.easings![easingOffset]!,
      track.easings![easingOffset + 1]!,
      track.easings![easingOffset + 2]!,
      track.easings![easingOffset + 3]!,
      xStart,
      xEnd,
      track,
      sourceSegment,
    );
    result.set(subcurve, interval * 4);
  }
  return result;
}

function sliceCubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  xStart: number,
  xEnd: number,
  track: ParsedAnimationTrack,
  sourceSegment: number,
): readonly [number, number, number, number] {
  if (xStart <= TIME_EPSILON && xEnd >= 1 - TIME_EPSILON) return [x1, y1, x2, y2];
  const t0 = solveCubicX(xStart, x1, x2);
  const t1 = solveCubicX(xEnd, x1, x2);
  const start = cubicPoint(t0, x1, y1, x2, y2);
  const end = cubicPoint(t1, x1, y1, x2, y2);
  const delta = t1 - t0;
  const startDerivative = cubicPointDerivative(t0, x1, y1, x2, y2);
  const endDerivative = cubicPointDerivative(t1, x1, y1, x2, y2);
  const control1 = [start[0] + startDerivative[0] * delta / 3, start[1] + startDerivative[1] * delta / 3] as const;
  const control2 = [end[0] - endDerivative[0] * delta / 3, end[1] - endDerivative[1] * delta / 3] as const;
  const width = end[0] - start[0];
  const height = end[1] - start[1];
  if (Math.abs(height) <= 1e-8) {
    if (sourceSegmentHasMotion(track, sourceSegment)) {
      throw new RangeError(
        `HYA cubic track "${track.node}.${track.property}" cannot be range-sliced at a zero-progress easing interval without losing fidelity.`,
      );
    }
    return [1 / 3, 1 / 3, 2 / 3, 2 / 3];
  }
  return [
    clamp01((control1[0] - start[0]) / width),
    (control1[1] - start[1]) / height,
    clamp01((control2[0] - start[0]) / width),
    (control2[1] - start[1]) / height,
  ];
}

function sourceSegmentHasMotion(track: ParsedAnimationTrack, segment: number): boolean {
  const start = segment * track.valueSize;
  const end = (segment + 1) * track.valueSize;
  for (let component = 0; component < track.valueSize; component++) {
    if (Math.abs(track.values[start + component]! - track.values[end + component]!) > 1e-8) return true;
  }
  return false;
}

function findSegment(times: Float32Array, time: number): number {
  if (times.length <= 1 || time <= times[0]!) return 0;
  if (time >= times[times.length - 1]!) return times.length - 1;
  let low = 0;
  let high = times.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! <= time) low = middle;
    else high = middle;
  }
  return low;
}

function cubicBezierYForX(easings: Float32Array, segment: number, x: number): number {
  const offset = segment * 4;
  const x1 = easings[offset]!;
  const y1 = easings[offset + 1]!;
  const x2 = easings[offset + 2]!;
  const y2 = easings[offset + 3]!;
  return cubicCoordinate(solveCubicX(x, x1, x2), y1, y2);
}

function solveCubicX(x: number, x1: number, x2: number): number {
  let parameter = x;
  for (let iteration = 0; iteration < 6; iteration++) {
    const estimate = cubicCoordinate(parameter, x1, x2) - x;
    const derivative = cubicDerivative(parameter, x1, x2);
    if (Math.abs(derivative) < 1e-7) break;
    parameter = clamp01(parameter - estimate / derivative);
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration++) {
    const estimate = cubicCoordinate(parameter, x1, x2);
    if (Math.abs(estimate - x) < 1e-8) break;
    if (estimate < x) low = parameter;
    else high = parameter;
    parameter = (low + high) * 0.5;
  }
  return parameter;
}

function cubicPoint(
  value: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): readonly [number, number] {
  return [cubicCoordinate(value, x1, x2), cubicCoordinate(value, y1, y2)];
}

function cubicPointDerivative(
  value: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): readonly [number, number] {
  return [cubicDerivative(value, x1, x2), cubicDerivative(value, y1, y2)];
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

function assertChannelCompatibleDocument(
  animation: ParsedAnimation,
  extension: HyaStateMachineExtension,
): void {
  let hasAudio = false;
  for (let nodeIndex = 0; nodeIndex < animation.nodes.length; nodeIndex++) {
    const node = animation.nodes[nodeIndex]!;
    const components = node.components ?? [];
    for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
      const component = components[componentIndex]!;
      const path = `$.nodes[${nodeIndex}].components[${componentIndex}]`;
      if (component.type === 'audio') hasAudio = true;
      const unsupported = unsupportedInlineChannel(component, path);
      if (unsupported) throw new AnimationStateMachineChannelError(unsupported);
    }
    for (let effectIndex = 0; effectIndex < (node.effects?.length ?? 0); effectIndex++) {
      const effect = node.effects![effectIndex]! as unknown as Readonly<Record<string, unknown>>;
      if (Object.keys(effect).some(key => key.endsWith('Track'))) {
        throw new AnimationStateMachineChannelError(unsupportedDiagnostic(
          'visual-effect',
          `$.nodes[${nodeIndex}].effects[${effectIndex}]`,
          'Animated visual-effect properties are not yet writable from the shared pose buffer.',
        ));
      }
    }
    const composites = node.composite
      ? ('layers' in node.composite ? node.composite.layers : [node.composite])
      : [];
    for (let compositeIndex = 0; compositeIndex < composites.length; compositeIndex++) {
      if (composites[compositeIndex]!.expansionTrack) {
        throw new AnimationStateMachineChannelError(unsupportedDiagnostic(
          'composite-expansion',
          `$.nodes[${nodeIndex}].composite.layers[${compositeIndex}].expansionTrack`,
          'Animated composite expansion is not yet writable from the shared pose buffer.',
        ));
      }
    }
  }
  if (hasAudio) {
    assertAudioStateMachineCompatible(
      extension.stateMachine,
      `$.extensions.${HYA_STATE_MACHINE_EXTENSION_ID}.stateMachine`,
    );
  }
}

function unsupportedInlineChannel(
  component: Readonly<AnimationComponent>,
  path: string,
): AnimationStateMachineChannelDiagnostic | null {
  if (component.type === 'shape2d'
    || component.type === 'path2d'
    || component.type === 'sprite2d'
    || component.type === 'particle2d'
    || component.type === 'audio'
    || component.type === 'org.haiyue.vector-stroke@1'
    || component.type === 'org.haiyue.vector-path-morph@1') return null;

  if (component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID) {
    const vector = component as Readonly<AnimationVectorShapeComponent>;
    if (vectorHasUnsupportedInlineTrack(vector)) {
      return unsupportedDiagnostic(
        'vector-paint',
        path,
        'Vector paint and modifier tracks are not yet writable from the shared pose buffer; vector morph is supported.',
      );
    }
    return null;
  }
  if (component.type === 'text2d') {
    const text = component as Readonly<Record<string, unknown>>;
    const documents = text.documents as readonly unknown[] | undefined;
    const animators = text.animators as readonly Readonly<Record<string, unknown>>[] | undefined;
    if ((documents?.length ?? 0) > 1 || animators?.some(recordHasNestedTrack)) {
      return unsupportedDiagnostic(
        'text-animator',
        path,
        'Animated text documents and animator tracks are not yet writable from the shared pose buffer.',
      );
    }
    return null;
  }
  return unsupportedDiagnostic(
    'visual-effect',
    path,
    `Component "${component.type}" has no registered state-machine channel strategy.`,
  );
}

function vectorHasUnsupportedInlineTrack(vector: Readonly<AnimationVectorShapeComponent>): boolean {
  const fill = vector.fill;
  if (fill) {
    if (fill.kind === 'solid') {
      if (fill.colorTrack || fill.opacityTrack) return true;
    } else if (fill.startTrack || fill.endTrack || fill.stopsTrack || fill.opacityTrack) return true;
  }
  const stroke = vector.stroke;
  if (stroke && (stroke.colorTrack || stroke.opacityTrack || stroke.widthTrack || stroke.dashOffsetTrack
    || (stroke.gradient && (stroke.gradient.startTrack || stroke.gradient.endTrack
      || stroke.gradient.stopsTrack || stroke.gradient.opacityTrack)))) return true;
  return vector.modifiers?.some(modifier => modifier.kind === 'round-corners'
    ? modifier.radiusTrack !== undefined
    : modifier.startTrack !== undefined || modifier.endTrack !== undefined
      || modifier.offsetTrack !== undefined) ?? false;
}

function recordHasNestedTrack(record: Readonly<Record<string, unknown>>): boolean {
  if (Object.keys(record).some(key => key.endsWith('Track'))) return true;
  return Object.values(record).some(value => value !== null && typeof value === 'object'
    && !Array.isArray(value)
    && recordHasNestedTrack(value as Readonly<Record<string, unknown>>));
}

function unsupportedDiagnostic(
  channelId: 'vector-paint' | 'text-animator' | 'visual-effect' | 'composite-expansion',
  path: string,
  message: string,
): AnimationStateMachineChannelDiagnostic {
  return Object.freeze({
    code: hyaStateMachineChannelCapability(channelId).diagnosticCode!,
    severity: 'error',
    channelId,
    path,
    message,
  });
}

function assertStrictFloatTimes(times: Float32Array, trackId: string): void {
  for (let index = 1; index < times.length; index++) {
    if (times[index]! <= times[index - 1]!) {
      throw new RangeError(
        `HYA state-machine clip "${trackId}" has time keys that collapse after Float32 conversion.`,
      );
    }
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
