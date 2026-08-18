import type { AnimationPath2DComponent } from '@haiyue/animation-spec';
import { Geometry2D } from '@haiyue/engine';
import earcut from 'earcut';

interface Point { x: number; y: number }
interface Contour { points: Point[]; area: number; parent: number; depth: number; role: 'outer' | 'hole' | 'ignore' }
interface StrokeSubpath { points: Point[]; closed: boolean }

export type ResolvedVectorPathModifier =
  | Readonly<{ kind: 'trim-path'; start: number; end: number; offset: number; mode: 'simultaneous' | 'individual' }>
  | Readonly<{ kind: 'round-corners'; radius: number }>;

export interface ResolvedVectorPath {
  readonly commands: string;
  readonly values: Float32Array;
}

export interface VectorStrokePathComponent {
  readonly [key: string]: unknown;
  readonly type: 'org.haiyue.vector-stroke@1';
  readonly commands?: string;
  readonly values?: readonly number[] | Float32Array;
  readonly sourceComponent?: number;
  readonly color: readonly [number, number, number, number];
  readonly width: number;
  readonly lineCap: 'butt' | 'round' | 'square';
  readonly lineJoin: 'miter' | 'round' | 'bevel';
  readonly miterLimit: number;
  readonly dash?: readonly number[] | Float32Array;
  readonly dashOffset?: number;
  readonly tolerance?: number;
}

export interface VectorPathMorphComponent {
  readonly [key: string]: unknown;
  readonly type: 'org.haiyue.vector-path-morph@1';
  readonly commands: string;
  readonly times: readonly number[] | Float32Array;
  readonly values: readonly number[] | Float32Array;
  readonly valueSize: number;
  readonly interpolation: 'step' | 'linear' | 'cubic-bezier';
  readonly easings?: readonly number[] | Float32Array;
  readonly fill: readonly [number, number, number, number];
  readonly fillRule: 'nonzero' | 'evenodd';
  readonly tolerance?: number;
}

const geometryCache = new WeakMap<object, Geometry2D>();
const strokeGeometryCache = new WeakMap<object, Geometry2D>();
const MAX_FLATTENED_VERTICES = 262_144;

/** Applies ordered source-neutral modifiers after curve flattening. Empty trim ranges return an empty command stream. */
export function applyVectorPathModifiers(
  commands: string,
  values: readonly number[] | Float32Array,
  tolerance: number,
  modifiers: readonly ResolvedVectorPathModifier[],
  closeOpen: boolean,
): ResolvedVectorPath {
  if (modifiers.length === 0) return { commands, values: new Float32Array(values) };
  let paths = flattenStrokePaths({
    type: 'org.haiyue.vector-stroke@1', commands, values,
    color: [1, 1, 1, 1], width: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 4,
    tolerance,
  });
  for (const modifier of modifiers) {
    paths = modifier.kind === 'round-corners'
      ? paths.map(path => roundStrokeSubpath(path, modifier.radius, tolerance))
      : trimStrokeSubpaths(paths, modifier.start, modifier.end, modifier.offset, modifier.mode);
  }
  let resolvedCommands = '';
  const resolvedValues: number[] = [];
  for (const path of paths) {
    if (path.points.length < 2 || subpathLength(path) <= 1e-6) continue;
    resolvedCommands += `M${'L'.repeat(path.points.length - 1)}${path.closed || closeOpen ? 'Z' : ''}`;
    for (const point of path.points) resolvedValues.push(point.x, point.y);
  }
  return { commands: resolvedCommands, values: new Float32Array(resolvedValues) };
}

