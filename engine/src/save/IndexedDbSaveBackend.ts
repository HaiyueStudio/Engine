import { GameSaveError, GameSaveErrorCode, normalizeGameSaveStorageError } from './GameSaveError';
import type { GameSaveBackend, GameSaveEnvelope } from './contracts';
import { assertValidGameSaveEnvelope } from './validation';

export interface IndexedDbSaveBackendOptions {
  databaseName?: string;
  storeName?: string;
  factory?: IDBFactory;
}

interface IndexedDbSaveRecord {
  key: string;
  gameId: string;
  save: GameSaveEnvelope;
}

export class IndexedDbSaveBackend implements GameSaveBackend {
  readonly id = 'indexed-db';
  readonly capabilities = Object.freeze({ multiple: true, delete: true, persistent: true });
  private readonly _databaseName: string;
  private readonly _storeName: string;
  private readonly _factory: IDBFactory | undefined;
  private _databasePromise: Promise<IDBDatabase> | null = null;
  private _disposed = false;

  constructor(options: IndexedDbSaveBackendOptions = {}) {
    this._databaseName = options.databaseName?.trim() || 'haiyue-game-saves';
    this._storeName = options.storeName?.trim() || 'saves';
    this._factory = options.factory;
  }

  async list(gameId: string): Promise<readonly GameSaveEnvelope[]> {
    return this._withTransaction('readonly', 'list', gameId, undefined, async store => {
      const records = await requestResult<IndexedDbSaveRecord[]>(store.index('gameId').getAll(gameId));
      return records
        .map(record => assertValidGameSaveEnvelope(record.save, { expectedGameId: gameId, operation: 'read' }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  async read(gameId: string, saveId: string): Promise<GameSaveEnvelope | null> {
    return this._withTransaction('readonly', 'read', gameId, saveId, async store => {
      const record = await requestResult<IndexedDbSaveRecord | undefined>(store.get(key(gameId, saveId)));
      return record === undefined ? null : assertValidGameSaveEnvelope(record.save, { expectedGameId: gameId, operation: 'read' });
    });
  }

  async write(save: GameSaveEnvelope): Promise<void> {
    const valid = assertValidGameSaveEnvelope(save, { operation: 'write' });
    await this._withTransaction('readwrite', 'write', save.gameId, save.saveId, async store => {
      await requestResult(store.put({ key: key(save.gameId, save.saveId), gameId: save.gameId, save: valid } satisfies IndexedDbSaveRecord));
    });
  }

  async delete(gameId: string, saveId: string): Promise<void> {
    await this._withTransaction('readwrite', 'delete', gameId, saveId, async store => {
      await requestResult(store.delete(key(gameId, saveId)));
    });
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    const pending = this._databasePromise;
    this._databasePromise = null;
    if (pending !== null) (await pending).close();
  }

  private async _withTransaction<T>(
    mode: IDBTransactionMode,
    operation: 'list' | 'read' | 'write' | 'delete',
    gameId: string,
    saveId: string | undefined,
    task: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    this._assertActive(operation, gameId, saveId);
    try {
      const database = await this._open();
      this._assertActive(operation, gameId, saveId);
      const transaction = database.transaction(this._storeName, mode);
      const completion = transactionComplete(transaction);
      const result = await task(transaction.objectStore(this._storeName));
      await completion;
      return result;
    } catch (error) {
      if (error instanceof GameSaveError) throw error;
      throw normalizeGameSaveStorageError(error, {
        operation,
        backendId: this.id,
        gameId,
        ...(saveId === undefined ? {} : { saveId }),
      });
    }
  }

  private _open(): Promise<IDBDatabase> {
    if (this._databasePromise !== null) return this._databasePromise;
    const factory = this._factory ?? globalThis.indexedDB;
    if (factory === undefined) {
      return Promise.reject(new GameSaveError(GameSaveErrorCode.StorageUnavailable, 'IndexedDB is not available in this environment.', {
        operation: 'read',
        backendId: this.id,
      }));
    }
    this._databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(this._databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(this._storeName)
          ? request.transaction!.objectStore(this._storeName)
          : database.createObjectStore(this._storeName, { keyPath: 'key' });
        if (!store.indexNames.contains('gameId')) store.createIndex('gameId', 'gameId');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked.'));
    });
    return this._databasePromise;
  }

  private _assertActive(operation: 'list' | 'read' | 'write' | 'delete', gameId: string, saveId?: string): void {
    if (!this._disposed) return;
    throw new GameSaveError(GameSaveErrorCode.Disposed, 'The IndexedDB save backend has been disposed.', {
      operation,
      backendId: this.id,
      gameId,
      ...(saveId === undefined ? {} : { saveId }),
    });
  }
}

function key(gameId: string, saveId: string): string {
  return `${gameId}\u0000${saveId}`;
}

function requestResult<T = undefined>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}
