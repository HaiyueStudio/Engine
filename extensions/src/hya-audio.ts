import type {HyaAudioEventDocument, HyaCompositionValue} from '@haiyue/animation-spec/hya-production';
export type HyaAudioResource = HyaAudioEventDocument['resources'][number];
export interface HyaAudioRequest {
  readonly domain: 'composition' | 'state' | 'event'; readonly time: number; readonly rate: number;
  readonly operation: 'advance' | 'seek' | 'pause' | 'resume' | 'stop';
}
export interface HyaAudioTrace {readonly sequence: number; readonly operation: string; readonly token: string; readonly resource: string; readonly sampleFrame: number; readonly details: Readonly<Record<string, HyaCompositionValue>>;}
export interface HyaAudioHost {
  readonly profile: 'sample-accurate' | 'html-media-restricted'; readonly sampleRate: number;
  readonly state: 'running' | 'suspended' | 'closed';
  nowFrame(): number; unlock(): Promise<void>;
  resolve?(resource: HyaAudioResource, signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  decode(resource: HyaAudioResource, signal: AbortSignal, encoded: ArrayBuffer): Promise<Readonly<{value: unknown; sampleRate: number; channels: number; frames: number; bytes: number; release(): void}>>;
  /** gain already includes the runtime-owned bus chain; bus identifies routing/trace, not a second gain multiplier. */
  schedule(request: Readonly<{token: string; value: unknown; startFrame: number; offsetFrame: number; stopFrame?: number; durationFrames?: number; gain: number; rate: number; bus: string; loop?: Readonly<{startFrame: number; endFrame: number}>; onEnded(): void}>): Readonly<{stop(frame?: number): void; setGain(gain: number, frame?: number): void; setRate(rate: number, frame?: number): void; release(): void}>;
}
export interface HyaAudio {
  /** advance/seek use the selected domain's time. pause/resume/stop operate on the owner; control request times do not advance clocks. */
  update(request: HyaAudioRequest): Promise<void>;
  play(cue: string, domain?: HyaAudioRequest['domain']): Promise<void>;
  /** Await outstanding async operations before changing a bus synchronously. unlock must be called from the actual user gesture. */
  stop(cue: string): Promise<void>; setBusGain(bus: string, gain: number): void; unlock(): Promise<void>;
  readonly trace: readonly HyaAudioTrace[]; dispose(): void;
}

import {parseHyaAudioEvents} from '@haiyue/animation-spec/hya-production';
import {createProductionAudio} from './animation/audio/createProductionAudio.js';
import {createBorrowedBrowserAudioHost} from './animation/audio/BrowserProductionAudioHost.js';
export async function createHyaAudio(document: HyaAudioEventDocument, host: HyaAudioHost, options: Readonly<{signal?: AbortSignal}> = {}): Promise<HyaAudio> {return createProductionAudio(parseHyaAudioEvents(document),host,options);}
export async function createBrowserHyaAudioHost(context: AudioContext): Promise<HyaAudioHost> {return createBorrowedBrowserAudioHost(context);}
