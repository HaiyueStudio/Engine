import type {
  CompiledAnimation3DBlend1DMotion,
  CompiledAnimation3DBlend2DMotion,
} from './AnimationStateMachineCompiler.js';

const EPSILON = 1e-9;
const TWO_PI = Math.PI * 2;

/**
 * Evaluates direct child weights for a compiled 1D blend tree. Values outside
 * the authored threshold range clamp to the nearest endpoint.
 */
export function evaluateAnimation3DBlend1DWeights(
  motion: CompiledAnimation3DBlend1DMotion,
  value: number,
  out: Float64Array = new Float64Array(motion.children.length),
): Float64Array {
  requireOutputSize(out, motion.children.length);
  out.fill(0);
  const children = motion.children;
  if (children.length === 1 || value <= children[0]!.threshold) {
    out[0] = 1;
    return out;
  }
  const lastIndex = children.length - 1;
  if (value >= children[lastIndex]!.threshold) {
    out[lastIndex] = 1;
    return out;
  }
  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (value < children[middle]!.threshold) high = middle;
    else low = middle;
  }
  const start = children[low]!.threshold;
  const end = children[high]!.threshold;
  const alpha = (value - start) / (end - start);
  out[low] = 1 - alpha;
  out[high] = alpha;
  return out;
}

/**
 * Evaluates direct child weights for a compiled 2D blend tree.
 *
 * Cartesian trees use a deterministic containing simplex after projecting
 * outside samples to the convex hull. Directional trees interpolate the two
 * surrounding authored directions and then interpolate/clamp radially.
 */
export function evaluateAnimation3DBlend2DWeights(
  motion: CompiledAnimation3DBlend2DMotion,
  x: number,
  y: number,
  out: Float64Array = new Float64Array(motion.children.length),
): Float64Array {
  requireOutputSize(out, motion.children.length);
  out.fill(0);
  if (motion.children.length === 1) {
    out[0] = 1;
    return out;
  }
  return motion.algorithm === 'directional'
    ? evaluateDirectional(motion, x, y, out)
    : evaluateCartesian(motion, x, y, out);
}

function evaluateCartesian(
  motion: CompiledAnimation3DBlend2DMotion,
  x: number,
  y: number,
  out: Float64Array,
): Float64Array {
  const children = motion.children;
  const exact = findExactPoint(motion, x, y);
  if (exact >= 0) {
    out[exact] = 1;
    return out;
  }

  const hull = convexHull(motion);
  const point = clampToHull(motion, hull, x, y);
  const clampedExact = findExactPoint(motion, point[0], point[1]);
  if (clampedExact >= 0) {
    out[clampedExact] = 1;
    return out;
  }

  let bestArea = Infinity;
  let bestIndices: readonly [number, number, number] | null = null;
  let bestWeights: readonly [number, number, number] | null = null;
  for (let first = 0; first < children.length - 2; first++) {
    for (let second = first + 1; second < children.length - 1; second++) {
      for (let third = second + 1; third < children.length; third++) {
        const a = children[first]!.position;
        const b = children[second]!.position;
        const c = children[third]!.position;
        const signedDoubleArea = cross(a, b, c);
        const area = Math.abs(signedDoubleArea);
        if (area <= EPSILON) continue;
        const weights = barycentric(point, a, b, c, signedDoubleArea);
        if (
          weights[0] < -EPSILON
          || weights[1] < -EPSILON
          || weights[2] < -EPSILON
        ) continue;
        if (
          area < bestArea - EPSILON
          || (
            Math.abs(area - bestArea) <= EPSILON
            && lexicographicallyBefore(
              [first, second, third],
              bestIndices,
            )
          )
        ) {
          bestArea = area;
          bestIndices = [first, second, third];
          bestWeights = weights;
        }
      }
    }
  }
  if (bestIndices && bestWeights) {
    out[bestIndices[0]] = clamp01(bestWeights[0]);
    out[bestIndices[1]] = clamp01(bestWeights[1]);
    out[bestIndices[2]] = clamp01(bestWeights[2]);
    normalize(out);
    return out;
  }

  // Collinear input (or a numerically degenerate hull): clamp to the closest
  // authored segment with declaration order as the final tie breaker.
  let bestDistance = Infinity;
  let bestLength = Infinity;
  let bestFirst = 0;
  let bestSecond = 1;
  let bestAlpha = 0;
  for (let first = 0; first < children.length - 1; first++) {
    for (let second = first + 1; second < children.length; second++) {
      const projection = closestPointOnSegment(
        point[0],
        point[1],
        children[first]!.position,
        children[second]!.position,
      );
      const dx = projection[0] - point[0];
      const dy = projection[1] - point[1];
      const distance = dx * dx + dy * dy;
      const segmentDx =
        children[second]!.position[0] - children[first]!.position[0];
      const segmentDy =
        children[second]!.position[1] - children[first]!.position[1];
      const length = segmentDx * segmentDx + segmentDy * segmentDy;
      if (
        distance < bestDistance - EPSILON
        || (
          Math.abs(distance - bestDistance) <= EPSILON
          && length < bestLength - EPSILON
        )
      ) {
        bestDistance = distance;
        bestLength = length;
        bestFirst = first;
        bestSecond = second;
        bestAlpha = projection[2];
      }
    }
  }
  out[bestFirst] = 1 - bestAlpha;
  out[bestSecond] = bestAlpha;
  return out;
}

