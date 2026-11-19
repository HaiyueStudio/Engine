import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import { GameSaveError, GameSaveErrorCode } from '@haiyue/engine/save';
import type { GameSaveThumbnail } from '@haiyue/engine/save';
import type { I18n } from '../../i18n/I18n';
import { connectNarrativeActions } from '../../narrative/actions.js';
import type { NarrativeActionHandler } from '../../narrative/actions';
import { NarrativeRuntime } from '../../narrative/NarrativeRuntime.js';
import type { NarrativeVariables } from '../../narrative/types';
import type { ReadingAudio } from '../audio/ReadingAudio';
import { stageActionHandler } from '../stage/narrative-stage.js';
import type { VisualNovelStage } from '../stage/VisualNovelStage';
import type { AuthoredStory } from '../story/types';
import type { ReadingEntry, ReadingPlayback, ReadingPreferences } from '../ui/ReadingPlayback';
import { SessionReading, VisualNovelProfile } from './profile.js';
import { autoSlotId, VisualNovelSlots } from './slots.js';
import type { SlotPosition, SlotStorageOptions } from './slots';
import { invalidSave, stable } from './snapshot.js';
import type { ReplayCapture, SavedMusic, SavedPosition } from './snapshot';

type Mode = 'play' | 'replay';
export interface SavePresentation {
  readonly stage: VisualNovelStage;
  readonly audio?: ReadingAudio;
  mount(reading: ReadingPlayback): void;
  /** Prepare offscreen. The host drives its existing scene clock until stageReady settles. */
  prepare(stageReady: Promise<void>, signal: AbortSignal): Promise<void>;
  readonly music?: {
    snapshot(): SavedMusic | undefined;
    prepare(saved: SavedMusic | undefined, signal: AbortSignal): Promise<void>;
  };
  thumbnail?(): GameSaveThumbnail | Promise<GameSaveThumbnail>;
  dispose(): void;
}
export interface SavePresentationHost {
  create(mode: Mode): SavePresentation;
  /** Synchronous scene/audio handoff. On failure leave the previous presentation selected. */
  present(next: SavePresentation | null, previous: SavePresentation | null): void;
}
export interface VisualNovelSaveOptions extends SlotStorageOptions {
  readonly story: AuthoredStory;
  readonly i18n: I18n;
  readonly profileStorage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly host: SavePresentationHost;
  /** Host-owned durable actions use the original NarrativeActionRequest.token as their idempotency key. */
  readonly actions?: Readonly<Record<string, NarrativeActionHandler>>;
  readonly autosave?: boolean;
  readonly onError?: (error: unknown) => void;
}
interface Mounted {
  readonly runtime: NarrativeRuntime;
  readonly reading: SessionReading;
  readonly presentation: SavePresentation;
  readonly marks: Set<string>;
  readonly drafts: Map<string, ReplayCapture>;
  readonly mode: Mode;
  readonly replayId?: string;
  detach?: () => void;
}

const superseded = () => new EngineError(EngineErrorCode.SceneFlowSuperseded, 'A newer visual novel request superseded this one.');
const aborted = () => new EngineError(EngineErrorCode.SceneFlowAborted, 'The visual novel request was cancelled.');
const stageAction = 'visualNovel.stage';

async function untilAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = Promise.withResolvers<never>();
  const stop = () => cancelled.reject(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try { return await Promise.race([task, cancelled.promise]); }
  finally { signal.removeEventListener('abort', stop); }
}

/** One logical play session, with detached load candidates and an isolated replay presentation. */
export class VisualNovelSaveSession {
  private readonly profile: VisualNovelProfile;
  private readonly slots: VisualNovelSlots;
  private readonly byNode: ReadonlyMap<string, string>;
  private readonly listeners = new Set<() => void>();
  private active: Mounted | undefined;
  private original: Mounted | undefined;
  private pending: AbortController | undefined;
  private closed = false;
  private writing = Promise.resolve();

  constructor(private readonly options: VisualNovelSaveOptions) {
    this.slots = new VisualNovelSlots(options.story, options);
    this.profile = new VisualNovelProfile(options.story, options.profileStorage, `haiyue:visual-novel:${encodeURIComponent(options.gameId)}`,
      error => this.report(error));
    this.byNode = new Map(Object.entries(options.story.lines).map(([id, line]) => [line.nodeId, id]));
  }

