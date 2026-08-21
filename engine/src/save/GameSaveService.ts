import { GameSaveError, GameSaveErrorCode } from './GameSaveError';
import type {
  GameSaveEnvelope,
  GameSaveServiceOptions,
  GameSaveSummary,
  ImportGameSaveOptions,
  WriteGameSaveOptions,
} from './contracts';
import { GAME_SAVE_FORMAT, GAME_SAVE_FORMAT_VERSION } from './contracts';
import { parseGameSaveFile, serializeGameSaveFile } from './file';
import { assertValidGameSaveEnvelope, computeGameSaveIntegrity, validateGameSaveEnvelope } from './validation';

export class GameSaveService<TData = unknown> {
  private readonly _gameId: string;
  private readonly _dataVersion: number;
  private readonly _maxSlots: number;
  private readonly _ownsBackend: boolean;
  private readonly _clock: () => Date;
  private readonly _createId: () => string;
  private _tail: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(private readonly _options: GameSaveServiceOptions) {
    this._gameId = requireText(_options.gameId, 'gameId');
    if (!Number.isInteger(_options.dataVersion) || _options.dataVersion < 0) throw new TypeError('dataVersion must be a non-negative integer.');
    this._dataVersion = _options.dataVersion;
    this._maxSlots = _options.maxSlots ?? Number.POSITIVE_INFINITY;
    if (!(this._maxSlots > 0) || (this._maxSlots !== Number.POSITIVE_INFINITY && !Number.isInteger(this._maxSlots))) {
      throw new TypeError('maxSlots must be a positive integer.');
    }
    this._ownsBackend = _options.ownsBackend ?? false;
    this._clock = _options.clock ?? (() => new Date());
    this._createId = _options.createId ?? defaultSaveId;
  }

  save(options: WriteGameSaveOptions<TData>): Promise<GameSaveEnvelope<TData>> {
    return this._enqueue(async () => {
      const saveId = requireText(options.saveId ?? this._createId(), 'saveId');
      const name = requireText(options.name, 'name');
      const existing = await this._options.backend.read(this._gameId, saveId);
      if (existing === null) await this._assertSlotAvailable();
      else this._validate(existing, 'read');

      const now = this._clock().toISOString();
      let data: TData;
      try {
        data = structuredClone(options.data);
      } catch (error) {
        throw new GameSaveError(GameSaveErrorCode.InvalidData, 'Game-specific save data could not be cloned.', {
          operation: 'write', backendId: this._options.backend.id, gameId: this._gameId, saveId, cause: error,
        });
      }
      const body: Omit<GameSaveEnvelope<TData>, 'integrity'> = {
        format: GAME_SAVE_FORMAT,
        formatVersion: GAME_SAVE_FORMAT_VERSION,
        saveId,
        gameId: this._gameId,
        name,
        kind: options.kind ?? 'manual',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        revision: (existing?.revision ?? 0) + 1,
        dataVersion: this._dataVersion,
        data,
        ...(options.thumbnail === undefined ? {} : { thumbnail: structuredClone(options.thumbnail) }),
        ...(options.metadata === undefined ? {} : { metadata: structuredClone(options.metadata) }),
      };
      const preflight = validateGameSaveEnvelope(
        { ...body, integrity: { algorithm: 'fnv1a32', checksum: '00000000' } },
        { ...this._validationOptions(), verifyIntegrity: false },
      );
      if (!preflight.valid) {
        throw new GameSaveError(GameSaveErrorCode.InvalidData, 'Game-specific save data is incomplete or invalid.', {
          operation: 'write', backendId: this._options.backend.id, gameId: this._gameId, saveId, issues: preflight.issues,
        });
      }
      const save: GameSaveEnvelope<TData> = { ...body, integrity: computeGameSaveIntegrity(body) };
      this._validate(save, 'write');
      await this._options.backend.write(save);
      this._assertActive('write', saveId);
      return structuredClone(save);
    });
  }

  checkpoint(options: Omit<WriteGameSaveOptions<TData>, 'kind'>): Promise<GameSaveEnvelope<TData>> {
    return this.save({ ...options, kind: 'checkpoint' });
  }

  load(saveId: string): Promise<GameSaveEnvelope<TData> | null> {
    return this._enqueue(async () => {
      const normalizedId = requireText(saveId, 'saveId');
      const save = await this._options.backend.read(this._gameId, normalizedId);
      this._assertActive('read', normalizedId);
      return save === null ? null : structuredClone(this._validate(save, 'read'));
    });
  }

