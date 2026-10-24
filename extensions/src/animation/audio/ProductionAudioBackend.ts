import {audioRuntimeFail} from './diagnostics.js';
import type {ProductionAudioHost} from './ProductionAudioHost.js';
import type {AudioBackendPort, AudioBackendScheduleRequest, AudioDecodeRequest, AudioResourceResolverPort,
  DecodedAudioHandle, ScheduledAudioHandle} from './runtime-types.js';

type HostDecoded = Awaited<ReturnType<ProductionAudioHost['decode']>>;
interface DecodedSlot {readonly result: HostDecoded; references: number; ownerActive: boolean;}
let nextHostOwner = 0;

/** Adapter only: the existing AudioEventRuntime owns scheduling, clocks, tokens and voice budgets. */
export class ProductionAudioBackend implements AudioBackendPort {
  readonly kind: 'realtime' | 'restricted';
  readonly resolver: AudioResourceResolverPort | undefined;
  private readonly slots = new Set<DecodedSlot>();
  private readonly slotByPayload = new WeakMap<object, DecodedSlot>();
  private readonly voices = new Set<ScheduledAudioHandle>();
  private readonly jobs = new Set<AbortController>();
  private readonly faults: unknown[] = [];
  private faultCount = 0;
  private disposed = false;
  private readonly hostOwner: string;

  constructor(private readonly host: ProductionAudioHost) {
    validateProductionAudioHost(host);
    this.kind = host.profile === 'sample-accurate' ? 'realtime' : 'restricted';
    if (!Number.isSafeInteger(nextHostOwner + 1)) audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', '$.host.audio.owner', 'audio host owner identity exhausted');
    this.hostOwner = `hya-audio-owner-${++nextHostOwner}`;
    const resolve = host.resolve?.bind(host);
    this.resolver = resolve ? Object.freeze({resolve: (request: Parameters<AudioResourceResolverPort['resolve']>[0], signal: AbortSignal) => resolve(request.resource, signal)}) : undefined;
    this.currentFrame(); this.readState();
  }
  get profile(): ProductionAudioHost['profile'] {return this.host.profile;}
  get sampleRate(): number {return this.host.sampleRate;}
  get state(): ProductionAudioHost['state'] {return this.disposed ? 'closed' : this.readState();}
  currentFrame(): number {
    const frame = this.host.nowFrame();
    if (!Number.isSafeInteger(frame) || frame < 0) audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.host.audio.nowFrame', 'audio clock must return a nonnegative safe sample frame');
    return frame;
  }

  async decode(request: AudioDecodeRequest, signal: AbortSignal): Promise<DecodedAudioHandle> {
    this.assertLive();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort(); else signal.addEventListener('abort', abort, {once: true});
    this.jobs.add(controller);
    try {
      if (controller.signal.aborted) audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', `resources.${request.resource.id}`, 'decode was cancelled');
      // AudioAssetOwner resolves and verifies the original bytes before this call.
      const result = await this.host.decode(request.resource, controller.signal, request.bytes);
      if (controller.signal.aborted || this.disposed) {
        this.releaseHost(result);
        audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', `resources.${request.resource.id}`, 'late host decode was retired');
      }
      if (!result || typeof result.release !== 'function' || !Number.isSafeInteger(result.frames) || result.frames <= 0
        || !Number.isSafeInteger(result.channels) || result.channels <= 0 || !Number.isSafeInteger(result.sampleRate) || result.sampleRate <= 0
        || !Number.isSafeInteger(result.bytes) || result.bytes !== result.frames * result.channels * 4) {
        if (result && typeof result.release === 'function') this.releaseHost(result);
        audioRuntimeFail('E_AUDIO_RUNTIME_DECODE', `resources.${request.resource.id}`, 'host decoded PCM metadata is invalid');
      }
      const slot: DecodedSlot = {result, references: 1, ownerActive: true};
      const payload = Object.freeze({}); this.slotByPayload.set(payload, slot); this.slots.add(slot);
      return Object.freeze({sampleRate: result.sampleRate, channels: result.channels, frameLength: result.frames, payload,
        release: () => {if (!slot.ownerActive) return; slot.ownerActive = false; this.drop(slot);}});
    } finally {
      signal.removeEventListener('abort', abort); this.jobs.delete(controller);
    }
  }

