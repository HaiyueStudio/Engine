import type { RuntimeContour, RuntimeGeometry, RuntimeGeometryResult, RuntimePathGeometry, RuntimePoint } from './runtime-types.js';

const CURVE_STEPS = 16;
const ELLIPSE_STEPS = 64;

export function evaluateGeometry(geometry: RuntimeGeometry, time: number): RuntimeGeometryResult {
  if (geometry.kind === 'path') return { contours: flattenPath(samplePath(geometry, time)) };
  if (geometry.kind === 'ellipse') return { contours: [{ points: ellipsePoints(geometry.cx, geometry.cy, geometry.rx, geometry.ry), closed: true, isHole: false }] };
  if (geometry.kind === 'rectangle') return { contours: [{ points: rectanglePoints(geometry.x, geometry.y, geometry.width, geometry.height, geometry.radii), closed: true, isHole: false }] };
  if (geometry.kind === 'polygon') return { contours: [{ points: radialPoints(geometry.cx, geometry.cy, geometry.radius, geometry.radius, geometry.points, geometry.rotation ?? -Math.PI / 2), closed: true, isHole: false }] };
  if (geometry.kind === 'star') return { contours: [{ points: radialPoints(geometry.cx, geometry.cy, geometry.outerRadius, geometry.innerRadius, geometry.points, geometry.rotation ?? -Math.PI / 2), closed: true, isHole: false }] };
  if (geometry.kind === 'triangle') return { contours: [{ points: [[geometry.points[0], geometry.points[1]], [geometry.points[2], geometry.points[3]], [geometry.points[4], geometry.points[5]]], closed: true, isHole: false }] };
  if (geometry.kind === 'image') {
    if (geometry.mesh) {
      const contours: RuntimeContour[] = [];
      for (let index = 0; index < geometry.mesh.indices.length; index += 3) {
        const a = geometry.mesh.indices[index]!, b = geometry.mesh.indices[index + 1]!, c = geometry.mesh.indices[index + 2]!;
        contours.push({ points: [meshPoint(geometry.mesh.positions, a), meshPoint(geometry.mesh.positions, b), meshPoint(geometry.mesh.positions, c)], closed: true, isHole: false });
      }
      return { contours, image: geometry };
    }
    return { contours: [{ points: rectanglePoints(geometry.x, geometry.y, geometry.width, geometry.height), closed: true, isHole: false }], image: geometry };
  }
  return { contours: [{ points: rectanglePoints(geometry.x, geometry.y, geometry.width, geometry.height), closed: true, isHole: false }], image: geometry };
}

interface SampledPath { readonly commands: string; readonly values: readonly number[]; readonly isHole: boolean; }

function samplePath(path: RuntimePathGeometry, time: number): SampledPath {
  const frames = path.frames ?? [];
  if (frames.length === 0 || time < frames[0]!.time) return { commands: path.commands, values: path.values, isHole: path.isHole ?? false };
  let left = frames[0]!;
  let right = left;
  for (let index = 1; index < frames.length; index++) {
    right = frames[index]!;
    if (right.time >= time) break;
    left = right;
  }
  if (path.topologyPolicy === 'discrete' || left === right || left.commands !== right.commands) return { commands: left.commands, values: left.values, isHole: path.isHole ?? false };
  const amount = Math.max(0, Math.min(1, (time - left.time) / (right.time - left.time)));
  return { commands: left.commands, values: left.values.map((value, index) => value + ((right.values[index] ?? value) - value) * amount), isHole: path.isHole ?? false };
}

