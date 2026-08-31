export type IndexedSpritePlaneFormat = 'indexed8' | 'rgb8' | 'rgba8';
export type IndexedSpriteSampling = 'nearest' | 'linear';
export type IndexedSpriteBlend = 'alpha' | 'additive' | 'opaque';

export interface IndexedSpritePlaneDescriptor {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly format: IndexedSpritePlaneFormat;
  readonly pixels: Uint8Array;
}

export interface IndexedSpritePaletteDescriptor {
  readonly id: string;
  readonly colorCount: number;
  readonly rgba: Uint8Array;
}

export interface IndexedSpriteAtlasLimits {
  readonly maxTextureDimension2D: number;
  readonly maxAtlasPages: number;
  readonly maxGpuBytes: number;
  readonly maxPaletteGpuBytes: number;
  readonly maxUploadBytesPerFrame: number;
  readonly maxDrawCommandsPerFrame: number;
}

export const DEFAULT_INDEXED_SPRITE_ATLAS_LIMITS: IndexedSpriteAtlasLimits = Object.freeze({
  maxTextureDimension2D: 8_192,
  maxAtlasPages: 64,
  maxGpuBytes: 536_870_912,
  maxPaletteGpuBytes: 16_777_216,
  maxUploadBytesPerFrame: 16_777_216,
  maxDrawCommandsPerFrame: 16_384,
});

export interface IndexedSpriteAtlasPlacement {
  readonly spriteId: string;
  readonly pageIndex: number;
  readonly pageKind: 'indexed' | 'color';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface IndexedSpriteAtlasPage {
  readonly index: number;
  readonly kind: 'indexed' | 'color';
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: 1 | 4;
  readonly pixels: Uint8Array;
}

export interface IndexedSpriteAtlasLayout {
  readonly pages: readonly IndexedSpriteAtlasPage[];
  readonly placements: ReadonlyMap<string, IndexedSpriteAtlasPlacement>;
  readonly paletteRows: ReadonlyMap<string, number>;
  readonly paletteWidth: 256;
  readonly paletteHeight: number;
  readonly palettePixels: Uint8Array;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
}

export interface IndexedSpriteDrawCommand {
  readonly spriteId: string;
  readonly paletteId?: string;
  readonly x: number;
  readonly y: number;
  readonly axisX?: number;
  readonly axisY?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly rotationRadians?: number;
  readonly opacity?: number;
  readonly tint?: readonly [number, number, number, number];
  readonly flipX?: boolean;
  readonly flipY?: boolean;
  readonly sampling?: IndexedSpriteSampling;
  readonly blend?: IndexedSpriteBlend;
  readonly priority?: number;
  readonly depth?: number;
}

export interface IndexedSpriteRendererStats {
  readonly pageCount: number;
  readonly indexedPageCount: number;
  readonly colorPageCount: number;
  readonly paletteCount: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly uploadedBytes: number;
  readonly pendingUploadBytes: number;
  readonly textureCount: number;
  readonly drawCommands: number;
  readonly drawCalls: number;
  readonly batches: number;
  readonly generation: number;
  readonly ready: boolean;
  readonly disposed: boolean;
}
