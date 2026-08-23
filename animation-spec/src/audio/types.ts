import type { AudioEventLimits } from './limits.js';

export const HYA_AUDIO_EVENT_FORMAT = 'haiyue-audio-events' as const;
export const HYA_AUDIO_EVENT_VERSION = 1 as const;
export const HYA_AUDIO_EVENT_EXTENSION_ID = 'org.haiyue.audio-events@1' as const;

export type HyaAudioCodec = 'pcm-f32' | 'wav' | 'mp3' | 'aac' | 'opus' | 'vorbis' | 'flac';
export type HyaAudioClockDomain = 'composition' | 'state' | 'event';
export type HyaAudioPlaybackProfile = 'sample-accurate' | 'html-media-restricted';
export type HyaAudioVoiceStealing = 'reject' | 'steal-oldest' | 'steal-lowest-priority';

export interface HyaAudioIntegrity {
  readonly algorithm: 'sha256';
  readonly digest: string;
}

export type HyaAudioResourceSource =
  | Readonly<{ kind: 'embedded'; data: string }>
  | Readonly<{ kind: 'referenced'; uri: string }>
  | Readonly<{ kind: 'hosted'; key: string }>;

export interface HyaAudioResource {
  readonly id: string;
  readonly codec: HyaAudioCodec;
  readonly mediaType: string;
  readonly integrity: HyaAudioIntegrity;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameLength: number;
  readonly source: HyaAudioResourceSource;
}

export interface HyaAudioBus {
  readonly id: string;
  readonly parent?: string;
  readonly gain: number;
}

export interface HyaAudioLoop {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly iterations: number | 'infinite';
}

export interface HyaAudioCue {
  readonly id: string;
  readonly resource: string;
  readonly owner: string;
  readonly bus: string;
  readonly gain: number;
  readonly rate: number;
  readonly offsetFrames: number;
  readonly durationFrames?: number;
  readonly loop?: HyaAudioLoop;
  readonly overlap: 'allow' | 'ignore' | 'restart';
  readonly priority: number;
}

export interface HyaAudioTimelineEvent {
  readonly id: string;
  readonly clock: HyaAudioClockDomain;
  readonly time: number;
  readonly sequence: number;
  readonly cue: string;
  readonly operation: 'start' | 'stop';
}

export interface HyaAudioClockPolicy {
  readonly sampleRate: number;
  readonly lookAheadFrames: number;
  readonly driftToleranceFrames: number;
  readonly driftPolicy: 'resync' | 'error';
  readonly lateDecodePolicy: 'catch-up' | 'drop' | 'error';
  readonly visibilityPolicy: 'continue' | 'pause-resume';
  readonly suspendedPolicy: 'queue-until-resume' | 'error';
}

export interface HyaAudioBrowserPolicy {
  readonly autoplay: 'require-user-gesture' | 'attempt';
}

export interface HyaAudioRuntimeLimits {
  readonly maxVoices: number;
  readonly maxVoicesPerResource: number;
  readonly maxDecodeJobs: number;
  readonly maxEventTokens: number;
  readonly maxDecodedFrames: number;
  readonly maxDecodedBytes: number;
}

export interface HyaAudioEventDocument {
  readonly format: typeof HYA_AUDIO_EVENT_FORMAT;
  readonly version: typeof HYA_AUDIO_EVENT_VERSION;
  readonly extension: typeof HYA_AUDIO_EVENT_EXTENSION_ID;
  readonly playbackProfile: HyaAudioPlaybackProfile;
  readonly clock: HyaAudioClockPolicy;
  readonly browser: HyaAudioBrowserPolicy;
  readonly limits: HyaAudioRuntimeLimits;
  readonly voiceStealing: HyaAudioVoiceStealing;
  readonly resources: readonly HyaAudioResource[];
  readonly buses: readonly HyaAudioBus[];
  readonly cues: readonly HyaAudioCue[];
  readonly timelineEvents: readonly HyaAudioTimelineEvent[];
}

export interface AudioEventParseOptions {
  readonly limits?: Partial<AudioEventLimits>;
}
