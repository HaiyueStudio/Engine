import { RAY_PROGRESSIVE_SEQUENCE_ID, type RayProgressiveSequenceSample } from './types.js';

export function createRayProgressiveSequenceSample(sampleIndex: number, baseSeed: number): RayProgressiveSequenceSample {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex > 0xffff_ffff) throw new RangeError('sampleIndex must be a uint32.');
  if (!Number.isInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffff_ffff) throw new RangeError('baseSeed must be a uint32.');
  const rotationX = uintToUnit(pcg32(baseSeed ^ 0xa511e9b3));
  const rotationY = uintToUnit(pcg32(baseSeed ^ 0x63d83595));
  const index = sampleIndex + 1;
  const jitter = Object.freeze([
    fract(radicalInverse(index, 2) + rotationX),
    fract(radicalInverse(index, 3) + rotationY),
  ]) as readonly [number, number];
  return Object.freeze({
    sequenceId: RAY_PROGRESSIVE_SEQUENCE_ID,
    sampleIndex,
    baseSeed,
    pathSeed: pcg32((baseSeed ^ Math.imul(sampleIndex + 1, 0x9e3779b9)) >>> 0),
    jitter,
  });
}

function radicalInverse(index: number, base: number): number {
  let value = 0; let factor = 1 / base; let remaining = index;
  while (remaining > 0) { value += (remaining % base) * factor; remaining = Math.floor(remaining / base); factor /= base; }
  return value;
}
function pcg32(value: number): number {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
function uintToUnit(value: number): number { return value / 0x1_0000_0000; }
function fract(value: number): number { return value - Math.floor(value); }
