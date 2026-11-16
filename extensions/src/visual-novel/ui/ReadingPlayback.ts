import type { I18n } from '../../i18n/I18n';
import type { I18nParams } from '../../i18n/types';
import type { NarrativeRuntime } from '../../narrative/NarrativeRuntime';
import type { NarrativeView } from '../../narrative/types';
import type { StoryLine } from '../story/types';
import type { ReadingAudio } from '../audio/ReadingAudio';
import { readingOffsets } from './reading-text.js';

export interface ReadingPreferences {
  /** Extended graphemes per second. Zero displays the entire line immediately. */
  readonly textSpeed: number;
  readonly fontScale: number;
  readonly highContrast: boolean;
  readonly reducedMotion: boolean;
  readonly voiceVolume: number;
}
export interface ReadingPreferenceStore { load(): unknown; save(value: ReadingPreferences): void }
export interface ReadingMarks { has(id: string): boolean; add(id: string): void }
export interface ReadingPlaybackOptions {
  readonly runtime: NarrativeRuntime;
  readonly i18n: I18n;
  readonly lines: Readonly<Record<string, StoryLine>>;
  readonly preferences?: ReadingPreferenceStore;
  readonly read?: ReadingMarks;
  readonly audio?: ReadingAudio;
  readonly minReadMs?: number;
  readonly maxHistory?: number;
  readonly onError?: (error: unknown) => void;
}

export type ReadingMode = 'manual' | 'auto' | 'skip';
export interface ReadingEntry {
  readonly key: string;
  readonly lineId: string;
  readonly textKey: string;
  readonly speakerKey?: string;
  readonly params: I18nParams;
}
export interface ReadingView {
  readonly revision: number;
  readonly nodeId: string | null;
  readonly kind: NarrativeView['node']['type'] | null;
  readonly lineId: string | null;
  readonly text: string;
  readonly speaker: string;
  readonly offsets: readonly number[];
  readonly visible: number;
  readonly locale: string;
  readonly choices: readonly { readonly id: string; readonly enabled: boolean; readonly text: string }[];
  readonly mode: ReadingMode;
  readonly preferences: ReadingPreferences;
}
const defaults: ReadingPreferences = Object.freeze({ textSpeed: 28, fontScale: 1, highContrast: false, reducedMotion: false, voiceVolume: 1 });
const range = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const bounded = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function preferenceValues(value: unknown, base: ReadingPreferences): ReadingPreferences {
  if (!value || typeof value !== 'object') return base;
  const next = value as Partial<ReadingPreferences>;
  return Object.freeze({
    textSpeed: range(next.textSpeed, 0, 120) ? next.textSpeed! : base.textSpeed,
    fontScale: range(next.fontScale, .75, 2) ? next.fontScale! : base.fontScale,
    highContrast: typeof next.highContrast === 'boolean' ? next.highContrast : base.highContrast,
    reducedMotion: typeof next.reducedMotion === 'boolean' ? next.reducedMotion : base.reducedMotion,
    voiceVolume: range(next.voiceVolume, 0, 1) ? next.voiceVolume! : base.voiceVolume,
  });
}

export function readingPreferenceStore(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string): ReadingPreferenceStore {
  return {
    load() {
      const value = JSON.parse(storage.getItem(key) ?? 'null');
      return value?.schemaVersion === 1 ? value.value : null;
    },
    save(value) { storage.setItem(key, JSON.stringify({ schemaVersion: 1, value })); },
  };
}

export class ReadingPlayback {
  private readonly lineIds = new Map<string, string>();
  private readonly marks: ReadingMarks;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly historyEntries: (ReadingEntry | undefined)[];
  private readonly minimum: number;
  private firstHistory = 0;
  private historyCount = 0;
  private historyKey = 0;
  private mode: ReadingMode = 'manual';
  private readAtEntry = false;
  private marked = false;
  private progress = 0;
  private readingMs = 0;
  private mountedRevision = -1;
  private currentEntry: ReadingEntry | null = null;
  private preferences = defaults;
  private modal = false;
  private active = true;
  private ended = false;
  private snapshot!: ReadingView;

