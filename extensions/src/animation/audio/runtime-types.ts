export type RuntimeAudioClockDomain = 'composition' | 'state' | 'event';
export type RuntimeAudioBackendProfile = 'sample-accurate' | 'html-media-restricted';

export type RuntimeAudioResourceSource =
  | Readonly<{ kind: 'embedded'; data: string }>
  | Readonly<{ kind: 'referenced'; uri: string }>
  | Readonly<{ kind: 'hosted'; key: string }>;

export interface RuntimeAudioResource {
  readonly id: string;
  readonly codec: 'pcm-f32' | 'wav' | 'mp3' | 'aac' | 'opus' | 'vorbis' | 'flac';
  readonly mediaType: string;
  readonly integrity: Readonly<{ algorithm: 'sha256'; digest: string }>;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameLength: number;
  readonly source: RuntimeAudioResourceSource;
}

export interface RuntimeAudioBus {
  readonly id: string;
  readonly parent?: string;
  readonly gain: number;
}

export interface RuntimeAudioCue {
  readonly id: string;
  readonly resource: string;
  readonly owner: string;
  readonly bus: string;
  readonly gain: number;
  readonly rate: number;
  readonly offsetFrames: number;
  readonly durationFrames?: number;
  readonly loop?: Readonly<{
    startFrame: number;
    endFrame: number;
    iterations: number | 'infinite';
  }>;
  readonly overlap: 'allow' | 'ignore' | 'restart';
  readonly priority: number;
}

export interface RuntimeAudioTimelineEvent {
  readonly id: string;
  readonly clock: RuntimeAudioClockDomain;
  readonly time: number;
  readonly sequence: number;
  readonly cue: string;
  readonly operation: 'start' | 'stop';
}

export interface RuntimeAudioDocument {
  readonly format: 'haiyue-audio-events';
  readonly version: 1;
  readonly extension: 'org.haiyue.audio-events@1';
  readonly playbackProfile: RuntimeAudioBackendProfile;
  readonly clock: Readonly<{
    sampleRate: number;
    lookAheadFrames: number;
    driftToleranceFrames: number;
    driftPolicy: 'resync' | 'error';
    lateDecodePolicy: 'catch-up' | 'drop' | 'error';
    visibilityPolicy: 'continue' | 'pause-resume';
    suspendedPolicy: 'queue-until-resume' | 'error';
  }>;
  readonly browser: Readonly<{ autoplay: 'require-user-gesture' | 'attempt' }>;
  readonly limits: Readonly<{
    maxVoices: number;
    maxVoicesPerResource: number;
    maxDecodeJobs: number;
    maxEventTokens: number;
    maxDecodedFrames: number;
    maxDecodedBytes: number;
  }>;
  readonly voiceStealing: 'reject' | 'steal-oldest' | 'steal-lowest-priority';
  readonly resources: readonly RuntimeAudioResource[];
  readonly buses: readonly RuntimeAudioBus[];
  readonly cues: readonly RuntimeAudioCue[];
  readonly timelineEvents: readonly RuntimeAudioTimelineEvent[];
}

export interface AudioResourceResolveRequest {
  readonly resource: RuntimeAudioResource;
}

export interface AudioResourceResolverPort {
  resolve(request: AudioResourceResolveRequest, signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  dispose?(): void;
}

export interface DecodedAudioHandle {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameLength: number;
  readonly payload: unknown;
  release(): void;
}

export interface AudioDecodeRequest {
  readonly resource: RuntimeAudioResource;
  readonly bytes: ArrayBuffer;
}

export interface AudioDecoderPort {
  decode(request: AudioDecodeRequest, signal: AbortSignal): Promise<DecodedAudioHandle>;
  dispose?(): void;
}

export interface AudioBackendScheduleRequest {
  readonly voiceId: string;
  readonly decoded: DecodedAudioHandle;
  readonly whenFrame: number;
  readonly offsetFrame: number;
  readonly stopFrame?: number;
  readonly rate: number;
  readonly gain: number;
  readonly loop?: Readonly<{ startFrame: number; endFrame: number }>;
  readonly onEnded: () => void;
}

export interface ScheduledAudioHandle {
  readonly voiceId: string;
  stop(frame: number): void;
  setGain(gain: number, frame: number): void;
  setRate(rate: number, frame: number): void;
  dispose(): void;
}

export interface AudioBackendPort extends AudioDecoderPort {
  readonly profile: RuntimeAudioBackendProfile;
  readonly kind: 'realtime' | 'offline' | 'restricted';
  readonly sampleRate: number;
  readonly state: 'running' | 'suspended' | 'closed';
  currentFrame(): number;
  schedule(request: AudioBackendScheduleRequest): ScheduledAudioHandle;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  dispose(): void;
}

export interface RuntimeClockSnapshot {
  readonly composition: number;
  readonly state: number;
  readonly event: number;
}

export interface RuntimeCueCommand {
  readonly eventId: string;
  readonly cue: string;
  readonly operation: 'start' | 'stop';
  readonly clock: RuntimeAudioClockDomain;
  readonly atTime?: number;
}

export interface AudioRuntimeDiagnosticRecord {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AudioRuntimeTraceEntry {
  readonly sequence: number;
  readonly kind:
    | 'scheduled'
    | 'stopped'
    | 'ended'
    | 'ignored'
    | 'stolen'
    | 'late-catch-up'
    | 'late-drop'
    | 'queued-suspended'
    | 'drift-resync'
    | 'resource-replaced';
  readonly cue?: string;
  readonly eventId?: string;
  readonly voiceId?: string;
  readonly frame?: number;
  readonly offsetFrame?: number;
  readonly owner?: string;
  readonly reason?: string;
}
