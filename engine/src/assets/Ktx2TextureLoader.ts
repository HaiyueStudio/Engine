/// <reference path="../types/external-modules.d.ts" />
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { parseAssetWorkerFirst } from './AssetParser';
import { monotonicNow } from '../async/AsyncPrimitives';
import { hasGpuFeature } from '../core/GPUFeatures';
import { alignUp } from '../utils/align';
import type { BudgetedAssetCache } from './AssetCache';
import type { AssetLoaderRegistration } from './AssetManager';
import { inflate } from 'pako';
import { loadLibrary } from '@loaders.gl/worker-utils';
import {
  getKtx2Dimension,
  getKtx2SupercompressionName,
  KTX2_SUPERCOMPRESSION_BASIS_LZ,
  KTX2_SUPERCOMPRESSION_NONE,
  KTX2_SUPERCOMPRESSION_ZSTD,
  KTX2_SUPERCOMPRESSION_ZLIB,
  parseKtx2Container,
  readKtx2Header,
  type Ktx2Level,
} from './Ktx2ContainerParser';
import {
  uploadPreparedKtx2TextureBudgeted,
  uploadPreparedKtx2Texture,
  type Ktx2TexturePayload,
} from './Ktx2TextureUpload';
import type {
  Ktx2TextureWorker,
  Ktx2TextureWorkerOptions,
} from './Ktx2TextureWorkerClient';
import {
  mapKtx2TextureFormat as mapTextureFormat,
  mapKtx2VkFormat as mapVkFormat,
  selectBasisOutputOptions,
  type BasisOutputOptions,
  type Ktx2FormatInfo,
} from './Ktx2TextureFormats';

export { uploadPreparedKtx2Texture } from './Ktx2TextureUpload';
export type { Ktx2TexturePayload } from './Ktx2TextureUpload';
export {
  createInlineKtx2TextureWorkerClient,
  createKtx2TextureWorkerClientFromUrl,
  createKtx2TextureWorkerSource,
  Ktx2TextureWorkerClient,
} from './Ktx2TextureWorkerClient';
export type {
  Ktx2TextureWorker,
  Ktx2TextureWorkerOptions,
  Ktx2TextureWorkerPoolOptions,
} from './Ktx2TextureWorkerClient';

interface ParsedKtx2Texture {
  vkFormat: number;
  width: number;
  height: number;
  depth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  formatInfo: Ktx2FormatInfo;
  levels: Ktx2Level[];
  data: Uint8Array;
  supercompressionScheme: number;
}

interface TranscodedKtx2Texture {
  width: number;
  height: number;
  depth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  formatInfo: Ktx2FormatInfo;
  levels: Array<{
    width: number;
    height: number;
    depthOrArrayLayers: number;
    data: Uint8Array;
  }>;
}

interface BasisKtx2File {
  startTranscoding(): boolean;
  getLevels(): number;
  getImageLevelInfo(level: number, layer: number, face: number): { alphaFlag: boolean; width: number; height: number };
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, basisFormat: number): number;
  transcodeImage(
    output: Uint8Array,
    level: number,
    layer: number,
    face: number,
    basisFormat: number,
    decodeFlags: number,
    channel0: number,
    channel1: number,
  ): boolean;
  close(): void;
  delete(): void;
}

interface BasisKtx2Module {
  KTX2File: new (data: Uint8Array) => BasisKtx2File;
  LowLevelETC1SImageTranscoder?: (new () => {
    decodePalettes(endpointCount: number, endpointData: Uint8Array, selectorCount: number, selectorData: Uint8Array): boolean;
    decodeTables(tableData: Uint8Array): boolean;
    transcodeImage(
      targetFormat: number,
      output: Uint8Array,
      outputSizeInBlocksOrPixels: number,
      compressedData: Uint8Array,
      numBlocksX: number,
      numBlocksY: number,
      origWidth: number,
      origHeight: number,
      levelIndex: number,
      rgbOffset: number,
      rgbLength: number,
      alphaOffset: number,
      alphaLength: number,
      decodeFlags: number,
      basisFileHasAlphaSlices: boolean,
      isVideo: boolean,
      outputRowPitchInBlocksOrPixels: number,
      outputRowsInPixels: number,
    ): boolean;
    delete?(): void;
  }) | undefined;
  transcodeUASTCImage?: ((
    targetFormat: number,
    output: Uint8Array,
    outputSizeInBlocksOrPixels: number,
    compressedData: Uint8Array,
    srcNumBlocksX: number,
    srcNumBlocksY: number,
    origWidth: number,
    origHeight: number,
    levelIndex: number,
    sliceOffset: number,
    sliceLength: number,
    decodeFlags: number,
    hasAlpha: boolean,
    isVideo: boolean,
    outputRowPitchInBlocksOrPixels: number,
    outputRowsInPixels: number,
    channel0: number,
    channel1: number,
  ) => boolean) | undefined;
}

interface TranscodedBasisImage {
  data: Uint8Array;
  width: number;
  height: number;
}

interface Etc1sImageDesc {
  flags: number;
  rgbOffset: number;
  rgbLength: number;
  alphaOffset: number;
  alphaLength: number;
}

interface Etc1sSupercompressionGlobalData {
  endpointCount: number;
  selectorCount: number;
  endpointData: Uint8Array;
  selectorData: Uint8Array;
  tableData: Uint8Array;
  imageDescs: Etc1sImageDesc[];
  hasAlphaSlices: boolean;
}

export interface Ktx2SupercompressionDecoder {
  scheme: number;
  name?: string;
  decode(data: Uint8Array, uncompressedByteLength: number, level: number, label: string): Uint8Array | Promise<Uint8Array>;
}