function roundStrokeSubpath(path: StrokeSubpath, radius: number, tolerance: number): StrokeSubpath {
  if (radius <= 1e-6 || path.points.length < 3) return path;
  const result: Point[] = [];
  const last = path.points.length - 1;
  for (let index = 0; index <= last; index++) {
    const current = path.points[index]!;
    if (!path.closed && (index === 0 || index === last)) {
      result.push(current);
      continue;
    }
    const previous = path.points[(index - 1 + path.points.length) % path.points.length]!;
    const next = path.points[(index + 1) % path.points.length]!;
    const previousLength = distance(previous, current);
    const nextLength = distance(current, next);
    if (previousLength <= 1e-6 || nextLength <= 1e-6) {
      result.push(current);
      continue;
    }
    const incomingX = (current.x - previous.x) / previousLength;
    const incomingY = (current.y - previous.y) / previousLength;
    const outgoingX = (next.x - current.x) / nextLength;
    const outgoingY = (next.y - current.y) / nextLength;
    if (incomingX * outgoingX + incomingY * outgoingY > 0.995) {
      result.push(current);
      continue;
    }
    const inset = Math.min(radius, previousLength * 0.5, nextLength * 0.5);
    const entry = interpolatePoint(current, previous, inset / previousLength);
    const exit = interpolatePoint(current, next, inset / nextLength);
    result.push(entry);
    const steps = Math.max(2, Math.min(16, Math.ceil(Math.sqrt(inset / Math.max(tolerance, 0.05)))));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const inverse = 1 - t;
      result.push({
        x: inverse * inverse * entry.x + 2 * inverse * t * current.x + t * t * exit.x,
        y: inverse * inverse * entry.y + 2 * inverse * t * current.y + t * t * exit.y,
      });
    }
  }
  return { points: result, closed: path.closed };
}

function trimStrokeSubpaths(
  paths: readonly StrokeSubpath[],
  start: number,
  end: number,
  offset: number,
  mode: 'simultaneous' | 'individual',
): StrokeSubpath[] {
  const span = end - start;
  if (Math.abs(span) >= 1 - 1e-6) return paths.slice();
  if (Math.abs(span) <= 1e-6) return [];
  const normalizedStart = wrapUnit(start + offset);
  const normalizedEnd = wrapUnit(end + offset);
  const intervals = normalizedEnd > normalizedStart
    ? [[normalizedStart, normalizedEnd] as const]
    : [[normalizedStart, 1] as const, [0, normalizedEnd] as const];
  if (mode === 'individual') return paths.flatMap(path => {
    const length = subpathLength(path);
    return intervals.flatMap(([from, to]) => extractSubpathRange(path, from * length, to * length));
  });
  const lengths = paths.map(subpathLength);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= 1e-6) return [];
  const result: StrokeSubpath[] = [];
  let pathStart = 0;
  for (let index = 0; index < paths.length; index++) {
    const length = lengths[index]!;
    const pathEnd = pathStart + length;
    for (const [from, to] of intervals) {
      const globalStart = from * total;
      const globalEnd = to * total;
      const overlapStart = Math.max(pathStart, globalStart);
      const overlapEnd = Math.min(pathEnd, globalEnd);
      if (overlapEnd > overlapStart + 1e-6) {
        result.push(...extractSubpathRange(paths[index]!, overlapStart - pathStart, overlapEnd - pathStart));
      }
    }
    pathStart = pathEnd;
  }
  return result;
}

function extractSubpathRange(path: StrokeSubpath, from: number, to: number): StrokeSubpath[] {
  const length = subpathLength(path);
  if (length <= 1e-6 || to <= from + 1e-6) return [];
  if (from <= 1e-6 && to >= length - 1e-6) return [path];
  const segmentCount = path.closed ? path.points.length : path.points.length - 1;
  const result: Point[] = [pointAtSubpathDistance(path, from)];
  let cursor = 0;
  for (let segment = 0; segment < segmentCount; segment++) {
    const next = (segment + 1) % path.points.length;
    cursor += distance(path.points[segment]!, path.points[next]!);
    if (cursor > from + 1e-6 && cursor < to - 1e-6) result.push(path.points[next]!);
  }
  result.push(pointAtSubpathDistance(path, to));
  return [{ points: result, closed: false }];
}

function pointAtSubpathDistance(path: StrokeSubpath, target: number): Point {
  const segmentCount = path.closed ? path.points.length : path.points.length - 1;
  let cursor = 0;
  for (let segment = 0; segment < segmentCount; segment++) {
    const next = (segment + 1) % path.points.length;
    const segmentLength = distance(path.points[segment]!, path.points[next]!);
    if (target <= cursor + segmentLength || segment === segmentCount - 1) {
      return interpolatePoint(path.points[segment]!, path.points[next]!, segmentLength <= 1e-8 ? 0 : (target - cursor) / segmentLength);
    }
    cursor += segmentLength;
  }
  return path.points.at(-1)!;
}