  get view() { return this.active?.reading.view ?? null; }
  get replayId(): string | null { return this.active?.replayId ?? null; }
  get history(): readonly ReadingEntry[] { return this.active?.reading.history() ?? []; }
  get transitioning(): boolean { return this.pending !== undefined; }
  subscribe(callback: () => void) {
    this.assertLive();
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }
  advance(): boolean { return this.active?.reading.confirm() ?? false; }
  choose(id: string): boolean { return this.active?.reading.choose(id) ?? false; }
  setPreferences(value: Partial<ReadingPreferences>): void { this.active?.reading.setPreferences(value); }
  replayVoice(entry: ReadingEntry): Promise<boolean> { return this.active?.reading.replayVoice(entry) ?? Promise.resolve(false); }
  tick(ms: number): void { this.active?.reading.tick(ms); }

  async start(runId: string, initial: NarrativeVariables = {}, signal?: AbortSignal): Promise<void> {
    if (runId === this.active?.runtime.save().runId) throw invalidSave('Start a new playthrough with a fresh run ID.');
    return this.transition(signal, async request => {
      const next = await this.prepare({ runId, initial }, request);
      this.replacePlay(next, true, request);
    });
  }

  async save(id: string, options: { name?: string; thumbnail?: boolean } = {}): Promise<void> {
    this.assertLive();
    const current = this.active;
    if (!current || current.mode === 'replay' || this.pending || !stable(current.runtime) || current.presentation.stage.waiting) {
      throw invalidSave('Save is available at a committed dialogue or choice in the main session.');
    }
    return this.write(current, id, options);
  }
  listSlots() { this.assertLive(); return this.slots.list(); }
  async load(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.transition(signal, request => this.loadPosition(id, request));
  }
  async continueLatest(signal?: AbortSignal): Promise<boolean> {
    return this.transition(signal, async request => {
      const id = await untilAbort(this.slots.latest(), request);
      return id === null ? false : this.loadPosition(id, request);
    });
  }

  listReplays(): readonly string[] { this.assertLive(); return this.profile.listReplays(); }
  async startReplay(id: string, signal?: AbortSignal): Promise<void> {
    this.assertLive();
    if (!this.active || this.original || this.active.runtime.view?.action || this.active.presentation.stage.waiting) {
      throw invalidSave('Replay requires a live playthrough at a committed boundary.');
    }
    const record = this.profile.replay(id);
    if (!record) throw invalidSave('Replay is locked or unavailable.');
    return this.transition(signal, async request => {
      const parent = this.active!;
      const next = await this.prepare({ position: record.start, replay: { id, record } }, request);
      try { request.throwIfAborted(); this.publish(next); }
      catch (error) { this.release(next); throw error; }
      this.original = parent;
      this.connect(next, record);
    });
  }
  endReplay(): boolean {
    this.assertLive();
    this.pending?.abort(aborted());
    const original = this.original;
    if (!original || !this.active) return false;
    const replay = this.active;
    this.publish(original);
    this.original = undefined;
    this.release(replay);
    this.notify();
    return true;
  }