interface DirectionGroup {
  readonly angle: number;
  readonly entries: readonly {
    readonly index: number;
    readonly radius: number;
  }[];
}

function evaluateDirectional(
  motion: CompiledAnimation3DBlend2DMotion,
  x: number,
  y: number,
  out: Float64Array,
): Float64Array {
  const exact = findExactPoint(motion, x, y);
  if (exact >= 0) {
    out[exact] = 1;
    return out;
  }
  const radius = Math.hypot(x, y);
  const originIndices: number[] = [];
  const directionalEntries: {
    angle: number;
    radius: number;
    index: number;
  }[] = [];
  motion.children.forEach((child, index) => {
    const childRadius = Math.hypot(child.position[0], child.position[1]);
    if (childRadius <= EPSILON) {
      originIndices.push(index);
    } else {
      directionalEntries.push({
        angle: normalizeAngle(Math.atan2(child.position[1], child.position[0])),
        radius: childRadius,
        index,
      });
    }
  });
  if (radius <= EPSILON) {
    out[originIndices[0] ?? directionalEntries[0]!.index] = 1;
    return out;
  }
  if (directionalEntries.length === 0) {
    out[originIndices[0]!] = 1;
    return out;
  }
  directionalEntries.sort((left, right) =>
    left.angle - right.angle
    || left.radius - right.radius
    || left.index - right.index);
  const groups: DirectionGroup[] = [];
  directionalEntries.forEach(entry => {
    const previous = groups[groups.length - 1];
    if (previous && Math.abs(previous.angle - entry.angle) <= EPSILON) {
      groups[groups.length - 1] = {
        angle: previous.angle,
        entries: Object.freeze([...previous.entries, {
          index: entry.index,
          radius: entry.radius,
        }]),
      };
    } else {
      groups.push({
        angle: entry.angle,
        entries: Object.freeze([{
          index: entry.index,
          radius: entry.radius,
        }]),
      });
    }
  });

  const queryAngle = normalizeAngle(Math.atan2(y, x));
  let leftGroupIndex = groups.length - 1;
  let rightGroupIndex = 0;
  let angularAlpha = 0;
  for (let index = 0; index < groups.length; index++) {
    const left = groups[index]!;
    const rightIndex = (index + 1) % groups.length;
    const right = groups[rightIndex]!;
    const leftAngle = left.angle;
    const rightAngle = rightIndex === 0 ? right.angle + TWO_PI : right.angle;
    const adjustedQuery = queryAngle < leftAngle ? queryAngle + TWO_PI : queryAngle;
    if (adjustedQuery >= leftAngle - EPSILON && adjustedQuery <= rightAngle + EPSILON) {
      leftGroupIndex = index;
      rightGroupIndex = rightIndex;
      angularAlpha = groups.length === 1
        ? 0
        : clamp01((adjustedQuery - leftAngle) / (rightAngle - leftAngle));
      break;
    }
  }

  const originIndex = originIndices[0] ?? -1;
  accumulateRadial(
    groups[leftGroupIndex]!,
    radius,
    1 - angularAlpha,
    originIndex,
    out,
  );
  if (rightGroupIndex !== leftGroupIndex) {
    accumulateRadial(
      groups[rightGroupIndex]!,
      radius,
      angularAlpha,
      originIndex,
      out,
    );
  }
  normalize(out);
  return out;
}

function accumulateRadial(
  group: DirectionGroup,
  radius: number,
  angularWeight: number,
  originIndex: number,
  out: Float64Array,
): void {
  if (angularWeight <= EPSILON) return;
  const entries = group.entries;
  const first = entries[0]!;
  if (radius <= first.radius) {
    if (originIndex >= 0) {
      const alpha = clamp01(radius / first.radius);
      out[originIndex] = (out[originIndex] ?? 0) + angularWeight * (1 - alpha);
      out[first.index] = (out[first.index] ?? 0) + angularWeight * alpha;
    } else {
      out[first.index] = (out[first.index] ?? 0) + angularWeight;
    }
    return;
  }
  const last = entries[entries.length - 1]!;
  if (radius >= last.radius) {
    out[last.index] = (out[last.index] ?? 0) + angularWeight;
    return;
  }
  for (let index = 0; index < entries.length - 1; index++) {
    const start = entries[index]!;
    const end = entries[index + 1]!;
    if (radius <= end.radius) {
      const alpha = (radius - start.radius) / (end.radius - start.radius);
      out[start.index] = (out[start.index] ?? 0) + angularWeight * (1 - alpha);
      out[end.index] = (out[end.index] ?? 0) + angularWeight * alpha;
      return;
    }
  }
}