function subpathLength(path: StrokeSubpath): number {
  const segmentCount = path.closed ? path.points.length : path.points.length - 1;
  let result = 0;
  for (let index = 0; index < segmentCount; index++) {
    result += distance(path.points[index]!, path.points[(index + 1) % path.points.length]!);
  }
  return result;
}

function distance(left: Point, right: Point): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function interpolatePoint(from: Point, to: Point, progress: number): Point {
  const t = Math.min(1, Math.max(0, progress));
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

/** Flattens packed quadratic/cubic commands and triangulates contours with hole nesting. */
export function tessellateAnimationPath(component: AnimationPath2DComponent): Geometry2D {
  const cached = geometryCache.get(component);
  if (cached) return cached;
  const contours = flattenPath(component);
  if (contours.length === 0) throw new RangeError('Animation path contains no drawable closed contour.');
  classifyContours(contours, component.fillRule ?? 'nonzero');

  const positions: number[] = [];
  const indices: number[] = [];
  for (let contourIndex = 0; contourIndex < contours.length; contourIndex++) {
    const outer = contours[contourIndex]!;
    if (outer.role !== 'outer') continue;
    const flat: number[] = [];
    const holes: number[] = [];
    appendContour(flat, outer.points);
    for (let childIndex = 0; childIndex < contours.length; childIndex++) {
      const hole = contours[childIndex]!;
      if (hole.role !== 'hole' || nearestOuterAncestor(contours, childIndex) !== contourIndex) continue;
      holes.push(flat.length / 2);
      appendContour(flat, hole.points);
    }
    const vertexOffset = positions.length / 2;
    positions.push(...flat);
    for (const index of earcut(flat, holes, 2)) indices.push(vertexOffset + index);
  }
  if (indices.length === 0) throw new RangeError('Animation path tessellation produced no triangles.');
  const indexArray = positions.length / 2 > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices);
  const geometry = new Geometry2D(new Float32Array(positions), indexArray);
  geometryCache.set(component, geometry);
  return geometry;
}

/** Tessellates the compact Lottie stroke extension without expanding it in the HYA payload. */
export function tessellateVectorStrokePath(component: VectorStrokePathComponent, allowEmpty = false): Geometry2D {
  const cached = strokeGeometryCache.get(component);
  if (cached) return cached;
  const flattened = flattenStrokePaths(component);
  const subpaths = component.dash?.length
    ? flattened.flatMap(subpath => dashStrokeSubpath(subpath, component.dash!, component.dashOffset ?? 0))
    : flattened;
  const contours = subpaths.flatMap(subpath => strokeContours(subpath, component));
  const positions: number[] = [];
  const indices: number[] = [];
  for (const contour of contours) {
    if (contour.length < 3) continue;
    const flat = contour.flatMap(point => [point.x, point.y]);
    const vertexOffset = positions.length / 2;
    positions.push(...flat);
    for (const index of earcut(flat, undefined, 2)) indices.push(vertexOffset + index);
  }
  if (indices.length === 0 && !allowEmpty) throw new RangeError('Animation stroke tessellation produced no triangles.');
  const indexArray = indices.length === 0
    ? new Uint16Array([0, 1, 2])
    : positions.length / 2 > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices);
  const geometry = new Geometry2D(indices.length === 0 ? new Float32Array(6) : new Float32Array(positions), indexArray);
  strokeGeometryCache.set(component, geometry);
  return geometry;
}

