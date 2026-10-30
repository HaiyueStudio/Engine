import {AudioEventRuntime} from './AudioEventRuntime.js';
import {ProductionAudioBackend} from './ProductionAudioBackend.js';
import {audioRuntimeFail} from './diagnostics.js';
import type {ProductionAudioHost} from './ProductionAudioHost.js';
import type {RuntimeAudioClockDomain, RuntimeAudioDocument, RuntimeClockSnapshot} from './runtime-types.js';

export interface ProductionAudioRequest {
  readonly domain: RuntimeAudioClockDomain;
  readonly time: number;
  readonly rate: number;
  readonly operation: 'advance' | 'seek' | 'pause' | 'resume' | 'stop';
}
export interface ProductionAudioTrace {
  readonly sequence: number;
  readonly operation: string;
  readonly token: string;
  readonly resource: string;
  readonly sampleFrame: number;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export type ProductionAudioCommand = Readonly<{kind:'transport'; clocks:RuntimeClockSnapshot; rate:number; status:'running'|'paused'|'stopped'; relocation?:'seek'|'restart'|'stop'}> | Readonly<{kind: 'clock'; clocks: RuntimeClockSnapshot; rate: number}> | Readonly<{kind: 'update'; request: ProductionAudioRequest}> | Readonly<{kind: 'play'; cue: string; domain?: RuntimeAudioClockDomain}> | Readonly<{kind: 'stop-cue'; cue: string}>;
export interface PreparedProductionAudioBatch {publish(): Promise<void>; rollback(): void;}

/** Owns one existing runtime and its host adapter. Parsing belongs to the public format entry. */
export class ProductionAudioOwner {
  private readonly backend: ProductionAudioBackend;
  private readonly runtime: AudioEventRuntime;
  private readonly resources: ReadonlyMap<string, string>;
  private readonly times = {composition: 0, state: 0, event: 0};
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private reserved = 0;
  private readonly reservations = new Set<{cost: number; active: boolean}>();
  private command = 0;
  private unlocked = false;
  private unlocking: Promise<void> | undefined;
  private explicitlyPaused = false;
  private disposed = false;
  private initialized = false;
  private readonly signal: AbortSignal | undefined;
  private readonly abort = () => this.dispose();
  private readonly cleanupErrors: unknown[] = [];

  constructor(readonly document: RuntimeAudioDocument, private readonly host: ProductionAudioHost, options: Readonly<{signal?: AbortSignal}> = {}) {
    if (options.signal?.aborted) audioRuntimeFail('E_AUDIO_RUNTIME_ABORTED', '$.signal', 'audio creation was cancelled');
    this.backend = new ProductionAudioBackend(host);
    try {
      this.runtime = new AudioEventRuntime(document, this.backend, {
        ...(this.backend.resolver ? {resolver: this.backend.resolver} : {}), compositionTransport: true,
      });
    } catch (error) {this.backend.dispose(); throw error;}
    this.resources = new Map(document.cues.map(cue => [cue.id, cue.resource]));
    this.signal = options.signal;
    this.signal?.addEventListener('abort', this.abort, {once: true});
  }

  async prepare(): Promise<void> {
    this.assertLive();
    if (this.initialized) return;
    try {
      // A running shared context is not authorization for this player to emit audio.
      await this.runtime.pause();
      this.assertLive(); await this.runtime.prepare(); this.assertLive(); this.initialized = true;
    } catch (error) {this.dispose(); throw error;}
  }

  update(request: ProductionAudioRequest): Promise<void> {
    let value: ProductionAudioRequest;
    try {this.validate(request); value = Object.freeze({...request});} catch (error) {return Promise.reject(error);}
    return this.enqueue(() => this.execute({kind: 'update', request: value}));
  }

  play(cue: string, domain: RuntimeAudioClockDomain = 'event'): Promise<void> {return this.enqueue(() => this.execute({kind: 'play', cue, domain}));}
  stop(cue: string): Promise<void> {return this.enqueue(() => this.execute({kind: 'stop-cue', cue}));}

