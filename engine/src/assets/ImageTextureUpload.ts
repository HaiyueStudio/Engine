import { estimateTextureBytes } from '../core/GPUResourceTracker';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { getBuiltinSpecializedRenderingShader } from '../shader/BuiltinSpecializedRenderingShader';

export type TextureMipmapMode = 'none' | 'generate';

export interface ImageTextureUploadResult {
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly estimatedBytes: number;
}

const MIPMAP_RENDERABLE_FORMATS = new Set<GPUTextureFormat>([
  'r8unorm',
  'rg8unorm',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'bgra8unorm',
  'bgra8unorm-srgb',
]);

const cacheByDevice = new WeakMap<GPUDevice, {
  sampler: GPUSampler;
  pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
}>();

export function uploadImageTexture(
  device: GPUDevice,
  source: ImageBitmap | HTMLCanvasElement | HTMLImageElement,
  format: GPUTextureFormat,
  mipmaps: TextureMipmapMode,
  label?: string,
  premultipliedAlpha = false,
): ImageTextureUploadResult {
  const width = Math.max(1, isHtmlImageElement(source) ? source.naturalWidth || source.width : source.width);
  const height = Math.max(1, isHtmlImageElement(source) ? source.naturalHeight || source.height : source.height);
  const mipLevelCount = mipmaps === 'generate' ? calculateMipLevelCount(width, height) : 1;
  if (mipLevelCount > 1 && !MIPMAP_RENDERABLE_FORMATS.has(format)) {
    throw new EngineError(
      EngineErrorCode.AssetInvalidData,
      `Runtime mipmap generation does not support texture format "${format}".`,
      {
        context: { format, mipmaps, width, height },
        hint: 'Use mipmaps: "none", an rgba8/bgra8 unorm format, or a compressed texture with a source mip chain.',
      },
    );
  }

  const texture = device.createTexture({
    ...(label ? { label } : {}),
    size: [width, height],
    mipLevelCount,
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha }, [width, height]);
  if (mipLevelCount > 1) generateMipChain(device, texture, format, mipLevelCount, label);
  return {
    texture,
    width,
    height,
    mipLevelCount,
    estimatedBytes: estimateMipChainBytes(width, height, format, mipLevelCount),
  };
}

export function calculateMipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

export function estimateMipChainBytes(
  width: number,
  height: number,
  format: GPUTextureFormat,
  mipLevelCount: number,
): number {
  let bytes = 0;
  for (let level = 0; level < mipLevelCount; level++) {
    bytes += estimateTextureBytes([
      Math.max(1, width >> level),
      Math.max(1, height >> level),
      1,
    ], format);
  }
  return bytes;
}

function generateMipChain(
  device: GPUDevice,
  texture: GPUTexture,
  format: GPUTextureFormat,
  mipLevelCount: number,
  label?: string,
): void {
  const cache = getDeviceCache(device);
  const pipeline = getMipmapPipeline(device, cache.pipelines, format);
  const encoder = device.createCommandEncoder({ label: label ? `${label}.mipmaps` : 'AssetManager.image-mipmaps' });
  for (let level = 1; level < mipLevelCount; level++) {
    const sourceView = texture.createView({
      ...(label ? { label: `${label}.mip-${level - 1}` } : {}),
      baseMipLevel: level - 1,
      mipLevelCount: 1,
    });
    const destinationView = texture.createView({
      ...(label ? { label: `${label}.mip-${level}` } : {}),
      baseMipLevel: level,
      mipLevelCount: 1,
    });
    const bindGroup = device.createBindGroup({
      label: label ? `${label}.mipmap-bind-group-${level}` : `AssetManager.mipmap-bind-group-${level}`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: cache.sampler },
      ],
    });
    const pass = encoder.beginRenderPass({
      label: label ? `${label}.mipmap-pass-${level}` : `AssetManager.mipmap-pass-${level}`,
      colorAttachments: [{
        view: destinationView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
}

function getDeviceCache(device: GPUDevice): {
  sampler: GPUSampler;
  pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
} {
  let cache = cacheByDevice.get(device);
  if (!cache) {
    cache = {
      sampler: device.createSampler({
        label: 'AssetManager.mipmap-sampler',
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      pipelines: new Map(),
    };
    cacheByDevice.set(device, cache);
  }
  return cache;
}

function getMipmapPipeline(
  device: GPUDevice,
  pipelines: Map<GPUTextureFormat, GPURenderPipeline>,
  format: GPUTextureFormat,
): GPURenderPipeline {
  let pipeline = pipelines.get(format);
  if (!pipeline) {
    const generated = getBuiltinSpecializedRenderingShader(device, 'mipmap');
    pipeline = device.createRenderPipeline({
      label: `AssetManager.mipmap-pipeline:${format}`,
      layout: generated.pipelineLayout,
      vertex: { module: generated.module, entryPoint: generated.pass.entryPoints.vertex! },
      fragment: { module: generated.module, entryPoint: generated.pass.entryPoints.fragment!, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    pipelines.set(format, pipeline);
  }
  return pipeline;
}

function isHtmlImageElement(
  source: ImageBitmap | HTMLCanvasElement | HTMLImageElement,
): source is HTMLImageElement {
  return typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement;
}
