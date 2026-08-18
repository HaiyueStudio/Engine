import {
  GPU_FEATURE_TEXTURE_COMPRESSION_ASTC,
  GPU_FEATURE_TEXTURE_COMPRESSION_BC,
  GPU_FEATURE_TEXTURE_COMPRESSION_ETC2,
  hasGpuFeature,
} from '../core/GPUFeatures';

/** GPU upload layout selected for a KTX2 payload. */
export interface Ktx2FormatInfo {
  format: GPUTextureFormat;
  blockWidth: number;
  blockHeight: number;
  bytesPerBlock: number;
  transform?: 'rgb8-to-rgba8';
  feature?: GPUFeatureName;
}

export interface BasisOutputOptions {
  basisFormat: number;
  textureFormat: import('@loaders.gl/schema').TextureFormat;
}

/** Chooses the highest-priority Basis target supported by the active device. */
export function selectBasisOutputOptions(
  deviceFeatures: ReadonlySet<string> | readonly string[],
  hasAlpha: boolean,
  forceUncompressed: boolean,
): BasisOutputOptions {
  if (forceUncompressed) return { basisFormat: 13, textureFormat: 'rgba8unorm' };
  if (hasGpuFeature(deviceFeatures, GPU_FEATURE_TEXTURE_COMPRESSION_ASTC)) {
    return { basisFormat: 10, textureFormat: 'astc-4x4-unorm' };
  }
  if (hasGpuFeature(deviceFeatures, GPU_FEATURE_TEXTURE_COMPRESSION_BC)) {
    return hasAlpha
      ? { basisFormat: 7, textureFormat: 'bc7-rgba-unorm' }
      : { basisFormat: 2, textureFormat: 'bc1-rgba-unorm' };
  }
  if (hasGpuFeature(deviceFeatures, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2)) {
    return { basisFormat: 1, textureFormat: 'etc2-rgba8unorm' };
  }
  return { basisFormat: 13, textureFormat: 'rgba8unorm' };
}

