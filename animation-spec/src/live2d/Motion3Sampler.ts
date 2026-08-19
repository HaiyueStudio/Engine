/** Build-time sampler for the documented Motion3 segment representation. */
export interface CubismMotion3Curve {
  readonly Target: 'Model' | 'Parameter' | 'PartOpacity';
  readonly Id: string;
  readonly Segments: readonly number[];
}

export interface CubismMotion3 {
  readonly Version?: number;
  readonly Meta: { readonly Duration: number; readonly Loop?: boolean };
  readonly Curves: readonly CubismMotion3Curve[];
}

export interface CubismMotion3Sample {
  readonly parameters: ReadonlyMap<string, number>;
  readonly partOpacities: ReadonlyMap<string, number>;
  readonly modelOpacity: number | undefined;
}

export function sampleCubismMotion3(motion: CubismMotion3, inputTime: number): CubismMotion3Sample {
  if (!motion || !motion.Meta || !Array.isArray(motion.Curves) || !Number.isFinite(motion.Meta.Duration) || motion.Meta.Duration <= 0) throw new TypeError('Motion3 document is invalid.');
  const time = motion.Meta.Loop ? modulo(inputTime, motion.Meta.Duration) : clamp(inputTime, 0, motion.Meta.Duration);
  const parameters = new Map<string, number>();
  const partOpacities = new Map<string, number>();
  let modelOpacity: number | undefined;
  for (const curve of motion.Curves) {
    const value = sampleSegments(curve.Segments, time);
    if (curve.Target === 'Parameter') parameters.set(curve.Id, value);
    else if (curve.Target === 'PartOpacity') partOpacities.set(curve.Id, value);
    else if (curve.Target === 'Model' && curve.Id === 'Opacity') modelOpacity = value;
  }
  return Object.freeze({ parameters, partOpacities, modelOpacity });
}

function sampleSegments(values: readonly number[], time: number): number {
  if (!Array.isArray(values) || values.length < 2 || !values.every(Number.isFinite)) throw new TypeError('Motion3 curve segments are invalid.');
  let startTime = values[0]!;
  let startValue = values[1]!;
  if (time <= startTime) return startValue;
  let cursor = 2;
  while (cursor < values.length) {
    const kind = values[cursor++]!;
    if (kind === 0 || kind === 2 || kind === 3) {
      if (cursor + 1 >= values.length) throw new TypeError('Motion3 segment is truncated.');
      const endTime = values[cursor++]!;
      const endValue = values[cursor++]!;
      if (time <= endTime) {
        if (kind === 2) return startValue;
        if (kind === 3) return endValue;
        const progress = endTime === startTime ? 1 : (time - startTime) / (endTime - startTime);
        return mix(startValue, endValue, clamp(progress, 0, 1));
      }
      startTime = endTime;
      startValue = endValue;
      continue;
    }
    if (kind === 1) {
      if (cursor + 5 >= values.length) throw new TypeError('Motion3 Bézier segment is truncated.');
      const x1 = values[cursor++]!, y1 = values[cursor++]!;
      const x2 = values[cursor++]!, y2 = values[cursor++]!;
      const endTime = values[cursor++]!, endValue = values[cursor++]!;
      if (time <= endTime) return cubicBezierValueForTime(startTime, startValue, x1, y1, x2, y2, endTime, endValue, time);
      startTime = endTime;
      startValue = endValue;
      continue;
    }
    throw new TypeError(`Motion3 segment type ${kind} is unsupported.`);
  }
  return startValue;
}

function cubicBezierValueForTime(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, time: number): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration++) {
    const t = (low + high) / 2;
    if (cubic(x0, x1, x2, x3, t) < time) low = t;
    else high = t;
  }
  return cubic(y0, y1, y2, y3, (low + high) / 2);
}

function cubic(a: number, b: number, c: number, d: number, t: number): number { const inverse = 1 - t; return inverse ** 3 * a + 3 * inverse ** 2 * t * b + 3 * inverse * t ** 2 * c + t ** 3 * d; }
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