function dashStrokeSubpath(
  subpath: StrokeSubpath,
  sourcePattern: readonly number[] | Float32Array,
  sourceOffset: number,
): StrokeSubpath[] {
  const positive = Array.from(sourcePattern, value => Math.max(0, value)).filter(value => value > 1e-6);
  if (positive.length === 0) return [subpath];
  const pattern = positive.length % 2 === 0 ? positive : [...positive, ...positive];
  const total = pattern.reduce((sum, value) => sum + value, 0);
  let offset = ((sourceOffset % total) + total) % total;
  let patternIndex = 0;
  while (offset >= pattern[patternIndex]!) {
    offset -= pattern[patternIndex]!;
    patternIndex = (patternIndex + 1) % pattern.length;
  }
  let remaining = pattern[patternIndex]! - offset;
  let drawing = patternIndex % 2 === 0;
  const result: StrokeSubpath[] = [];
  let active: Point[] | null = drawing ? [subpath.points[0]!] : null;
  const segmentCount = subpath.closed ? subpath.points.length : subpath.points.length - 1;
  for (let segment = 0; segment < segmentCount; segment++) {
    const from = subpath.points[segment]!;
    const to = subpath.points[(segment + 1) % subpath.points.length]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length <= 1e-8) continue;
    let distance = 0;
    while (distance < length - 1e-8) {
      const advance = Math.min(remaining, length - distance);
      const endDistance = distance + advance;
      const point = {
        x: from.x + (to.x - from.x) * endDistance / length,
        y: from.y + (to.y - from.y) * endDistance / length,
      };
      if (drawing) {
        active ??= [{
          x: from.x + (to.x - from.x) * distance / length,
          y: from.y + (to.y - from.y) * distance / length,
        }];
        active.push(point);
      }
      distance = endDistance;
      remaining -= advance;
      if (remaining <= 1e-8) {
        if (drawing && active && active.length >= 2) result.push({ points: active, closed: false });
        patternIndex = (patternIndex + 1) % pattern.length;
        drawing = patternIndex % 2 === 0;
        remaining = pattern[patternIndex]!;
        active = drawing ? [point] : null;
      }
    }
  }
  if (drawing && active && active.length >= 2) result.push({ points: active, closed: false });
  return result;
}

/** Samples a topology-stable Lottie path morph into the ordinary path tessellator ABI. */
export function sampleVectorPathMorph(
  component: VectorPathMorphComponent,
  time: number,
): AnimationPath2DComponent {
  const values = samplePackedPathMorph(component, time);
  return {
    type: 'path2d',
    commands: component.commands,
    values,
    fill: component.fill,
    fillRule: component.fillRule,
    ...(component.tolerance === undefined ? {} : { tolerance: component.tolerance }),
  };
}

function samplePackedPathMorph(
  component: Readonly<{
    times: readonly number[] | Float32Array;
    values: readonly number[] | Float32Array;
    valueSize: number;
    interpolation: 'step' | 'linear' | 'cubic-bezier';
    easings?: readonly number[] | Float32Array;
  }>,
  time: number,
): Float32Array {
  const frameCount = component.times.length;
  if (frameCount === 0 || component.valueSize <= 0) throw new RangeError('Lottie path morph contains no keyframes.');
  let frame = 0;
  while (frame + 1 < frameCount && component.times[frame + 1]! <= time) frame++;
  const nextFrame = Math.min(frame + 1, frameCount - 1);
  let progress = 0;
  if (nextFrame !== frame && component.interpolation !== 'step') {
    const start = component.times[frame]!;
    const end = component.times[nextFrame]!;
    progress = Math.min(1, Math.max(0, (time - start) / Math.max(1e-8, end - start)));
    if (component.interpolation === 'cubic-bezier' && component.easings) {
      const offset = frame * 4;
      progress = cubicBezierYForX(
        progress,
        component.easings[offset] ?? 0.333,
        component.easings[offset + 1] ?? 0.333,
        component.easings[offset + 2] ?? 0.667,
        component.easings[offset + 3] ?? 0.667,
      );
    }
  }
  const fromOffset = frame * component.valueSize;
  const toOffset = nextFrame * component.valueSize;
  const values = new Float32Array(component.valueSize);
  for (let offset = 0; offset < values.length; offset++) {
    const from = component.values[fromOffset + offset] ?? 0;
    const to = component.values[toOffset + offset] ?? from;
    values[offset] = from + (to - from) * progress;
  }
  return values;
}

function cubicBezierYForX(x: number, x1: number, y1: number, x2: number, y2: number): number {
  let parameter = x;
  for (let iteration = 0; iteration < 5; iteration++) {
    const estimate = cubicBezierCoordinate(parameter, x1, x2) - x;
    const derivative = cubicBezierDerivative(parameter, x1, x2);
    if (Math.abs(derivative) < 1e-5) break;
    parameter = Math.min(1, Math.max(0, parameter - estimate / derivative));
  }
  return cubicBezierCoordinate(parameter, y1, y2);
}