function flattenPath(path: SampledPath): RuntimeContour[] {
  const contours: RuntimeContour[] = [];
  let points: RuntimePoint[] = [];
  let valueIndex = 0;
  let x = 0, y = 0, startX = 0, startY = 0;
  const finish = (closed: boolean): void => {
    if (points.length > 0) contours.push({ points, closed, isHole: path.isHole });
    points = [];
  };
  for (const command of path.commands) {
    if (command === 'M') {
      finish(false);
      x = path.values[valueIndex++]!; y = path.values[valueIndex++]!; startX = x; startY = y; points.push([x, y]);
    } else if (command === 'L') {
      x = path.values[valueIndex++]!; y = path.values[valueIndex++]!; points.push([x, y]);
    } else if (command === 'H') {
      x = path.values[valueIndex++]!; points.push([x, y]);
    } else if (command === 'V') {
      y = path.values[valueIndex++]!; points.push([x, y]);
    } else if (command === 'Q') {
      const cx = path.values[valueIndex++]!, cy = path.values[valueIndex++]!, endX = path.values[valueIndex++]!, endY = path.values[valueIndex++]!;
      const originX = x, originY = y;
      for (let step = 1; step <= CURVE_STEPS; step++) { const t = step / CURVE_STEPS, u = 1 - t; points.push([u * u * originX + 2 * u * t * cx + t * t * endX, u * u * originY + 2 * u * t * cy + t * t * endY]); }
      x = endX; y = endY;
    } else if (command === 'C') {
      const c1x = path.values[valueIndex++]!, c1y = path.values[valueIndex++]!, c2x = path.values[valueIndex++]!, c2y = path.values[valueIndex++]!, endX = path.values[valueIndex++]!, endY = path.values[valueIndex++]!;
      const originX = x, originY = y;
      for (let step = 1; step <= CURVE_STEPS; step++) { const t = step / CURVE_STEPS, u = 1 - t; points.push([u * u * u * originX + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * endX, u * u * u * originY + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * endY]); }
      x = endX; y = endY;
    } else {
      if (points.length > 0 && (points.at(-1)![0] !== startX || points.at(-1)![1] !== startY)) points.push([startX, startY]);
      finish(true); x = startX; y = startY;
    }
  }
  finish(false);
  return contours;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): RuntimePoint[] { return Array.from({ length: ELLIPSE_STEPS }, (_, index) => { const angle = index / ELLIPSE_STEPS * Math.PI * 2; return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry] as const; }); }

function rectanglePoints(x: number, y: number, width: number, height: number, radii?: readonly [number, number, number, number]): RuntimePoint[] {
  if (!radii || radii.every(radius => radius === 0)) return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  const maximum = Math.min(width, height) / 2;
  const corners = [
    { cx: x + Math.min(maximum, radii[0]), cy: y + Math.min(maximum, radii[0]), radius: Math.min(maximum, radii[0]), from: Math.PI, to: Math.PI * 1.5 },
    { cx: x + width - Math.min(maximum, radii[1]), cy: y + Math.min(maximum, radii[1]), radius: Math.min(maximum, radii[1]), from: Math.PI * 1.5, to: Math.PI * 2 },
    { cx: x + width - Math.min(maximum, radii[2]), cy: y + height - Math.min(maximum, radii[2]), radius: Math.min(maximum, radii[2]), from: 0, to: Math.PI * 0.5 },
    { cx: x + Math.min(maximum, radii[3]), cy: y + height - Math.min(maximum, radii[3]), radius: Math.min(maximum, radii[3]), from: Math.PI * 0.5, to: Math.PI },
  ];
  const result: RuntimePoint[] = [];
  for (const corner of corners) for (let step = 0; step <= 4; step++) { const angle = corner.from + (corner.to - corner.from) * step / 4; result.push([corner.cx + Math.cos(angle) * corner.radius, corner.cy + Math.sin(angle) * corner.radius]); }
  return result;
}

function radialPoints(cx: number, cy: number, outer: number, inner: number, points: number, rotation: number): RuntimePoint[] {
  const count = outer === inner ? points : points * 2;
  return Array.from({ length: count }, (_, index) => { const radius = index % 2 === 0 ? outer : inner; const angle = rotation + index / count * Math.PI * 2; return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius] as const; });
}
function meshPoint(positions: readonly number[], index: number): RuntimePoint { return [positions[index * 2]!, positions[index * 2 + 1]!]; }
