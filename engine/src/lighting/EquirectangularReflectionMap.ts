import { uploadImageTexture } from '../assets/ImageTextureUpload';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { EnvironmentCubeTexture } from './EnvironmentLight';
import { getBuiltinSpecializedRenderingShader } from '../shader/BuiltinSpecializedRenderingShader';

/** A decoded LDR image whose pixels use the standard 2:1 equirectangular layout. */
export type EquirectangularReflectionMapSource =
  | ImageBitmap
  | HTMLCanvasElement
  | HTMLImageElement;

export interface EquirectangularReflectionMapOptions {
  /** Cubemap face width/height. Defaults to the source's angular pixel density. */
  readonly faceSize?: number;
  readonly label?: string;
  readonly signal?: AbortSignal;
}

/** An owned cubemap produced from an equirectangular image. */
export interface EquirectangularReflectionMap extends EnvironmentCubeTexture {
  readonly kind: 'equirectangular-reflection-map';
  readonly faceSize: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Releases the generated GPU cubemap. Safe to call more than once. */
  destroy(): void;
}

interface DeviceResources {
  readonly sampler: GPUSampler;
  readonly pipeline: Promise<GPURenderPipeline>;
}

const deviceResources = new WeakMap<GPUDevice, DeviceResources>();
const OUTPUT_FORMAT: GPUTextureFormat = 'rgba8unorm';
const FACE_COUNT = 6;

/**
 * Converts one decoded 2:1 equirectangular image into an owned six-face cubemap.
 *
 * The result is an unfiltered, single-mip reflection map. Use an irradiance or
 * GGX-prefiltered cubemap when physically based diffuse or rough reflections are
 * required.
 */
export async function createEquirectangularReflectionMap(
  device: GPUDevice,
  source: EquirectangularReflectionMapSource,
  options: EquirectangularReflectionMapOptions = {},
): Promise<EquirectangularReflectionMap> {
  throwIfAborted(options.signal);
  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(source);
  validateSourceDimensions(sourceWidth, sourceHeight);
  const defaultFaceSize = Math.max(1, Math.floor(Math.min(sourceWidth / 4, sourceHeight / 2)));
  const faceSize = options.faceSize ?? defaultFaceSize;
  validateFaceSize(device, faceSize);

  const label = options.label ?? 'EquirectangularReflectionMap';
  let sourceTexture: GPUTexture | undefined;
  let cubeTexture: GPUTexture | undefined;
  try {
    const resources = await getDeviceResources(device);
    throwIfAborted(options.signal);
    const uploaded = uploadImageTexture(
      device,
      source,
      'rgba8unorm-srgb',
      'none',
      `${label}.source`,
    );
    sourceTexture = uploaded.texture;
    cubeTexture = device.createTexture({
      label: `${label}.cube`,
      size: { width: faceSize, height: faceSize, depthOrArrayLayers: FACE_COUNT },
      dimension: '2d',
      format: OUTPUT_FORMAT,
      mipLevelCount: 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const bindGroup = device.createBindGroup({
      label: `${label}.bind-group`,
      layout: resources.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceTexture.createView() },
        { binding: 1, resource: resources.sampler },
      ],
    });
    const encoder = device.createCommandEncoder({ label: `${label}.encoder` });
    for (let face = 0; face < FACE_COUNT; face++) {
      const pass = encoder.beginRenderPass({
        label: `${label}.face-${face}`,
        colorAttachments: [{
          view: cubeTexture.createView({
            label: `${label}.face-${face}.view`,
            dimension: '2d',
            baseArrayLayer: face,
            arrayLayerCount: 1,
          }),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(resources.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3, 1, 0, face);
      pass.end();
    }
    throwIfAborted(options.signal);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    throwIfAborted(options.signal);
    sourceTexture.destroy();
    sourceTexture = undefined;

    let destroyed = false;
    const ownedTexture = cubeTexture;
    cubeTexture = undefined;
    return {
      kind: 'equirectangular-reflection-map',
      texture: ownedTexture,
      mipLevelCount: 1,
      version: 0,
      faceSize,
      sourceWidth,
      sourceHeight,
      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        ownedTexture.destroy();
      },
    };
  } catch (error) {
    sourceTexture?.destroy();
    cubeTexture?.destroy();
    throw error;
  }
}

async function getDeviceResources(device: GPUDevice): Promise<{
  sampler: GPUSampler;
  pipeline: GPURenderPipeline;
}> {
  let cached = deviceResources.get(device);
  if (!cached) {
    const sampler = device.createSampler({
      label: 'EquirectangularReflectionMap.sampler',
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    });
    const generated = getBuiltinSpecializedRenderingShader(device, 'equirectangular-to-cube');
    const pipeline = device.createRenderPipelineAsync({
      label: 'EquirectangularReflectionMap.pipeline',
      layout: generated.pipelineLayout,
      vertex: { module: generated.module, entryPoint: generated.pass.entryPoints.vertex! },
      fragment: { module: generated.module, entryPoint: generated.pass.entryPoints.fragment!, targets: [{ format: OUTPUT_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    cached = { sampler, pipeline };
    deviceResources.set(device, cached);
    void pipeline.catch(() => {
      if (deviceResources.get(device) === cached) deviceResources.delete(device);
    });
  }
  return { sampler: cached.sampler, pipeline: await cached.pipeline };
}

function getSourceDimensions(source: EquirectangularReflectionMapSource): {
  width: number;
  height: number;
} {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
    };
  }
  return { width: source.width, height: source.height };
}

function validateSourceDimensions(width: number, height: number): void {
  const ratio = width / height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new EngineError(
      EngineErrorCode.AssetInvalidData,
      'Equirectangular reflection map source must have positive integer dimensions.',
      { context: { width, height }, path: 'source' },
    );
  }
  if (Math.abs(ratio - 2) > 0.05) {
    throw new EngineError(
      EngineErrorCode.AssetInvalidData,
      `Equirectangular reflection map source must use a 2:1 aspect ratio; received ${width}x${height}.`,
      {
        context: { width, height, aspectRatio: ratio },
        path: 'source',
        hint: 'Crop or pad the decoded panorama to a standard 2:1 equirectangular layout.',
      },
    );
  }
}

function validateFaceSize(device: GPUDevice, faceSize: number): void {
  const maximum = device.limits.maxTextureDimension2D;
  if (!Number.isInteger(faceSize) || faceSize <= 0 || faceSize > maximum) {
    throw new EngineError(
      EngineErrorCode.AssetInvalidData,
      `Equirectangular reflection map faceSize must be an integer from 1 to ${maximum}.`,
      { context: { faceSize, maximum }, path: 'options.faceSize' },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new EngineError(
    EngineErrorCode.AssetJobAborted,
    'Equirectangular reflection map conversion was aborted.',
    {
      context: { reason: signal.reason },
      path: 'options.signal',
      cause: signal.reason,
    },
  );
}
