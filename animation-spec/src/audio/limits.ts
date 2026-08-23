import { audioEventFail } from './diagnostics.js';

export interface AudioEventLimits {
  readonly maxResources: number;
  readonly maxBuses: number;
  readonly maxCues: number;
  readonly maxTimelineEvents: number;
  readonly maxVoices: number;
  readonly maxVoicesPerResource: number;
  readonly maxDecodeJobs: number;
  readonly maxEventTokens: number;
  readonly maxEmbeddedBytes: number;
  readonly maxTotalEmbeddedBytes: number;
  readonly maxDecodedFrames: number;
  readonly maxDecodedBytes: number;
  readonly maxStringBytes: number;
  readonly maxTotalTextBytes: number;
  readonly maxReferenceDepth: number;
}

export const DEFAULT_AUDIO_EVENT_LIMITS: AudioEventLimits = Object.freeze({
  maxResources: 4_096,
  maxBuses: 4_096,
  maxCues: 1_000_000,
  maxTimelineEvents: 1_000_000,
  maxVoices: 256,
  maxVoicesPerResource: 64,
  maxDecodeJobs: 16,
  maxEventTokens: 1_000_000,
  maxEmbeddedBytes: 256 * 1024 * 1024,
  maxTotalEmbeddedBytes: 1024 * 1024 * 1024,
  maxDecodedFrames: 1_000_000_000,
  maxDecodedBytes: 512 * 1024 * 1024,
  maxStringBytes: 4 * 1024 * 1024,
  maxTotalTextBytes: 32 * 1024 * 1024,
  maxReferenceDepth: 128,
});

export function resolveAudioEventLimits(
  overrides: Partial<AudioEventLimits> = {},
): Readonly<AudioEventLimits> {
  const limits = { ...DEFAULT_AUDIO_EVENT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      audioEventFail(
        'E_AUDIO_EVENT_LIMIT',
        `$.limits.${name}`,
        'limit must be a positive safe integer',
      );
    }
  }
  return Object.freeze(limits);
}
