import type { RigLimits } from './types.js';

export const DEFAULT_PARAMETERIZED_RIG_LIMITS: Readonly<RigLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxRigs: 1_024,
  maxInstances: 8_192,
  maxBones: 65_536,
  maxMeshes: 16_384,
  maxDrawables: 1_000_000,
  maxVertices: 5_000_000,
  maxIndices: 15_000_000,
  maxInfluences: 40_000_000,
  maxInfluencesPerVertex: 32,
  maxConstraints: 250_000,
  maxConstraintIterations: 128,
  maxPaths: 65_536,
  maxPathPoints: 5_000_000,
  maxParameters: 250_000,
  maxDrivers: 1_000_000,
  maxNestingDepth: 128,
  maxGpuBytes: 512 * 1024 * 1024,
});
