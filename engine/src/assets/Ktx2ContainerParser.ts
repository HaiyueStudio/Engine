import { EngineError, EngineErrorCode } from '../core/EngineError';

export const KTX2_SUPERCOMPRESSION_NONE = 0;
export const KTX2_SUPERCOMPRESSION_BASIS_LZ = 1;
export const KTX2_SUPERCOMPRESSION_ZSTD = 2;
export const KTX2_SUPERCOMPRESSION_ZLIB = 3;

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

export interface Ktx2Level {
  offset: number;
  length: number;
  uncompressedLength: number;
}

export interface Ktx2Header {
  data: Uint8Array;
  view: DataView;
  vkFormat: number;
  pixelWidth: number;
  pixelHeight: number;
  pixelDepth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  supercompressionScheme: number;
}

export interface Ktx2Container {
  header: Ktx2Header;
  levels: Ktx2Level[];
}

export function readKtx2Header(buffer: ArrayBuffer, label: string): Ktx2Header {
  const data = new Uint8Array(buffer);
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) {
    if (data[i] !== KTX2_IDENTIFIER[i]) {
      throw new EngineError(
        EngineErrorCode.AssetLoadFailed,
        `Invalid KTX2 texture "${label}".`,
        {
          hint: 'Expected a KTX2 file with the standard identifier.',
          docsPath: 'errors/E_ASSET_LOAD_FAILED',
        },
      );
    }
  }

  const view = new DataView(buffer);
  return {
    data,
    view,
    vkFormat: view.getUint32(12, true),
    pixelWidth: view.getUint32(20, true),
    pixelHeight: view.getUint32(24, true),
    pixelDepth: view.getUint32(28, true),
    layerCount: view.getUint32(32, true),
    faceCount: view.getUint32(36, true),
    levelCount: view.getUint32(40, true) || 1,
    supercompressionScheme: view.getUint32(44, true),
  };
}

/** Parses and shape-validates the KTX2 container without selecting a GPU format. */
export function parseKtx2Container(buffer: ArrayBuffer, label: string): Ktx2Container {
  const header = readKtx2Header(buffer, label);
  const { faceCount, pixelDepth, layerCount, levelCount, view } = header;
  if (
    faceCount < 1
    || (faceCount !== 1 && faceCount !== 6)
    || (pixelDepth > 0 && (layerCount > 0 || faceCount !== 1))
  ) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `Unsupported KTX2 texture shape "${label}".`,
      {
        hint: 'The built-in KTX2 loader currently supports 2D, 2D array, cubemap, cubemap array, and 3D textures. 3D array/cubemap combinations are not supported.',
        docsPath: 'errors/E_ASSET_LOAD_FAILED',
      },
    );
  }

  const levels: Ktx2Level[] = [];
  let levelIndexOffset = 80;
  for (let level = 0; level < levelCount; level++) {
    levels.push({
      offset: Number(view.getBigUint64(levelIndexOffset, true)),
      length: Number(view.getBigUint64(levelIndexOffset + 8, true)),
      uncompressedLength: Number(view.getBigUint64(levelIndexOffset + 16, true)),
    });
    levelIndexOffset += 24;
  }
  return { header, levels };
}

export function getKtx2Dimension(
  depth: number,
  layers: number,
  faces: number,
): '2d' | '2d-array' | 'cube' | 'cube-array' | '3d' {
  if (depth > 0) return '3d';
  if (faces === 6) return layers > 1 ? 'cube-array' : 'cube';
  return layers > 1 ? '2d-array' : '2d';
}

export function getKtx2SupercompressionName(
  scheme: number,
): 'none' | 'basisLz' | 'zstd' | 'zlib' | `scheme-${number}` {
  if (scheme === KTX2_SUPERCOMPRESSION_NONE) return 'none';
  if (scheme === KTX2_SUPERCOMPRESSION_BASIS_LZ) return 'basisLz';
  if (scheme === KTX2_SUPERCOMPRESSION_ZSTD) return 'zstd';
  if (scheme === KTX2_SUPERCOMPRESSION_ZLIB) return 'zlib';
  return `scheme-${scheme}`;
}