function cubicBezierCoordinate(value: number, first: number, second: number): number {
  const inverse = 1 - value;
  return 3 * inverse * inverse * value * first + 3 * inverse * value * value * second + value * value * value;
}

function cubicBezierDerivative(value: number, first: number, second: number): number {
  const inverse = 1 - value;
  return 3 * inverse * inverse * first + 6 * inverse * value * (second - first) + 3 * value * value * (1 - second);
}

function flattenStrokePaths(component: VectorStrokePathComponent): StrokeSubpath[] {
  const subpaths: StrokeSubpath[] = [];
  const values = component.values;
  if (typeof component.commands !== 'string' || values === undefined) {
    throw new TypeError('Resolved Lottie stroke extension requires commands and values.');
  }
  const toleranceSquared = (component.tolerance ?? 0.35) ** 2;
  let valueOffset = 0;
  let current: Point[] | null = null;
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = cursor;
  const budget = { count: 0 };
  const finish = (closed: boolean): void => {
    if (!current) return;
    const compact: Point[] = [];
    for (const point of current) if (!compact.length || !samePoint(compact.at(-1)!, point)) compact.push(point);
    if (closed && compact.length > 1 && samePoint(compact[0]!, compact.at(-1)!)) compact.pop();
    if (compact.length >= 2) subpaths.push({ points: compact, closed });
    current = null;
  };
  for (const command of component.commands) {
    if (command === 'M') {
      finish(false);
      cursor = readPoint(values, valueOffset); valueOffset += 2;
      start = cursor;
      current = [];
      appendPoint(current, cursor, budget);
    } else if (command === 'L') {
      cursor = readPoint(values, valueOffset); valueOffset += 2;
      if (current) appendPoint(current, cursor, budget);
    } else if (command === 'Q') {
      const control = readPoint(values, valueOffset);
      const end = readPoint(values, valueOffset + 2);
      valueOffset += 4;
      if (current) flattenQuadratic(cursor, control, end, toleranceSquared, current, budget, 0);
      cursor = end;
    } else if (command === 'C') {
      const control1 = readPoint(values, valueOffset);
      const control2 = readPoint(values, valueOffset + 2);
      const end = readPoint(values, valueOffset + 4);
      valueOffset += 6;
      if (current) flattenCubic(cursor, control1, control2, end, toleranceSquared, current, budget, 0);
      cursor = end;
    } else if (command === 'Z') {
      cursor = start;
      finish(true);
    }
  }
  finish(false);
  return subpaths;
}

