import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import { gameAudioOwner } from '../../audio/GameAudio.js';
import type { GameAudio } from '../../audio/types';

type VoiceLease = NonNullable<ReturnType<typeof gameAudioOwner>>['lease'];
interface PlaybackLease extends VoiceLease {
  attenuate(id: string, factor: number): (() => void) | null;
  onEnd(id: string, callback: () => void): (() => void) | null;
  stop(id: string): boolean;
  gain(id: string, value: number): boolean;
}

function playbackLease(lease: VoiceLease): PlaybackLease {
  const playback = lease as Partial<PlaybackLease>;
  if (typeof playback.attenuate !== 'function' || typeof playback.onEnd !== 'function' ||
    typeof playback.stop !== 'function' || typeof playback.gain !== 'function') {
    throw new EngineError(EngineErrorCode.AudioCapabilityUnavailable, 'Reading requires the original mixer playback lease.');
  }
  return playback as PlaybackLease;
}

/** Reading owns child leases. The regular GameAudio owner also closes them on exit. */
export function gameAudioPlaybackPort(audio: GameAudio) {
  const owner = gameAudioOwner(audio);
  const closed = () => new EngineError(EngineErrorCode.ResourceOwnerReleased, 'Reading requires a live GameAudio owner.');
  if (!owner || owner.mixer.stats.state === 'closed') throw closed();
  const music = playbackLease(owner.lease);
  const kind = () => gameAudioOwner(audio) === owner ? owner.mixer.stats.state : 'closed';
  return {
    kind,
    open: (): PlaybackLease => {
      if (kind() === 'closed') throw closed();
      const lease = owner.acquire();
      const release = () => { if (owner.cleanup.delete(release)) lease.release(); };
      try {
        const child = { ...playbackLease(lease), release };
        owner.cleanup.add(release);
        return child;
      } catch (error) { lease.release(); throw error; }
    },
    duck: (id: string, factor: number) => music.attenuate(id, factor),
  };
}

export interface ReadingVoiceBuffer {
  readonly bufferId: string;
  release(): void;
}

export interface ReadingAudioOptions {
  readonly gameAudio: GameAudio;
  /** Resolve an installed original mixer buffer. The lesson/show owns the source cache. */
  readonly resolve: (assetId: string, signal: AbortSignal) => Promise<ReadingVoiceBuffer>;
  readonly duckFactor?: number;
  readonly voiceVolume?: number;
  readonly onError?: (error: unknown) => void;
}

type Channel = 'line' | 'history';
interface VoiceRun {
  readonly controller: AbortController;
  readonly eventId: string;
  buffer?: ReadingVoiceBuffer;
  voice?: string;
  detach?: () => void;
}
let nextReader = 0;
const unit = (value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Reading audio level must be from 0 to 1.');
  return value;
};

/** The original mixer owns both voices. This controller owns their intent and one scene-track gain factor. */
export class ReadingAudio {
  private readonly owner = `reading:${++nextReader}`;
  private readonly port: ReturnType<typeof gameAudioPlaybackPort>;
  private readonly leases: Record<Channel, ReturnType<ReturnType<typeof gameAudioPlaybackPort>['open']>>;
  private readonly requests: Partial<Record<Channel, VoiceRun>> = {};
  private readonly factor: number;
  private musicVoice: string | null = null;
  private unduck: (() => void) | null = null;
  private volume: number;
  private sequence = 0;
  private active = true;
  private pageVisible = true;
  private dead = false;

  constructor(private readonly options: ReadingAudioOptions) {
    this.factor = unit(options.duckFactor ?? .35);
    this.volume = unit(options.voiceVolume ?? 1);
    this.port = gameAudioPlaybackPort(options.gameAudio);
    const line = this.port.open();
    try { this.leases = { line, history: this.port.open() }; }
    catch (error) { line.release(); throw error; }
  }

  get linePending(): boolean { return !!this.requests.line; }
  get historyPending(): boolean { return !!this.requests.history; }

