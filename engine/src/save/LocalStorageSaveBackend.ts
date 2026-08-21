import { GameSaveError, GameSaveErrorCode, normalizeGameSaveStorageError } from './GameSaveError';
import type { GameSaveBackend, GameSaveEnvelope } from './contracts';
import { assertValidGameSaveEnvelope } from './validation';

export interface LocalStorageSaveBackendOptions {
  namespace?: string;
  storage?: Storage;
}

export class LocalStorageSaveBackend implements GameSaveBackend {
  readonly id = 'local-storage';
  readonly capabilities = Object.freeze({ multiple: true, delete: true, persistent: true });
  private readonly _namespace: string;
  private readonly _storage: Storage | undefined;

  constructor(options: LocalStorageSaveBackendOptions = {}) {
    this._namespace = options.namespace?.trim() || 'haiyue';
    this._storage = options.storage;
  }

  async list(gameId: string): Promise<readonly GameSaveEnvelope[]> {
    const storage = this._getStorage('list', gameId);
    const prefix = this._gamePrefix(gameId);
    try {
      const saves: GameSaveEnvelope[] = [];
      for (let i = 0; i < storage.length; i++) {
        const storageKey = storage.key(i);
        if (!storageKey?.startsWith(prefix)) continue;
        const raw = storage.getItem(storageKey);
        if (raw !== null) saves.push(this._parse(raw, 'list', gameId));
      }
      return saves.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      throw normalizeGameSaveStorageError(error, { operation: 'list', backendId: this.id, gameId });
    }
  }

  async read(gameId: string, saveId: string): Promise<GameSaveEnvelope | null> {
    try {
      const raw = this._getStorage('read', gameId, saveId).getItem(this._key(gameId, saveId));
      return raw === null ? null : this._parse(raw, 'read', gameId, saveId);
    } catch (error) {
      if (error instanceof GameSaveError) throw error;
      throw normalizeGameSaveStorageError(error, { operation: 'read', backendId: this.id, gameId, saveId });
    }
  }

  async write(save: GameSaveEnvelope): Promise<void> {
    try {
      const valid = assertValidGameSaveEnvelope(save, { operation: 'write' });
      this._getStorage('write', save.gameId, save.saveId).setItem(this._key(save.gameId, save.saveId), JSON.stringify(valid));
    } catch (error) {
      if (error instanceof GameSaveError) throw error;
      throw normalizeGameSaveStorageError(error, { operation: 'write', backendId: this.id, gameId: save.gameId, saveId: save.saveId });
    }
  }

  async delete(gameId: string, saveId: string): Promise<void> {
    try {
      this._getStorage('delete', gameId, saveId).removeItem(this._key(gameId, saveId));
    } catch (error) {
      throw normalizeGameSaveStorageError(error, { operation: 'delete', backendId: this.id, gameId, saveId });
    }
  }

  private _parse(raw: string, operation: 'list' | 'read', gameId: string, saveId?: string): GameSaveEnvelope {
    try {
      return assertValidGameSaveEnvelope(JSON.parse(raw), { expectedGameId: gameId, operation: 'read' });
    } catch (error) {
      if (error instanceof GameSaveError) throw error;
      throw new GameSaveError(GameSaveErrorCode.SerializationFailed, 'Stored game save JSON could not be parsed.', {
        operation,
        backendId: this.id,
        gameId,
        ...(saveId === undefined ? {} : { saveId }),
        cause: error,
      });
    }
  }

  private _getStorage(operation: 'list' | 'read' | 'write' | 'delete', gameId: string, saveId?: string): Storage {
    let storage = this._storage;
    if (storage === undefined && typeof globalThis.localStorage !== 'undefined') storage = globalThis.localStorage;
    if (storage === undefined) {
      throw new GameSaveError(GameSaveErrorCode.StorageUnavailable, 'LocalStorage is not available in this environment.', {
        operation,
        backendId: this.id,
        gameId,
        ...(saveId === undefined ? {} : { saveId }),
      });
    }
    return storage;
  }

  private _gamePrefix(gameId: string): string {
    return `${this._namespace}:game-save:${encodeURIComponent(gameId)}:`;
  }

  private _key(gameId: string, saveId: string): string {
    return `${this._gamePrefix(gameId)}${encodeURIComponent(saveId)}`;
  }
}

