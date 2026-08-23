import { audioRuntimeFail } from './diagnostics.js';
import type {
  AudioBackendPort,
  AudioBackendScheduleRequest,
  AudioDecodeRequest,
  DecodedAudioHandle,
  ScheduledAudioHandle,
} from './runtime-types.js';

interface WebAudioContextLike extends BaseAudioContext {
  resume?: () => Promise<void>;
  suspend?: () => Promise<void>;
  close?: () => Promise<void>;
}

export interface WebAudioBackendOptions {
  readonly kind?: 'realtime' | 'offline';
  readonly ownsContext?: boolean;
}

export class WebAudioBackend implements AudioBackendPort {
  readonly profile = 'sample-accurate' as const;
  readonly kind: 'realtime' | 'offline';
  private readonly scheduled = new Set<ScheduledAudioHandle>();
  private readonly ownsContext: boolean;
  private disposed = false;

  constructor(
    private readonly context: WebAudioContextLike,
    options: WebAudioBackendOptions = {},
  ) {
    this.kind = options.kind ?? 'realtime';
    this.ownsContext = options.ownsContext ?? false;
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get state(): 'running' | 'suspended' | 'closed' {
    return this.context.state === 'interrupted' ? 'suspended' : this.context.state;
  }

  currentFrame(): number {
    return Math.round(this.context.currentTime * this.context.sampleRate);
  }

  async decode(request: AudioDecodeRequest, signal: AbortSignal): Promise<DecodedAudioHandle> {
    this.assertLive();
    if (signal.aborted) audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', `resources.${request.resource.id}`, 'decode was aborted');
    const buffer = await this.context.decodeAudioData(request.bytes.slice(0));
    if (signal.aborted || this.disposed) {
      audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', `resources.${request.resource.id}`, 'late Web Audio decode was retired');
    }
    let released = false;
    return Object.freeze({
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      frameLength: buffer.length,
      payload: buffer,
      release() {
        if (released) return;
        released = true;
      },
    });
  }

  schedule(request: AudioBackendScheduleRequest): ScheduledAudioHandle {
    this.assertLive();
    const buffer = request.decoded.payload;
    if (!(buffer instanceof AudioBuffer)) {
      audioRuntimeFail('E_AUDIO_RUNTIME_DECODE', request.voiceId, 'decoded handle does not contain an AudioBuffer');
    }
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(request.rate, this.context.currentTime);
    gain.gain.setValueAtTime(request.gain, this.context.currentTime);
    source.connect(gain);
    gain.connect(this.context.destination);
    if (request.loop) {
      source.loop = true;
      source.loopStart = request.loop.startFrame / buffer.sampleRate;
      source.loopEnd = request.loop.endFrame / buffer.sampleRate;
    }

    let retired = false;
    let handle: ScheduledAudioHandle;
    const finish = () => {
      if (retired) return;
      retired = true;
      source.onended = null;
      try { source.disconnect(); } catch { /* already disconnected */ }
      try { gain.disconnect(); } catch { /* already disconnected */ }
      this.scheduled.delete(handle);
      request.onEnded();
    };
    handle = Object.freeze({
      voiceId: request.voiceId,
      stop: (frame: number) => {
        if (retired) return;
        try { source.stop(frame / this.sampleRate); } catch { finish(); }
      },
      setGain: (value: number, frame: number) => {
        if (retired) return;
        gain.gain.cancelScheduledValues(frame / this.sampleRate);
        gain.gain.setValueAtTime(value, frame / this.sampleRate);
      },
      setRate: (value: number, frame: number) => {
        if (retired) return;
        source.playbackRate.cancelScheduledValues(frame / this.sampleRate);
        source.playbackRate.setValueAtTime(value, frame / this.sampleRate);
      },
      dispose: () => {
        if (retired) return;
        try { source.stop(); } catch { /* source may already have ended */ }
        finish();
      },
    });
    source.onended = finish;
    this.scheduled.add(handle);
    const when = request.whenFrame / this.sampleRate;
    const offset = request.offsetFrame / buffer.sampleRate;
    source.start(when, offset);
    if (request.stopFrame !== undefined) source.stop(request.stopFrame / this.sampleRate);
    return handle;
  }

  async resume(): Promise<void> {
    this.assertLive();
    if (this.kind === 'offline') return;
    if (!this.context.resume) audioRuntimeFail('E_AUDIO_RUNTIME_PORT', '$.backend', 'audio backend cannot resume');
    await this.context.resume();
  }

  async suspend(): Promise<void> {
    this.assertLive();
    if (this.kind === 'offline') return;
    if (!this.context.suspend) audioRuntimeFail('E_AUDIO_RUNTIME_PORT', '$.backend', 'audio backend cannot suspend');
    await this.context.suspend();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of [...this.scheduled]) handle.dispose();
    this.scheduled.clear();
    if (this.ownsContext) void this.context.close?.().catch(() => undefined);
  }

  get stats(): Readonly<{ scheduledNodes: number; disposed: boolean }> {
    return Object.freeze({ scheduledNodes: this.scheduled.size, disposed: this.disposed });
  }

  private assertLive(): void {
    if (this.disposed || this.context.state === 'closed') {
      audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.backend', 'Web Audio backend is closed');
    }
  }
}
