import { AudioAssetOwner } from './AudioAssetOwner.js';
import { AudioRuntimeError, audioRuntimeFail } from './diagnostics.js';
import type {
  AudioBackendPort,
  AudioResourceResolverPort,
  AudioRuntimeDiagnosticRecord,
  AudioRuntimeTraceEntry,
  RuntimeAudioClockDomain,
  RuntimeAudioCue,
  RuntimeAudioDocument,
  RuntimeAudioResource,
  RuntimeAudioTimelineEvent,
  RuntimeClockSnapshot,
  RuntimeCueCommand,
  ScheduledAudioHandle,
} from './runtime-types.js';

interface DomainState {
  time: number;
  anchorTime: number;
  anchorFrame: number;
  rate: number;
  readonly scheduledEvents: Set<string>;
}

interface ActiveVoice {
  readonly id: string;
  readonly cue: RuntimeAudioCue;
  readonly eventId: string;
  readonly clock: RuntimeAudioClockDomain;
  readonly startFrame: number;
  readonly contentAdvanceAtStart: number;
  readonly playbackRate: number;
  readonly handle: ScheduledAudioHandle;
  stopping: boolean;
}

interface PausedVoice {
  readonly cue: string;
  readonly eventId: string;
  readonly clock: RuntimeAudioClockDomain;
  readonly delayFrames: number;
  readonly contentAdvanceFrames: number;
}

interface SuspendedStart {
  readonly cue: string;
  readonly eventId: string;
  readonly clock: RuntimeAudioClockDomain;
  readonly intendedFrame: number;
  readonly contentAdvanceFrames: number;
}

interface PendingVoiceReservation {
  readonly id: number;
  readonly cue: RuntimeAudioCue;
  readonly eventId: string;
  readonly frame: number;
  readonly clock: RuntimeAudioClockDomain;
  cancelled: boolean;
}

export interface AudioEventRuntimeOptions {
  readonly resolver?: AudioResourceResolverPort;
  /** New composition owner semantics; the standalone legacy transport remains unchanged. */
  readonly compositionTransport?: boolean;
}

export class AudioEventRuntime {
  readonly assets: AudioAssetOwner;
  private readonly cues: Map<string, RuntimeAudioCue>;
  private readonly resources: Map<string, RuntimeAudioResource>;
  private readonly events: Readonly<Record<RuntimeAudioClockDomain, readonly RuntimeAudioTimelineEvent[]>>;
  private readonly domains: Record<RuntimeAudioClockDomain, DomainState>;
  private readonly busParents = new Map<string, string | undefined>();
  private readonly busGains = new Map<string, number>();
  private readonly voices = new Map<string, ActiveVoice>();
  private readonly eventTokens = new Set<string>();
  private readonly pendingSuspended: SuspendedStart[] = [];
  private readonly pendingVoices = new Map<number, PendingVoiceReservation>();
  private pausedVoices: PausedVoice[] = [];
  private readonly diagnosticRecords: AudioRuntimeDiagnosticRecord[] = [];
  private readonly traceRecords: AudioRuntimeTraceEntry[] = [];
  private voiceSequence = 0;
  private reservationSequence = 0;
  private recordSequence = 0;
  private lifecycleGeneration = 0;
  private paused = false;
  private visibilityPaused = false;
  private disposed = false;
  private readonly compositionTransport: boolean;

