import { GameSaveError, GameSaveErrorCode, GameSaveService, assertValidGameSaveEnvelope, computeGameSaveIntegrity } from '@haiyue/engine/save';
import type { GameSaveBackend, GameSaveEnvelope, GameSaveThumbnail } from '@haiyue/engine/save';
import type { AuthoredStory } from '../story/types';
import { invalidSave, readPosition, readReplay, valueRecord } from './snapshot.js';
import type { ReplayCapture, SavedPosition, VisualNovelSnapshot } from './snapshot.js';

export const autoSlotId = 'auto';
export interface SlotStorageOptions {
  readonly gameId: string;
  readonly backend: GameSaveBackend;
  readonly manualSlots: readonly string[];
  readonly migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
  readonly clock?: () => Date;
}
export interface SlotPosition extends SavedPosition {
  readonly pendingReplays: Readonly<Record<string, ReplayCapture>>;
}
export type SlotSummary = {
  readonly id: string;
  readonly status: 'valid';
  readonly name: string;
  readonly lineId: string;
  readonly updatedAt: string;
  readonly thumbnail?: GameSaveThumbnail;
} | { readonly id: string; readonly status: 'empty' | 'unreadable'; readonly error?: GameSaveError };

const unreadable = (error: unknown): error is GameSaveError => error instanceof GameSaveError &&
  (error.code === GameSaveErrorCode.InvalidData || error.code === GameSaveErrorCode.InvalidEnvelope ||
    error.code === GameSaveErrorCode.SerializationFailed);

/**
 * The slot IDs already bound capacity. Use per-slot reads for list/allocation so an
 * unreadable record cannot prevent a different slot from being created.
 */
export class VisualNovelSlots {
  private readonly ids: readonly string[];
  private readonly service: GameSaveService<VisualNovelSnapshot>;
  private latestTime = Number.NEGATIVE_INFINITY;
  private indexReady: Promise<void> | undefined;

  constructor(private readonly story: AuthoredStory, private readonly options: SlotStorageOptions) {
    const { backend, gameId } = options;
    const ids = [autoSlotId, ...options.manualSlots];
    if (!backend.capabilities.multiple || !options.manualSlots.length || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id || id.trim() !== id)) throw invalidSave('Expected unique visual novel slots and a multi-slot backend.');
    this.ids = ids;
    const adapted: GameSaveBackend = {
      id: backend.id, capabilities: backend.capabilities,
      read: (_, saveId) => this.readEnvelope(saveId),
      list: async () => (await Promise.all(ids.map(id => this.readIsolated(id))))
        .flatMap(result => result.status === 'valid' ? [result.envelope] : []),
      write: save => backend.write(save),
      delete: (id, slot) => backend.delete(id, slot),
    };
    this.service = new GameSaveService({
      gameId, backend: adapted, maxSlots: ids.length, dataVersion: 1,
      clock: () => new Date(this.latestTime = Math.max((options.clock?.() ?? new Date()).getTime(), this.latestTime + 1)),
    });
  }

  async write(id: string, position: SlotPosition, name: string, thumbnail?: GameSaveThumbnail): Promise<void> {
    this.checkSlot(id);
    await (this.indexReady ??= this.initializeIndex().catch(error => { this.indexReady = undefined; throw error; }));
    const checked = readPosition(this.story, position);
    await this.service.save({
      saveId: id, kind: id === autoSlotId ? 'autosave' : 'manual', name, data: checked.snapshot,
      metadata: { ...(checked.music ? { music: checked.music } : {}), pendingReplays: position.pendingReplays },
      ...(thumbnail ? { thumbnail } : {}),
    });
  }

  async read(id: string): Promise<SlotPosition | null> {
    this.checkSlot(id);
    const envelope = await this.service.load(id);
    return envelope && this.position(envelope);
  }

  async latest(): Promise<string | null> {
    const rows = await this.list();
    const usable = rows.filter((row): row is Extract<SlotSummary, { status: 'valid' }> => row.status === 'valid');
    usable.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return usable[0]?.id ?? null;
  }

  async list(): Promise<readonly SlotSummary[]> {
    return Promise.all(this.ids.map(async (id): Promise<SlotSummary> => {
      const found = await this.readIsolated(id);
      if (found.status !== 'valid') return found;
      const { envelope } = found;
      const nodeId = envelope.data.narrative.nodeId;
      const lineId = Object.keys(this.story.lines).find(key => this.story.lines[key]!.nodeId === nodeId) ?? nodeId;
      return { id, status: 'valid', name: envelope.name, lineId, updatedAt: envelope.updatedAt,
        ...(envelope.thumbnail ? { thumbnail: envelope.thumbnail } : {}) };
    }));
  }

  flush(): Promise<void> { return this.service.flush(); }
  dispose(): Promise<void> { return this.service.dispose(); }

  private checkSlot(id: string): void {
    if (!this.ids.includes(id)) throw invalidSave('Unknown visual novel slot.');
  }

  private async initializeIndex(): Promise<void> {
    for (const entry of await this.list()) if (entry.status === 'valid') {
      this.latestTime = Math.max(this.latestTime, Date.parse(entry.updatedAt));
    }
  }

  private async readIsolated(id: string) {
    try {
      const envelope = await this.readEnvelope(id);
      return envelope ? { id, status: 'valid' as const, envelope } : { id, status: 'empty' as const };
    } catch (error) {
      if (!unreadable(error)) throw error;
      return { id, status: 'unreadable' as const, error };
    }
  }

  private async readEnvelope(id: string): Promise<GameSaveEnvelope<VisualNovelSnapshot> | null> {
    const { backend, gameId, migrations } = this.options;
    const raw = await backend.read(gameId, id);
    if (!raw) return null;
    const record = assertValidGameSaveEnvelope(raw, { expectedGameId: gameId, operation: 'read' });
    if (record.saveId !== id) throw invalidSave('Save ID differs from its slot ID.');
    let data = record.data;
    if (record.dataVersion !== 1) {
      const migrate = migrations && Object.hasOwn(migrations, record.dataVersion) ? migrations[record.dataVersion] : undefined;
      if (!migrate) throw invalidSave('Unsupported visual novel save version.');
      try { data = migrate(structuredClone(data)); }
      catch (cause) { throw invalidSave('Visual novel save migration failed.', cause); }
    }
    const position = this.position({ ...record, data });
    const { integrity, ...body } = record;
    const next = { ...body, dataVersion: 1, data: position.snapshot };
    return { ...next, integrity: computeGameSaveIntegrity(next) };
  }

  private position(envelope: GameSaveEnvelope): SlotPosition {
    const position = readPosition(this.story, { snapshot: envelope.data, music: envelope.metadata?.music });
    const pending: Record<string, ReplayCapture> = Object.create(null);
    const drafts = envelope.metadata?.pendingReplays;
    if (drafts !== undefined) {
      if (!valueRecord(drafts)) throw invalidSave('Malformed pending replay metadata.');
      for (const [id, draft] of Object.entries(drafts)) {
        const saved = readReplay(this.story, id, draft);
        if (saved.start.snapshot.narrative.runId !== position.snapshot.narrative.runId) throw invalidSave('Replay draft belongs to another run.');
        pending[id] = saved;
      }
    }
    return { ...position, pendingReplays: { ...pending } };
  }
}