  /** Validates/reserves synchronously; uses the original command queue only after full-frame publication. */
  prepareBatch(commands: readonly ProductionAudioCommand[], beforeExecute?: () => void, transportStatus?: 'running'|'paused'|'stopped'): PreparedProductionAudioBatch {
    this.assertPrepared(); this.backend.currentFrame();
    if (!Array.isArray(commands) || !commands.length || commands.length > this.document.limits.maxEventTokens
      || this.pending + this.reserved + commands.length > this.document.limits.maxEventTokens)
      audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', '$.audio.queue', 'prepared audio commands exceed the original queue budget');
    // A composition frame is admitted before the preceding asynchronous host command settles.
    // Its existing transport intent, when supplied, is the authoritative state at this queue position.
    let paused = transportStatus === undefined ? this.runtime.stats.paused : transportStatus !== 'running', bytes = 0;
    const values = Object.freeze(commands.map(command => {
      if (!command || typeof command !== 'object') audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.audio', 'prepared command must be an object');
      bytes += command.kind === 'play' || command.kind === 'stop-cue' ? new TextEncoder().encode(command.cue).byteLength + 64 : 256;
      if (bytes > 64 * 1024 * 1024) audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', '$.audio.queue', 'prepared audio bytes exceed the composition ceiling');
      if (command.kind === 'transport') {
        this.assertRate(command.rate);
        if (!['running','paused','stopped'].includes(command.status) || command.relocation !== undefined && !['seek','restart','stop'].includes(command.relocation)) audioRuntimeFail('E_AUDIO_RUNTIME_STATE','$.audio.transport','invalid prepared transport intent');
        for (const domain of ['composition','state','event'] as const) this.validate({operation:'advance',domain,time:command.clocks[domain],rate:command.rate});
        if (command.status === 'running') this.requireUnlocked();
        this.runtime.assertPreparedAdvance(command.clocks,command.rate,{active:command.status==='running',...(command.relocation ? {relocation:command.relocation} : {})});
        paused=command.status!=='running';
        return Object.freeze({...command,clocks:Object.freeze({...command.clocks})});
      }
      if (command.kind === 'clock') {
        for (const domain of ['composition', 'state', 'event'] as const) this.validate({operation: 'advance', domain, time: command.clocks[domain], rate: command.rate});
        this.requireUnlocked(); this.runtime.assertPreparedAdvance(command.clocks, command.rate); return Object.freeze({kind: 'clock' as const, clocks: Object.freeze({...command.clocks}), rate: command.rate});
      }
      if (command.kind === 'update') {
        this.validate(command.request);
        if (command.request.operation === 'advance' || command.request.operation === 'resume') this.requireUnlocked();
        if (command.request.operation === 'pause' || command.request.operation === 'stop') paused = true;
        if (command.request.operation === 'resume') paused = false;
        return Object.freeze({kind: 'update' as const, request: Object.freeze({...command.request})});
      }
      if (command.kind === 'play') {
        this.requireUnlocked(); this.validateCue(command.cue); this.validateDomain(command.domain ?? 'event');
        if (paused) audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.audio', 'resume before a prepared cue start');
        return Object.freeze({kind: 'play' as const, cue: command.cue, domain: command.domain ?? 'event'});
      }
      if (command.kind !== 'stop-cue') audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.audio', 'unknown prepared audio command');
      this.validateCue(command.cue); return Object.freeze({kind: 'stop-cue' as const, cue: command.cue});
    }));
    const reservation = {cost: values.length, active: true}; this.reservations.add(reservation); this.reserved += reservation.cost;
    let job: Promise<void> | undefined;
    const release = (): void => {if (!reservation.active) return; reservation.active = false; this.reservations.delete(reservation); this.reserved -= reservation.cost;};
    return Object.freeze({rollback: release, publish: () => {
      if (job) return job;
      if (!reservation.active) return Promise.reject(new Error('Prepared audio batch was cancelled'));
      release(); return job = this.enqueue(async () => {beforeExecute?.(); for (const command of values) {this.assertLive(); await this.execute(command);}}, values.length);
    }});
  }

