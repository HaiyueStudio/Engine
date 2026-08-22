import type { LayoutLimits } from './types.js';

export const DEFAULT_LAYOUT_LIMITS: Readonly<LayoutLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxAssets: 4096,
  maxAssetBytes: 256 * 1024 * 1024,
  maxTotalAssetBytes: 1024 * 1024 * 1024,
  maxArtboards: 8192,
  maxNodes: 250_000,
  maxTextBytes: 32 * 1024 * 1024,
  maxGlyphs: 1_000_000,
  maxLines: 250_000,
  maxLayoutPasses: 64,
  maxNestedDepth: 128,
  maxComponentInstances: 8192,
  maxListItems: 100_000,
  maxVirtualizedWindow: 4096,
  maxNslicePatches: 1_000_000,
  maxGpuBytes: 512 * 1024 * 1024,
});
