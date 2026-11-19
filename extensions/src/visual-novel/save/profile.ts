import type { AuthoredStory } from '../story/types';
import { ReadingPlayback } from '../ui/ReadingPlayback.js';
import type { ReadingEntry, ReadingPlaybackOptions, ReadingPreferences, ReadingView } from '../ui/ReadingPlayback';
import { readReplay, valueRecord } from './snapshot.js';
import type { ReplayCapture, SavedReadingLine } from './snapshot.js';

type ProfileStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface Profile {
  readonly schemaVersion: 1;
  readonly preferences: unknown;
  readonly read: readonly string[];
  readonly unlocked: Readonly<Record<string, unknown>>;
}

export class VisualNovelProfile {
  private data: Profile = { schemaVersion: 1, preferences: null, read: [], unlocked: {} };
  private readonly read = new Set<string>();

  constructor(private readonly story: AuthoredStory, private readonly storage: ProfileStorage, private readonly key: string,
    onError: (error: unknown) => void) {
    try {
      const raw: unknown = JSON.parse(storage.getItem(key) ?? 'null');
      if (valueRecord(raw) && raw.schemaVersion === 1) {
        const read = Array.isArray(raw.read) ? raw.read.filter((line): line is string => typeof line === 'string') : [];
        this.data = { schemaVersion: 1, preferences: raw.preferences ?? null, read, unlocked: valueRecord(raw.unlocked) ? raw.unlocked : {} };
        for (const line of read) this.read.add(line);
      }
    } catch (error) { onError(error); }
  }

  preferences() { return this.data.preferences; }
  savePreferences(preferences: ReadingPreferences): void { this.write({ ...this.data, preferences }); }
  hasRead(lineId: string): boolean { return this.read.has(lineId); }
  markRead(lineId: string): void {
    if (!this.read.has(lineId)) {
      this.write({ ...this.data, read: [...this.read, lineId] });
      this.read.add(lineId);
    }
  }

  replay(id: string): ReplayCapture | undefined {
    if (!Object.hasOwn(this.data.unlocked, id)) return undefined;
    try { return readReplay(this.story, id, this.data.unlocked[id]); }
    catch { return undefined; }
  }

  unlock(id: string, capture: ReplayCapture): void {
    if (!this.replay(id)) this.write({ ...this.data, unlocked: { ...this.data.unlocked, [id]: capture } });
  }

  listReplays(): readonly string[] {
    return Object.keys(this.story.definition.replays ?? {}).filter(id => this.replay(id) !== undefined);
  }

  private write(next: Profile): void {
    this.storage.setItem(this.key, JSON.stringify(next));
    this.data = next;
  }
}

// Keep restored rows in the same bounded history surface; G04 still owns incoming rows and input.
export class SessionReading extends ReadingPlayback {
  private readonly restored: readonly ReadingEntry[];
  private readonly initialHistoryRevision: number;
  private choiceView?: { readonly source: ReadingView; readonly filtered: ReadingView };
  constructor(options: ReadingPlaybackOptions, restored: readonly SavedReadingLine[], private readonly canPlay: () => boolean,
    private readonly replayChoice?: () => string | null) {
    super(options);
    this.initialHistoryRevision = super.historyRevision;
    this.restored = restored.map(({ lineId, params }, index) => {
      const line = options.lines[lineId]!;
      const node = options.runtime.definition.nodes[line.nodeId];
      return Object.freeze({ key: `saved:${index}`, lineId, textKey: line.textKey, params: Object.freeze({ ...params }),
        ...(node && 'speakerKey' in node && node.speakerKey ? { speakerKey: node.speakerKey } : {}) });
    });
    const last = restored.at(-1), first = super.history()[0];
    if (last && first && last.lineId === first.lineId &&
      Object.keys(last.params).length === Object.keys(first.params).length &&
      Object.entries(last.params).every(([key, value]) => first.params[key] === value)) {
      this.restored = this.restored.slice(0, -1);
    }
  }
  override get historySize(): number { return this.disposed ? 0 : Math.min(2_000, this.restored.length + super.historySize); }
  override get historyRevision(): number { return super.historyRevision - this.initialHistoryRevision; }
  override get view(): ReadingView {
    const source = super.view;
    if (source.kind !== 'choice' || !this.replayChoice) return source;
    if (this.choiceView?.source !== source) {
      const allowed = this.replayChoice();
      const choices = Object.freeze(source.choices.map(choice => Object.freeze({ ...choice, enabled: choice.enabled && choice.id === allowed })));
      this.choiceView = { source, filtered: Object.freeze({ ...source, choices }) };
    }
    return this.choiceView.filtered;
  }
  override history(): readonly ReadingEntry[] {
    if (this.disposed) return [];
    return [...this.restored, ...super.history()].slice(-2_000);
  }
  override confirm(revision?: number): boolean { return this.canPlay() && super.confirm(revision); }
  override choose(id: string, revision?: number): boolean {
    return this.canPlay() && (!this.replayChoice || this.replayChoice() === id) && super.choose(id, revision);
  }
  override tick(ms: number): void { if (this.canPlay()) super.tick(ms); }
}
