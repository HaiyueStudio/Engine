import type { GameSaveBackend, GameSaveEnvelope } from './contracts';

/** Non-persistent backend for tests and file-only save flows. */
export class MemorySaveBackend implements GameSaveBackend {
  readonly id = 'memory';
  readonly capabilities = Object.freeze({ multiple: true, delete: true, persistent: false });
  private readonly _saves = new Map<string, GameSaveEnvelope>();

  async list(gameId: string): Promise<readonly GameSaveEnvelope[]> {
    return [...this._saves.values()]
      .filter(save => save.gameId === gameId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneSave);
  }

  async read(gameId: string, saveId: string): Promise<GameSaveEnvelope | null> {
    const save = this._saves.get(key(gameId, saveId));
    return save ? cloneSave(save) : null;
  }

  async write(save: GameSaveEnvelope): Promise<void> {
    this._saves.set(key(save.gameId, save.saveId), cloneSave(save));
  }

  async delete(gameId: string, saveId: string): Promise<void> {
    this._saves.delete(key(gameId, saveId));
  }
}

function key(gameId: string, saveId: string): string {
  return `${gameId}\u0000${saveId}`;
}

function cloneSave(save: GameSaveEnvelope): GameSaveEnvelope {
  return structuredClone(save);
}