function convexHull(motion: CompiledAnimation3DBlend2DMotion): readonly number[] {
  const sorted = motion.children.map((child, index) => ({
    index,
    x: child.position[0],
    y: child.position[1],
  })).sort((left, right) =>
    left.x - right.x || left.y - right.y || left.index - right.index);
  if (sorted.length <= 2) return sorted.map(entry => entry.index);
  const lower: typeof sorted = [];
  for (const entry of sorted) {
    while (
      lower.length >= 2
      && crossEntries(lower[lower.length - 2]!, lower[lower.length - 1]!, entry) <= EPSILON
    ) lower.pop();
    lower.push(entry);
  }
  const upper: typeof sorted = [];
  for (let index = sorted.length - 1; index >= 0; index--) {
    const entry = sorted[index]!;
    while (
      upper.length >= 2
      && crossEntries(upper[upper.length - 2]!, upper[upper.length - 1]!, entry) <= EPSILON
    ) upper.pop();
    upper.push(entry);
  }
  lower.pop();
  upper.pop();
  const result = [...lower, ...upper].map(entry => entry.index);
  return result.length === 0 ? [sorted[0]!.index] : result;
}

function clampToHull(
  motion: CompiledAnimation3DBlend2DMotion,
  hull: readonly number[],
  x: number,
  y: number,
): readonly [number, number] {
  if (hull.length === 1) return motion.children[hull[0]!]!.position;
  if (hull.length === 2) {
    const projection = closestPointOnSegment(
      x,
      y,
      motion.children[hull[0]!]!.position,
      motion.children[hull[1]!]!.position,
    );
    return [projection[0], projection[1]];
  }
  let inside = true;
  for (let index = 0; index < hull.length; index++) {
    const start = motion.children[hull[index]!]!.position;
    const end = motion.children[hull[(index + 1) % hull.length]!]!.position;
    if ((end[0] - start[0]) * (y - start[1]) - (end[1] - start[1]) * (x - start[0]) < -EPSILON) {
      inside = false;
      break;
    }
  }
  if (inside) return [x, y];

  let bestX = x;
  let bestY = y;
  let bestDistance = Infinity;
  for (let index = 0; index < hull.length; index++) {
    const projection = closestPointOnSegment(
      x,
      y,
      motion.children[hull[index]!]!.position,
      motion.children[hull[(index + 1) % hull.length]!]!.position,
    );
    const dx = projection[0] - x;
    const dy = projection[1] - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance - EPSILON) {
      bestDistance = distance;
      bestX = projection[0];
      bestY = projection[1];
    }
  }
  return [bestX, bestY];
}

function closestPointOnSegment(
  x: number,
  y: number,
  start: readonly [number, number],
  end: readonly [number, number],
): readonly [number, number, number] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const alpha = denominator <= EPSILON
    ? 0
    : clamp01(((x - start[0]) * dx + (y - start[1]) * dy) / denominator);
  return [start[0] + dx * alpha, start[1] + dy * alpha, alpha];
}

function barycentric(
  point: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  signedDoubleArea: number,
): readonly [number, number, number] {
  const first = (
    (b[0] - point[0]) * (c[1] - point[1])
    - (b[1] - point[1]) * (c[0] - point[0])
  ) / signedDoubleArea;
  const second = (
    (c[0] - point[0]) * (a[1] - point[1])
    - (c[1] - point[1]) * (a[0] - point[0])
  ) / signedDoubleArea;
  return [first, second, 1 - first - second];
}

function findExactPoint(
  motion: CompiledAnimation3DBlend2DMotion,
  x: number,
  y: number,
): number {
  for (let index = 0; index < motion.children.length; index++) {
    const position = motion.children[index]!.position;
    if (Math.abs(position[0] - x) <= EPSILON && Math.abs(position[1] - y) <= EPSILON) {
      return index;
    }
  }
  return -1;
}

function cross(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function crossEntries(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  c: { readonly x: number; readonly y: number },
): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function lexicographicallyBefore(
  candidate: readonly [number, number, number],
  current: readonly [number, number, number] | null,
): boolean {
  if (!current) return true;
  return candidate[0] < current[0]
    || (candidate[0] === current[0] && candidate[1] < current[1])
    || (
      candidate[0] === current[0]
      && candidate[1] === current[1]
      && candidate[2] < current[2]
    );
}

function normalize(out: Float64Array): void {
  let total = 0;
  for (const value of out) total += value;
  if (total <= EPSILON) return;
  for (let index = 0; index < out.length; index++) out[index] = out[index]! / total;
}

function normalizeAngle(angle: number): number {
  return angle < 0 ? angle + TWO_PI : angle;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function requireOutputSize(out: Float64Array, size: number): void {
  if (out.length < size) {
    throw new RangeError(`Blend weight output requires ${size} entries; received ${out.length}.`);
  }
}
