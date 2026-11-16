import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import type { HyaFrame, HyaFrameRequest } from '../../hya-player';
import type { StoryCue, StorySlot } from '../story/types';
import { StageResourceQueue } from './resources.js';
import type {
  StageAction, StageAssetLease, StageCompletion, StageFrame, StageOptions, StagePlayer,
  StageSlot, StageTransition, StageView, StageWaiting,
} from './types';

const PRELOAD_ASSET_LIMIT = 8;
const invalid = (message: string) => new EngineError(EngineErrorCode.GameplayInvalidInput, message);
const aborted = (cause?: unknown) => new EngineError(EngineErrorCode.SceneFlowAborted, 'Stage action was cancelled.', { cause });
const superseded = () => new EngineError(EngineErrorCode.SceneFlowSuperseded, 'A newer stage action replaced this request.');

type Event = HyaFrame['events'][number];
type Move = { readonly clip: StageTransition; readonly seconds: number; readonly decorative: boolean; elapsed: number };
type Attempt = { readonly request: HyaFrameRequest; readonly movedSeconds: number };
interface Live {
  slot: StageSlot;
  readonly instance: number;
  readonly owner: AbortController;
  readonly lease: StageAssetLease;
  player?: StagePlayer;
  configured: boolean;
  pose?: HyaFrame;
  relocating?: Promise<unknown>;
  sequence: number;
  view?: StageView;
  viewport?: readonly [number, number];
  pending?: Attempt;
  loopTail?: number;
  failure: unknown;
  failureReported?: boolean;
  retired: boolean;
}
interface Intent {
  slot: StageSlot;
  readonly prior?: Live;
  readonly keepTime: boolean;
  readonly transition?: Extract<StoryCue, { op: 'transition' }>;
}
interface EventWait {
  readonly slot: Live;
  readonly generation: number;
  readonly afterSequence: number;
  readonly name: string;
}
interface Group {
  prefix: Live[];
  intents: Intent[];
  candidates: Live[];
  moves: Map<Live, Move>;
  events: EventWait[];
  requestedEvents: { slotId: string; name: string }[];
  phase: 'preparing' | 'ready' | 'running';
  left: number;
  waited: number;
  timer?: ReturnType<typeof setTimeout>;
}
interface Work {
  readonly action: StageAction;
  readonly controller: AbortController;
  readonly promise: Promise<StageCompletion>;
  readonly resolve: (value: StageCompletion) => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
  index: number;
  skip: boolean;
  group?: Group;
}
const finite = (value: number, min: number) => Number.isFinite(value) && value >= min;
const sameView = (a: StageView | undefined, b: StageView) =>
  a?.dpr === b.dpr && a.viewport[0] === b.viewport[0] && a.viewport[1] === b.viewport[1];
const order = (a: StageSlot, b: StageSlot) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sameAsset = (a: StageSlot, b: StageSlot) => a.assetId === b.assetId && a.variantId === b.variantId;

function checkedSlots(slots: readonly StageSlot[]): StageSlot[] {
  const ids = new Set<string>();
  return slots.map(slot => {
    const { id, assetId, bounds, time, data } = slot;
    if (!id?.trim() || !assetId?.trim() || ids.has(id) || !Number.isSafeInteger(slot.order) ||
      bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= 0 || bounds[3] <= 0 ||
      (time !== undefined && !finite(time, 0))) throw invalid(`Invalid or repeated stage slot "${id}".`);
    if (slot.fit !== undefined && !['contain', 'cover', 'stretch'].includes(slot.fit)) throw invalid(`Invalid fit for "${id}".`);
    if (data && !Object.values(data).every(value => typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value))) {
      throw invalid(`Invalid data for "${id}".`);
    }
    ids.add(id);
    return Object.freeze({ ...slot, bounds: Object.freeze([...bounds]) as StageSlot['bounds'], ...(data ? { data: Object.freeze({ ...data }) } : {}) });
  }).sort(order);
}

/** Owns the committed shot and a single hidden candidate suffix. One caller supplies before-render frame boundaries. */
export class VisualNovelStage {
  private shot: Live[] = [];
  private work: Work | undefined;
  private lastFrame = -1;
  private instance = 0;
  private disposed = false;
  private busy = false;
  private completed: StageCompletion | undefined;
  private readonly queue: StageResourceQueue;
  private readonly timeout: number;
  private readonly waitTimeout: number;
  private readonly preloadBytes: number;
  private prefetch: { controller: AbortController; leases: StageAssetLease[]; bytes: number; detach: () => void } | undefined;

