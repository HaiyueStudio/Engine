import type { AnimationTrack } from '../../types.js';
import type { RiveBakedTrackPlan, RiveConversionLimits, RiveExtremaRequest, RiveSampleRequest, RiveVisualEvaluator } from './types.js';
import { conversionFail, throwIfAborted } from './diagnostics.js';
import { compareUtf8 } from './stable.js';

interface SamplePoint { readonly time: number; readonly value: readonly number[]; }
interface Segment { readonly left: number; readonly right: number; readonly depth: number; }

export async function sampleBakedTracks(plans: readonly RiveBakedTrackPlan[], evaluator: RiveVisualEvaluator | undefined, limits: RiveConversionLimits, signal: AbortSignal): Promise<readonly AnimationTrack[]> {
  if (plans.length === 0) return Object.freeze([]);
  if (!evaluator) conversionFail('E_RIVE_CONVERT_ORACLE_REQUIRED', 'Visual-baked tracks require the pinned build-time evaluator.', '$.options.evaluator');
  const ids = new Set<string>();
  const ordered = [...plans].sort((left, right) => compareUtf8(left.id, right.id));
  for (let index = 0; index < ordered.length; index++) validatePlan(ordered[index]!, index, ids);
  if (typeof evaluator.extrema !== 'function') conversionFail('E_RIVE_CONVERT_ORACLE_REQUIRED', 'Visual-baked tracks require a complete extrema oracle.', '$.options.evaluator.extrema');
  const tracks: AnimationTrack[] = [];
  for (const plan of ordered) {
    throwIfAborted(signal);
    tracks.push(await sampleTrack(plan, evaluator, limits, signal));
  }
  return Object.freeze(tracks);
}