  /** Pass the ID returned by GameAudio.play for the current scene music track. */
  setMusicVoice(id: string | null): void {
    if (this.dead || this.musicVoice === id) return;
    this.restoreMusic();
    this.musicVoice = id;
    this.syncMusic();
  }

  setVoiceVolume(value: number): void {
    this.volume = unit(value);
    for (const channel of ['line', 'history'] as const) {
      const voice = this.requests[channel]?.voice;
      if (voice) this.guard(() => this.leases[channel].gain(voice, value));
    }
  }

  playLine(assetId: string | null): Promise<boolean> {
    this.cancelHistory();
    return this.play('line', assetId);
  }

  replayHistory(assetId: string): Promise<boolean> {
    this.cancelLine();
    return this.play('history', assetId);
  }

  cancelLine(): void { this.cancel('line'); }
  cancelHistory(): void { this.cancel('history'); }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) { this.cancelLine(); this.cancelHistory(); }
  }

  setPageVisible(visible: boolean): void {
    this.pageVisible = visible;
    if (visible) return;
    this.cancelLine();
    if (!this.requests.history?.voice) this.cancelHistory();
  }

  update(): void {
    const state = this.port.kind();
    if (state === 'running') return;
    this.cancelLine();
    // A suspended output retains the scheduled source and its position.
    if (state !== 'suspended' || !this.requests.history?.voice) this.cancelHistory();
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.setActive(false);
    this.settleLeases();
    this.musicVoice = null;
  }

  private async play(channel: Channel, assetId: string | null): Promise<boolean> {
    this.cancel(channel);
    if (this.dead || !this.active || !this.pageVisible || !assetId || this.port.kind() !== 'running') return false;
    const request: VoiceRun = { controller: new AbortController(), eventId: `${this.owner}:${++this.sequence}` };
    this.requests[channel] = request;
    const { signal } = request.controller;
    const lease = this.leases[channel];
    try {
      const buffer = await this.options.resolve(assetId, signal);
      if (this.requests[channel] !== request) { this.guard(() => buffer.release()); return false; }
      request.buffer = buffer;
      if (this.port.kind() !== 'running') { this.end(channel, request, false); return false; }
      const id = lease.play({ eventId: request.eventId, bufferId: buffer.bufferId, owner: this.owner,
        channel, bus: 'sfx', volume: this.volume, startTick: this.sequence });
      if (!id) { this.end(channel, request, false); return false; }
      request.voice = id;
      const detach = lease.onEnd(id, () => this.end(channel, request, false));
      if (!detach) { this.end(channel, request, false); return false; }
      request.detach = detach;
      this.syncMusic();
      return true;
    } catch (error) {
      if (!signal.aborted) this.report(error);
      this.end(channel, request, true);
      return false;
    }
  }

  private cancel(channel: Channel): void {
    const request = this.requests[channel];
    if (request) this.end(channel, request, true);
  }

  private end(channel: Channel, request: VoiceRun, stop: boolean): void {
    if (this.requests[channel] !== request) return;
    delete this.requests[channel];
    this.guard(() => request.detach?.());
    if (stop) {
      request.controller.abort();
      const id = request.voice;
      if (id) this.guard(() => this.leases[channel].stop(id));
    }
    this.guard(() => request.buffer?.release());
    this.syncMusic();
  }

  private syncMusic(): void {
    if (this.requests.line?.voice || this.requests.history?.voice) {
      if (this.musicVoice && !this.unduck) {
        const id = this.musicVoice;
        this.guard(() => { this.unduck = this.port.duck(id, this.factor); });
      }
    } else this.restoreMusic();
  }

  private restoreMusic(): void {
    const release = this.unduck;
    this.unduck = null;
    if (release) this.guard(release);
  }

  private settleLeases(): void {
    this.restoreMusic();
    this.guard(() => this.leases.line.release());
    this.guard(() => this.leases.history.release());
  }

  private guard(operation: () => void): void {
    try { operation(); }
    catch (error) { this.report(error); }
  }

  private report(error: unknown): void {
    try { this.options.onError?.(error); }
    catch { /* observation cannot interrupt cleanup */ }
  }
}
