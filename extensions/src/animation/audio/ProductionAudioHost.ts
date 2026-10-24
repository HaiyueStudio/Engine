import type {RuntimeAudioBackendProfile, RuntimeAudioResource} from './runtime-types.js';

/** Source-neutral ports for the admitted HYA facade; no platform object is created on import. */
export interface ProductionAudioHost {
  readonly profile: RuntimeAudioBackendProfile;
  readonly sampleRate: number;
  readonly state: 'running' | 'suspended' | 'closed';
  nowFrame(): number;
  unlock(): Promise<void>;
  resolve?(resource: RuntimeAudioResource, signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  decode(resource: RuntimeAudioResource, signal: AbortSignal, encoded: ArrayBuffer): Promise<Readonly<{
    value: unknown; sampleRate: number; channels: number; frames: number; bytes: number; release(): void;
  }>>;
  schedule(request: Readonly<{
    token: string; value: unknown; startFrame: number; offsetFrame: number;
    stopFrame?: number; durationFrames?: number; gain: number; rate: number; bus: string;
    loop?: Readonly<{startFrame: number; endFrame: number}>;
    onEnded(): void;
  }>): Readonly<{
    stop(frame?: number): void;
    setGain(gain: number, frame?: number): void;
    setRate(rate: number, frame?: number): void;
    release(): void;
  }>;
}