  async flush(): Promise<void> { await this.writing; await this.slots.flush(); }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending?.abort(aborted());
    const { active, original } = this;
    this.active = this.original = undefined;
    this.listeners.clear();
    this.guard(() => { if (active) this.options.host.present(null, active.presentation); });
    if (active) this.release(active);
    if (original) this.release(original);
    await this.flush();
    await this.slots.dispose();
  }

  private async transition<T>(external: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertLive();
    external?.throwIfAborted();
    this.pending?.abort(superseded());
    const request = new AbortController();
    this.pending = request;
    this.notify();
    const signal = external ? AbortSignal.any([external, request.signal]) : request.signal;
    try {
      await untilAbort(this.writing, signal);
      signal.throwIfAborted();
      return await operation(signal);
    } finally {
      if (this.pending === request) { this.pending = undefined; this.notify(); }
    }
  }

  private async loadPosition(id: string, signal: AbortSignal): Promise<boolean> {
    const slot = await untilAbort(this.slots.read(id), signal);
    if (!slot) return false;
    const next = await this.prepare({ position: slot, drafts: slot.pendingReplays }, signal);
    this.replacePlay(next, false, signal);
    return true;
  }

  private async prepare(input: { runId: string; initial: NarrativeVariables } |
    { position: SavedPosition; drafts?: Readonly<Record<string, ReplayCapture>>; replay?: { id: string; record: ReplayCapture } },
    signal: AbortSignal): Promise<Mounted> {
    const { story, i18n, host } = this.options;
    const saved = 'position' in input ? input.position : undefined;
    const replay = 'replay' in input ? input.replay : undefined;
    const runtime = new NarrativeRuntime(story.definition.narrative);
    const replayChoice = replay?.record.choices ? () => {
      const index = runtime.save().choices.length - replay.record.start.snapshot.narrative.choices.length;
      const step = replay.record.choices?.[index];
      return step?.nodeId === runtime.view?.nodeId ? step?.optionId ?? null : null;
    } : undefined;
    let presentation: SavePresentation | undefined;
    let reading: SessionReading | undefined;
    let mounted: Mounted | undefined;
    try {
      signal.throwIfAborted();
      if ('position' in input) runtime.restore(input.position.snapshot.narrative);
      else runtime.start(input.runId, input.initial);
      const mode = replay ? 'replay' : 'play';
      const surface = presentation = host.create(mode);
      surface.audio?.setActive(false);
      const marks = new Set<string>();
      reading = new SessionReading({
        runtime, i18n, lines: story.lines, ...(surface.audio ? { audio: surface.audio } : {}),
        preferences: {
          load: () => this.profile.preferences(),
          save: value => { if (mode === 'play' && this.active === mounted) this.profile.savePreferences(value); },
        },
        read: {
          has: id => this.profile.hasRead(id) || marks.has(id),
          add: id => { if (mode === 'play') {
            if (this.active === mounted && mounted) this.profile.markRead(id);
            else marks.add(id);
          } },
        },
        onError: error => this.report(error),
      }, saved?.snapshot.history ?? [], () => !!mounted && this.canPlay(mounted), replayChoice);
      reading.setActive(false);
      mounted = { runtime, reading, presentation: surface, marks, mode,
        drafts: new Map(Object.entries('drafts' in input ? input.drafts ?? {} : {})),
        ...(replay ? { replayId: replay.id } : {}) };
      surface.mount(reading);
      reading.setActive(false);
      if (saved?.music && !surface.music) throw invalidSave('Saved music has no presentation port.');
      const stage = saved ? surface.stage.restore(saved.snapshot.narrative.runId, saved.snapshot.slots, signal) : Promise.resolve();
      const music = Promise.resolve().then(() => surface.music?.prepare(saved?.music, signal));
      await untilAbort(Promise.all([stage, music, Promise.resolve().then(() => surface.prepare(stage, signal))]), signal);
      signal.throwIfAborted();
      this.assertLive();
      return mounted;
    } catch (error) {
      if (mounted) this.release(mounted);
      else {
        this.guard(() => reading?.dispose());
        this.guard(() => runtime.dispose());
        this.guard(() => presentation?.dispose());
      }
      throw error;
    }
  }

  private publish(mounted: Mounted): void {
    const old = this.active;
    this.options.host.present(mounted.presentation, old?.presentation ?? null);
    this.active = mounted;
    this.guard(() => old?.reading.setActive(false));
    this.guard(() => mounted.reading.setActive(true));
    for (const id of mounted.marks) this.guard(() => this.profile.markRead(id));
    mounted.marks.clear();
  }

  private replacePlay(next: Mounted, fresh: boolean, signal: AbortSignal): void {
    const old = this.active, original = this.original;
    try { signal.throwIfAborted(); this.publish(next); }
    catch (error) { this.release(next); throw error; }
    this.original = undefined;
    this.connect(next);
    if (old) this.release(old);
    if (original) this.release(original);
    this.guard(() => this.visit(next, fresh));
    const { lineId, locale, kind } = next.reading.view;
    if (fresh && kind === 'dialogue' && lineId) void next.presentation.audio?.playLine(this.options.story.lines[lineId]?.voices[locale] ?? null);
  }

  private connect(mounted: Mounted, replay?: ReplayCapture): void {
    const { runtime, presentation } = mounted;
    const actions: Record<string, NarrativeActionHandler> = Object.create(null);
    if (replay) {
      for (const node of Object.values(runtime.definition.nodes)) if (node.type === 'action') {
        actions[node.name] = request => {
          if (!Object.hasOwn(replay.results, request.token)) {
            const error = invalidSave('This replay has no recorded result for the chosen action.');
            this.report(error);
            throw error;
          }
          return replay.results[request.token];
        };
      }
    } else for (const [name, handler] of Object.entries(this.options.actions ?? {})) actions[name] = async (request, signal) => {
      const result = await handler(request, signal);
      if (!signal.aborted) for (const [id, draft] of mounted.drafts) {
        mounted.drafts.set(id, { ...draft, results: { ...draft.results, [request.token]: structuredClone(result ?? {}) } });
      }
      return result;
    };
    actions[stageAction] = stageActionHandler(runtime, presentation.stage, this.options.story.definition.cues,
      () => mounted.reading.view.preferences.reducedMotion);
    const connection = connectNarrativeActions(runtime, actions);
    const stop = runtime.subscribe(event => {
      if (event.type === 'change' && this.active === mounted && mounted.mode === 'play') this.guard(() => this.visit(mounted, true));
    });
    const offReading = mounted.reading.subscribe(() => { if (this.active === mounted) this.notify(); });
    mounted.detach = () => { stop(); offReading(); connection.dispose(); };
  }

  private canPlay(mounted: Mounted): boolean {
    if (this.active !== mounted || this.pending || this.closed) return false;
    const end = mounted.replayId && this.options.story.definition.replays?.[mounted.replayId]?.endLineId;
    return !end || mounted.reading.view.lineId !== end;
  }

  private visit(mounted: Mounted, autosave: boolean): void {
    const line = this.byNode.get(mounted.runtime.view!.nodeId);
    for (const [id, replay] of Object.entries(this.options.story.definition.replays ?? {})) {
      if (line === replay.startLineId && stable(mounted.runtime) && !this.profile.replay(id)) {
        mounted.drafts.set(id, { start: this.position(mounted), results: {} });
      }
      const draft = mounted.drafts.get(id);
      if (line === replay.endLineId && draft) {
        this.profile.unlock(id, { ...draft,
          choices: mounted.runtime.save().choices.slice(draft.start.snapshot.narrative.choices.length) });
        mounted.drafts.delete(id);
      }
    }
    if (autosave && this.options.autosave !== false && stable(mounted.runtime) && !mounted.presentation.stage.waiting) {
      void this.write(mounted, autoSlotId, {}).catch(error => this.report(error));
    }
  }

  private position(mounted: Mounted): SavedPosition {
    const narrative = mounted.runtime.save();
    const chapter = narrative.nodeId.split('/').slice(0, -1).join('/');
    const history = mounted.reading.history().flatMap(({ lineId, params }) => {
      const node = this.options.story.lines[lineId]?.nodeId;
      return node !== undefined && node.split('/').slice(0, -1).join('/') === chapter ? [{ lineId, params }] : [];
    });
    const music = mounted.presentation.music?.snapshot();
    return { snapshot: { schemaVersion: 1, narrative, slots: mounted.presentation.stage.snapshot, history },
      ...(music ? { music } : {}) };
  }

  private write(mounted: Mounted, id: string, options: { name?: string; thumbnail?: boolean }): Promise<void> {
    const revision = mounted.runtime.view?.revision;
    const position = structuredClone({ ...this.position(mounted), pendingReplays: Object.fromEntries(mounted.drafts) });
    const name = options.name ?? position.snapshot.narrative.nodeId;
    const capture = options.thumbnail ? this.thumbnail(mounted) : undefined;
    const result = this.writing.then(async () => {
      const thumbnail = await capture;
      if (this.closed) throw new GameSaveError(GameSaveErrorCode.Disposed, 'Visual novel save session is disposed.', { operation: 'write' });
      await this.slots.write(id, position, name, mounted.runtime.view?.revision === revision ? thumbnail : undefined);
    });
    this.writing = result.then(() => {}, () => {});
    return result;
  }

  private async thumbnail(mounted: Mounted): Promise<GameSaveThumbnail | undefined> {
    try {
      const value = await mounted.presentation.thumbnail?.();
      if (!value) return undefined;
      if (!['image/png','image/jpeg','image/webp'].includes(value.mimeType) || !Number.isSafeInteger(value.width) || value.width < 1 ||
        !Number.isSafeInteger(value.height) || value.height < 1 || !value.dataUrl.startsWith(`data:${value.mimeType};base64,`)) {
        throw invalidSave('Invalid visual novel thumbnail.');
      }
      return value;
    } catch (error) { this.report(error); return undefined; }
  }

  private release(mounted: Mounted): void {
    for (const dispose of [() => mounted.detach?.(), () => mounted.reading.dispose(), () => mounted.runtime.dispose(),
      () => mounted.presentation.dispose()]) this.guard(dispose);
  }
  private assertLive() {
    if (this.closed) throw new GameSaveError(GameSaveErrorCode.Disposed, 'Visual novel save session is disposed.', { operation: 'read' });
  }
  private notify() { for (const callback of [...this.listeners]) this.guard(callback); }
  private guard(callback: () => void) { try { callback(); } catch (error) { this.report(error); } }
  private report(error: unknown) { try { this.options.onError?.(error); } catch { /* observers cannot change a commit */ } }
}