export interface Ktx2TextureLoaderOptions {
  /**
   * CDN root used by loaders.gl to fetch Basis Universal WASM support files.
   * BasisLZ KTX2 currently uses loaders.gl's KTX2-capable basis_encoder module.
   * Set to null to disable CDN loading and rely on loaders.gl local/module options.
   */
  basisTranscoderCDN?: string | null;
  /** Explicit, same-origin Basis Universal script used instead of CDN discovery. */
  basisEncoderScriptUrl?: string;
  /** Explicit, same-origin Basis Universal WASM used instead of CDN discovery. */
  basisEncoderWasmUrl?: string;
  /**
   * Optional decoders for supercompression schemes that are not built into the
   * engine, such as Zstandard. Decoder output must contain the uncompressed KTX2
   * level payload for GPU-native textures.
   */
  supercompressionDecoders?: readonly Ktx2SupercompressionDecoder[];
  /**
   * Optional preloaded Basis Universal encoder module. Supplying this avoids
   * runtime script/wasm loading and enables offline/browser-controlled hosting.
   */
  basisEncoderModule?: BasisKtx2Module;
  /**
   * Optional worker-side KTX2 payload preparer. When present, fetched KTX2 bytes
   * are transferred to the worker for parse/transcode/decompression; the main
   * thread only creates the GPUTexture and uploads the returned payload.
   */
  textureWorker?: Ktx2TextureWorker | null;
  /** Optional cold-load phase observer used by asset performance gates and tooling. */
  diagnostics?: {
    onPhase?(event: Ktx2TexturePhaseEvent): void;
  };
}

export interface Ktx2TexturePhaseEvent {
  readonly label: string;
  readonly phase: 'fetch' | 'decode-transcode' | 'gpu-upload';
  readonly startedAt: number;
  readonly endedAt: number;
  readonly bytes: number;
}

export interface Ktx2TextureInfo {
  vkFormat: number;
  width: number;
  height: number;
  depth: number;
  layers: number;
  faces: number;
  levels: number;
  dimension: '2d' | '2d-array' | 'cube' | 'cube-array' | '3d';
  supercompression: 'none' | 'basisLz' | 'zstd' | 'zlib' | `scheme-${number}`;
  gpuFormat: GPUTextureFormat | null;
  requiredFeature: GPUFeatureName | null;
  uploadPath: 'gpu-native' | 'basis-transcode' | 'unsupported';
  supportedByBuiltInLoader: boolean;
  unsupportedReason?: string | undefined;
}

export function createKtx2TextureLoader(options: Ktx2TextureLoaderOptions = {}): AssetLoaderRegistration<GPUTexture> {
  const textureOwners = new WeakMap<GPUTexture, {
    device: GPUDevice;
    tracker?: import('../core/GPUResourceTracker').GPUResourceTracker | undefined;
    gpuCache: BudgetedAssetCache;
    gpuCacheKey: string;
  }>();
  return {
    type: 'texture/ktx2',
    extensions: ['.ktx2'],
    mimeTypes: ['image/ktx2'],
    aliases: ['ktx2'],
    async load(url, context) {
      context.setPhase('loading');
      const networkKey = `network:ktx2:${url}`;
      let buffer = context.cache.network.get(networkKey) as ArrayBuffer | undefined;
      if (!buffer) {
        const fetchStartedAt = nowMilliseconds();
        buffer = context.worker
          ? await context.worker.fetchArrayBuffer(url, { signal: context.signal })
          : await fetchKtx2ArrayBuffer(url, context.signal);
        reportKtx2Phase(options, url, 'fetch', fetchStartedAt, buffer.byteLength);
        context.cache.network.set(networkKey, buffer, buffer.byteLength);
      }
      context.reportProgress(buffer.byteLength, buffer.byteLength);
      if (context.signal.aborted) throw context.signal.reason;
      context.setPhase('parsing');
      const parsedKey = `parsed:ktx2:${url}:${[...context.device.features].sort().join(',')}`;
      let payload = context.cache.parsed.get(parsedKey) as Ktx2TexturePayload | undefined;
      if (!payload) {
        const prepareStartedAt = nowMilliseconds();
        payload = await parseAssetWorkerFirst({
          parser: {
            type: 'texture/ktx2',
            parse: input => prepareKtx2TexturePayload(context.device.features, input, url, options),
          },
          input: buffer,
          context: { signal: context.signal, source: url },
          worker: options.textureWorker
            ? input => options.textureWorker!.prepareTexturePayload(
                input.slice(0),
                url,
                [...context.device.features],
                getKtx2TextureWorkerOptions(options),
                context.signal,
              )
            : null,
        });
        reportKtx2Phase(options, url, 'decode-transcode', prepareStartedAt, getKtx2PayloadBytes(payload));
        context.cache.parsed.set(parsedKey, payload, getKtx2PayloadBytes(payload));
      }
      if (context.signal.aborted) throw context.signal.reason;
      context.setPhase('uploading');
      const uploadStartedAt = nowMilliseconds();
      const texture = await uploadPreparedKtx2TextureBudgeted(context, payload, url);
      reportKtx2Phase(options, url, 'gpu-upload', uploadStartedAt, getKtx2PayloadBytes(payload));
      const gpuCacheKey = `gpu:ktx2:${url}`;
      const gpuCache = context.cache.forDevice(context.device);
      gpuCache.set(gpuCacheKey, texture, getKtx2PayloadBytes(payload), { retain: true });
      textureOwners.set(texture, { device: context.device, tracker: context.tracker, gpuCache, gpuCacheKey });
      return texture;
    },
    dispose(texture) {
      const owner = textureOwners.get(texture);
      owner?.gpuCache.delete(owner.gpuCacheKey);
      owner?.tracker?.untrackTexture(texture);
      const device = owner?.device;
      if (!device) {
        texture.destroy();
        return;
      }
      void device.queue.onSubmittedWorkDone()
        .then(() => texture.destroy())
        .catch(() => {
          try {
            texture.destroy();
          } catch {
            // Device may already be lost/destroyed during teardown.
          }
        });
    },
  };
}

function reportKtx2Phase(
  options: Ktx2TextureLoaderOptions,
  label: string,
  phase: Ktx2TexturePhaseEvent['phase'],
  startedAt: number,
  bytes: number,
): void {
  options.diagnostics?.onPhase?.(Object.freeze({
    label,
    phase,
    startedAt,
    endedAt: nowMilliseconds(),
    bytes,
  }));
}

const nowMilliseconds = monotonicNow;

function getKtx2PayloadBytes(payload: Ktx2TexturePayload): number {
  return payload.levels.reduce((total, level) => total + level.data.byteLength, 0);
}

function getKtx2TextureWorkerOptions(options: Ktx2TextureLoaderOptions): Ktx2TextureWorkerOptions {
  return {
    basisTranscoderCDN: options.basisTranscoderCDN,
    basisEncoderScriptUrl: options.basisEncoderScriptUrl,
    basisEncoderWasmUrl: options.basisEncoderWasmUrl,
  };
}

