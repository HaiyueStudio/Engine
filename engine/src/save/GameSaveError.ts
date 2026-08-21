export const GameSaveErrorCode = {
  InvalidEnvelope: 'E_GAME_SAVE_INVALID_ENVELOPE',
  InvalidData: 'E_GAME_SAVE_INVALID_DATA',
  NotFound: 'E_GAME_SAVE_NOT_FOUND',
  Conflict: 'E_GAME_SAVE_CONFLICT',
  SlotLimit: 'E_GAME_SAVE_SLOT_LIMIT',
  StorageUnavailable: 'E_GAME_SAVE_STORAGE_UNAVAILABLE',
  QuotaExceeded: 'E_GAME_SAVE_QUOTA_EXCEEDED',
  SerializationFailed: 'E_GAME_SAVE_SERIALIZATION_FAILED',
  UnsupportedOperation: 'E_GAME_SAVE_UNSUPPORTED_OPERATION',
  Disposed: 'E_GAME_SAVE_DISPOSED',
} as const;

export type GameSaveErrorCode = typeof GameSaveErrorCode[keyof typeof GameSaveErrorCode];
export type GameSaveOperation = 'list' | 'read' | 'write' | 'delete' | 'validate' | 'import' | 'export' | 'thumbnail';

export interface GameSaveErrorOptions {
  operation: GameSaveOperation;
  backendId?: string;
  gameId?: string;
  saveId?: string;
  issues?: readonly { code: string; path: string; message: string }[];
  cause?: unknown;
}

export class GameSaveError extends Error {
  readonly code: GameSaveErrorCode;
  readonly operation: GameSaveOperation;
  readonly backendId: string | undefined;
  readonly gameId: string | undefined;
  readonly saveId: string | undefined;
  readonly issues: readonly { code: string; path: string; message: string }[];
  override readonly cause: unknown;

  constructor(code: GameSaveErrorCode, message: string, options: GameSaveErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'GameSaveError';
    this.code = code;
    this.operation = options.operation;
    this.backendId = options.backendId;
    this.gameId = options.gameId;
    this.saveId = options.saveId;
    this.issues = options.issues ?? [];
    this.cause = options.cause;
  }
}

export function normalizeGameSaveStorageError(error: unknown, options: GameSaveErrorOptions): GameSaveError {
  if (error instanceof GameSaveError) return error;
  const domName = typeof DOMException !== 'undefined' && error instanceof DOMException ? error.name : '';
  const quotaExceeded = domName === 'QuotaExceededError' || domName === 'NS_ERROR_DOM_QUOTA_REACHED';
  return new GameSaveError(
    quotaExceeded ? GameSaveErrorCode.QuotaExceeded : GameSaveErrorCode.StorageUnavailable,
    quotaExceeded ? 'The save storage quota was exceeded.' : 'The selected save storage is unavailable.',
    { ...options, cause: error },
  );
}

