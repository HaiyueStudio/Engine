import { DeferredLightingCapabilityError } from '../frame/DeferredLightTable';
import { DEFERRED_TILE_LAYOUT as TILE } from '../shaders/generated/deferred-tile-layout.generated';

export const DEFERRED_SHARED_RESERVE_BYTES = 512 * 1024;
export const DEFERRED_VIEW_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEFERRED_AO_LAYOUT_VERSION = 2;

export function deferredAoStorage(width: number, height: number, passes: number) {
  if (![width, height, passes].every(Number.isSafeInteger) || width < 1 || height < 1 || passes < 0) throw new RangeError('Invalid Deferred AO extent/count.');
  const bytesPerRow = Math.ceil(width * 2 / 256) * 256;
  const bufferBytes = passes ? 256 + bytesPerRow * height : 0;
  const textureBytes = Math.min(2, passes) * width * height * 2;
  return { bytesPerRow, bufferBytes, textureBytes, bytes: bufferBytes + textureBytes };
}

/** Keep each stored tile's frozen layout. Unstored tiles use the existing full-list resolve. */
export function planDeferredViewMemory(width: number, height: number, aoPasses: number) {
  const ao = deferredAoStorage(width, height, aoPasses);
  const reservedBytes = DEFERRED_SHARED_RESERVE_BYTES + ao.bytes;
  const baseBytes = 28 * width * height + reservedBytes;
  if (baseBytes + 4 > DEFERRED_VIEW_LIMIT_BYTES) throw new DeferredLightingCapabilityError('view-deferred-bytes', baseBytes + 4, DEFERRED_VIEW_LIMIT_BYTES);
  const maxTileRecords = Math.floor((DEFERRED_VIEW_LIMIT_BYTES - baseBytes) / (TILE.strideWords * 4));
  return { ao, reservedBytes, maxTileRecords, baseBytes };
}
