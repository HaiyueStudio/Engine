import { GameSaveError, GameSaveErrorCode } from './GameSaveError';
import type { GameSaveEnvelope, GameSaveValidationOptions } from './contracts';
import { assertValidGameSaveEnvelope } from './validation';

export function serializeGameSaveFile(save: GameSaveEnvelope, pretty = true): string {
  try {
    assertValidGameSaveEnvelope(save, { operation: 'write' });
    return JSON.stringify(save, null, pretty ? 2 : undefined);
  } catch (error) {
    if (error instanceof GameSaveError) throw error;
    throw new GameSaveError(GameSaveErrorCode.SerializationFailed, 'The game save could not be serialized.', {
      operation: 'export', gameId: save.gameId, saveId: save.saveId, cause: error,
    });
  }
}

export function parseGameSaveFile<TData = unknown>(contents: string, options: GameSaveValidationOptions = {}): GameSaveEnvelope<TData> {
  try {
    return assertValidGameSaveEnvelope<TData>(JSON.parse(contents), { ...options, operation: 'import' });
  } catch (error) {
    if (error instanceof GameSaveError) throw error;
    throw new GameSaveError(GameSaveErrorCode.SerializationFailed, 'The game save file is not valid JSON.', {
      operation: 'import',
      ...(options.expectedGameId === undefined ? {} : { gameId: options.expectedGameId }),
      cause: error,
    });
  }
}

export function downloadGameSaveFile(save: GameSaveEnvelope, fileName = `${safeFileName(save.name)}.hysave.json`): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new GameSaveError(GameSaveErrorCode.UnsupportedOperation, 'Downloading save files requires a browser document.', {
      operation: 'export', gameId: save.gameId, saveId: save.saveId,
    });
  }
  const blob = new Blob([serializeGameSaveFile(save)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function readGameSaveFile<TData = unknown>(file: Blob, options: GameSaveValidationOptions = {}): Promise<GameSaveEnvelope<TData>> {
  return parseGameSaveFile<TData>(await file.text(), options);
}

function safeFileName(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '');
  return normalized || 'game-save';
}
