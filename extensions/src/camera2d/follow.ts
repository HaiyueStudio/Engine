/** Pure world-space math. Projection, transforms and time ownership stay outside. */
export type Point = readonly [number, number];
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type Limits = readonly [number, number, number, number];
export const point = (x: number, y: number): Point => Object.freeze([x, y]);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function centerLimits(bounds: Rect | undefined, halfWidth: number, halfHeight: number): Limits {
  if (!bounds) return [-Infinity, Infinity, -Infinity, Infinity];
  const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
  return [Math.min(bounds.x + halfWidth, centerX), Math.max(bounds.x + bounds.width - halfWidth, centerX),
    Math.min(bounds.y + halfHeight, centerY), Math.max(bounds.y + bounds.height - halfHeight, centerY)];
}
export function constrain(position: Point, limits: Limits): Point {
  return point(clamp(position[0], limits[0], limits[1]), clamp(position[1], limits[2], limits[3]));
}
export function follow(position: Point, target: Point, zone: Point, damping: number, deltaMs: number, limits: Limits): Point {
  const start = constrain(position, limits);
  const desired = constrain(point(clamp(start[0], target[0] - zone[0] / 2, target[0] + zone[0] / 2),
    clamp(start[1], target[1] - zone[1] / 2, target[1] + zone[1] / 2)), limits);
  const weight = damping === 0 ? 1 : -Math.expm1(-damping * (deltaMs / 1000));
  return constrain(point(start[0] + (desired[0] - start[0]) * weight, start[1] + (desired[1] - start[1]) * weight), limits);
}
function phase(seed: number): number {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000 * Math.PI * 2;
}
/** Absolute elapsed time, never one random advance per display frame. */
export function shakeOffset(amplitude: number, durationMs: number, elapsedMs: number, seed: number): Point {
  if (!amplitude || elapsedMs >= durationMs || !durationMs) return point(0, 0);
  const envelope = amplitude * (1 - elapsedMs / durationMs), seconds = elapsedMs / 1000;
  return point(envelope * Math.sin(seconds * 79 + phase(seed)), envelope * Math.sin(seconds * 97 + phase(seed ^ 0x9e3779b9)));
}
