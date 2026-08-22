export interface StateMachineV2Limits {
  readonly maxChannels: number; readonly maxClips: number; readonly maxTracks: number; readonly maxKeyframes: number;
  readonly maxStateMachines: number; readonly maxInputs: number; readonly maxLayers: number; readonly maxStates: number;
  readonly maxTransitions: number; readonly maxConditionTerms: number; readonly maxMotionDepth: number;
  readonly maxComponents: number; readonly maxStringLength: number;
}

export const DEFAULT_STATE_MACHINE_V2_LIMITS: StateMachineV2Limits = Object.freeze({
  maxChannels: 1_000_000, maxClips: 10_000, maxTracks: 1_000_000, maxKeyframes: 10_000_000,
  maxStateMachines: 10_000, maxInputs: 100_000, maxLayers: 8_192, maxStates: 250_000,
  maxTransitions: 500_000, maxConditionTerms: 1_000_000, maxMotionDepth: 128,
  maxComponents: 8_192, maxStringLength: 4 * 1024 * 1024,
});

export function resolveStateMachineV2Limits(overrides: Partial<StateMachineV2Limits> = {}): StateMachineV2Limits {
  const limits = { ...DEFAULT_STATE_MACHINE_V2_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`State-machine v2 limit ${name} must be a positive safe integer.`);
  return Object.freeze(limits);
}