/** Maps the loaders.gl Basis result to a WebGPU block layout. */
export function mapKtx2TextureFormat(textureFormat: string): Ktx2FormatInfo | null {
  switch (textureFormat) {
    case 'rgba8unorm': return { format: 'rgba8unorm', blockWidth: 1, blockHeight: 1, bytesPerBlock: 4 };
    case 'bc1-rgb-unorm-webgl':
    case 'bc1-rgba-unorm': return compressed('bc1-rgba-unorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 'bc1-rgba-unorm-srgb': return compressed('bc1-rgba-unorm-srgb', 8, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 'bc3-rgba-unorm': return compressed('bc3-rgba-unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 'bc3-rgba-unorm-srgb': return compressed('bc3-rgba-unorm-srgb', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 'bc7-rgba-unorm': return compressed('bc7-rgba-unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 'bc7-rgba-unorm-srgb': return compressed('bc7-rgba-unorm-srgb', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 'etc2-rgb8unorm': return compressed('etc2-rgb8unorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 'etc2-rgba8unorm': return compressed('etc2-rgba8unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 'astc-4x4-unorm': return compressed('astc-4x4-unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_ASTC);
    default: return null;
  }
}

/** Maps Vulkan KTX2 format ids to WebGPU formats and feature requirements. */
export function mapKtx2VkFormat(vkFormat: number): Ktx2FormatInfo | null {
  switch (vkFormat) {
    case 9: return plain('r8unorm', 1);
    case 10: return plain('r8snorm', 1);
    case 13: return plain('r8uint', 1);
    case 14: return plain('r8sint', 1);
    case 16: return plain('rg8unorm', 2);
    case 17: return plain('rg8snorm', 2);
    case 20: return plain('rg8uint', 2);
    case 21: return plain('rg8sint', 2);
    case 23: return { ...plain('rgba8unorm', 4), transform: 'rgb8-to-rgba8' };
    case 29: return { ...plain('rgba8unorm-srgb', 4), transform: 'rgb8-to-rgba8' };
    case 37: return plain('rgba8unorm', 4);
    case 38: return plain('rgba8snorm', 4);
    case 41: return plain('rgba8uint', 4);
    case 42: return plain('rgba8sint', 4);
    case 43: return plain('rgba8unorm-srgb', 4);
    case 44: return plain('bgra8unorm', 4);
    case 50: return plain('bgra8unorm-srgb', 4);
    case 64: return plain('rgb10a2unorm', 4);
    case 81: return plain('rg16uint', 4);
    case 82: return plain('rg16sint', 4);
    case 83: return plain('rg16float', 4);
    case 91: return plain('rgba16unorm', 8);
    case 92: return plain('rgba16snorm', 8);
    case 95: return plain('rgba16uint', 8);
    case 96: return plain('rgba16sint', 8);
    case 97: return plain('rgba16float', 8);
    case 107: return plain('rgba32uint', 16);
    case 108: return plain('rgba32sint', 16);
    case 109: return plain('rgba32float', 16);
    case 122: return plain('rg11b10ufloat', 4);
    case 123: return plain('rgb9e5ufloat', 4);
    case 131:
    case 133: return compressed('bc1-rgba-unorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 132:
    case 134: return compressed('bc1-rgba-unorm-srgb', 8, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 135: return compressed('bc2-rgba-unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 136: return compressed('bc2-rgba-unorm-srgb', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 137: return compressed('bc3-rgba-unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 138: return compressed('bc3-rgba-unorm-srgb', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 139: return compressed('bc4-r-unorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 140: return compressed('bc4-r-snorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 141: return compressed('bc5-rg-unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 142: return compressed('bc5-rg-snorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 143: return compressed('bc6h-rgb-ufloat', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 144: return compressed('bc6h-rgb-float', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 145: return compressed('bc7-rgba-unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 146: return compressed('bc7-rgba-unorm-srgb', 16, GPU_FEATURE_TEXTURE_COMPRESSION_BC);
    case 147: return compressed('etc2-rgb8unorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 148: return compressed('etc2-rgb8unorm-srgb', 8, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 149: return compressed('etc2-rgb8a1unorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 150: return compressed('etc2-rgb8a1unorm-srgb', 8, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 151: return compressed('etc2-rgba8unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 152: return compressed('etc2-rgba8unorm-srgb', 16, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 153: return compressed('eac-r11unorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 154: return compressed('eac-r11snorm', 8, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 155: return compressed('eac-rg11unorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    case 156: return compressed('eac-rg11snorm', 16, GPU_FEATURE_TEXTURE_COMPRESSION_ETC2);
    default: return mapAstcVkFormat(vkFormat);
  }
}

function plain(format: GPUTextureFormat, bytesPerBlock: number): Ktx2FormatInfo {
  return { format, blockWidth: 1, blockHeight: 1, bytesPerBlock };
}

function compressed(
  format: GPUTextureFormat,
  bytesPerBlock: number,
  feature: GPUFeatureName,
): Ktx2FormatInfo {
  return { format, blockWidth: 4, blockHeight: 4, bytesPerBlock, feature };
}

function mapAstcVkFormat(vkFormat: number): Ktx2FormatInfo | null {
  const astc: Record<number, [GPUTextureFormat, number, number]> = {
    157: ['astc-4x4-unorm', 4, 4], 158: ['astc-4x4-unorm-srgb', 4, 4],
    159: ['astc-5x4-unorm', 5, 4], 160: ['astc-5x4-unorm-srgb', 5, 4],
    161: ['astc-5x5-unorm', 5, 5], 162: ['astc-5x5-unorm-srgb', 5, 5],
    163: ['astc-6x5-unorm', 6, 5], 164: ['astc-6x5-unorm-srgb', 6, 5],
    165: ['astc-6x6-unorm', 6, 6], 166: ['astc-6x6-unorm-srgb', 6, 6],
    167: ['astc-8x5-unorm', 8, 5], 168: ['astc-8x5-unorm-srgb', 8, 5],
    169: ['astc-8x6-unorm', 8, 6], 170: ['astc-8x6-unorm-srgb', 8, 6],
    171: ['astc-8x8-unorm', 8, 8], 172: ['astc-8x8-unorm-srgb', 8, 8],
    173: ['astc-10x5-unorm', 10, 5], 174: ['astc-10x5-unorm-srgb', 10, 5],
    175: ['astc-10x6-unorm', 10, 6], 176: ['astc-10x6-unorm-srgb', 10, 6],
    177: ['astc-10x8-unorm', 10, 8], 178: ['astc-10x8-unorm-srgb', 10, 8],
    179: ['astc-10x10-unorm', 10, 10], 180: ['astc-10x10-unorm-srgb', 10, 10],
    181: ['astc-12x10-unorm', 12, 10], 182: ['astc-12x10-unorm-srgb', 12, 10],
    183: ['astc-12x12-unorm', 12, 12], 184: ['astc-12x12-unorm-srgb', 12, 12],
  };
  const info = astc[vkFormat];
  return info ? {
    format: info[0],
    blockWidth: info[1],
    blockHeight: info[2],
    bytesPerBlock: 16,
    feature: GPU_FEATURE_TEXTURE_COMPRESSION_ASTC,
  } : null;
}
