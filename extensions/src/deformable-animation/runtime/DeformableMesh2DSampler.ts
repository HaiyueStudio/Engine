import type { ParsedDeformableMesh2DDrawable } from '@haiyue/animation-spec/deformable2d';

export interface DeformableMesh2DSample {
  readonly opacity: number;
  readonly renderOrder: number;
  readonly frame: number;
  readonly nextFrame: number;
  readonly progress: number;
}

export function sampleDeformableMesh2DDrawable(
  times: Float32Array,
  drawable: ParsedDeformableMesh2DDrawable,
  time: number,
  targetRuntimePositions: Float32Array,
): DeformableMesh2DSample {
  if (targetRuntimePositions.length !== drawable.vertexCount * 2) throw new RangeError('Deformable sample target does not match drawable vertex count.');
  const frame = findFrame(times, time);
  const nextFrame = Math.min(frame + 1, times.length - 1);
  const startTime = times[frame]!;
  const endTime = times[nextFrame]!;
  const progress = nextFrame === frame || endTime <= startTime ? 0 : clamp((time - startTime) / (endTime - startTime), 0, 1);
  const stride = drawable.vertexCount * 2;
  const startOffset = frame * stride;
  const nextOffset = nextFrame * stride;
  for (let index = 0; index < stride; index += 2) {
    targetRuntimePositions[index] = mix(drawable.positions[startOffset + index]!, drawable.positions[nextOffset + index]!, progress);
    // HYA stores screen-y-down coordinates; Animation2D geometry uses local y-up.
    targetRuntimePositions[index + 1] = -mix(drawable.positions[startOffset + index + 1]!, drawable.positions[nextOffset + index + 1]!, progress);
  }
  return Object.freeze({
    opacity: mix(drawable.opacities[frame]!, drawable.opacities[nextFrame]!, progress),
    renderOrder: drawable.renderOrders[frame]!,
    frame,
    nextFrame,
    progress,
  });
}

function findFrame(times: Float32Array, time: number): number {
  if (time <= times[0]!) return 0;
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

function mix(a: number, b: number, progress: number): number { return a + (b - a) * progress; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