  private async execute(command: ProductionAudioCommand): Promise<void> {
    if (command.kind === 'transport') {
      if (command.relocation==='stop') {this.runtime.reset();await this.runtime.pause();this.times.composition=this.times.state=this.times.event=0;this.explicitlyPaused=true;return;}
      if (command.relocation) {
        if (command.relocation==='restart') this.runtime.reset();
        else await this.runtime.pause();
        if(command.relocation==='seek') for(const domain of ['composition','state','event'] as const) await this.runtime.seek(domain,command.clocks[domain],command.rate);
        Object.assign(this.times,command.clocks);
      }
      if (command.status!=='running') {await this.runtime.pause();this.explicitlyPaused=true;return;}
      this.requireUnlocked();if(this.runtime.stats.paused) await this.runtime.resume(true);this.explicitlyPaused=false;
      await this.runtime.advance(command.clocks,command.rate);Object.assign(this.times,command.clocks);return;
    }
    if (command.kind === 'clock') {this.requireUnlocked(); await this.runtime.advance(command.clocks, command.rate); if (!this.runtime.stats.paused) Object.assign(this.times, command.clocks); return;}
    if (command.kind === 'update') {const value = command.request;
      switch (value.operation) {
        case 'advance': {
          this.requireUnlocked();
          const snapshot = {...this.times, [value.domain]: value.time};
          await this.runtime.advance(snapshot, value.rate);
          if (!this.runtime.stats.paused) this.times[value.domain] = value.time;
          break;
        }
        case 'seek':
          await this.runtime.seek(value.domain, value.time, value.rate); this.times[value.domain] = value.time; break;
        case 'pause':
          this.explicitlyPaused = true; await this.runtime.pause(); break;
        case 'resume':
          this.requireUnlocked(); await this.runtime.resume(true); this.explicitlyPaused = false; break;
        case 'stop':
          this.runtime.reset(); await this.runtime.pause();
          this.times.composition = this.times.state = this.times.event = 0; this.explicitlyPaused = true; break;
      }
    } else if (command.kind === 'play') {const cue = command.cue, domain = command.domain ?? 'event';
      this.requireUnlocked(); this.validateCue(cue); this.validateDomain(domain);
      if (this.runtime.stats.paused) audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.audio', 'resume the audio owner before playing a cue');
      await this.runtime.dispatchCue({eventId: this.nextToken(), cue, operation: 'start', clock: domain});
    } else {const cue = command.cue;
      this.validateCue(cue);
      await this.runtime.dispatchCue({eventId: this.nextToken(), cue, operation: 'stop', clock: 'event'});
    }
  }

  setBusGain(bus: string, gain: number): void {
    this.assertPrepared();
    if (this.pending || this.reserved) audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.audio', 'await queued audio work before changing a bus synchronously');
    this.runtime.setBusGain(bus, gain);
  }

  unlock(): Promise<void> {
    try {this.assertPrepared();} catch (error) {return Promise.reject(error);}
    if (this.unlocking) return this.unlocking;
    // Invoke the host now, within the caller's actual gesture, never in a queued microtask.
    let grant: Promise<void>;
    try {grant = this.host.unlock();} catch (error) {return Promise.reject(error);}
    const job = grant.then(async () => {
      this.assertLive();
      if (this.backend.state !== 'running') audioRuntimeFail('E_AUDIO_RUNTIME_AUTOPLAY', '$.host.audio.state', 'unlock did not put the host into a running state');
      this.unlocked = true;
      await this.enqueue(async () => {if (!this.explicitlyPaused) await this.runtime.resume(true);});
    }).finally(() => {if (this.unlocking === job) this.unlocking = undefined;});
    this.unlocking = job;
    return job;
  }