function validatePlan(plan: RiveBakedTrackPlan, index: number, ids: Set<string>): void {
  const path = `$.evaluation.bakedTracks[${index}]`;
  const planKeys = new Set(['id', 'node', 'property', 'duration', 'tolerance', 'valueQuantum', 'timeQuantum', 'maxDepth', 'deterministicVisual', 'observables']);
  for (const key of Object.keys(plan)) if (!planKeys.has(key)) conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', `Unknown baked-track field "${key}".`, `${path}.${key}`);
  const observableKeys = new Set(['input', 'data', 'layoutResize', 'event', 'audio', 'semantics', 'script', 'resourceReplacement', 'stateExposure']);
  for (const key of Object.keys(plan.observables)) if (!observableKeys.has(key)) conversionFail('E_RIVE_CONVERT_UNCLASSIFIED', `Unknown baking observable "${key}".`, `${path}.observables.${key}`);
  if (Object.keys(plan.observables).length !== observableKeys.size || Object.values(plan.observables).some(value => typeof value !== 'boolean')) conversionFail('E_RIVE_CONVERT_FORMAT', 'Every baking observable must be an explicit boolean.', `${path}.observables`);
  if (!plan.id || ids.has(plan.id)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Baked track id is empty or duplicated.', `${path}.id`); ids.add(plan.id);
  if (!(plan.duration > 0) || !Number.isFinite(plan.duration)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Baked track duration must be positive and finite.', `${path}.duration`);
  if (!(plan.tolerance > 0) || !Number.isFinite(plan.tolerance)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Baked track tolerance must be positive and finite.', `${path}.tolerance`);
  if (!(plan.valueQuantum > 0) || plan.valueQuantum > plan.tolerance / 2) conversionFail('E_RIVE_CONVERT_FORMAT', 'Value quantum must be positive and no greater than half the error tolerance.', `${path}.valueQuantum`);
  if (!(plan.timeQuantum > 0) || plan.timeQuantum > plan.duration / 2) conversionFail('E_RIVE_CONVERT_FORMAT', 'Time quantum is outside the composition interval.', `${path}.timeQuantum`);
  if (!Number.isSafeInteger(plan.maxDepth) || plan.maxDepth < 0 || plan.maxDepth > 20) conversionFail('E_RIVE_CONVERT_LIMIT', 'Adaptive sampling maxDepth must be an integer in [0, 20].', `${path}.maxDepth`);
  if (plan.deterministicVisual !== true) conversionFail('E_RIVE_CONVERT_BAKING_INELIGIBLE', 'Baking requires deterministic visual output.', `${path}.deterministicVisual`);
  const active = Object.entries(plan.observables).filter(([, enabled]) => enabled).map(([name]) => name);
  if (active.length > 0) conversionFail('E_RIVE_CONVERT_BAKING_INELIGIBLE', `Visual baking would discard observable behavior: ${active.join(', ')}.`, `${path}.observables`);
}

async function sampleTrack(plan: RiveBakedTrackPlan, evaluator: RiveVisualEvaluator, limits: RiveConversionLimits, signal: AbortSignal): Promise<AnimationTrack> {
  const expectedSize = plan.property === 'position' || plan.property === 'scale' ? 2 : 1;
  const samples = new Map<number, readonly number[]>();
  await evaluateTimes(plan, [0, plan.duration], expectedSize, evaluator, samples, limits, signal);
  let active: Segment[] = [{ left: 0, right: plan.duration, depth: 0 }];
  while (active.length > 0) {
    throwIfAborted(signal);
    const requested = new Set<number>();
    const extremaBySegment = await evaluateExtrema(plan, active, evaluator, signal);
    for (const segment of active) {
      const span = segment.right - segment.left;
      requested.add(segment.left + span * 0.25); requested.add(segment.left + span * 0.5); requested.add(segment.left + span * 0.75);
      for (const time of extremaBySegment.get(segmentKey(segment)) ?? []) requested.add(time);
    }
    await evaluateTimes(plan, [...requested], expectedSize, evaluator, samples, limits, signal);
    const next: Segment[] = [];
    for (const segment of active) {
      const left = samples.get(segment.left)!, right = samples.get(segment.right)!;
      const span = segment.right - segment.left;
      const probes = [0.25, 0.5, 0.75].map(fraction => ({ fraction, time: segment.left + span * fraction }));
      const extrema = (extremaBySegment.get(segmentKey(segment)) ?? []).map(time => ({ time, fraction: (time - segment.left) / span }));
      const error = Math.max(...[...probes, ...extrema].map(probe => vectorError(samples.get(probe.time)!, lerp(left, right, probe.fraction))));
      if (error <= plan.tolerance) continue;
      if (segment.depth >= plan.maxDepth) conversionFail('E_RIVE_CONVERT_LIMIT', `Adaptive sampling cannot satisfy tolerance ${plan.tolerance}; observed error ${error}.`, `$.evaluation.bakedTracks[id=${plan.id}]`);
      const boundaries = [segment.left, ...probes.map(probe => probe.time), segment.right];
      for (let index = 0; index < 4; index++) next.push({ left: boundaries[index]!, right: boundaries[index + 1]!, depth: segment.depth + 1 });
    }
    active = next;
  }
  const all = [...samples.entries()].map(([time, value]) => ({ time, value })).sort((left, right) => left.time - right.time);
  let sparse = quantizeAndMerge(sparsify(all, plan.tolerance / 2), plan, expectedSize);
  if (maximumEncodedError(all, sparse) > plan.tolerance) sparse = quantizeAndMerge(all, plan, expectedSize);
  verifyError(all, sparse, plan.tolerance, plan.id);
  return Object.freeze({
    node: plan.node, property: plan.property, interpolation: 'linear',
    times: Object.freeze(sparse.map(point => point.time)),
    values: Object.freeze(sparse.flatMap(point => [...point.value])),
  });
}

async function evaluateExtrema(plan: RiveBakedTrackPlan, segments: readonly Segment[], evaluator: RiveVisualEvaluator, signal: AbortSignal): Promise<ReadonlyMap<string, readonly number[]>> {
  const requests: RiveExtremaRequest[] = segments.map(segment => Object.freeze({ trackId: plan.id, start: segment.left, end: segment.right }));
  let results;
  try { results = await evaluator.extrema(Object.freeze(requests), signal); }
  catch (error) { throwIfAborted(signal); conversionFail('E_RIVE_CONVERT_INTERNAL', 'Extrema oracle failed.', `$.evaluation.bakedTracks[id=${plan.id}]`, undefined, error); }
  throwIfAborted(signal);
  if (results.length !== requests.length) conversionFail('E_RIVE_CONVERT_FORMAT', 'Extrema oracle returned an incomplete or oversized interval set.', `$.evaluation.bakedTracks[id=${plan.id}]`);
  const output = new Map<string, readonly number[]>();
  for (const result of results) {
    const key = segmentKey({ left: result.start, right: result.end, depth: 0 });
    if (result.trackId !== plan.id || !segments.some(segment => segment.left === result.start && segment.right === result.end) || output.has(key)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Extrema oracle returned an unexpected or duplicate interval.', `$.evaluation.bakedTracks[id=${plan.id}]`);
    if (!Array.isArray(result.times) || result.times.some(time => !Number.isFinite(time) || time <= result.start || time >= result.end)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Extrema must be finite times inside the requested open interval.', `$.evaluation.bakedTracks[id=${plan.id}]`);
    output.set(key, Object.freeze([...new Set(result.times)].sort((left, right) => left - right)));
  }
  return output;
}

function segmentKey(segment: Segment): string { return `${segment.left}\0${segment.right === -0 ? 0 : segment.right}`; }

async function evaluateTimes(plan: RiveBakedTrackPlan, times: readonly number[], expectedSize: number, evaluator: RiveVisualEvaluator, samples: Map<number, readonly number[]>, limits: RiveConversionLimits, signal: AbortSignal): Promise<void> {
  const missing = [...new Set(times)].filter(time => !samples.has(time)).sort((left, right) => left - right);
  if (samples.size + missing.length > limits.maxSamplesPerTrack) conversionFail('E_RIVE_CONVERT_LIMIT', `Baked track exceeds ${limits.maxSamplesPerTrack} samples.`, `$.evaluation.bakedTracks[id=${plan.id}]`);
  if (missing.length === 0) return;
  const requests: RiveSampleRequest[] = missing.map(time => Object.freeze({ trackId: plan.id, time }));
  let results;
  try { results = await evaluator.sample(Object.freeze(requests), signal); }
  catch (error) { throwIfAborted(signal); conversionFail('E_RIVE_CONVERT_INTERNAL', 'Build-time evaluator failed.', `$.evaluation.bakedTracks[id=${plan.id}]`, undefined, error); }
  throwIfAborted(signal);
  if (results.length !== requests.length) conversionFail('E_RIVE_CONVERT_FORMAT', 'Evaluator returned an incomplete or oversized sample set.', `$.evaluation.bakedTracks[id=${plan.id}]`);
  const byTime = new Map<number, readonly number[]>();
  for (const result of results) {
    if (result.trackId !== plan.id || !missing.includes(result.time) || byTime.has(result.time)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Evaluator returned an unexpected or duplicate sample.', `$.evaluation.bakedTracks[id=${plan.id}]`);
    if (!Array.isArray(result.value) || result.value.length !== expectedSize || !result.value.every(Number.isFinite)) conversionFail('E_RIVE_CONVERT_FORMAT', `Evaluator sample must contain ${expectedSize} finite values.`, `$.evaluation.bakedTracks[id=${plan.id}]`);
    byTime.set(result.time, Object.freeze([...result.value]));
  }
  for (const time of missing) { const value = byTime.get(time); if (!value) conversionFail('E_RIVE_CONVERT_FORMAT', 'Evaluator omitted a requested sample.', `$.evaluation.bakedTracks[id=${plan.id}]`); samples.set(time, value); }
}

function sparsify(points: readonly SamplePoint[], tolerance: number): SamplePoint[] {
  if (points.length <= 2) return [...points];
  const kept = new Set([0, points.length - 1]);
  const pending: Array<readonly [number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [leftIndex, rightIndex] = pending.pop()!;
    const left = points[leftIndex]!, right = points[rightIndex]!;
    let maximum = -1, pivot = -1;
    for (let index = leftIndex + 1; index < rightIndex; index++) {
      const point = points[index]!, fraction = (point.time - left.time) / (right.time - left.time);
      const error = vectorError(point.value, lerp(left.value, right.value, fraction));
      if (error > maximum) { maximum = error; pivot = index; }
    }
    if (maximum > tolerance && pivot > leftIndex) {
      kept.add(pivot);
      pending.push([pivot, rightIndex], [leftIndex, pivot]);
    }
  }
  return [...kept].sort((left, right) => left - right).map(index => points[index]!);
}

function quantizeAndMerge(points: readonly SamplePoint[], plan: RiveBakedTrackPlan, size: number): SamplePoint[] {
  const result: SamplePoint[] = [];
  for (const point of points) {
    const time = point.time === 0 || point.time === plan.duration ? point.time : quantize(point.time, plan.timeQuantum);
    const value = point.value.map(item => quantize(item, plan.valueQuantum));
    const previous = result[result.length - 1];
    if (previous?.time === time) {
      if (vectorError(previous.value, value) > plan.tolerance) conversionFail('E_RIVE_CONVERT_LIMIT', 'Time quantization merged materially different samples.', `$.evaluation.bakedTracks[id=${plan.id}]`);
      result[result.length - 1] = { time, value };
    } else result.push({ time, value });
  }
  if (result.length < 2 || result.some(point => point.value.length !== size)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Quantized baked track is invalid.', `$.evaluation.bakedTracks[id=${plan.id}]`);
  return result;
}

function verifyError(original: readonly SamplePoint[], encoded: readonly SamplePoint[], tolerance: number, id: string): void {
  const error = maximumEncodedError(original, encoded);
  if (error > tolerance) conversionFail('E_RIVE_CONVERT_LIMIT', `Quantized sparse track exceeds tolerance: ${error}.`, `$.evaluation.bakedTracks[id=${id}]`);
}

function maximumEncodedError(original: readonly SamplePoint[], encoded: readonly SamplePoint[]): number {
  let segment = 0;
  let maximum = 0;
  for (const point of original) {
    while (segment + 1 < encoded.length - 1 && point.time > encoded[segment + 1]!.time) segment++;
    const left = encoded[segment]!, right = encoded[Math.min(segment + 1, encoded.length - 1)]!;
    const fraction = right.time === left.time ? 0 : (point.time - left.time) / (right.time - left.time);
    maximum = Math.max(maximum, vectorError(point.value, lerp(left.value, right.value, fraction)));
  }
  return maximum;
}

function lerp(left: readonly number[], right: readonly number[], fraction: number): number[] { return left.map((value, index) => value + (right[index]! - value) * fraction); }
function vectorError(left: readonly number[], right: readonly number[]): number { return Math.max(...left.map((value, index) => Math.abs(value - right[index]!))); }
function quantize(value: number, quantum: number): number { const result = Math.round(value / quantum) * quantum; return Object.is(result, -0) ? 0 : result; }