  schedule(request: AudioBackendScheduleRequest): ScheduledAudioHandle {
    this.assertLive();
    const payload = request.decoded.payload;
    const slot = payload && typeof payload === 'object' ? this.slotByPayload.get(payload) : undefined;
    if (!slot?.ownerActive) audioRuntimeFail('E_AUDIO_RUNTIME_DECODE', request.voiceId, 'decoded audio does not belong to this active host adapter');
    slot.references++;
    let voice: ReturnType<ProductionAudioHost['schedule']> | undefined, finished = false, scheduled = false, notified = false;
    const notify = () => {
      if (!scheduled || notified) return;
      notified = true;
      if (!this.disposed) this.cleanup(request.onEnded);
    };
    const finish = () => {
      if (finished) return;
      finished = true; this.voices.delete(handle);
      if (voice) this.cleanup(() => voice!.release());
      this.drop(slot);
      // A host is allowed to complete synchronously; the existing runtime must first register its voice.
      notify();
    };
    const invoke = (operation: () => void) => {if (finished) return; try {operation();} catch (error) {finish(); throw error;}};
    const handle: ScheduledAudioHandle = Object.freeze({voiceId: request.voiceId,
      stop: (frame: number) => invoke(() => voice!.stop(frame)),
      setGain: (gain: number, frame: number) => invoke(() => voice!.setGain(gain, frame)),
      setRate: (rate: number, frame: number) => invoke(() => voice!.setRate(rate, frame)),
      dispose: finish});
    try {
      voice = this.host.schedule({token: `${this.hostOwner}:${request.voiceId}`, value: slot.result.value, startFrame: request.whenFrame,
        offsetFrame: request.offsetFrame, gain: request.gain, rate: request.rate, bus: request.bus ?? 'master',
        ...(request.stopFrame === undefined ? {} : {stopFrame: request.stopFrame, durationFrames: request.stopFrame - request.whenFrame}),
        ...(request.loop === undefined ? {} : {loop: request.loop}), onEnded: finish});
      if (!voice || ['stop', 'setGain', 'setRate', 'release'].some(key => typeof voice![key as keyof ReturnType<ProductionAudioHost['schedule']>] !== 'function'))
        audioRuntimeFail('E_AUDIO_RUNTIME_PORT', request.voiceId, 'host voice controls are incomplete');
      scheduled = true;
      if (finished) {this.cleanup(() => voice!.release()); queueMicrotask(notify);} else this.voices.add(handle);
      return handle;
    } catch (error) {finish(); throw error;}
  }
  async resume(): Promise<void> {this.assertLive(); if (this.state === 'running') return; await this.host.unlock(); this.assertLive();}
  async suspend(): Promise<void> {
    this.assertLive();
    // AudioEventRuntime stops this owner's voices before calling suspend. The shared host stays running.
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.jobs) controller.abort();
    for (const voice of [...this.voices]) voice.dispose();
    for (const slot of [...this.slots]) if (slot.ownerActive) {slot.ownerActive = false; this.drop(slot);}
  }
  get stats(): Readonly<{voices: number; decoded: number; jobs: number; faults: number; disposed: boolean}> {
    return Object.freeze({voices: this.voices.size, decoded: this.slots.size, jobs: this.jobs.size, faults: this.faultCount, disposed: this.disposed});
  }
  get cleanupFaults(): readonly unknown[] {return Object.freeze([...this.faults]);}
  private readState(): ProductionAudioHost['state'] {
    const state = this.host.state;
    if (!['running', 'suspended', 'closed'].includes(state)) audioRuntimeFail('E_AUDIO_RUNTIME_PORT', '$.host.audio.state', 'unknown host audio state');
    return state;
  }
  private drop(slot: DecodedSlot): void {if (--slot.references === 0) {this.slots.delete(slot); this.releaseHost(slot.result);}}
  private releaseHost(result: HostDecoded): void {this.cleanup(() => result.release());}
  private cleanup(operation: () => void): void {
    try {operation();} catch (error) {this.faultCount++; if (this.faults.length === 64) this.faults.shift(); this.faults.push(error);}
  }
  private assertLive(): void {if (this.disposed || this.readState() === 'closed') audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.host.audio', 'audio adapter is closed');}
}

/** Pure port/profile admission before any composition owner creates jobs. */
export function validateProductionAudioHost(host: ProductionAudioHost): void {
    if (!host || !['sample-accurate', 'html-media-restricted'].includes(host.profile)
      || !Number.isSafeInteger(host.sampleRate) || host.sampleRate <= 0
      || ['nowFrame', 'unlock', 'decode', 'schedule'].some(key => typeof host[key as keyof ProductionAudioHost] !== 'function'))
      audioRuntimeFail('E_AUDIO_RUNTIME_PORT', '$.host.audio', 'audio host contract is incomplete');
  const frame = host.nowFrame(); if (!Number.isSafeInteger(frame) || frame < 0) audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.host.audio.nowFrame', 'audio clock must return a nonnegative safe sample frame');
  if (!['running', 'suspended', 'closed'].includes(host.state)) audioRuntimeFail('E_AUDIO_RUNTIME_PORT', '$.host.audio.state', 'unknown host audio state');
}