  constructor(
    readonly document: RuntimeAudioDocument,
    private readonly backend: AudioBackendPort,
    options: AudioEventRuntimeOptions = {},
  ) {
    this.compositionTransport = options.compositionTransport ?? false;
    if (backend.profile !== document.playbackProfile) {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_PROFILE',
        '$.playbackProfile',
        `document requires ${document.playbackProfile}, backend provides ${backend.profile}`,
      );
    }
    if (backend.sampleRate !== document.clock.sampleRate) {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_CLOCK',
        '$.clock.sampleRate',
        'backend and document sample rates must match for sample-frame scheduling',
      );
    }
    this.cues = new Map(document.cues.map(cue => [cue.id, cue]));
    this.resources = new Map(document.resources.map(resource => [resource.id, resource]));
    this.events = Object.freeze({
      composition: sortedEvents(document.timelineEvents, 'composition'),
      state: sortedEvents(document.timelineEvents, 'state'),
      event: sortedEvents(document.timelineEvents, 'event'),
    });
    const frame = backend.currentFrame();
    this.domains = {
      composition: domainState(frame),
      state: domainState(frame),
      event: domainState(frame),
    };
    for (const bus of document.buses) {
      this.busParents.set(bus.id, bus.parent);
      this.busGains.set(bus.id, bus.gain);
    }
    this.assets = new AudioAssetOwner(document.resources, backend, {
      ...(options.resolver ? { resolver: options.resolver } : {}),
      ownsDecoder: false,
      maxDecodeJobs: document.limits.maxDecodeJobs,
      maxDecodedFrames: document.limits.maxDecodedFrames,
      maxDecodedBytes: document.limits.maxDecodedBytes,
    });
    if (document.playbackProfile === 'html-media-restricted') {
      this.diagnostic(
        'W_AUDIO_RESTRICTED_PROFILE',
        '$.playbackProfile',
        'restricted media profile is not sample-accurate parity evidence',
      );
    }
  }

  async prepare(resourceIds: readonly string[] = [...this.resources.keys()]): Promise<void> {
    this.assertLive();
    await Promise.all(resourceIds.map(resourceId => this.assets.load(resourceId)));
  }

  /** Pure admission for the same original scheduler before a whole-player frame may commit. */
  assertPreparedAdvance(snapshot: RuntimeClockSnapshot, rate = 1, intent?: Readonly<{active:boolean; relocation?: 'seek' | 'restart' | 'stop'}>): void {
    this.assertLive(); validateRate(rate); validateSnapshot(snapshot); this.validateTransportRate(rate);
    let events = 0;
    for (const domain of clockDomains()) {
      const state = this.domains[domain];
      if (!intent?.relocation && snapshot[domain] < state.time) audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.clock.' + domain, 'clock cannot move backward through advance; use seek or rewind');
      if (!this.compositionTransport || !(intent?.active ?? !this.paused)) continue;
      const end = snapshot[domain] + this.document.clock.lookAheadFrames / this.backend.sampleRate * rate;
      for (const event of this.events[domain]) if (event.time <= end && (intent?.relocation === 'restart' ? true : intent?.relocation === 'seek' ? event.time > snapshot[domain] : !state.scheduledEvents.has(event.id))) {
        if (++events > this.document.limits.maxEventTokens) audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', '$.clock.events', 'the original event-token ceiling is exceeded by this complete crossed window');
        if (event.operation === 'start' && event.time < snapshot[domain] && this.document.clock.lateDecodePolicy === 'error') audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.clock.' + domain, 'the crossed cue would violate the declared late-decode error policy');
      }
    }
  }

  async advance(snapshot: RuntimeClockSnapshot, rate = 1): Promise<void> {
    this.assertPreparedAdvance(snapshot, rate);
    for (const domain of clockDomains()) if (snapshot[domain] < this.domains[domain].time) {
      audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', `$.clock.${domain}`, 'clock cannot move backward through advance; use seek or rewind');
    }
    if (this.paused) return;
    const frame = this.backend.currentFrame();
    for (const domain of clockDomains()) {
      const state = this.domains[domain];
      const nextTime = snapshot[domain];
      if (nextTime < state.time) {
        audioRuntimeFail(
          'E_AUDIO_RUNTIME_CLOCK',
          `$.clock.${domain}`,
          'clock cannot move backward through advance; use seek or rewind',
        );
      }
      this.checkDrift(domain, nextTime, rate, frame);
      if (this.compositionTransport && rate !== state.rate) await this.changeTransportRate(domain, rate, frame);
      state.time = nextTime;
      state.anchorTime = nextTime;
      state.anchorFrame = frame;
      state.rate = rate;
      await this.scheduleWindow(domain);
    }
  }

  async dispatchCue(command: RuntimeCueCommand): Promise<void> {
    this.assertLive();
    if (this.eventTokens.has(command.eventId)) {
      this.recordTrace({ kind: 'ignored', eventId: command.eventId, cue: command.cue, reason: 'duplicate-event-token' });
      return;
    }
    if (this.eventTokens.size >= this.document.limits.maxEventTokens) {
      audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', '$.eventTokens', 'exactly-once event token budget exceeded');
    }
    const cue = this.requireCue(command.cue);
    const state = this.domains[command.clock];
    const time = command.atTime ?? state.time;
    if (!Number.isFinite(time) || time < 0) {
      audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', `events.${command.eventId}.atTime`, 'cue time is invalid');
    }
    const frame = Math.max(
      this.backend.currentFrame(),
      state.anchorFrame + Math.round((time - state.anchorTime) / state.rate * this.backend.sampleRate),
    );
    this.eventTokens.add(command.eventId);
    if (command.operation === 'start') {
      await this.startCue(cue, command.eventId, command.clock, frame, 0);
    } else {
      this.stopCue(cue.id, frame, 'cue-command');
      if (this.compositionTransport) {
        this.pausedVoices = this.pausedVoices.filter(voice => voice.cue !== cue.id);
        for (let index = this.pendingSuspended.length - 1; index >= 0; index--) {
          if (this.pendingSuspended[index]!.cue === cue.id) this.pendingSuspended.splice(index, 1);
        }
        for (const pending of [...this.pendingVoices.values()]) if (pending.cue.id === cue.id) this.cancelPendingVoice(pending, frame, 'cue-command');
      }
    }
  }

  async seek(domain: RuntimeAudioClockDomain, time: number, rate = this.domains[domain].rate): Promise<void> {
    this.assertLive();
    validateRate(rate);
    this.validateTransportRate(rate);
    if (!Number.isFinite(time) || time < 0) {
      audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', `$.clock.${domain}`, 'seek time must be finite and non-negative');
    }
    const frame = this.backend.currentFrame();
    this.stopDomain(domain, frame, 'seek');
    if (this.compositionTransport) {
      this.pausedVoices = this.pausedVoices.filter(voice => voice.clock !== domain);
      for (let index = this.pendingSuspended.length - 1; index >= 0; index--) {
        if (this.pendingSuspended[index]!.clock === domain) this.pendingSuspended.splice(index, 1);
      }
      for (const pending of [...this.pendingVoices.values()]) if (pending.clock === domain) this.cancelPendingVoice(pending, frame, 'seek');
    }
    const state = this.domains[domain];
    state.time = time;
    state.anchorTime = time;
    state.anchorFrame = frame;
    state.rate = rate;
    state.scheduledEvents.clear();
    const active = new Map<string, RuntimeAudioTimelineEvent[]>();
    for (const event of this.events[domain]) {
      if (event.time > time) break;
      state.scheduledEvents.add(event.id);
      if (event.operation === 'start') {
        const entries = active.get(event.cue) ?? [];
        entries.push(event);
        active.set(event.cue, entries);
      } else {
        active.delete(event.cue);
      }
    }
    for (const entries of active.values()) {
      for (const event of entries) {
        const cue = this.requireCue(event.cue);
        if (this.compositionTransport && !cue.loop) continue;
        const resource = this.resources.get(cue.resource)!;
        const contentAdvance = Math.floor((time - event.time) * resource.sampleRate * cue.rate);
        if (this.compositionTransport && this.paused) {
          this.pausedVoices.push(Object.freeze({cue: cue.id, eventId: event.id, clock: domain, delayFrames: 0, contentAdvanceFrames: contentAdvance}));
        } else await this.startCue(cue, event.id, domain, frame, contentAdvance);
      }
    }
    if (!this.paused && !this.compositionTransport) await this.scheduleWindow(domain);
  }

  async rewind(domain: RuntimeAudioClockDomain): Promise<void> {
    await this.seek(domain, 0);
  }

  reset(): void {
    this.assertLive();
    this.lifecycleGeneration++;
    const frame = this.backend.currentFrame();
    this.stopAll(frame, 'reset');
    this.eventTokens.clear();
    this.pendingSuspended.length = 0;
    this.cancelPendingVoices();
    this.pausedVoices = [];
    this.paused = false;
    this.visibilityPaused = false;
    for (const domain of clockDomains()) {
      const state = this.domains[domain];
      state.time = 0;
      state.anchorTime = 0;
      state.anchorFrame = frame;
      state.rate = 1;
      state.scheduledEvents.clear();
    }
  }

  async pause(): Promise<void> {
    this.assertLive();
    if (this.paused) return;
    this.paused = true;
    const frame = this.backend.currentFrame();
    this.pausedVoices = [...this.voices.values()]
      .filter(voice => !voice.stopping)
      .map(voice => {
        const resource = this.resources.get(voice.cue.resource)!;
        const delayFrames = Math.max(0, voice.startFrame - frame);
        const elapsedBackendFrames = Math.max(0, frame - voice.startFrame);
        const elapsedContentFrames = Math.floor(
          elapsedBackendFrames * voice.playbackRate * resource.sampleRate / this.backend.sampleRate,
        );
        return Object.freeze({
          cue: voice.cue.id,
          eventId: voice.eventId,
          clock: voice.clock,
          delayFrames,
          contentAdvanceFrames: voice.contentAdvanceAtStart + elapsedContentFrames,
        });
      });
    this.stopAll(frame, 'pause');
    if (this.backend.kind === 'realtime') await this.backend.suspend();
  }

  async resume(userGesture: boolean): Promise<void> {
    this.assertLive();
    if (this.document.browser.autoplay === 'require-user-gesture' && !userGesture) {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_AUTOPLAY',
        '$.browser.autoplay',
        'audio resume requires an explicit user gesture',
      );
    }
    try {
      await this.backend.resume();
    } catch (error) {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_AUTOPLAY',
        '$.backend',
        error instanceof Error ? error.message : 'audio backend resume was rejected',
      );
    }
    const frame = this.backend.currentFrame();
    const paused = this.pausedVoices;
    this.pausedVoices = [];
    this.paused = false;
    this.visibilityPaused = false;
    for (const entry of paused) {
      await this.startCue(
        this.requireCue(entry.cue),
        entry.eventId,
        entry.clock,
        frame + entry.delayFrames,
        entry.contentAdvanceFrames,
      );
    }
    const suspended = this.pendingSuspended.splice(0);
    for (const entry of suspended) {
      await this.startCue(
        this.requireCue(entry.cue),
        entry.eventId,
        entry.clock,
        entry.intendedFrame,
        entry.contentAdvanceFrames,
        true,
      );
    }
  }

  async setVisibility(visible: boolean): Promise<void> {
    this.assertLive();
    if (this.document.clock.visibilityPolicy === 'continue') return;
    if (!visible && !this.paused) {
      this.visibilityPaused = true;
      await this.pause();
    }
    if (visible && this.visibilityPaused) {
      this.diagnostic(
        'W_AUDIO_VISIBILITY_RESUME_REQUIRED',
        '$.clock.visibilityPolicy',
        'visibility restored; an explicit authorized resume is required',
      );
    }
  }

  async transition(owner: string, policy: 'continue' | 'stop' | 'restart'): Promise<void> {
    this.assertLive();
    if (policy === 'continue') return;
    const frame = this.backend.currentFrame();
    const owned = [...this.voices.values()].filter(voice => voice.cue.owner === owner && !voice.stopping);
    for (const voice of owned) this.stopVoice(voice, frame, 'transition');
    if (policy === 'restart') {
      for (const voice of owned) {
        await this.startCue(voice.cue, `${voice.eventId}:transition:${this.recordSequence}`, voice.clock, frame, 0);
      }
    }
  }

  setBusGain(busId: string, gain: number): void {
    this.assertLive();
    if (!this.busGains.has(busId)) audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `buses.${busId}`, 'unknown audio bus');
    if (!Number.isFinite(gain) || gain < 0 || gain > 4) {
      audioRuntimeFail('E_AUDIO_RUNTIME_LIMIT', `buses.${busId}.gain`, 'bus gain must be in [0, 4]');
    }
    this.busGains.set(busId, gain);
    const frame = this.backend.currentFrame();
    for (const voice of this.voices.values()) {
      if (voice.stopping || !this.busChainContains(voice.cue.bus, busId)) continue;
      voice.handle.setGain(this.effectiveGain(voice.cue), frame);
    }
  }

  async replaceResource(resource: RuntimeAudioResource, signal?: AbortSignal): Promise<void> {
    this.assertLive();
    this.validateReplacement(resource);
    const frame = this.backend.currentFrame();
    for (const voice of [...this.voices.values()]) {
      if (voice.cue.resource === resource.id) this.stopVoice(voice, frame, 'resource-replace');
    }
    for (const reservation of [...this.pendingVoices.values()]) {
      if (reservation.cue.resource === resource.id) this.cancelPendingVoice(reservation, frame, 'resource-replace');
    }
    await this.assets.replace(resource, signal);
    this.resources.set(resource.id, resource);
    this.recordTrace({ kind: 'resource-replaced', reason: resource.id });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration++;
    this.stopAll(this.backend.currentFrame(), 'dispose');
    this.pendingSuspended.length = 0;
    this.cancelPendingVoices();
    this.pausedVoices = [];
    this.eventTokens.clear();
    this.assets.dispose();
    this.backend.dispose();
  }

  get trace(): readonly AudioRuntimeTraceEntry[] {
    return Object.freeze(this.traceRecords.map(entry => Object.freeze({ ...entry })));
  }

  get diagnostics(): readonly AudioRuntimeDiagnosticRecord[] {
    return Object.freeze(this.diagnosticRecords.map(entry => Object.freeze({ ...entry })));
  }

  get stats(): Readonly<{
    voices: number;
    eventTokens: number;
    pendingSuspended: number;
    pendingVoices: number;
    pausedVoices: number;
    paused: boolean;
    disposed: boolean;
  }> {
    return Object.freeze({
      voices: [...this.voices.values()].filter(voice => !voice.stopping).length,
      eventTokens: this.eventTokens.size,
      pendingSuspended: this.pendingSuspended.length,
      pendingVoices: this.pendingVoices.size,
      pausedVoices: this.pausedVoices.length,
      paused: this.paused,
      disposed: this.disposed,
    });
  }

  private async scheduleWindow(domain: RuntimeAudioClockDomain): Promise<void> {
    const state = this.domains[domain];
    const lookAheadSeconds = this.document.clock.lookAheadFrames / this.backend.sampleRate * state.rate;
    const end = state.time + lookAheadSeconds;
    for (const event of this.events[domain]) {
      if ((!this.compositionTransport && event.time < state.time) || event.time > end || state.scheduledEvents.has(event.id)) continue;
      state.scheduledEvents.add(event.id);
      const frame = state.anchorFrame + Math.round((event.time - state.anchorTime) / state.rate * this.backend.sampleRate);
      const cue = this.requireCue(event.cue);
      if (event.operation === 'start') await this.startCue(cue, event.id, domain, frame, 0);
      else this.stopCue(cue.id, this.compositionTransport ? Math.max(frame, this.backend.currentFrame()) : frame, 'timeline-stop');
    }
  }

  private async startCue(
    cue: RuntimeAudioCue,
    eventId: string,
    clock: RuntimeAudioClockDomain,
    intendedFrame: number,
    contentAdvanceFrames: number,
    fromSuspendedQueue = false,
  ): Promise<void> {
    if (this.disposed) return;
    const playbackRate = cue.rate * (this.compositionTransport ? this.domains[clock].rate : 1);
    if (this.backend.kind !== 'offline' && this.backend.state === 'suspended' && !fromSuspendedQueue) {
      if (this.document.clock.suspendedPolicy === 'error') {
        audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$.backend', 'audio backend is suspended');
      }
      this.pendingSuspended.push(Object.freeze({
        cue: cue.id,
        eventId,
        clock,
        intendedFrame,
        contentAdvanceFrames,
      }));
      this.recordTrace({ kind: 'queued-suspended', cue: cue.id, eventId, frame: intendedFrame });
      return;
    }

    const overlapping = [...this.voices.values()].filter(voice => (
      !voice.stopping && voice.cue.id === cue.id && voice.cue.owner === cue.owner
    ));
    const pendingOverlap = [...this.pendingVoices.values()].filter(reservation => (
      !reservation.cancelled && reservation.cue.id === cue.id && reservation.cue.owner === cue.owner
    ));
    if ((overlapping.length || pendingOverlap.length) && cue.overlap === 'ignore') {
      this.recordTrace({ kind: 'ignored', cue: cue.id, eventId, reason: 'overlap-ignore' });
      return;
    }
    if (cue.overlap === 'restart') {
      for (const voice of overlapping) this.stopVoice(voice, intendedFrame, 'overlap-restart');
      for (const reservation of pendingOverlap) this.cancelPendingVoice(reservation, intendedFrame, 'overlap-restart');
    }
    const reservation = this.reserveVoice(cue, eventId, intendedFrame, clock);
    try {
      const generation = this.lifecycleGeneration;
      const decoded = await this.assets.load(cue.resource);
      if (reservation.cancelled || this.disposed || generation !== this.lifecycleGeneration) return;
      const now = this.backend.currentFrame();
      const lateFrames = Math.max(0, now - intendedFrame);
      let contentAdvance = contentAdvanceFrames;
      if (lateFrames > 0) {
        if (this.document.clock.lateDecodePolicy === 'drop') {
          this.recordTrace({ kind: 'late-drop', cue: cue.id, eventId, frame: now, reason: 'late-decode' });
          return;
        }
        if (this.document.clock.lateDecodePolicy === 'error') {
          audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', `cues.${cue.id}`, 'audio decode completed after its schedule frame');
        }
        contentAdvance += Math.floor(lateFrames * playbackRate * decoded.sampleRate / this.backend.sampleRate);
        this.recordTrace({ kind: 'late-catch-up', cue: cue.id, eventId, frame: now, reason: String(lateFrames) });
      }
      const playback = resolvePlayback(playbackRate === cue.rate ? cue : {...cue, rate: playbackRate}, decoded.frameLength, contentAdvance, this.backend.sampleRate, decoded.sampleRate);
      if (!playback) {
        this.recordTrace({ kind: 'late-drop', cue: cue.id, eventId, frame: now, reason: 'cue-already-ended' });
        return;
      }
      const voiceId = `audio-voice-${++this.voiceSequence}`;
      const whenFrame = Math.max(now, intendedFrame);
      let voice: ActiveVoice;
      const handle = this.backend.schedule({
        voiceId,
        bus: cue.bus,
        decoded,
        whenFrame,
        offsetFrame: playback.offsetFrame,
        ...(playback.stopFrameCount === undefined
          ? {}
          : { stopFrame: whenFrame + playback.stopFrameCount }),
        rate: playbackRate,
        gain: this.effectiveGain(cue),
        ...(cue.loop ? { loop: { startFrame: cue.loop.startFrame, endFrame: cue.loop.endFrame } } : {}),
        onEnded: () => {
          const current = this.voices.get(voiceId);
          if (current) this.voices.delete(voiceId);
          this.recordTrace({ kind: 'ended', cue: cue.id, eventId, voiceId, frame: this.backend.currentFrame(), owner: cue.owner });
        },
      });
      voice = {
        id: voiceId,
        cue,
        eventId,
        clock,
        startFrame: whenFrame,
        contentAdvanceAtStart: contentAdvance,
        playbackRate,
        handle,
        stopping: false,
      };
      this.voices.set(voiceId, voice);
      this.recordTrace({
        kind: 'scheduled',
        cue: cue.id,
        eventId,
        voiceId,
        frame: whenFrame,
        offsetFrame: playback.offsetFrame,
        owner: cue.owner,
      });
    } finally {
      this.pendingVoices.delete(reservation.id);
    }
  }

  private reserveVoice(cue: RuntimeAudioCue, eventId: string, frame: number, clock: RuntimeAudioClockDomain): PendingVoiceReservation {
    const live = [...this.voices.values()].filter(voice => !voice.stopping);
    const pending = [...this.pendingVoices.values()].filter(reservation => !reservation.cancelled);
    const resourceVoices = live.filter(voice => voice.cue.resource === cue.resource);
    const resourcePending = pending.filter(reservation => reservation.cue.resource === cue.resource);
    if (resourceVoices.length + resourcePending.length >= this.document.limits.maxVoicesPerResource) {
      this.stealOrReject(resourceVoices, resourcePending, cue, frame, 'per-resource-voice-limit');
    }
    const remaining = [...this.voices.values()].filter(voice => !voice.stopping);
    const remainingPending = [...this.pendingVoices.values()].filter(reservation => !reservation.cancelled);
    if (remaining.length + remainingPending.length >= this.document.limits.maxVoices) {
      this.stealOrReject(remaining, remainingPending, cue, frame, 'total-voice-limit');
    }
    const reservation = { id: ++this.reservationSequence, cue, eventId, frame, clock, cancelled: false };
    this.pendingVoices.set(reservation.id, reservation);
    return reservation;
  }

  private stealOrReject(
    candidates: readonly ActiveVoice[],
    pendingCandidates: readonly PendingVoiceReservation[],
    incoming: RuntimeAudioCue,
    frame: number,
    reason: string,
  ): void {
    if (this.document.voiceStealing === 'reject') {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_LIMIT',
        `cues.${incoming.id}`,
        `voice budget exceeded (${reason})`,
      );
    }
    const ordered = [
      ...candidates.map(voice => ({ kind: 'voice' as const, cue: voice.cue, frame: voice.startFrame, id: voice.id, voice })),
      ...pendingCandidates.map(reservation => ({ kind: 'pending' as const, cue: reservation.cue, frame: reservation.frame, id: String(reservation.id), reservation })),
    ].sort((left, right) => {
      if (this.document.voiceStealing === 'steal-lowest-priority') {
        return left.cue.priority - right.cue.priority || left.frame - right.frame || left.id.localeCompare(right.id);
      }
      return left.frame - right.frame || left.id.localeCompare(right.id);
    });
    const victim = ordered[0]!;
    if (victim.kind === 'voice') {
      this.recordTrace({ kind: 'stolen', cue: victim.cue.id, eventId: victim.voice.eventId, voiceId: victim.voice.id, frame, reason });
      this.stopVoice(victim.voice, frame, reason);
    } else {
      this.cancelPendingVoice(victim.reservation, frame, reason);
    }
  }

  private cancelPendingVoice(reservation: PendingVoiceReservation, frame: number, reason: string): void {
    if (reservation.cancelled) return;
    reservation.cancelled = true;
    this.pendingVoices.delete(reservation.id);
    this.recordTrace({
      kind: reason.includes('voice-limit') ? 'stolen' : 'ignored',
      cue: reservation.cue.id,
      eventId: reservation.eventId,
      frame,
      reason: `pending:${reason}`,
    });
  }

  private cancelPendingVoices(): void {
    for (const reservation of this.pendingVoices.values()) reservation.cancelled = true;
    this.pendingVoices.clear();
  }

  private validateReplacement(resource: RuntimeAudioResource): void {
    if (!this.resources.has(resource.id)) {
      audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `resources.${resource.id}`, 'replacement target is unknown');
    }
    for (const cue of this.cues.values()) {
      if (cue.resource !== resource.id) continue;
      if (cue.offsetFrames >= resource.frameLength
        || (cue.durationFrames !== undefined && cue.offsetFrames + cue.durationFrames > resource.frameLength)
        || (cue.loop !== undefined
          && (cue.loop.endFrame > resource.frameLength
            || cue.loop.startFrame >= cue.loop.endFrame
            || cue.offsetFrames >= cue.loop.endFrame))) {
        audioRuntimeFail(
          'E_AUDIO_RUNTIME_RESOURCE',
          `resources.${resource.id}.frameLength`,
          `replacement does not satisfy cue ${cue.id}`,
        );
      }
    }
  }

  private stopCue(cueId: string, frame: number, reason: string): void {
    for (const voice of [...this.voices.values()]) {
      if (voice.cue.id === cueId && !voice.stopping) this.stopVoice(voice, frame, reason);
    }
  }

  private stopDomain(domain: RuntimeAudioClockDomain, frame: number, reason: string): void {
    for (const voice of [...this.voices.values()]) {
      if (voice.clock === domain && !voice.stopping) this.stopVoice(voice, frame, reason);
    }
  }

  private stopAll(frame: number, reason: string): void {
    for (const voice of [...this.voices.values()]) {
      if (!voice.stopping) this.stopVoice(voice, frame, reason);
    }
  }

  private stopVoice(voice: ActiveVoice, frame: number, reason: string): void {
    if (voice.stopping) return;
    voice.stopping = true;
    this.recordTrace({
      kind: 'stopped',
      cue: voice.cue.id,
      eventId: voice.eventId,
      voiceId: voice.id,
      frame,
      owner: voice.cue.owner,
      reason,
    });
    voice.handle.stop(frame);
  }

  private checkDrift(domain: RuntimeAudioClockDomain, time: number, rate: number, frame: number): void {
    const state = this.domains[domain];
    const expected = state.anchorFrame + Math.round((time - state.anchorTime) / rate * this.backend.sampleRate);
    const drift = frame - expected;
    if (Math.abs(drift) <= this.document.clock.driftToleranceFrames) return;
    if (this.document.clock.driftPolicy === 'error') {
      audioRuntimeFail(
        'E_AUDIO_RUNTIME_CLOCK',
        `$.clock.${domain}`,
        'audio clock drift exceeds the configured tolerance',
        Object.freeze({ expectedFrame: expected, observedFrame: frame, driftFrames: drift }),
      );
    }
    this.recordTrace({ kind: 'drift-resync', frame, reason: `${domain}:${drift}` });
    this.diagnostic(
      'W_AUDIO_CLOCK_RESYNC',
      `$.clock.${domain}`,
      'audio clock anchor was resynchronized',
      Object.freeze({ expectedFrame: expected, observedFrame: frame, driftFrames: drift }),
    );
  }

  private validateTransportRate(rate: number): void {
    if (!this.compositionTransport) return;
    for (const cue of this.cues.values()) if (cue.rate * rate < .0625 || cue.rate * rate > 16) {
      audioRuntimeFail('E_AUDIO_RUNTIME_PROFILE', `cues.${cue.id}.rate`, 'combined composition and cue rate is outside the audio profile');
    }
  }

  private async changeTransportRate(domain: RuntimeAudioClockDomain, rate: number, frame: number): Promise<void> {
    const previousRate = this.domains[domain].rate;
    const voices = [...this.voices.values()].filter(voice => voice.clock === domain && !voice.stopping);
    this.domains[domain].rate = rate;
    for (const voice of voices) {
      const resource = this.resources.get(voice.cue.resource)!;
      const elapsed = Math.max(0, frame - voice.startFrame);
      const content = voice.contentAdvanceAtStart + Math.floor(elapsed * voice.playbackRate * resource.sampleRate / this.backend.sampleRate);
      const delay = Math.round(Math.max(0, voice.startFrame - frame) * previousRate / rate);
      this.stopVoice(voice, frame, 'composition-rate');
      await this.startCue(voice.cue, voice.eventId, domain, frame + delay, content);
    }
  }

  private effectiveGain(cue: RuntimeAudioCue): number {
    let gain = cue.gain;
    let bus: string | undefined = cue.bus;
    while (bus !== undefined) {
      gain *= this.busGains.get(bus) ?? 1;
      bus = this.busParents.get(bus);
    }
    return Math.min(4, Math.max(0, gain));
  }

  private busChainContains(bus: string, target: string): boolean {
    let current: string | undefined = bus;
    while (current !== undefined) {
      if (current === target) return true;
      current = this.busParents.get(current);
    }
    return false;
  }

  private requireCue(cueId: string): RuntimeAudioCue {
    const cue = this.cues.get(cueId);
    if (!cue) audioRuntimeFail('E_AUDIO_RUNTIME_RESOURCE', `cues.${cueId}`, 'unknown audio cue');
    return cue;
  }

  private recordTrace(entry: Omit<AudioRuntimeTraceEntry, 'sequence'>): void {
    if (this.disposed && entry.kind === 'ended') return;
    this.traceRecords.push(Object.freeze({ sequence: ++this.recordSequence, ...entry }));
  }

  private diagnostic(
    code: string,
    path: string,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    this.diagnosticRecords.push(Object.freeze({ code, path, message, ...(context ? { context } : {}) }));
  }

  private assertLive(): void {
    if (this.disposed) audioRuntimeFail('E_AUDIO_RUNTIME_STATE', '$', 'audio event runtime is disposed');
  }
}