  constructor(private readonly options: ReadingPlaybackOptions) {
    const cap = options.maxHistory ?? 2_000;
    this.minimum = options.minReadMs ?? 650;
    if (!Number.isSafeInteger(cap) || !range(cap, 1, 100_000) || !range(this.minimum, 0, 60_000) || options.runtime.disposed || options.i18n.disposed) {
      throw new RangeError('Invalid reading history, clock or host.');
    }
    this.historyEntries = new Array(cap);
    this.marks = options.read ?? new Set<string>();
    for (const [id, line] of Object.entries(options.lines)) this.lineIds.set(line.nodeId, id);
    try {
      this.preferences = preferenceValues(options.preferences?.load(), defaults);
    } catch (error) { this.report(error); }
    options.audio?.setVoiceVolume(this.preferences.voiceVolume);
    this.sync(false);
    this.unsubscribe.push(
      options.runtime.subscribe(event => { if (event.type === 'dispose') this.dispose(); else if (event.type === 'change') this.sync(false); }),
      options.i18n.subscribe(event => { if (event.type === 'dispose') this.dispose(); else this.sync(true); }),
    );
  }

  get view(): ReadingView { return this.snapshot; }
  get disposed(): boolean { return this.ended; }
  get historySize(): number { return this.historyCount; }
  get historyRevision(): number { return this.historyKey; }
  get canSkip(): boolean { return this.view.kind === 'dialogue' && this.marked; }

  history(): readonly ReadingEntry[] {
    return Array.from({ length: this.historyCount }, (_, i) => this.historyEntries[(this.firstHistory + i) % this.historyEntries.length]!);
  }

  subscribe(listener: () => void): () => void {
    if (this.ended) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  translate(entry: ReadingEntry): { text: string; speaker: string } {
    const { i18n } = this.options;
    return { text: i18n.text(entry.textKey, entry.params), speaker: entry.speakerKey ? i18n.text(entry.speakerKey, entry.params) : '' };
  }

  setPreferences(value: Partial<ReadingPreferences>): void {
    if (this.ended) return;
    const current = this.preferences;
    const next = preferenceValues(value, current);
    if (Object.keys(next).every(key => next[key as keyof ReadingPreferences] === current[key as keyof ReadingPreferences])) return;
    this.preferences = next;
    this.options.audio?.setVoiceVolume(next.voiceVolume);
    try { this.options.preferences?.save(next); } catch (error) { this.report(error); }
    this.updateView(next.textSpeed === 0 ? this.total : this.snapshot.visible);
  }

  setModal(open: boolean): void {
    this.modal = open;
    if (!open) this.options.audio?.cancelHistory();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.options.audio?.setActive(active);
  }

  setMode(mode: ReadingMode): void {
    if (this.ended || this.modal) return;
    const next = this.view.kind === 'dialogue' && (mode !== 'skip' || this.canSkip) ? mode : 'manual';
    if (next === this.mode) return;
    this.mode = next;
    this.readingMs = 0;
    if (next === 'skip') this.options.audio?.cancelLine();
    this.updateView(next === 'skip' ? this.total : this.view.visible);
  }

  confirm(revision = this.view.revision): boolean {
    if (this.ended || this.modal || !this.active || revision !== this.view.revision || this.view.kind !== 'dialogue') return false;
    if (this.view.visible < this.total) {
      this.updateView(this.total);
      this.readingMs = 0;
      return true;
    }
    return this.options.runtime.advance(revision);
  }

  choose(id: string, revision = this.view.revision): boolean {
    return !this.ended && !this.modal && this.active && this.options.runtime.choose(id, revision);
  }

  voiceAvailable(entry: ReadingEntry): boolean { return !!this.options.audio && !!this.voiceAsset(entry); }
  stopReplay(): void { this.options.audio?.cancelHistory(); }

  replayVoice(entry: ReadingEntry): Promise<boolean> {
    if (this.ended || !this.active) return Promise.resolve(false);
    const asset = this.voiceAsset(entry);
    return asset ? this.options.audio?.replayHistory(asset) ?? Promise.resolve(false) : Promise.resolve(false);
  }

  tick(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new RangeError('Invalid reading frame delta.');
    if (this.ended) return;
    const audio = this.options.audio;
    audio?.update();
    if (this.modal || !this.active || this.view.kind !== 'dialogue') return;
    if (this.view.visible < this.total) {
      const speed = this.preferences.textSpeed / 1000;
      const used = speed === 0 ? 0 : Math.min(deltaMs, (this.total - this.progress) / speed);
      const visible = used < deltaMs || speed === 0 ? this.total : Math.floor(this.progress + used * speed + 1e-7);
      this.progress = Math.min(this.total, this.progress + used * speed);
      this.updateView(visible);
      deltaMs -= used;
    }
    if (this.view.visible < this.total) return;
    this.readingMs += deltaMs;
    const autoReady = this.mode === 'auto' && this.readingMs >= this.minimum && !audio?.linePending;
    if (autoReady || (this.mode === 'skip' && this.readingMs >= 75)) this.options.runtime.advance(this.view.revision);
  }

  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    for (const off of this.unsubscribe.splice(0)) off();
    this.options.audio?.dispose();
    this.notify();
    this.listeners.clear();
    this.historyEntries.fill(undefined);
    this.historyCount = 0;
  }