function strokeContours(subpath: StrokeSubpath, style: VectorStrokePathComponent): Point[][] {
  const points = subpath.points;
  const closed = subpath.closed;
  const halfWidth = style.width / 2;
  const contours: Point[][] = [];
  const segmentCount = closed ? points.length : points.length - 1;
  for (let segment = 0; segment < segmentCount; segment++) {
    const from = points[segment]!;
    const to = points[(segment + 1) % points.length]!;
    const direction = normalizePoint({ x: to.x - from.x, y: to.y - from.y });
    if (!direction) continue;
    const normal = { x: -direction.y, y: direction.x };
    const extendStart = !closed && style.lineCap === 'square' && segment === 0 ? halfWidth : 0;
    const extendEnd = !closed && style.lineCap === 'square' && segment === segmentCount - 1 ? halfWidth : 0;
    const start = { x: from.x - direction.x * extendStart, y: from.y - direction.y * extendStart };
    const end = { x: to.x + direction.x * extendEnd, y: to.y + direction.y * extendEnd };
    contours.push([
      { x: start.x + normal.x * halfWidth, y: start.y + normal.y * halfWidth },
      { x: end.x + normal.x * halfWidth, y: end.y + normal.y * halfWidth },
      { x: end.x - normal.x * halfWidth, y: end.y - normal.y * halfWidth },
      { x: start.x - normal.x * halfWidth, y: start.y - normal.y * halfWidth },
    ]);
  }
  const joinStart = closed ? 0 : 1;
  const joinEnd = closed ? points.length : points.length - 1;
  for (let index = joinStart; index < joinEnd; index++) {
    const previous = points[(index - 1 + points.length) % points.length]!;
    const vertex = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const incoming = normalizePoint({ x: vertex.x - previous.x, y: vertex.y - previous.y });
    const outgoing = normalizePoint({ x: next.x - vertex.x, y: next.y - vertex.y });
    if (!incoming || !outgoing) continue;
    if (style.lineJoin === 'round') {
      contours.push(strokeCircle(vertex, halfWidth));
      continue;
    }
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    if (Math.abs(cross) < 1e-6) continue;
    const side = cross > 0 ? 1 : -1;
    const incomingNormal = { x: -incoming.y * side, y: incoming.x * side };
    const outgoingNormal = { x: -outgoing.y * side, y: outgoing.x * side };
    const outerIncoming = { x: vertex.x + incomingNormal.x * halfWidth, y: vertex.y + incomingNormal.y * halfWidth };
    const outerOutgoing = { x: vertex.x + outgoingNormal.x * halfWidth, y: vertex.y + outgoingNormal.y * halfWidth };
    if (style.lineJoin === 'miter') {
      const bisector = normalizePoint({ x: incomingNormal.x + outgoingNormal.x, y: incomingNormal.y + outgoingNormal.y });
      const denominator = bisector ? bisector.x * outgoingNormal.x + bisector.y * outgoingNormal.y : 0;
      const miterLength = Math.abs(denominator) > 1e-6 ? halfWidth / denominator : Infinity;
      if (bisector && miterLength > 0 && miterLength <= halfWidth * style.miterLimit) {
        contours.push([outerIncoming, { x: vertex.x + bisector.x * miterLength, y: vertex.y + bisector.y * miterLength }, outerOutgoing]);
        continue;
      }
    }
    contours.push([outerIncoming, vertex, outerOutgoing]);
  }
  if (!closed && style.lineCap === 'round' && points.length > 1) {
    contours.push(strokeCircle(points[0]!, halfWidth), strokeCircle(points.at(-1)!, halfWidth));
  }
  return contours;
}

