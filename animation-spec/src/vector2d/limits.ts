import type { VectorVisualLimits } from './types.js';

export const DEFAULT_VECTOR_VISUAL_LIMITS: Readonly<VectorVisualLimits> = Object.freeze({
  maxNodes: 4_096,
  maxPathsPerNode: 64,
  maxCommands: 1_000_000,
  maxValues: 8_000_000,
  maxKeyframes: 36_000,
  maxGradientStops: 256,
  maxPaintsPerNode: 64,
  maxEffectsPerGroup: 32,
  maxEffectGroupsPerNode: 32,
  maxClipNodes: 4_096,
  maxClipDepth: 64,
  maxVertices: 2_000_000,
  maxIndices: 6_000_000,
  maxDashEntries: 256,
  maxFeather: 4_096,
  maxOffscreenPixels: 268_435_456,
  maxImagePixels: 268_435_456,
});