  constructor(private readonly options: StageOptions) {
    const concurrency = options.concurrency ?? 4;
    this.timeout = options.prepareTimeoutMs ?? 10_000;
    this.waitTimeout = options.waitTimeoutSeconds ?? 30;
    this.preloadBytes = options.maxPreloadBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > PRELOAD_ASSET_LIMIT ||
      !finite(this.timeout, 1) || this.timeout > 2_147_483_647 || !finite(this.waitTimeout, Number.MIN_VALUE) ||
      !Number.isSafeInteger(this.preloadBytes) || this.preloadBytes < 0) throw invalid('Invalid stage loading limits.');
    this.queue = new StageResourceQueue(concurrency);
  }

  get snapshot(): readonly StageSlot[] {
    return Object.freeze(this.shot.map(item => Object.freeze({ ...item.slot, time: item.pose?.time ?? item.slot.time ?? 0 })));
  }

  get waiting(): StageWaiting | null {
    const work = this.work, group = work?.group;
    if (!work || !group) return null;
    return {
      group: work.index, kind: group.phase === 'running' ? 'cues' : 'resources',
      durationRemaining: Math.max(group.left, ...[...group.moves.values()].map(move => move.seconds - move.elapsed)),
      events: group.phase === 'running' ? group.events.map(event => ({ slotId: event.slot.slot.id, name: event.name })) : group.requestedEvents.map(event => ({ ...event })),
    };
  }

  run(action: StageAction): Promise<StageCompletion> {
    return this.start(action);
  }

  /** Restore is an ordered, silent pose preparation. It uses the same visibility handoff as a cue group. */
  restore(sessionId: string, slots: readonly StageSlot[], signal?: AbortSignal): Promise<void> {
    let desired: StageSlot[];
    try { desired = checkedSlots(slots); }
    catch (error) { return Promise.reject(error); }
    return this.start({ sessionId, actionId: -1, cues: [], ...(signal ? { signal } : {}) }, desired).then(() => {});
  }

  private start(action: StageAction, restore?: StageSlot[]): Promise<StageCompletion> {
    if (this.disposed || action.signal?.aborted) return Promise.reject(aborted(action.signal?.reason));
    if (!action.sessionId?.trim() || !Number.isSafeInteger(action.actionId) || (!restore && action.actionId < 0)) {
      return Promise.reject(invalid('Expected a session and a numeric stage action identity.'));
    }
    const current = this.work;
    const sameSession = current?.action.sessionId === action.sessionId;
    if (!restore && sameSession && current?.action.actionId === action.actionId) return current.promise;
    if (!restore && this.completed?.sessionId === action.sessionId && this.completed.actionId === action.actionId) return Promise.resolve(this.completed);
    if (!restore && ((sameSession && current!.action.actionId > action.actionId) ||
      (this.completed?.sessionId === action.sessionId && this.completed.actionId > action.actionId))) {
      return Promise.reject(superseded());
    }
    const controller = new AbortController();
    const { promise, resolve, reject } = Promise.withResolvers<StageCompletion>();
    const cancel = () => this.stop(work, aborted(action.signal?.reason));
    const work: Work = {
      action, controller, promise, resolve, reject, index: 0, skip: !!action.reducedMotion,
      detach: () => action.signal?.removeEventListener('abort', cancel),
    };
    this.work = work;
    if (current) this.stop(current, superseded());
    action.signal?.addEventListener('abort', cancel, { once: true });
    if (action.signal?.aborted) cancel();
    if (this.work !== work) { work.detach(); return promise; }
    if (restore || this.completed?.sessionId !== action.sessionId) this.completed = undefined;
    try { this.beginGroup(work, restore); }
    catch (error) { this.stop(work, error); }
    return promise;
  }

  skipDecorations(): void {
    if (this.work) this.work.skip = true;
  }

  cancel(): void {
    if (this.work) this.stop(this.work, aborted());
  }

  async preload(slots: readonly StorySlot[], signal?: AbortSignal): Promise<{ count: number; bytes: number }> {
    if (this.disposed || signal?.aborted) throw aborted(signal?.reason);
    const unique = new Map(checkedSlots(slots).map(slot => [JSON.stringify([slot.assetId, slot.variantId]), slot]));
    if (unique.size > PRELOAD_ASSET_LIMIT) throw invalid(`Preload accepts up to ${PRELOAD_ASSET_LIMIT} distinct sources.`);
    this.clearPreload();
    const controller = new AbortController();
    const cancel = () => this.releasePreload(prefetch);
    const prefetch = { controller, leases: [] as StageAssetLease[], bytes: 0, detach: () => signal?.removeEventListener('abort', cancel) };
    this.prefetch = prefetch;
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await Promise.all([...unique.values()].map(async slot => {
        const lease = await this.load(slot, controller.signal);
        if (controller.signal.aborted || prefetch.bytes + lease.value.bytes > this.preloadBytes) {
          this.cleanup(() => lease.release());
          controller.signal.throwIfAborted();
          throw invalid('Stage preload exceeds its source byte budget.');
        }
        prefetch.leases.push(lease);
        prefetch.bytes += lease.value.bytes;
      }));
      return { count: prefetch.leases.length, bytes: prefetch.bytes };
    } catch (error) {
      this.releasePreload(prefetch);
      throw error;
    }
  }

  clearPreload(): void {
    if (this.prefetch) this.releasePreload(this.prefetch);
  }

  frame(frame: StageFrame): void {
    if (this.disposed) return;
    if (this.busy) throw invalid('Stage frame cannot reenter.');
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || !finite(frame.deltaSeconds, 0) ||
      !finite(frame.dpr, Number.MIN_VALUE) || frame.viewport.length !== 2 || !frame.viewport.every(value => finite(value, 1))) {
      throw invalid('Invalid stage frame.');
    }
    if (frame.sequence <= this.lastFrame) return;
    this.lastFrame = frame.sequence;
    this.busy = true;
    const work = this.work, group = work?.group;
    try {
      for (const slot of this.shot) {
        try { this.advance(slot, frame, work); }
        catch (error) {
          if (group?.phase === 'running' && (group.moves.has(slot) || group.events.some(event => event.slot === slot))) throw error;
          slot.failure = error;
          if (!slot.failureReported) { slot.failureReported = true; this.report(error); }
        }
      }
      if (!work || !group || this.work !== work) return;
      if (group.phase === 'running') {
        group.waited += frame.deltaSeconds;
        group.left = Math.max(0, group.left - frame.deltaSeconds);
        if (group.events.length && group.waited >= this.waitTimeout) {
          throw invalid('Stage event wait expired.');
        }
        this.checkGroup(work, group);
      } else if (group.phase === 'ready' && this.preparePoses(work, group, frame)) {
        this.commit(work, group);
        this.checkGroup(work, group);
      }
    } catch (error) {
      if (work && this.work === work) this.stop(work, error);
      else this.report(error);
    } finally { this.busy = false; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.clearPreload();
    this.retire(this.shot.splice(0));
    this.completed = undefined;
    this.cleanup(() => this.options.onDispose?.());
  }

  private beginGroup(work: Work, restore?: StageSlot[]): void {
    const cues = work.action.cues[work.index];
    if (!cues && !restore) { this.finish(work); return; }
    const old = new Map(this.shot.map(item => [item.slot.id, item]));
    const desired = new Map<string, Intent>();
    const changed = new Set<string>();
    const requestedEvents: Group['requestedEvents'] = [];
    let left = 0;
    if (restore) {
      for (const slot of restore) desired.set(slot.id, { slot, keepTime: false });
    } else {
      for (const prior of this.shot) desired.set(prior.slot.id, { slot: prior.slot, prior, keepTime: true });
      const change = (id: string) => {
        if (changed.has(id)) throw invalid(`Parallel cues modify slot "${id}" twice.`);
        changed.add(id);
      };
      for (const cue of cues!) {
        switch (cue.op) {
          case 'show':
            for (const slot of cue.slots) { change(slot.id); desired.set(slot.id, { slot, keepTime: false }); }
            break;
          case 'hide':
            change(cue.slotId);
            desired.delete(cue.slotId);
            break;
          case 'state':
          case 'transition': {
            const intent = desired.get(cue.slotId);
            if (!intent) throw invalid(`Stage cue requires visible slot "${cue.slotId}".`);
            change(cue.slotId);
            desired.set(cue.slotId, cue.op === 'state'
              ? { ...intent, slot: { ...intent.slot, stateId: cue.stateId } }
              : { ...intent, transition: cue });
            break;
          }
          case 'wait':
            if (cue.wait.kind === 'duration') {
              if (!finite(cue.wait.seconds, 0)) throw invalid('Invalid stage wait duration.');
              left = Math.max(left, cue.wait.seconds);
            } else {
              const { slotId, event } = cue.wait;
              if (!requestedEvents.some(wait => wait.slotId === slotId && wait.name === event)) requestedEvents.push({ slotId, name: event });
            }
        }
      }
    }
    const slots = checkedSlots([...desired.values()].map(intent => intent.slot));
    for (const event of requestedEvents) {
      if (!event.name?.trim() || !desired.has(event.slotId)) throw invalid(`Stage event requires visible slot "${event.slotId}" and a name.`);
    }
    // Reuse an unchanged painter prefix only. A later old producer cannot remain above a newly appended producer.
    let size = 0;
    if (!restore) while (size < this.shot.length && slots[size]?.id === this.shot[size]?.slot.id && !changed.has(slots[size]!.id)) size++;
    const prefix = this.shot.slice(0, size);
    const intents = slots.slice(size).map(slot => {
      const intent = desired.get(slot.id)!;
      const previous = old.get(slot.id);
      return { ...intent, slot, ...(intent.keepTime && previous && sameAsset(slot, previous.slot) ? { prior: previous } : {}) };
    });
    const group: Group = { prefix, intents, candidates: [], moves: new Map(), events: [], requestedEvents, left, waited: 0, phase: 'preparing' };
    work.group = group;
    if (!intents.length) { group.phase = 'ready'; return; }
    group.timer = setTimeout(() => this.stop(work, invalid('Stage first frame timed out.')), this.timeout);
    void this.prepare(work, group).catch(error => this.stop(work, error));
  }

  private async load(slot: StorySlot, signal: AbortSignal): Promise<StageAssetLease> {
    const release = (lease: StageAssetLease) => this.cleanup(() => lease.release());
    const lease = await this.queue.run(signal, () => this.options.port.acquire(slot, signal), release);
    const { bytes, playback } = lease.value;
    if (signal.aborted || !Number.isSafeInteger(bytes) || bytes < 0 ||
      (playback && playback.mode !== 'hold' && (!['loop', 'once'].includes(playback.mode) || !finite(playback.duration, Number.MIN_VALUE)))) {
      release(lease);
      signal.throwIfAborted();
      throw invalid(`Invalid stage asset byte count or playback range for "${slot.id}".`);
    }
    return lease;
  }

  private async prepare(work: Work, group: Group): Promise<void> {
    const signal = work.controller.signal;
    const results = await Promise.all(group.intents.map(async intent => {
      const lease = await this.load(intent.slot, signal);
      if (signal.aborted) { this.cleanup(() => lease.release()); signal.throwIfAborted(); }
      const live: Live = {
        slot: intent.slot, instance: ++this.instance, owner: new AbortController(), lease,
        configured: false, sequence: 0, failure: undefined, retired: false,
      };
      group.candidates.push(live);
      return live;
    }));
    signal.throwIfAborted();
    // Player construction registers its producer. Await each registration in painter order.
    group.candidates = results;
    for (const live of results) {
      signal.throwIfAborted();
      const player = await this.options.port.create(live.lease.value, live.slot, live.instance, live.owner.signal, error => {
        if (!live.retired) live.failure = error;
        this.invalidate();
      });
      if (live.retired) { this.cleanup(() => player.dispose()); signal.throwIfAborted(); }
      live.player = player;
    }
    signal.throwIfAborted();
    group.phase = 'ready';
    this.invalidate();
  }

  private preparePoses(work: Work, group: Group, frame: StageFrame): boolean {
    for (const [index, live] of group.candidates.entries()) {
      this.verifyLive(live);
      if (!live.configured) {
        const asset = live.lease.value;
        const intent = group.intents[index]!;
        const command = intent.transition;
        const clip = command && asset.transitions && Object.hasOwn(asset.transitions, command.transitionId)
          ? asset.transitions[command.transitionId] : undefined;
        if (command && (!clip || !finite(clip.fromTime, 0) || !finite(clip.toTime, clip.fromTime) || !finite(command.seconds, 0))) {
          throw invalid(`Invalid or unknown transition "${command.transitionId}" on "${live.slot.id}".`);
        }
        const stateId = clip?.stateId ?? live.slot.stateId;
        if (stateId !== undefined && stateId !== live.slot.stateId) live.slot = Object.freeze({ ...live.slot, stateId });
        const state = this.assetState(live);
        live.player!.configure({ ...live.slot.data, ...state?.data });
        live.configured = true;
        if (command && clip) {
          const decorative = command.decorative && !group.requestedEvents.some(event => event.slotId === live.slot.id);
          group.moves.set(live, { clip, decorative, seconds: command.seconds, elapsed: 0 });
        }
      }
      if (!live.pose || live.pending || !sameView(live.view, frame)) this.step(live, frame, 0, 0);
    }
    if (group.candidates.some(live => !live.pose || live.pending || !sameView(live.view, frame))) return false;
    for (const [index, live] of group.candidates.entries()) {
      const intent = group.intents[index]!;
      const state = this.assetState(live), prior = intent.prior;
      const move = group.moves.get(live);
      let time = live.slot.time ?? 0;
      if (prior?.pose && intent.keepTime) time = prior.pose.time;
      if (!prior) time = live.slot.time ?? state?.time ?? time;
      else if (prior.slot.stateId !== live.slot.stateId) time = state?.time ?? time;
      if (move) {
        if (move.seconds === 0 || (move.decorative && work.skip)) {
          move.elapsed = move.seconds;
          time = move.clip.toTime;
        } else time = move.clip.fromTime;
      }
      if (live.pose!.time !== time && !this.relocate(live, time)) return false;
      if (!live.pose?.ready) throw invalid(`Stage pose for "${live.slot.id}" is not ready to present.`);
    }
    return true;
  }

  private assetState(live: Live) {
    const id = live.slot.stateId;
    if (id === undefined) return undefined;
    const states = live.lease.value.states;
    if (!states || !Object.hasOwn(states, id)) throw invalid(`Unknown state "${id}" on "${live.slot.id}".`);
    const state = states[id]!;
    if (state.time !== undefined && !finite(state.time, 0)) throw invalid(`Invalid state time for "${live.slot.id}".`);
    return state;
  }

  private relocate(live: Live, time: number): boolean {
    if (live.relocating) return false;
    try {
      live.pose = live.player!.seek(time);
      return live.pose.ready;
    } catch (error) {
      const ready = (error as { ready?: unknown } | null)?.ready;
      if (!(ready instanceof Promise)) throw error;
      live.relocating = ready;
      void ready.then(() => this.invalidate(), failure => {
        if (!live.retired) live.failure = failure;
        this.invalidate();
      }).finally(() => { delete live.relocating; });
      return false;
    }
  }

  private commit(work: Work, group: Group): void {
    const previous = this.shot.slice(group.prefix.length);
    const shown: Live[] = [], hidden: Live[] = [];
    try {
      for (const live of group.candidates) { shown.push(live); live.player!.setVisible(true); }
      for (const live of previous) { hidden.push(live); live.player!.setVisible(false); }
    } catch (error) {
      for (const live of hidden) this.cleanup(() => live.player!.setVisible(true));
      for (const live of shown) this.cleanup(() => live.player!.setVisible(false));
      throw error;
    }
    this.shot = [...group.prefix, ...group.candidates];
    group.candidates = [];
    group.phase = 'running';
    clearTimeout(group.timer);
    const slots = new Map(this.shot.map(live => [live.slot.id, live]));
    group.events = group.requestedEvents.map(({ slotId, name }) => {
      const slot = slots.get(slotId)!;
      return { slot, generation: slot.pose!.generation, afterSequence: slot.pose!.sequence, name };
    });
    this.retire(previous);
    this.clearPreload();
    if (this.work === work) this.invalidate();
  }

  private advance(live: Live, frame: StageFrame, work?: Work): void {
    this.verifyLive(live);
    const group = work?.group;
    const move = group?.phase === 'running' ? group.moves.get(live) : undefined;
    const invalidated = live.player!.takeInvalidation();
    const resized = !sameView(live.view, frame);
    const playback = live.lease.value.playback;
    if (move && move.elapsed < move.seconds && move.decorative && work?.skip && !live.pending) {
      if (this.relocate(live, move.clip.toTime)) move.elapsed = move.seconds;
      return;
    }
    let delta = frame.deltaSeconds, moved = 0;
    if (!live.pending && move && move.elapsed < move.seconds) {
      moved = Math.min(delta, move.seconds - move.elapsed);
      delta = moved * ((move.clip.toTime - move.clip.fromTime) / move.seconds);
    } else if (playback?.mode === 'hold' || live.loopTail) delta = 0;
    else if (!live.pending && playback) {
      if (playback.mode === 'loop' && delta > 0 && live.pose!.time >= playback.duration && !this.relocate(live, 0)) return;
      const segment = Math.min(delta, Math.max(0, playback.duration - live.pose!.time));
      if (playback.mode === 'loop' && delta - segment > 1e-9) live.loopTail = delta - segment;
      delta = segment;
    }
    if (live.pending || resized || invalidated || delta > 0 || moved > 0) {
      const outcome = this.presentStep(live, frame, delta, moved, work);
      if (outcome) {
        if (move) move.elapsed = Math.min(move.seconds, move.elapsed + outcome.movedSeconds);
      }
    }
    if (!live.pending && live.loopTail && playback?.mode === 'loop' && this.relocate(live, 0)) {
      const tail = live.loopTail;
      delete live.loopTail;
      // Sample at most one complete extra lap to deliver named waits across a long host pause.
      const lap = Math.min(tail, playback.duration);
      const remainder = tail > lap ? tail % playback.duration : 0;
      if (remainder) live.loopTail = remainder;
      if (this.presentStep(live, frame, lap, 0, work) && remainder && this.relocate(live, 0)) {
        delete live.loopTail;
        this.presentStep(live, frame, remainder, 0, work);
      }
    }
  }

  private presentStep(live: Live, frame: StageFrame, delta: number, moved: number, work?: Work): Attempt | undefined {
    const before = live.pose!.sequence;
    const result = this.step(live, frame, delta, moved);
    const group = work?.group;
    if (result && group?.phase === 'running' && work === this.work && this.shot.includes(live) && live.pose!.sequence > before) {
      for (const event of live.pose!.events) this.consume(group, live, event);
    }
    return result;
  }

  private step(live: Live, view: StageView, deltaSeconds: number, movedSeconds: number): Attempt | undefined {
    const player = live.player!;
    if (!live.pending && !sameView(live.view, view)) {
      live.viewport = player.resize(view);
      live.view = view;
    }
    const attempt = live.pending ?? { request: { sequence: ++live.sequence, deltaSeconds, viewport: live.viewport!, dpr: view.dpr }, movedSeconds };
    const pose = player.advance(attempt.request);
    this.verifyLive(live);
    if (!pose.ready) { live.pending = attempt; return undefined; }
    live.pose = pose;
    delete live.pending;
    return attempt;
  }

  private consume(group: Group, live: Live, event: Event): void {
    if (event.sequence !== live.pose!.sequence) return;
    const payload = event.payload;
    const name = payload && typeof payload === 'object' && 'name' in payload && typeof payload.name === 'string' ? payload.name : event.kind;
    group.events = group.events.filter(wait => !(wait.slot.instance === live.instance && wait.generation === live.pose!.generation &&
      event.sequence > wait.afterSequence && wait.name === name));
  }

  private checkGroup(work: Work, group: Group): void {
    if (this.work !== work || group.left > 0 || group.events.length || [...group.moves.values()].some(move => move.elapsed < move.seconds)) return;
    work.index++;
    this.beginGroup(work);
  }

  private finish(work: Work): void {
    if (this.work !== work) return;
    this.work = undefined;
    work.detach();
    const result = Object.freeze({ sessionId: work.action.sessionId, actionId: work.action.actionId });
    if (result.actionId >= 0) this.completed = result;
    work.resolve(result);
  }

  private stop(work: Work, error: unknown): void {
    if (work.controller.signal.aborted) return;
    if (this.work === work) this.work = undefined;
    work.detach();
    clearTimeout(work.group?.timer);
    work.controller.abort(error);
    this.retire(work.group?.candidates.splice(0) ?? []);
    work.reject(error);
  }

  private retire(slots: readonly Live[]): void {
    for (const live of slots) {
      live.retired = true;
      this.cleanup(() => live.player?.dispose());
      this.cleanup(() => live.owner.abort());
      this.cleanup(() => live.lease.release());
    }
  }

  private releasePreload(prefetch: NonNullable<VisualNovelStage['prefetch']>): void {
    if (this.prefetch === prefetch) this.prefetch = undefined;
    prefetch.detach();
    prefetch.controller.abort(aborted());
    for (const lease of prefetch.leases.splice(0)) this.cleanup(() => lease.release());
  }

  private verifyLive(live: Live): void {
    if (live.failure !== undefined) throw live.failure;
  }

  private cleanup(action: () => void): void {
    try { action(); }
    catch (error) { this.report(error); }
  }

  private invalidate(): void { this.cleanup(() => this.options.port.invalidate?.()); }
  private report(error: unknown): void {
    try { this.options.onError?.(error); }
    catch { /* Observation cannot interrupt retirement or presentation. */ }
  }
}