async function fetchKtx2ArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `Failed to load KTX2 texture "${url}": ${response.status} ${response.statusText}`,
      {
        hint: 'Check the KTX2 URL, server response, and CORS headers.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }
  return response.arrayBuffer();
}

export async function uploadKtx2Texture(
  device: GPUDevice,
  buffer: ArrayBuffer,
  label = 'KTX2Texture',
  tracker?: import('../core/GPUResourceTracker').GPUResourceTracker,
  options: Ktx2TextureLoaderOptions = {},
): Promise<GPUTexture> {
  const payload = await prepareKtx2TexturePayload(device.features, buffer, label, options);
  return uploadPreparedKtx2Texture(device, payload, label, tracker);
}

export async function prepareKtx2TexturePayload(
  deviceFeatures: ReadonlySet<string> | readonly string[],
  buffer: ArrayBuffer,
  label = 'KTX2Texture',
  options: Ktx2TextureLoaderOptions = {},
): Promise<Ktx2TexturePayload> {
  const parsed = parseKtx2(buffer, label, options);
  if (parsed.vkFormat === 0 || parsed.supercompressionScheme === KTX2_SUPERCOMPRESSION_BASIS_LZ) {
    return transcodedKtx2ToPayload(await transcodeBasisKtx2(deviceFeatures, parsed, buffer, label, options));
  }
  const { width, height, levelCount, formatInfo } = parsed;
  const arrayLayerCount = parsed.layerCount * parsed.faceCount;
  const isTexture3D = parsed.depth > 0;
  if (formatInfo.feature && !hasGpuFeature(deviceFeatures, formatInfo.feature)) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `KTX2 texture "${label}" requires WebGPU feature "${formatInfo.feature}".`,
      {
        hint: 'Create the engine on an adapter that supports the compressed texture feature, or provide an uncompressed fallback texture.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }

  const levels: Ktx2TexturePayload['levels'] = [];
  for (const [level, levelInfo] of parsed.levels.entries()) {
    const mipWidth = Math.max(1, width >> level);
    const mipHeight = Math.max(1, height >> level);
    const mipDepthOrLayers = isTexture3D ? Math.max(1, parsed.depth >> level) : arrayLayerCount;
    levels.push({
      width: mipWidth,
      height: mipHeight,
      depthOrArrayLayers: mipDepthOrLayers,
      data: await getUploadLevelBytes(parsed, levelInfo, formatInfo, mipWidth, mipHeight, mipDepthOrLayers, label, options),
    });
  }
  return {
    width,
    height,
    depth: parsed.depth,
    layerCount: parsed.layerCount,
    faceCount: parsed.faceCount,
    levelCount,
    format: formatInfo.format,
    blockWidth: formatInfo.blockWidth,
    blockHeight: formatInfo.blockHeight,
    bytesPerBlock: formatInfo.bytesPerBlock,
    requiredFeature: formatInfo.feature,
    uploadPath: 'gpu-native',
    levels,
  };
}

function transcodedKtx2ToPayload(transcoded: TranscodedKtx2Texture): Ktx2TexturePayload {
  const { formatInfo } = transcoded;
  return {
    width: transcoded.width,
    height: transcoded.height,
    depth: transcoded.depth,
    layerCount: transcoded.layerCount,
    faceCount: transcoded.faceCount,
    levelCount: transcoded.levelCount,
    format: formatInfo.format,
    blockWidth: formatInfo.blockWidth,
    blockHeight: formatInfo.blockHeight,
    bytesPerBlock: formatInfo.bytesPerBlock,
    requiredFeature: formatInfo.feature,
    uploadPath: 'basis-transcode',
    levels: transcoded.levels,
  };
}

function uploadTranscodedKtx2Texture(
  device: GPUDevice,
  transcoded: TranscodedKtx2Texture,
  label: string,
  tracker?: import('../core/GPUResourceTracker').GPUResourceTracker,
): GPUTexture {
  const { width, height, depth, layerCount, faceCount, levelCount, formatInfo } = transcoded;
  const isTexture3D = depth > 0;
  const arrayLayerCount = layerCount * faceCount;
  const texture = device.createTexture({
    label,
    size: [width, height, isTexture3D ? depth : arrayLayerCount],
    dimension: isTexture3D ? '3d' : '2d',
    mipLevelCount: levelCount,
    format: formatInfo.format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const payloadBytes = transcoded.levels.reduce((total, level) => total + level.data.byteLength, 0);
  tracker?.trackTexture(texture, `AssetManager.ktx2.transcoded:${formatInfo.format}`, payloadBytes);

  const encoder = device.createCommandEncoder({ label: `${label}.basisUpload` });
  const stagingBuffers: GPUBuffer[] = [];
  for (const [level, levelInfo] of transcoded.levels.entries()) {
    const blocksX = Math.ceil(levelInfo.width / formatInfo.blockWidth);
    const blocksY = Math.ceil(levelInfo.height / formatInfo.blockHeight);
    const bytesPerRow = blocksX * formatInfo.bytesPerBlock;
    const alignedBytesPerRow = alignUp(bytesPerRow, 256);
    const stagingSize = alignedBytesPerRow * blocksY * levelInfo.depthOrArrayLayers;
    const staging = device.createBuffer({
      label: `${label}.basisUpload.level${level}`,
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
        width: blocksX * formatInfo.blockWidth,
        height: blocksY * formatInfo.blockHeight,
        depthOrArrayLayers: levelInfo.depthOrArrayLayers,
      },
    );
  }
  device.queue.submit([encoder.finish()]);
  void device.queue.onSubmittedWorkDone().then(() => {
    for (const buffer of stagingBuffers) buffer.destroy();
  });
  return texture;
}

export function inspectKtx2Texture(buffer: ArrayBuffer, label = 'KTX2Texture'): Ktx2TextureInfo {
  const header = readKtx2Header(buffer, label);
  const effectiveLayers = header.layerCount || 1;
  const formatInfo = mapVkFormat(header.vkFormat);
  const dimension = getKtx2Dimension(header.pixelDepth, effectiveLayers, header.faceCount);
  const supercompression = getKtx2SupercompressionName(header.supercompressionScheme);
  const isBasis = header.vkFormat === 0 || header.supercompressionScheme === KTX2_SUPERCOMPRESSION_BASIS_LZ;
  let uploadPath: Ktx2TextureInfo['uploadPath'] = formatInfo ? 'gpu-native' : 'unsupported';
  let unsupportedReason: string | undefined;

  if (isBasis) {
    uploadPath = 'basis-transcode';
  } else if (!formatInfo) {
    unsupportedReason = `Unsupported KTX2 vkFormat ${header.vkFormat}.`;
  } else if (
    header.supercompressionScheme !== KTX2_SUPERCOMPRESSION_NONE &&
    header.supercompressionScheme !== KTX2_SUPERCOMPRESSION_ZLIB
  ) {
    unsupportedReason = `GPU-native KTX2 supercompression ${supercompression} needs a custom decoder.`;
  }

  return {
    vkFormat: header.vkFormat,
    width: header.pixelWidth,
    height: header.pixelHeight || 1,
    depth: header.pixelDepth,
    layers: effectiveLayers,
    faces: header.faceCount,
    levels: header.levelCount,
    dimension,
    supercompression,
    gpuFormat: isBasis ? null : formatInfo?.format ?? null,
    requiredFeature: isBasis ? null : formatInfo?.feature ?? null,
    uploadPath,
    supportedByBuiltInLoader: !unsupportedReason,
    unsupportedReason,
  };
}

function parseKtx2(buffer: ArrayBuffer, label: string, options: Ktx2TextureLoaderOptions = {}): ParsedKtx2Texture {
  const { header, levels } = parseKtx2Container(buffer, label);
  const {
    data,
    vkFormat,
    pixelWidth,
    pixelHeight,
    pixelDepth,
    layerCount,
    faceCount,
    levelCount,
    supercompressionScheme,
  } = header;

  const effectiveLayerCount = layerCount || 1;
  validateSupercompression(vkFormat, supercompressionScheme, label, options);

  const formatInfo = mapVkFormat(vkFormat);
  if (!formatInfo) {
    if (vkFormat === 0 && (
      supercompressionScheme === KTX2_SUPERCOMPRESSION_NONE ||
      supercompressionScheme === KTX2_SUPERCOMPRESSION_BASIS_LZ ||
      supercompressionScheme === KTX2_SUPERCOMPRESSION_ZSTD
    )) {
      return {
        vkFormat,
        width: pixelWidth,
        height: pixelHeight || 1,
        depth: pixelDepth,
        layerCount: effectiveLayerCount,
        faceCount,
        levelCount,
        formatInfo: { format: 'rgba8unorm', blockWidth: 1, blockHeight: 1, bytesPerBlock: 4 },
        levels,
        data,
        supercompressionScheme,
      };
    }
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `Unsupported KTX2 vkFormat ${vkFormat} in "${label}".`,
      {
        hint: 'Use a WebGPU-compatible BC/ETC2/ASTC KTX2 format or register a custom texture loader.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }

  return {
    vkFormat,
    width: pixelWidth,
    height: pixelHeight || 1,
    depth: pixelDepth,
    layerCount: effectiveLayerCount,
    faceCount,
    levelCount,
    formatInfo,
    levels,
    data,
    supercompressionScheme,
  };
}

function getSupercompressionDecoder(
  supercompressionScheme: number,
  options: Ktx2TextureLoaderOptions,
): Ktx2SupercompressionDecoder | undefined {
  return options.supercompressionDecoders?.find(decoder => decoder.scheme === supercompressionScheme);
}

function validateSupercompression(
  vkFormat: number,
  supercompressionScheme: number,
  label: string,
  options: Ktx2TextureLoaderOptions,
): void {
  if (
    supercompressionScheme === KTX2_SUPERCOMPRESSION_NONE ||
    supercompressionScheme === KTX2_SUPERCOMPRESSION_BASIS_LZ ||
    supercompressionScheme === KTX2_SUPERCOMPRESSION_ZLIB ||
    (vkFormat === 0 && supercompressionScheme === KTX2_SUPERCOMPRESSION_ZSTD) ||
    getSupercompressionDecoder(supercompressionScheme, options)
  ) {
    return;
  }
  const name = getKtx2SupercompressionName(supercompressionScheme);
  throw new EngineError(
    EngineErrorCode.AssetLoadFailed,
    `Unsupported KTX2 supercompression ${name} in "${label}".`,
    {
      hint: 'This KTX2 supercompression method is not built in. Register a custom texture/ktx2 loader or convert the texture to GPU-native/zlib/BasisLZ KTX2.',
      docsPath: 'errors/E_ASSET_LOAD_FAILED',
    },
  );
}

async function transcodeBasisKtx2(
  deviceFeatures: ReadonlySet<string> | readonly string[],
  parsed: ParsedKtx2Texture,
  buffer: ArrayBuffer,
  label: string,
  options: Ktx2TextureLoaderOptions,
): Promise<TranscodedKtx2Texture> {
  try {
    const module = await loadBasisKtx2Module(options);
    if (isBasisLzVolume(parsed)) return transcodeBasisLzEtc1sVolume(module, parsed);
    if (isRawUastcVolume(parsed)) return transcodeRawUastcVolume(module, parsed);
    const ktx2File = new module.KTX2File(new Uint8Array(buffer));
    try {
      if (!ktx2File.startTranscoding()) throw new Error('Basis transcoder failed to start KTX2 transcoding.');
      return transcodeBasisKtx2File(deviceFeatures, ktx2File, parsed);
    } finally {
      ktx2File.close();
      ktx2File.delete();
    }
  } catch (error) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `Failed to transcode Basis Universal KTX2 texture "${label}".`,
      {
        cause: error,
        hint: 'Verify the KTX2 file, Basis Universal WASM assets, target GPU compressed texture support, and array/cube/3D layer metadata.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }
}

function transcodeBasisKtx2File(
  deviceFeatures: ReadonlySet<string> | readonly string[],
  ktx2File: BasisKtx2File,
  parsed: ParsedKtx2Texture,
): TranscodedKtx2Texture {
  const levelCount = Math.max(1, Math.min(parsed.levelCount, ktx2File.getLevels()));
  const isTexture3D = parsed.depth > 0;
  let outputOptions: BasisOutputOptions | null = null;
  const levels: TranscodedKtx2Texture['levels'] = [];

  for (let level = 0; level < levelCount; level++) {
    const mipWidth = Math.max(1, parsed.width >> level);
    const mipHeight = Math.max(1, parsed.height >> level);
    const depthOrArrayLayers = isTexture3D ? Math.max(1, parsed.depth >> level) : parsed.layerCount * parsed.faceCount;
    const levelResult: TranscodedBasisImage & { outputOptions: BasisOutputOptions } = isTexture3D
      ? transcodeBasisKtx2VolumeLevel(deviceFeatures, ktx2File, level, mipWidth, mipHeight, depthOrArrayLayers, outputOptions)
      : transcodeBasisKtx2LayeredLevel(deviceFeatures, ktx2File, parsed, level, mipWidth, mipHeight, outputOptions);
    outputOptions = levelResult.outputOptions;
    levels.push({
      width: levelResult.width,
      height: levelResult.height,
      depthOrArrayLayers,
      data: levelResult.data,
    });
  }

  if (!outputOptions) throw new Error('Basis transcoder returned no texture levels.');
  const formatInfo = mapTextureFormat(outputOptions.textureFormat);
  if (!formatInfo) throw new Error(`Unsupported transcoded texture format ${String(outputOptions.textureFormat)}.`);
  if (formatInfo.feature && !hasGpuFeature(deviceFeatures, formatInfo.feature)) {
    throw new Error(`Device does not support transcoded texture feature ${formatInfo.feature}.`);
  }

  const firstLevel = levels[0];
  if (!firstLevel) throw new Error('Basis transcoder returned no texture levels.');
  return {
    width: firstLevel.width,
    height: firstLevel.height,
    depth: parsed.depth,
    layerCount: parsed.layerCount,
    faceCount: parsed.faceCount,
    levelCount: levels.length,
    formatInfo,
    levels,
  };
}

function transcodeBasisKtx2LayeredLevel(
  deviceFeatures: ReadonlySet<string> | readonly string[],
  ktx2File: BasisKtx2File,
  parsed: ParsedKtx2Texture,
  level: number,
  mipWidth: number,
  mipHeight: number,
  outputOptions: BasisOutputOptions | null,
): TranscodedBasisImage & { outputOptions: BasisOutputOptions } {
  const pieces: Uint8Array[] = [];
  let levelBytes = 0;
  let levelWidth = mipWidth;
  let levelHeight = mipHeight;
  let resolvedOptions = outputOptions;

  for (let layer = 0; layer < parsed.layerCount; layer++) {
    for (let face = 0; face < parsed.faceCount; face++) {
      const info = ktx2File.getImageLevelInfo(level, layer, face);
      resolvedOptions ??= selectBasisOutputOptions(deviceFeatures, info.alphaFlag, false);
      const image = transcodeBasisKtx2Image(ktx2File, level, layer, face, resolvedOptions);
      levelWidth = image.width || mipWidth;
      levelHeight = image.height || mipHeight;
      pieces.push(image.data);
      levelBytes += image.data.byteLength;
    }
  }

  const data = new Uint8Array(levelBytes);
  let offset = 0;
  for (const piece of pieces) {
    data.set(piece, offset);
    offset += piece.byteLength;
  }
  if (!resolvedOptions) throw new Error(`Basis transcoder returned no images for level ${level}.`);
  return { data, width: levelWidth, height: levelHeight, outputOptions: resolvedOptions };
}

function transcodeBasisKtx2VolumeLevel(
  deviceFeatures: ReadonlySet<string> | readonly string[],
  ktx2File: BasisKtx2File,
  level: number,
  mipWidth: number,
  mipHeight: number,
  mipDepth: number,
  outputOptions: BasisOutputOptions | null,
): TranscodedBasisImage & { outputOptions: BasisOutputOptions } {
  const firstInfo = ktx2File.getImageLevelInfo(level, 0, 0);
  const resolvedOptions = outputOptions ?? selectBasisOutputOptions(deviceFeatures, firstInfo.alphaFlag, true);
  const formatInfo = mapTextureFormat(resolvedOptions.textureFormat);
  if (!formatInfo) throw new Error(`Unsupported transcoded texture format ${String(resolvedOptions.textureFormat)}.`);
  const expectedBytes = getPackedLevelByteLength(mipWidth, mipHeight, mipDepth, formatInfo);
  const failures: string[] = [];

  const whole = tryTranscodeBasisKtx2Image(ktx2File, level, 0, 0, resolvedOptions, failures);
  if (whole && whole.data.byteLength === expectedBytes) {
    return {
      data: whole.data,
      width: whole.width || mipWidth,
      height: whole.height || mipHeight,
      outputOptions: resolvedOptions,
    };
  }
  if (whole) {
    failures.push(`level ${level} layer 0 face 0 produced ${whole.data.byteLength} bytes, expected ${expectedBytes}.`);
  }

  const layerSlices = tryTranscodeBasisKtx2VolumeSlices(
    ktx2File,
    level,
    mipDepth,
    resolvedOptions,
    expectedBytes,
    'layer',
    failures,
  );
  if (layerSlices) return layerSlices;

  const faceSlices = tryTranscodeBasisKtx2VolumeSlices(
    ktx2File,
    level,
    mipDepth,
    resolvedOptions,
    expectedBytes,
    'face',
    failures,
  );
  if (faceSlices) return faceSlices;

  throw new Error(`Basis transcoder failed for 3D level ${level}. ${failures.join(' ')}`);
}

function tryTranscodeBasisKtx2VolumeSlices(
  ktx2File: BasisKtx2File,
  level: number,
  sliceCount: number,
  outputOptions: BasisOutputOptions,
  expectedBytes: number,
  addressing: 'layer' | 'face',
  failures: string[],
): (TranscodedBasisImage & { outputOptions: BasisOutputOptions }) | null {
  const pieces: Uint8Array[] = [];
  let totalBytes = 0;
  let width = 0;
  let height = 0;
  for (let slice = 0; slice < sliceCount; slice++) {
    const layer = addressing === 'layer' ? slice : 0;
    const face = addressing === 'face' ? slice : 0;
    const image = tryTranscodeBasisKtx2Image(ktx2File, level, layer, face, outputOptions, failures);
    if (!image) return null;
    width ||= image.width;
    height ||= image.height;
    pieces.push(image.data);
    totalBytes += image.data.byteLength;
  }
  if (totalBytes !== expectedBytes) {
    failures.push(`3D ${addressing}-slice path produced ${totalBytes} bytes, expected ${expectedBytes}.`);
    return null;
  }
  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const piece of pieces) {
    data.set(piece, offset);
    offset += piece.byteLength;
  }
  return { data, width, height, outputOptions };
}

function transcodeBasisKtx2Image(
  ktx2File: BasisKtx2File,
  level: number,
  layer: number,
  face: number,
  outputOptions: BasisOutputOptions,
): TranscodedBasisImage {
  const info = ktx2File.getImageLevelInfo(level, layer, face);
  const size = ktx2File.getImageTranscodedSizeInBytes(level, layer, face, outputOptions.basisFormat);
  const data = new Uint8Array(size);
  if (!ktx2File.transcodeImage(data, level, layer, face, outputOptions.basisFormat, 0, -1, -1)) {
    throw new Error(`Basis transcoder failed for level ${level}, layer ${layer}, face ${face}.`);
  }
  return { data, width: info.width, height: info.height };
}

function tryTranscodeBasisKtx2Image(
  ktx2File: BasisKtx2File,
  level: number,
  layer: number,
  face: number,
  outputOptions: BasisOutputOptions,
  failures: string[],
): TranscodedBasisImage | null {
  try {
    return transcodeBasisKtx2Image(ktx2File, level, layer, face, outputOptions);
  } catch (error) {
    failures.push(`level ${level} layer ${layer} face ${face}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function getPackedLevelByteLength(width: number, height: number, depthOrArrayLayers: number, formatInfo: Ktx2FormatInfo): number {
  return Math.ceil(width / formatInfo.blockWidth) * Math.ceil(height / formatInfo.blockHeight) * depthOrArrayLayers * formatInfo.bytesPerBlock;
}

function isRawUastcVolume(parsed: ParsedKtx2Texture): boolean {
  return parsed.vkFormat === 0
    && parsed.supercompressionScheme === KTX2_SUPERCOMPRESSION_NONE
    && parsed.depth > 0;
}

function isBasisLzVolume(parsed: ParsedKtx2Texture): boolean {
  if (parsed.vkFormat !== 0 || parsed.supercompressionScheme !== KTX2_SUPERCOMPRESSION_BASIS_LZ || parsed.depth <= 0) {
    return false;
  }
  const view = new DataView(parsed.data.buffer, parsed.data.byteOffset, parsed.data.byteLength);
  const sgdByteOffset = Number(view.getBigUint64(64, true));
  const sgdByteLength = Number(view.getBigUint64(72, true));
  return sgdByteOffset > 0 && sgdByteLength >= 20;
}

function transcodeBasisLzEtc1sVolume(module: BasisKtx2Module, parsed: ParsedKtx2Texture): TranscodedKtx2Texture {
  const Transcoder = module.LowLevelETC1SImageTranscoder;
  if (!Transcoder) {
    throw new Error('Basis module does not expose LowLevelETC1SImageTranscoder required for 3D ETC1S KTX2.');
  }
  const formatInfo = mapTextureFormat('rgba8unorm');
  if (!formatInfo) throw new Error('Internal error: rgba8unorm texture format is not mapped.');
  const sgd = parseEtc1sSupercompressionGlobalData(parsed);
  const transcoder = new Transcoder();
  try {
    if (!transcoder.decodePalettes(sgd.endpointCount, sgd.endpointData, sgd.selectorCount, sgd.selectorData)) {
      throw new Error('ETC1S low-level palette decode failed.');
    }
    if (!transcoder.decodeTables(sgd.tableData)) {
      throw new Error('ETC1S low-level table decode failed.');
    }

    const levels: TranscodedKtx2Texture['levels'] = [];
    let imageDescIndex = 0;
    for (const [level, levelInfo] of parsed.levels.entries()) {
      const mipWidth = Math.max(1, parsed.width >> level);
      const mipHeight = Math.max(1, parsed.height >> level);
      const mipDepth = Math.max(1, parsed.depth >> level);
      const blocksX = Math.ceil(mipWidth / 4);
      const blocksY = Math.ceil(mipHeight / 4);
      const compressedLevel = parsed.data.subarray(levelInfo.offset, levelInfo.offset + levelInfo.length);
      const sliceByteLength = mipWidth * mipHeight * 4;
      const data = new Uint8Array(sliceByteLength * mipDepth);
      for (let slice = 0; slice < mipDepth; slice++) {
        const desc = sgd.imageDescs[imageDescIndex++];
        if (!desc) throw new Error(`Missing ETC1S image descriptor for level ${level}, slice ${slice}.`);
        const output = data.subarray(slice * sliceByteLength, (slice + 1) * sliceByteLength);
        const ok = transcoder.transcodeImage(
          13,
          output,
          mipWidth * mipHeight,
          compressedLevel,
          blocksX,
          blocksY,
          mipWidth,
          mipHeight,
          level,
          desc.rgbOffset,
          desc.rgbLength,
          desc.alphaOffset,
          desc.alphaLength,
          0,
          sgd.hasAlphaSlices,
          false,
          mipWidth,
          mipHeight,
        );
        if (!ok) throw new Error(`ETC1S 3D transcode failed for level ${level}, slice ${slice}.`);
      }
      levels.push({
        width: mipWidth,
        height: mipHeight,
        depthOrArrayLayers: mipDepth,
        data,
      });
    }
    return {
      width: parsed.width,
      height: parsed.height,
      depth: parsed.depth,
      layerCount: parsed.layerCount,
      faceCount: parsed.faceCount,
      levelCount: levels.length,
      formatInfo,
      levels,
    };
  } finally {
    transcoder.delete?.();
  }
}

function parseEtc1sSupercompressionGlobalData(parsed: ParsedKtx2Texture): Etc1sSupercompressionGlobalData {
  const headerView = new DataView(parsed.data.buffer, parsed.data.byteOffset, parsed.data.byteLength);
  const globalOffset = Number(headerView.getBigUint64(64, true));
  const globalLength = Number(headerView.getBigUint64(72, true));
  if (globalOffset <= 0 || globalLength < 20 || globalOffset + globalLength > parsed.data.byteLength) {
    throw new Error('Invalid or missing ETC1S supercompression global data.');
  }
  const globalData = parsed.data.subarray(globalOffset, globalOffset + globalLength);
  const view = new DataView(globalData.buffer, globalData.byteOffset, globalData.byteLength);
  const endpointCount = view.getUint16(0, true);
  const selectorCount = view.getUint16(2, true);
  const endpointsByteLength = view.getUint32(4, true);
  const selectorsByteLength = view.getUint32(8, true);
  const tablesByteLength = view.getUint32(12, true);
  const extendedByteLength = view.getUint32(16, true);
  const imageDescCount = getBasisVolumeImageDescCount(parsed);
  const imageDescByteLength = imageDescCount * 20;
  const endpointOffset = 20 + imageDescByteLength;
  const selectorOffset = endpointOffset + endpointsByteLength;
  const tableOffset = selectorOffset + selectorsByteLength;
  const extendedOffset = tableOffset + tablesByteLength;
  const requiredBytes = extendedOffset + extendedByteLength;
  if (requiredBytes > globalData.byteLength) {
    throw new Error(`Invalid ETC1S supercompression global data length ${globalData.byteLength}, expected at least ${requiredBytes}.`);
  }

  const imageDescs: Etc1sImageDesc[] = [];
  let hasAlphaSlices = false;
  for (let i = 0; i < imageDescCount; i++) {
    const offset = 20 + i * 20;
    const desc = {
      flags: view.getUint32(offset, true),
      rgbOffset: view.getUint32(offset + 4, true),
      rgbLength: view.getUint32(offset + 8, true),
      alphaOffset: view.getUint32(offset + 12, true),
      alphaLength: view.getUint32(offset + 16, true),
    };
    hasAlphaSlices ||= desc.alphaLength > 0;
    imageDescs.push(desc);
  }

  return {
    endpointCount,
    selectorCount,
    endpointData: globalData.subarray(endpointOffset, endpointOffset + endpointsByteLength),
    selectorData: globalData.subarray(selectorOffset, selectorOffset + selectorsByteLength),
    tableData: globalData.subarray(tableOffset, tableOffset + tablesByteLength),
    imageDescs,
    hasAlphaSlices,
  };
}

function getBasisVolumeImageDescCount(parsed: ParsedKtx2Texture): number {
  let count = 0;
  for (let level = 0; level < parsed.levels.length; level++) {
    count += Math.max(1, parsed.depth >> level);
  }
  return count;
}

function transcodeRawUastcVolume(module: BasisKtx2Module, parsed: ParsedKtx2Texture): TranscodedKtx2Texture {
  const transcodeUASTCImage = module.transcodeUASTCImage;
  if (!transcodeUASTCImage) {
    throw new Error('Basis module does not expose low-level transcodeUASTCImage required for raw 3D UASTC KTX2.');
  }

  const formatInfo = mapTextureFormat('rgba8unorm');
  if (!formatInfo) throw new Error('Internal error: rgba8unorm texture format is not mapped.');
  const levels: TranscodedKtx2Texture['levels'] = [];

  for (const [level, levelInfo] of parsed.levels.entries()) {
    const mipWidth = Math.max(1, parsed.width >> level);
    const mipHeight = Math.max(1, parsed.height >> level);
    const mipDepth = Math.max(1, parsed.depth >> level);
    const blocksX = Math.ceil(mipWidth / 4);
    const blocksY = Math.ceil(mipHeight / 4);
    const sliceLength = blocksX * blocksY * 16;
    const requiredLevelBytes = sliceLength * mipDepth;
    if (levelInfo.length < requiredLevelBytes) {
      throw new Error(`Raw UASTC 3D level ${level} has ${levelInfo.length} bytes, expected at least ${requiredLevelBytes}.`);
    }

    const compressedLevel = parsed.data.subarray(levelInfo.offset, levelInfo.offset + levelInfo.length);
    const sliceByteLength = mipWidth * mipHeight * 4;
    const data = new Uint8Array(sliceByteLength * mipDepth);
    for (let slice = 0; slice < mipDepth; slice++) {
      const output = data.subarray(slice * sliceByteLength, (slice + 1) * sliceByteLength);
      const ok = transcodeUASTCImage(
        13,
        output,
        mipWidth * mipHeight,
        compressedLevel,
        blocksX,
        blocksY,
        mipWidth,
        mipHeight,
        level,
        slice * sliceLength,
        sliceLength,
        0,
        true,
        false,
        mipWidth,
        mipHeight,
        -1,
        -1,
      );
      if (!ok) throw new Error(`Raw UASTC 3D transcode failed for level ${level}, slice ${slice}.`);
    }
    levels.push({
      width: mipWidth,
      height: mipHeight,
      depthOrArrayLayers: mipDepth,
      data,
    });
  }

  return {
    width: parsed.width,
    height: parsed.height,
    depth: parsed.depth,
    layerCount: parsed.layerCount,
    faceCount: parsed.faceCount,
    levelCount: levels.length,
    formatInfo,
    levels,
  };
}

const basisKtx2ModulePromises = new Map<string, Promise<BasisKtx2Module>>();

async function loadBasisKtx2Module(options: Ktx2TextureLoaderOptions): Promise<BasisKtx2Module> {
  if (options.basisEncoderModule) return options.basisEncoderModule;
  const cacheKey = [
    options.basisEncoderScriptUrl ?? '',
    options.basisEncoderWasmUrl ?? '',
    options.basisTranscoderCDN === undefined ? 'default' : String(options.basisTranscoderCDN),
  ].join('|');
  try {
    let promise = basisKtx2ModulePromises.get(cacheKey);
    if (!promise) {
      promise = loadBasisEncoderModule(options);
      basisKtx2ModulePromises.set(cacheKey, promise);
    }
    return await promise;
  } catch (error) {
    basisKtx2ModulePromises.delete(cacheKey);
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      'Failed to load Basis Universal KTX2 transcoder.',
      {
        cause: error,
        hint: 'Install @loaders.gl/textures with its Basis encoder WASM assets, host basis_encoder.js/basis_encoder.wasm, or pass basisEncoderModule.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }
}

async function loadBasisEncoderModule(options: Ktx2TextureLoaderOptions): Promise<BasisKtx2Module> {
  const loadOptions = {
    CDN: options.basisTranscoderCDN === undefined
      ? 'https://unpkg.com/@loaders.gl'
      : options.basisTranscoderCDN,
  };
  let basisEncoder: unknown = null;
  let wasmBinary: unknown = null;
  [basisEncoder, wasmBinary] = await Promise.all([
    options.basisEncoderScriptUrl
      ? loadExplicitBasisFactory(options.basisEncoderScriptUrl)
      : loadLibrary('basis_encoder.js', 'textures', loadOptions),
    options.basisEncoderWasmUrl
      ? fetchRequiredArrayBuffer(options.basisEncoderWasmUrl, 'Basis encoder WASM')
      : loadLibrary('basis_encoder.wasm', 'textures', loadOptions),
  ]);
  const factory = basisEncoder || (globalThis as { BASIS?: unknown }).BASIS;
  if (typeof factory !== 'function') throw new Error('Basis encoder module factory is unavailable.');

  return await new Promise<BasisKtx2Module>((resolve, reject) => {
    try {
      void (factory as (options: { wasmBinary?: unknown }) => Promise<unknown>)({ wasmBinary }).then((module) => {
        const basisModule = module as {
          KTX2File?: BasisKtx2Module['KTX2File'];
          LowLevelETC1SImageTranscoder?: BasisKtx2Module['LowLevelETC1SImageTranscoder'];
          transcodeUASTCImage?: BasisKtx2Module['transcodeUASTCImage'];
          initializeBasis?: () => void;
        };
        basisModule.initializeBasis?.();
        if (!basisModule.KTX2File) {
          reject(new Error('Basis encoder module did not expose KTX2File.'));
          return;
        }
        resolve({
          KTX2File: basisModule.KTX2File,
          ...(basisModule.LowLevelETC1SImageTranscoder ? { LowLevelETC1SImageTranscoder: basisModule.LowLevelETC1SImageTranscoder } : {}),
          ...(basisModule.transcodeUASTCImage ? { transcodeUASTCImage: basisModule.transcodeUASTCImage } : {}),
        });
      }, reject);
    } catch (error) {
      reject(error);
    }
  });
}

async function loadExplicitBasisFactory(scriptUrl: string): Promise<unknown> {
  const response = await fetch(scriptUrl);
  if (!response.ok) throw new Error(`Failed to load Basis encoder script "${scriptUrl}": ${response.status}.`);
  const source = await response.text();
  return new Function(
    `${source}\nreturn typeof BASIS === "function" ? BASIS : null;\n//# sourceURL=${scriptUrl}`,
  )();
}

async function fetchRequiredArrayBuffer(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${label} "${url}": ${response.status}.`);
  return await response.arrayBuffer();
}

async function getLevelBytes(parsed: ParsedKtx2Texture, level: Ktx2Level, label: string, options: Ktx2TextureLoaderOptions): Promise<Uint8Array> {
  const compressed = parsed.data.subarray(level.offset, level.offset + level.length);
  if (parsed.supercompressionScheme === KTX2_SUPERCOMPRESSION_NONE) return compressed;
  if (parsed.supercompressionScheme === KTX2_SUPERCOMPRESSION_ZLIB) {
    try {
      const inflated = inflate(compressed);
      if (level.uncompressedLength > 0 && inflated.byteLength !== level.uncompressedLength) {
        throw new Error(`Expected ${level.uncompressedLength} bytes, got ${inflated.byteLength}.`);
      }
      return inflated;
    } catch (error) {
      throw new EngineError(
        EngineErrorCode.AssetLoadFailed,
        `Failed to inflate zlib KTX2 level in "${label}".`,
        {
          cause: error,
          hint: 'Verify the KTX2 level index and zlib-compressed level payload.',
          docsPath: 'errors/E_ASSET_LOAD_FAILED',
        },
      );
    }
  }

  const decoder = getSupercompressionDecoder(parsed.supercompressionScheme, options);
  if (!decoder) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `Unsupported KTX2 supercompression scheme ${parsed.supercompressionScheme} in "${label}".`,
      {
        hint: 'Only uncompressed and zlib-supercompressed GPU-native KTX2 levels can be uploaded by the built-in loader.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }
  try {
    const decoded = await decoder.decode(compressed, level.uncompressedLength, parsed.levels.indexOf(level), label);
    if (level.uncompressedLength > 0 && decoded.byteLength !== level.uncompressedLength) {
      throw new Error(`Expected ${level.uncompressedLength} bytes, got ${decoded.byteLength}.`);
    }
    return decoded;
  } catch (error) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `Failed to decode ${decoder.name ?? getKtx2SupercompressionName(parsed.supercompressionScheme)} KTX2 level in "${label}".`,
      {
        cause: error,
        hint: 'Verify the KTX2 level index, supercompression decoder, and compressed level payload.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }
}

async function getUploadLevelBytes(
  parsed: ParsedKtx2Texture,
  level: Ktx2Level,
  formatInfo: Ktx2FormatInfo,
  width: number,
  height: number,
  layerCount: number,
  label: string,
  options: Ktx2TextureLoaderOptions,
): Promise<Uint8Array> {
  const bytes = await getLevelBytes(parsed, level, label, options);
  if (formatInfo.transform === 'rgb8-to-rgba8') {
    return expandRgb8ToRgba8(bytes, width, height, layerCount, label);
  }
  return bytes;
}

function expandRgb8ToRgba8(source: Uint8Array, width: number, height: number, layerCount: number, label: string): Uint8Array {
  const pixelCount = width * height * layerCount;
  const requiredBytes = pixelCount * 3;
  if (source.byteLength < requiredBytes) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `KTX2 RGB8 level in "${label}" is truncated.`,
      {
        hint: `Expected at least ${requiredBytes} bytes for ${width}x${height}x${layerCount} RGB8 data, got ${source.byteLength}.`,
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }
  const output = new Uint8Array(pixelCount * 4);
  for (let src = 0, dst = 0; dst < output.length; src += 3, dst += 4) {
    output[dst] = source[src] ?? 0;
    output[dst + 1] = source[src + 1] ?? 0;
    output[dst + 2] = source[src + 2] ?? 0;
    output[dst + 3] = 255;
  }
  return output;
}