  get trace(): readonly ProductionAudioTrace[] {
    return Object.freeze(this.runtime.trace.map(entry => {
      const details: Record<string, string | number | boolean | null> = {};
      for (const key of ['cue', 'voiceId', 'offsetFrame', 'owner', 'reason'] as const) if (entry[key] !== undefined) details[key] = entry[key]!;
      return Object.freeze({sequence: entry.sequence, operation: entry.kind, token: entry.eventId ?? entry.voiceId ?? '',
        resource: entry.cue ? this.resources.get(entry.cue) ?? '' : '', sampleFrame: entry.frame ?? 0, details: Object.freeze(details)});
    }));
  }
  dispose(): void {
    if (this.disposed) return;
    for (const reservation of this.reservations) reservation.active = false; this.reservations.clear(); this.reserved = 0;
    this.disposed = true; this.signal?.removeEventListener('abort', this.abort);
    // A broken/closed host clock must not prevent decoder cancellation and voice retirement.
    for (const release of [() => this.runtime.dispose(), () => this.runtime.assets.dispose(), () => this.backend.dispose()]) {
      try {release();} catch (error) {this.cleanupErrors.push(error);}
    }
  }
  get stats(): Readonly<{pending: number; reserved: number; disposed: boolean; unlocked: boolean; cleanupErrors: number; voices: number; decoded: number}> {
    return Object.freeze({pending: this.pending, reserved: this.reserved, disposed: this.disposed, unlocked: this.unlocked,
      cleanupErrors: this.cleanupErrors.length + this.backend.stats.faults, voices: this.backend.stats.voices, decoded: this.backend.stats.decoded});
  }
  private enqueue(operation: () => Promise<void>, cost = 1): Promise<void> {
    try {
      this.assertPrepared();
      if (this.pending + this.reserved + cost > this.document.limits.maxEventTokens) audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', '$.audio.queue', 'audio command queue exceeds the document token budget');
    } catch (error) {return Promise.reject(error);}
    this.pending += cost;
    const job = this.queue.then(async () => {this.assertLive(); await operation(); this.assertLive();}).finally(() => {this.pending -= cost;});
    this.queue = job.catch(() => undefined);
    return job;
  }
  private nextToken(): string {
    if (!Number.isSafeInteger(this.command + 1)) audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', '$.audio.sequence', 'audio command sequence exhausted');
    return `hya-audio-command-${++this.command}`;
  }
  assertRate(rate:number):void {this.validate({operation:'advance',domain:'composition',time:0,rate});}
  private validate(request: ProductionAudioRequest): void {
    this.assertPrepared();
    if (!request || !['advance', 'seek', 'pause', 'resume', 'stop'].includes(request.operation)) audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.audio.operation', 'unknown transport operation');
    this.validateDomain(request.domain);
    if (!Number.isFinite(request.time) || request.time < 0) audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.audio.time', 'time must be finite and nonnegative');
    if (!Number.isFinite(request.rate) || request.rate < .0625 || request.rate > 16
      || this.document.cues.some(cue => cue.rate * request.rate < .0625 || cue.rate * request.rate > 16))
      audioRuntimeFail('E_AUDIO_RUNTIME_PROFILE', '$.audio.rate', 'rate or combined cue rate is outside the audio profile');
  }
  private validateDomain(domain: RuntimeAudioClockDomain): void {
    if (!['composition', 'state', 'event'].includes(domain)) audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.audio.domain', 'unknown clock domain');
  }
  private validateCue(cue: string): void {
    if (!this.resources.has(cue)) audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', '$.audio.cue', 'unknown audio cue');
  }
  private requireUnlocked(): void {
    if (!this.unlocked || this.backend.state !== 'running') audioRuntimeFail('E_AUDIO_RUNTIME_AUTOPLAY', '$.audio', 'unlock audio from an actual user gesture before playback');
  }
  private assertPrepared(): void {this.assertLive(); if (!this.initialized) audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.audio', 'prepare the audio owner first');}
  private assertLive(): void {
    if (this.disposed) audioRuntimeFail(this.signal?.aborted ? 'E_AUDIO_RUNTIME_ABORTED' : 'E_AUDIO_RUNTIME_STATE', '$.audio', 'audio owner is disposed');
  }
}
