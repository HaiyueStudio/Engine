import { GameSaveError, GameSaveErrorCode } from './GameSaveError';
import type { CaptureGameSaveThumbnailOptions, GameSaveThumbnail } from './contracts';

export function captureGameSaveThumbnail(
  canvas: HTMLCanvasElement,
  options: CaptureGameSaveThumbnailOptions = {},
): GameSaveThumbnail {
  const mimeType = options.mimeType ?? 'image/webp';
  try {
    const dataUrl = canvas.toDataURL(mimeType, options.quality ?? 0.82);
    if (!dataUrl.startsWith(`data:${mimeType};`)) {
      throw new Error(`Canvas encoder did not support ${mimeType}.`);
    }
    return { mimeType, dataUrl, width: canvas.width, height: canvas.height };
  } catch (error) {
    throw new GameSaveError(GameSaveErrorCode.SerializationFailed, 'The current canvas could not be captured as a save thumbnail.', {
      operation: 'thumbnail', cause: error,
    });
  }
}