  private get total(): number { return this.snapshot.offsets.length - 1; }

  private sync(localeOnly: boolean): void {
    if (this.ended) return;
    const { runtime, i18n, audio } = this.options;
    const view = runtime.view, node = view?.node;
    const revision = view?.revision ?? -1;
    const changed = this.mountedRevision !== revision;
    const lineId = view ? this.lineIds.get(view.nodeId) ?? view.nodeId : null;
    const params = Object.freeze(Object.fromEntries(Object.entries(view?.variables ?? {}).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value])));
    const entry: ReadingEntry | null = lineId && node && 'textKey' in node && node.textKey ? {
      key: String(this.historyKey + 1), lineId, textKey: node.textKey, params,
      ...('speakerKey' in node && node.speakerKey ? { speakerKey: node.speakerKey } : {}),
    } : null;
    const content = entry ? this.translate(entry) : { text: '', speaker: '' };
    if (!changed && this.snapshot && this.snapshot.locale === i18n.locale && this.snapshot.text === content.text && this.snapshot.speaker === content.speaker &&
      !view?.choices.length) return;
    this.mountedRevision = revision;
    if (changed) {
      this.currentEntry = node?.type === 'dialogue' && entry ? this.push(entry) : entry;
      this.readAtEntry = !!lineId && this.marks.has(lineId);
      this.marked = this.readAtEntry;
      this.readingMs = 0;
      this.progress = 0;
      if (node?.type !== 'dialogue' || (this.mode === 'skip' && !this.readAtEntry)) this.mode = 'manual';
    }
    const previous = this.snapshot;
    const offsets = Object.freeze(readingOffsets(content.text, i18n.locale));
    const all = offsets.length - 1;
    const fullyVisible = node?.type !== 'dialogue' || this.preferences.textSpeed === 0 || this.mode === 'skip' ||
      (!changed && previous && previous.visible === previous.offsets.length - 1);
    const visible = fullyVisible ? all : changed ? 0 : Math.min(all, previous?.visible ?? 0);
    this.progress = visible;
    this.snapshot = Object.freeze({
      revision, nodeId: view?.nodeId ?? null, kind: node?.type ?? null, lineId, ...content, offsets, locale: i18n.locale,
      visible, mode: this.mode, preferences: this.preferences,
      choices: Object.freeze((view?.choices ?? []).map(choice => Object.freeze({ id: choice.id, enabled: choice.enabled, text: i18n.text(choice.textKey, params) }))),
    });
    this.mark();
    if (changed || (localeOnly && previous?.locale !== i18n.locale)) {
      if (this.mode === 'skip' || node?.type !== 'dialogue' || !this.currentEntry || this.modal) {
        audio?.cancelLine(); audio?.cancelHistory();
      } else void audio?.playLine(this.voiceAsset(this.currentEntry));
    }
    this.notify();
  }

  private push(entry: ReadingEntry): ReadingEntry {
    const capacity = this.historyEntries.length;
    const row = Object.freeze(entry);
    this.historyEntries[(this.firstHistory + this.historyCount) % capacity] = row;
    if (this.historyCount === capacity) this.firstHistory = (this.firstHistory + 1) % capacity;
    else this.historyCount++;
    this.historyKey++;
    return row;
  }

  private voiceAsset(entry: ReadingEntry): string | null {
    return Object.hasOwn(this.options.lines, entry.lineId) ? this.options.lines[entry.lineId]?.voices[this.options.i18n.locale] ?? null : null;
  }

  private updateView(visible: number): void {
    visible = bounded(visible, 0, this.total);
    this.progress = Math.max(this.progress, visible);
    const last = this.snapshot;
    if (last.visible === visible && last.mode === this.mode && last.preferences === this.preferences) return;
    this.snapshot = Object.freeze({ ...last, visible, mode: this.mode, preferences: this.preferences });
    this.mark();
    this.notify();
  }

  private mark(): void {
    const { lineId, kind, visible } = this.snapshot;
    if (kind === 'dialogue' && lineId && !this.marked && visible === this.total) {
      this.marked = true;
      try { this.marks.add(lineId); } catch (error) { this.report(error); }
    }
  }

  private notify(): void {
    for (const callback of [...this.listeners]) try { callback(); } catch (error) { this.report(error); }
  }

  private report(error: unknown): void {
    try { this.options.onError?.(error); }
    catch { /* observation cannot interrupt playback */ }
  }
}
