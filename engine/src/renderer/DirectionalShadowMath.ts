import { mat4 } from 'wgpu-matrix';
import type { DirectionalLight } from '../lighting/DirectionalLight';

export const DIRECTIONAL_SHADOW_FOCUS_ORIGIN: readonly [number, number, number] = Object.freeze([0, 0, 0]);

/** Writes the CPU shadow camera matrix used by both spatial queries and GPU rendering. */
export function writeDirectionalShadowViewProjection(
  light: DirectionalLight,
  target: Float32Array,
  viewMatrix: Float32Array,
  projectionMatrix: Float32Array,
  focus: readonly [number, number, number] = DIRECTIONAL_SHADOW_FOCUS_ORIGIN,
): Float32Array {
  const direction = light.direction;
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const dx = direction[0] / length;
  const dy = direction[1] / length;
  const dz = direction[2] / length;
  const distance = Math.max(light.shadow.extent, light.shadow.far * 0.45);
  const eye: [number, number, number] = [
    focus[0] - dx * distance,
    focus[1] - dy * distance,
    focus[2] - dz * distance,
  ];
  const up: [number, number, number] = Math.abs(dy) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  mat4.lookAt(eye, focus, up, viewMatrix);
  const extent = light.shadow.extent;
  mat4.ortho(-extent, extent, -extent, extent, light.shadow.near, light.shadow.far, projectionMatrix);
  mat4.multiply(projectionMatrix, viewMatrix, target);
  return target;
}