function domainState(frame: number): DomainState {
  return { time: 0, anchorTime: 0, anchorFrame: frame, rate: 1, scheduledEvents: new Set() };
}

function sortedEvents(
  values: readonly RuntimeAudioTimelineEvent[],
  domain: RuntimeAudioClockDomain,
): readonly RuntimeAudioTimelineEvent[] {
  return Object.freeze(values
    .filter(event => event.clock === domain)
    .map((event, index) => ({ event, index }))
    .sort((left, right) => (
      left.event.time - right.event.time
      || left.event.sequence - right.event.sequence
      || left.index - right.index
    ))
    .map(entry => entry.event));
}

function resolvePlayback(
  cue: RuntimeAudioCue,
  resourceFrames: number,
  contentAdvanceFrames: number,
  backendSampleRate: number,
  resourceSampleRate: number,
): Readonly<{ offsetFrame: number; stopFrameCount?: number }> | null {
  const advance = Math.max(0, contentAdvanceFrames);
  if (!cue.loop) {
    const total = cue.durationFrames ?? resourceFrames - cue.offsetFrames;
    if (advance >= total) return null;
    const remaining = total - advance;
    return Object.freeze({
      offsetFrame: cue.offsetFrames + advance,
      stopFrameCount: Math.max(1, Math.round(remaining / cue.rate * backendSampleRate / resourceSampleRate)),
    });
  }
  const loopLength = cue.loop.endFrame - cue.loop.startFrame;
  const firstLength = cue.loop.endFrame - cue.offsetFrames;
  const total = cue.loop.iterations === 'infinite'
    ? undefined
    : firstLength + (cue.loop.iterations - 1) * loopLength;
  if (total !== undefined && advance >= total) return null;
  const offsetFrame = advance < firstLength
    ? cue.offsetFrames + advance
    : cue.loop.startFrame + (advance - firstLength) % loopLength;
  if (total === undefined) return Object.freeze({ offsetFrame });
  return Object.freeze({
    offsetFrame,
    stopFrameCount: Math.max(1, Math.round((total - advance) / cue.rate * backendSampleRate / resourceSampleRate)),
  });
}

function validateSnapshot(snapshot: RuntimeClockSnapshot): void {
  for (const domain of clockDomains()) {
    if (!Number.isFinite(snapshot[domain]) || snapshot[domain] < 0) {
      audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', `$.clock.${domain}`, 'clock value must be finite and non-negative');
    }
  }
}

function validateRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0.0625 || rate > 16) {
    audioRuntimeFail('E_AUDIO_RUNTIME_CLOCK', '$.clock.rate', 'clock rate must be in [0.0625, 16]');
  }
}

function clockDomains(): readonly RuntimeAudioClockDomain[] {
  return ['composition', 'state', 'event'] as const;
}
