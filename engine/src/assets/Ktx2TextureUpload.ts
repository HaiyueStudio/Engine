import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { GPUResourceOwner, GPUResourceTracker } from '../core/GPUResourceTracker';
import { alignUp } from '../utils/align';
import type { AssetLoaderContext } from './AssetManager';
import { createAbortError } from '../async/AsyncPrimitives';

export interface Ktx2TexturePayload {
  width: number;
  height: number;
  depth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  format: GPUTextureFormat;
  blockWidth: number;
  blockHeight: number;
  bytesPerBlock: number;
  requiredFeature?: GPUFeatureName | undefined;
  uploadPath: 'gpu-native' | 'basis-transcode';
  levels: Array<{
    width: number;
    height: number;
    depthOrArrayLayers: number;
    data: Uint8Array;
  }>;
}

export function uploadPreparedKtx2Texture(
  device: GPUDevice,
  payload: Ktx2TexturePayload,
  label = 'KTX2Texture',
  tracker?: GPUResourceTracker,
  owner?: GPUResourceOwner,
): GPUTexture {
  assertKtx2TextureFeature(device, payload, label);
  const texture = createPreparedKtx2Texture(device, payload, label);
  const payloadBytes = payload.levels.reduce((total, level) => total + level.data.byteLength, 0);
  tracker?.trackTexture(texture, `AssetManager.ktx2.${payload.uploadPath}:${payload.format}`, payloadBytes, owner);

  const encoder = device.createCommandEncoder({ label: `${label}.${payload.uploadPath}Upload` });
  const stagingBuffers: GPUBuffer[] = [];
  for (const [level, levelInfo] of payload.levels.entries()) {
    const blocksX = Math.ceil(levelInfo.width / payload.blockWidth);
    const blocksY = Math.ceil(levelInfo.height / payload.blockHeight);
    const bytesPerRow = blocksX * payload.bytesPerBlock;
    const alignedBytesPerRow = alignUp(bytesPerRow, 256);
    const stagingSize = alignedBytesPerRow * blocksY * levelInfo.depthOrArrayLayers;
    const staging = device.createBuffer({
      label: `${label}.${payload.uploadPath}Upload.level${level}`,
      size: stagingSize,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    const mapped = new Uint8Array(staging.getMappedRange());
    for (let layer = 0; layer < levelInfo.depthOrArrayLayers; layer++) {
      const sourceLayerOffset = layer * blocksY * bytesPerRow;
      const mappedLayerOffset = layer * blocksY * alignedBytesPerRow;
      for (let row = 0; row < blocksY; row++) {
        const srcStart = sourceLayerOffset + row * bytesPerRow;
        mapped.set(levelInfo.data.subarray(srcStart, srcStart + bytesPerRow), mappedLayerOffset + row * alignedBytesPerRow);
      }
    }
    staging.unmap();
    stagingBuffers.push(staging);
    encoder.copyBufferToTexture(
      { buffer: staging, bytesPerRow: alignedBytesPerRow, rowsPerImage: blocksY },
      { texture, mipLevel: level },
      {
        width: blocksX * payload.blockWidth,
        height: blocksY * payload.blockHeight,
        depthOrArrayLayers: levelInfo.depthOrArrayLayers,
      },
    );
  }
  device.queue.submit([encoder.finish()]);
  destroyKtx2StagingAfterSubmission(device, stagingBuffers);
  return texture;
}

export function assertKtx2TextureFeature(device: GPUDevice, payload: Ktx2TexturePayload, label: string): void {
  if (payload.requiredFeature && !device.features.has(payload.requiredFeature)) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `KTX2 texture "${label}" requires WebGPU feature "${payload.requiredFeature}".`,
      {
        hint: 'Create the engine on an adapter that supports the compressed texture feature, or provide an uncompressed fallback texture.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }
}

export function createPreparedKtx2Texture(device: GPUDevice, payload: Ktx2TexturePayload, label: string): GPUTexture {
  const { width, height, depth, layerCount, faceCount, levelCount } = payload;
  const isTexture3D = depth > 0;
  return device.createTexture({
    label,
    size: [width, height, isTexture3D ? depth : layerCount * faceCount],
    dimension: isTexture3D ? '3d' : '2d',
    mipLevelCount: levelCount,
    format: payload.format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
}

export function destroyKtx2StagingAfterSubmission(device: GPUDevice, stagingBuffers: readonly GPUBuffer[]): void {
  const destroy = () => {
    for (const buffer of stagingBuffers) {
      try { buffer.destroy(); } catch { /* Device teardown is idempotent. */ }
    }
  };
  void device.queue.onSubmittedWorkDone().then(destroy, destroy);
}

export interface Ktx2BudgetedUploadRegion {
  readonly level: number;
  readonly layerStart: number;
  readonly layerCount: number;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly blocksX: number;
  readonly blocksY: number;
  readonly bytesPerRow: number;
  readonly alignedBytesPerRow: number;
  readonly stagingOffset: number;
  readonly stagingBytes: number;
}

export interface Ktx2BudgetedUploadBatch {
  readonly bytes: number;
  readonly regions: readonly Ktx2BudgetedUploadRegion[];
}

/**
 * Packs complete mip/layer regions into frame-budgeted batches. The plan keeps
 * each row 256-byte aligned for WebGPU while allowing one staging buffer and
 * one command submission to carry multiple independent copy commands.
 */
export function planKtx2BudgetedUploadBatches(
  payload: Ktx2TexturePayload,
  frameBudgetBytes: number,
): readonly Ktx2BudgetedUploadBatch[] {
  const frameBudget = Math.floor(frameBudgetBytes);
  if (!Number.isFinite(frameBudgetBytes) || frameBudget <= 0) {
    throw new EngineError(
      EngineErrorCode.AssetInvalidData,
      'KTX2 upload frame budget must be a positive finite byte count.',
      { context: { frameBudgetBytes }, path: 'ktx2.upload.frameBudgetBytes' },
    );
  }

  const batches: Array<{ bytes: number; regions: Ktx2BudgetedUploadRegion[] }> = [];
  let current: { bytes: number; regions: Ktx2BudgetedUploadRegion[] } | null = null;
  const getCurrent = () => {
    if (!current) current = { bytes: 0, regions: [] };
    return current;
  };
  const flush = () => {
    if (!current || current.regions.length === 0) return;
    batches.push(current);
    current = null;
  };

  for (const [level, levelInfo] of payload.levels.entries()) {
    const blocksX = Math.ceil(levelInfo.width / payload.blockWidth);
    const blocksY = Math.ceil(levelInfo.height / payload.blockHeight);
    const bytesPerRow = blocksX * payload.bytesPerBlock;
    const alignedBytesPerRow = alignUp(bytesPerRow, 256);
    if (alignedBytesPerRow > frameBudget) {
      throw new EngineError(
        EngineErrorCode.AssetInvalidData,
        `KTX2 mip ${level} has a row larger than the per-frame upload budget.`,
        {
          context: { level, alignedBytesPerRow, frameBudgetBytes: frameBudget },
          path: `ktx2.levels[${level}].bytesPerRow`,
          hint: 'Increase the asset upload budget so at least one aligned texture row fits in a frame.',
        },
      );
    }

    let layer = 0;
    let row = 0;
    while (layer < levelInfo.depthOrArrayLayers) {
      let batch = getCurrent();
      let availableRows = Math.floor((frameBudget - batch.bytes) / alignedBytesPerRow);
      if (availableRows === 0) {
        flush();
        batch = getCurrent();
        availableRows = Math.floor(frameBudget / alignedBytesPerRow);
      }

      if (row === 0 && availableRows >= blocksY) {
        const layerCount = Math.min(
          levelInfo.depthOrArrayLayers - layer,
          Math.floor(availableRows / blocksY),
        );
        const stagingBytes = alignedBytesPerRow * blocksY * layerCount;
        batch.regions.push({
          level,
          layerStart: layer,
          layerCount,
          rowStart: 0,
          rowCount: blocksY,
          blocksX,
          blocksY,
          bytesPerRow,
          alignedBytesPerRow,
          stagingOffset: batch.bytes,
          stagingBytes,
        });
        batch.bytes += stagingBytes;
        layer += layerCount;
      } else {
        const rowCount = Math.min(blocksY - row, availableRows);
        const stagingBytes = alignedBytesPerRow * rowCount;
        batch.regions.push({
          level,
          layerStart: layer,
          layerCount: 1,
          rowStart: row,
          rowCount,
          blocksX,
          blocksY,
          bytesPerRow,
          alignedBytesPerRow,
          stagingOffset: batch.bytes,
          stagingBytes,
        });
        batch.bytes += stagingBytes;
        row += rowCount;
        if (row === blocksY) {
          layer++;
          row = 0;
        }
      }

      if (batch.bytes === frameBudget) flush();
    }
  }
  flush();
  return batches;
}

export async function uploadPreparedKtx2TextureBudgeted(
  context: AssetLoaderContext,
  payload: Ktx2TexturePayload,
  label: string,
): Promise<GPUTexture> {
  assertKtx2TextureFeature(context.device, payload, label);
  const texture = createPreparedKtx2Texture(context.device, payload, label);
  const payloadBytes = payload.levels.reduce((total, level) => total + level.data.byteLength, 0);
  context.tracker?.trackTexture(
    texture,
    `AssetManager.ktx2.${payload.uploadPath}:${payload.format}`,
    payloadBytes,
    context.resourceOwner,
  );

  const localController = new AbortController();
  const signal = AbortSignal.any([context.signal, localController.signal]);
  try {
    const frameBudget = Math.max(1, context.manager.uploads.frameBudgetBytes);
    // Large textures use half-frame atomic batches. Two full batches still
    // drain in one frame, while a texture tail can share the frame with the
    // next texture instead of stranding most of the global upload budget.
    const largestAlignedRow = payload.levels.reduce((largest, level) => {
      const blocksX = Math.ceil(level.width / payload.blockWidth);
      return Math.max(largest, alignUp(blocksX * payload.bytesPerBlock, 256));
    }, 0);
    const atomicBatchBudget = frameBudget >= 1024 * 1024
      ? Math.min(frameBudget, Math.max(Math.floor(frameBudget / 2), largestAlignedRow))
      : frameBudget;
    const batches = planKtx2BudgetedUploadBatches(
      payload,
      atomicBatchBudget,
    );
    await Promise.all(batches.map((batch, batchIndex) => context.scheduleUpload({
      label: `${label}.batch${batchIndex}`,
      bytes: batch.bytes,
      signal,
      upload: () => uploadPreparedKtx2Batch(context.device, texture, payload, batch, label, batchIndex),
    })));
    if (context.signal.aborted) throw createAbortError('KTX2 upload aborted.', context.signal.reason);
    return texture;
  } catch (error) {
    localController.abort(error);
    context.tracker?.untrackTexture(texture);
    try { texture.destroy(); } catch { /* Device teardown is idempotent. */ }
    throw error;
  }
}

function uploadPreparedKtx2Batch(
  device: GPUDevice,
  texture: GPUTexture,
  payload: Ktx2TexturePayload,
  batch: Ktx2BudgetedUploadBatch,
  label: string,
  batchIndex: number,
): void {
  const staging = device.createBuffer({
    label: `${label}.${payload.uploadPath}Upload.batch${batchIndex}`,
    size: batch.bytes,
    usage: GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  try {
    const mapped = new Uint8Array(staging.getMappedRange());
    for (const region of batch.regions) {
      const levelInfo = payload.levels[region.level];
      if (!levelInfo) throw new RangeError(`KTX2 mip level ${region.level} is out of range.`);
      for (let layerOffset = 0; layerOffset < region.layerCount; layerOffset++) {
        const sourceLayer = region.layerStart + layerOffset;
        const sourceLayerOffset = sourceLayer * region.blocksY * region.bytesPerRow;
        const stagingLayerOffset = region.stagingOffset
          + layerOffset * region.rowCount * region.alignedBytesPerRow;
        for (let rowOffset = 0; rowOffset < region.rowCount; rowOffset++) {
          const sourceStart = sourceLayerOffset
            + (region.rowStart + rowOffset) * region.bytesPerRow;
          mapped.set(
            levelInfo.data.subarray(sourceStart, sourceStart + region.bytesPerRow),
            stagingLayerOffset + rowOffset * region.alignedBytesPerRow,
          );
        }
      }
    }
    staging.unmap();

    const encoder = device.createCommandEncoder({
      label: `${label}.${payload.uploadPath}Upload.batch${batchIndex}`,
    });
    for (const region of batch.regions) {
      encoder.copyBufferToTexture(
        {
          buffer: staging,
          offset: region.stagingOffset,
          bytesPerRow: region.alignedBytesPerRow,
          rowsPerImage: region.rowCount,
        },
        {
          texture,
          mipLevel: region.level,
          origin: {
            x: 0,
            y: region.rowStart * payload.blockHeight,
            z: region.layerStart,
          },
        },
        {
          width: region.blocksX * payload.blockWidth,
          height: region.rowCount * payload.blockHeight,
          depthOrArrayLayers: region.layerCount,
        },
      );
    }
    device.queue.submit([encoder.finish()]);
    destroyKtx2StagingAfterSubmission(device, [staging]);
  } catch (error) {
    try { staging.destroy(); } catch { /* Device teardown is idempotent. */ }
    throw error;
  }
}
