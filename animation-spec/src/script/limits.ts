import type { SandboxedAnimationScriptLimits } from './types.js';

export const DEFAULT_SANDBOXED_ANIMATION_SCRIPT_LIMITS: SandboxedAnimationScriptLimits = Object.freeze({
  maxPrograms: 128,
  maxProgramBytes: 1_048_576,
  maxFunctions: 512,
  maxInstructionsPerFunction: 16_384,
  maxInstructionsPerInvocation: 1_000_000,
  maxInstructionsPerScope: 10_000_000,
  maxRegistersPerFunction: 512,
  maxConstants: 8_192,
  maxStringBytes: 4_194_304,
  maxHeapBytes: 16_777_216,
  maxCallDepth: 128,
  maxOutputCommands: 4_096,
  maxEventsPerInvocation: 64,
  maxTimers: 256,
  maxPendingPromises: 64,
  maxWallTimeMs: 50,
  maxShaderModules: 32,
  maxShaderSourceBytes: 262_144,
  maxShaderTokens: 65_536,
  maxShaderBindings: 32,
  maxTextures: 16,
  maxUniformBytes: 65_536,
  maxStorageBytes: 67_108_864,
  maxPipelines: 32,
  maxDrawsPerFrame: 256,
});

export type SandboxedAnimationScriptLimitOverrides = Partial<SandboxedAnimationScriptLimits>;

export function resolveSandboxedAnimationScriptLimits(
  overrides: SandboxedAnimationScriptLimitOverrides = {},
): SandboxedAnimationScriptLimits {
  return Object.freeze({ ...DEFAULT_SANDBOXED_ANIMATION_SCRIPT_LIMITS, ...overrides });
}