  list(): Promise<readonly GameSaveSummary[]> {
    return this._enqueue(async () => {
      const saves = await this._options.backend.list(this._gameId);
      this._assertActive('list');
      return saves.map(save => toSummary(this._validate(save, 'read')));
    });
  }

  delete(saveId: string): Promise<void> {
    return this._enqueue(async () => {
      const normalizedId = requireText(saveId, 'saveId');
      if (!this._options.backend.capabilities.delete) {
        throw new GameSaveError(GameSaveErrorCode.UnsupportedOperation, 'The selected save backend cannot delete saves.', {
          operation: 'delete', backendId: this._options.backend.id, gameId: this._gameId, saveId: normalizedId,
        });
      }
      await this._options.backend.delete(this._gameId, normalizedId);
      this._assertActive('delete', normalizedId);
    });
  }

  validate(value: unknown) {
    return validateGameSaveEnvelope(value, this._validationOptions());
  }

  export(saveId: string, pretty = true): Promise<string> {
    return this._enqueue(async () => {
      const normalizedId = requireText(saveId, 'saveId');
      const save = await this._options.backend.read(this._gameId, normalizedId);
      this._assertActive('export', normalizedId);
      if (save === null) throw this._notFound('export', normalizedId);
      return serializeGameSaveFile(this._validate(save, 'read'), pretty);
    });
  }

  import(contents: string, options: ImportGameSaveOptions = {}): Promise<GameSaveEnvelope<TData>> {
    return this._enqueue(async () => {
      const save = parseGameSaveFile<TData>(contents, this._validationOptions());
      const existing = await this._options.backend.read(this._gameId, save.saveId);
      if (existing !== null && options.replace !== true) {
        throw new GameSaveError(GameSaveErrorCode.Conflict, `Save "${save.saveId}" already exists.`, {
          operation: 'import', backendId: this._options.backend.id, gameId: this._gameId, saveId: save.saveId,
        });
      }
      if (existing === null) await this._assertSlotAvailable();
      await this._options.backend.write(save);
      this._assertActive('import', save.saveId);
      return structuredClone(save);
    });
  }

  async flush(): Promise<void> {
    await this._tail;
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    await this._tail;
    if (this._ownsBackend) await this._options.backend.dispose?.();
  }

  private _validate(value: unknown, operation: 'read' | 'write'): GameSaveEnvelope<TData> {
    return assertValidGameSaveEnvelope<TData>(value, {
      operation,
      ...this._validationOptions(),
    });
  }

  private _validationOptions() {
    return {
      expectedGameId: this._gameId,
      expectedDataVersion: this._dataVersion,
      ...(this._options.validateData === undefined ? {} : { validateData: this._options.validateData }),
    };
  }

  private async _assertSlotAvailable(): Promise<void> {
    const saves = await this._options.backend.list(this._gameId);
    if (saves.length < this._maxSlots) return;
    throw new GameSaveError(GameSaveErrorCode.SlotLimit, `The save slot limit of ${this._maxSlots} was reached.`, {
      operation: 'write', backendId: this._options.backend.id, gameId: this._gameId,
    });
  }

  private _enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this._tail.then(async () => {
      this._assertActive('read');
      return task();
    });
    this._tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private _assertActive(operation: 'list' | 'read' | 'write' | 'delete' | 'import' | 'export', saveId?: string): void {
    if (!this._disposed) return;
    throw new GameSaveError(GameSaveErrorCode.Disposed, 'The game save service has been disposed.', {
      operation, backendId: this._options.backend.id, gameId: this._gameId, ...(saveId === undefined ? {} : { saveId }),
    });
  }

  private _notFound(operation: 'export', saveId: string): GameSaveError {
    return new GameSaveError(GameSaveErrorCode.NotFound, `Save "${saveId}" was not found.`, {
      operation, backendId: this._options.backend.id, gameId: this._gameId, saveId,
    });
  }
}

function toSummary(save: GameSaveEnvelope): GameSaveSummary {
  return {
    saveId: save.saveId,
    gameId: save.gameId,
    name: save.name,
    kind: save.kind,
    createdAt: save.createdAt,
    updatedAt: save.updatedAt,
    revision: save.revision,
    dataVersion: save.dataVersion,
    ...(save.thumbnail === undefined ? {} : { thumbnail: structuredClone(save.thumbnail) }),
    ...(save.metadata === undefined ? {} : { metadata: structuredClone(save.metadata) }),
  };
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return normalized;
}

function defaultSaveId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