function strokeCircle(center: Point, radius: number): Point[] {
  return Array.from({ length: 16 }, (_, index) => {
    const angle = index * Math.PI * 2 / 16;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}

function normalizePoint(point: Point): Point | null {
  const length = Math.hypot(point.x, point.y);
  return length > 1e-8 ? { x: point.x / length, y: point.y / length } : null;
}

function flattenPath(component: AnimationPath2DComponent): Contour[] {
  const contours: Contour[] = [];
  const values = component.values;
  const toleranceSquared = (component.tolerance ?? 0.35) ** 2;
  let valueOffset = 0;
  let current: Point[] | null = null;
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = cursor;
  const budget = { count: 0 };
  for (const command of component.commands) {
    if (command === 'M') {
      if (current && current.length >= 3) closeContour(contours, current);
      cursor = readPoint(values, valueOffset); valueOffset += 2;
      start = cursor;
      current = [];
      appendPoint(current, cursor, budget);
    } else if (command === 'L') {
      cursor = readPoint(values, valueOffset); valueOffset += 2;
      if (current) appendPoint(current, cursor, budget);
    } else if (command === 'Q') {
      const control = readPoint(values, valueOffset);
      const end = readPoint(values, valueOffset + 2);
      valueOffset += 4;
      if (current) flattenQuadratic(cursor, control, end, toleranceSquared, current, budget, 0);
      cursor = end;
    } else if (command === 'C') {
      const control1 = readPoint(values, valueOffset);
      const control2 = readPoint(values, valueOffset + 2);
      const end = readPoint(values, valueOffset + 4);
      valueOffset += 6;
      if (current) flattenCubic(cursor, control1, control2, end, toleranceSquared, current, budget, 0);
      cursor = end;
    } else if (command === 'Z' && current) {
      if (!samePoint(cursor, start)) appendPoint(current, start, budget);
      closeContour(contours, current);
      current = null;
      cursor = start;
    }
  }
  return contours;
}

function readPoint(values: ArrayLike<number>, offset: number): Point {
  return { x: values[offset] ?? 0, y: -(values[offset + 1] ?? 0) };
}

function flattenQuadratic(a: Point, b: Point, c: Point, toleranceSquared: number, out: Point[], budget: { count: number }, depth: number): void {
  if (depth >= 12 || pointLineDistanceSquared(b, a, c) <= toleranceSquared) { appendPoint(out, c, budget); return; }
  const ab = midpoint(a, b), bc = midpoint(b, c), middle = midpoint(ab, bc);
  flattenQuadratic(a, ab, middle, toleranceSquared, out, budget, depth + 1);
  flattenQuadratic(middle, bc, c, toleranceSquared, out, budget, depth + 1);
}

function flattenCubic(a: Point, b: Point, c: Point, d: Point, toleranceSquared: number, out: Point[], budget: { count: number }, depth: number): void {
  if (depth >= 12 || Math.max(pointLineDistanceSquared(b, a, d), pointLineDistanceSquared(c, a, d)) <= toleranceSquared) {
    appendPoint(out, d, budget); return;
  }
  const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
  const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
  flattenCubic(a, ab, abc, middle, toleranceSquared, out, budget, depth + 1);
  flattenCubic(middle, bcd, cd, d, toleranceSquared, out, budget, depth + 1);
}

function appendPoint(out: Point[], point: Point, budget: { count: number }): void {
  if (++budget.count > MAX_FLATTENED_VERTICES) {
    throw new RangeError(`Animation path exceeds the ${MAX_FLATTENED_VERTICES} flattened-vertex runtime budget.`);
  }
  out.push(point);
}

function closeContour(out: Contour[], points: Point[]): void {
  const compact: Point[] = [];
  for (const point of points) if (!compact.length || !samePoint(compact[compact.length - 1]!, point)) compact.push(point);
  if (compact.length > 1 && samePoint(compact[0]!, compact[compact.length - 1]!)) compact.pop();
  if (compact.length < 3) return;
  out.push({ points: compact, area: signedArea(compact), parent: -1, depth: 0, role: 'ignore' });
}

function classifyContours(contours: Contour[], fillRule: AnimationPath2DComponent['fillRule']): void {
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i]!;
    let parent = -1;
    let parentArea = Infinity;
    const point = contour.points[0]!;
    for (let candidateIndex = 0; candidateIndex < contours.length; candidateIndex++) {
      if (candidateIndex === i) continue;
      const candidate = contours[candidateIndex]!;
      const area = Math.abs(candidate.area);
      if (area <= Math.abs(contour.area) || area >= parentArea || !pointInPolygon(point, candidate.points)) continue;
      parent = candidateIndex;
      parentArea = area;
    }
    contour.parent = parent;
  }
  for (const contour of contours) {
    let depth = 0;
    let parent = contour.parent;
    while (parent >= 0) { depth++; parent = contours[parent]!.parent; }
    contour.depth = depth;
    if (fillRule === 'evenodd') {
      contour.role = (depth & 1) === 0 ? 'outer' : 'hole';
      continue;
    }
    let windingBefore = 0;
    parent = contour.parent;
    while (parent >= 0) {
      windingBefore += Math.sign(contours[parent]!.area);
      parent = contours[parent]!.parent;
    }
    const windingAfter = windingBefore + Math.sign(contour.area);
    contour.role = windingBefore === 0 && windingAfter !== 0
      ? 'outer'
      : windingBefore !== 0 && windingAfter === 0 ? 'hole' : 'ignore';
  }
}

function nearestOuterAncestor(contours: readonly Contour[], contourIndex: number): number {
  let parent = contours[contourIndex]!.parent;
  while (parent >= 0) {
    if (contours[parent]!.role === 'outer') return parent;
    parent = contours[parent]!.parent;
  }
  return -1;
}

function appendContour(out: number[], points: readonly Point[]): void {
  for (const point of points) out.push(point.x, point.y);
}

function signedArea(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function midpoint(a: Point, b: Point): Point { return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 }; }
function samePoint(a: Point, b: Point): boolean { return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6; }
function pointLineDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return (point.x - a.x) ** 2 + (point.y - a.y) ** 2;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  const x = a.x - point.x + dx * t, y = a.y - point.y + dy * t;
  return x * x + y * y;
}
