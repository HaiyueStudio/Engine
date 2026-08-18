import type { IEngine } from '@haiyue/engine/core';
import { ComputeKernel } from '@haiyue/engine/compute';

export type BlurMethod = 'none' | 'convolution' | 'gaussian' | 'box' | 'mipmap' | 'kawase';
export type ConvolutionKernelSize = 3 | 5 | 7;

export interface TextureBlurSettings {
  method: BlurMethod;
  kernelSize: ConvolutionKernelSize;
  radius: number;
  iterations: number;
}

export interface TextureBlurProcessOptions {
  sourceView: GPUTextureView;
  destination: GPUTexture;
  width: number;
  height: number;
  settings: TextureBlurSettings;
}

const MAX_RADIUS = 32;
const MAX_PASS_COUNT = 24;
const PARAM_BYTES = 48;
const KERNEL_BYTES = 256;

const BLUR_SHADER = /* wgsl */ `
struct Params {
  srcSize : vec2<u32>,
  dstSize : vec2<u32>,
  direction : vec2<f32>,
  radius : u32,
  mode : u32,
  sigma : f32,
  offset : f32,
  _padding : vec2<u32>,
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var linearSampler : sampler;
@group(0) @binding(2) var dstTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params : Params;
@group(0) @binding(4) var<storage, read> kernelWeights : array<f32>;

fn sampleAt(uv : vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(srcTex, linearSampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.dstSize.x || gid.y >= params.dstSize.y) { return; }
  let srcSize = vec2<f32>(params.srcSize);
  let uv = (vec2<f32>(gid.xy) + vec2<f32>(0.5)) / vec2<f32>(params.dstSize);
  var color = vec4<f32>(0.0);

  // Copy / linearly upscale a pyramid level.
  if (params.mode == 0u) {
    color = sampleAt(uv);
  }

  // Separable Gaussian.
  if (params.mode == 1u) {
    var weightSum = 0.0;
    for (var tap = -${MAX_RADIUS}; tap <= ${MAX_RADIUS}; tap = tap + 1) {
      if (abs(tap) <= i32(params.radius)) {
        let x = f32(tap);
        let weight = exp(-(x * x) / max(0.0001, 2.0 * params.sigma * params.sigma));
        color += sampleAt(uv + params.direction * x / srcSize) * weight;
        weightSum += weight;
      }
    }
    color /= max(weightSum, 0.0001);
  }

  // Separable Box blur.
  if (params.mode == 2u) {
    var sampleCount = 0.0;
    for (var tap = -${MAX_RADIUS}; tap <= ${MAX_RADIUS}; tap = tap + 1) {
      if (abs(tap) <= i32(params.radius)) {
        color += sampleAt(uv + params.direction * f32(tap) / srcSize);
        sampleCount += 1.0;
      }
    }
    color /= max(sampleCount, 1.0);
  }

  // Four-tap Kawase iteration.
  if (params.mode == 3u) {
    let delta = vec2<f32>(params.offset + 0.5) / srcSize;
    color = (
      sampleAt(uv + vec2<f32>(-delta.x, -delta.y)) +
      sampleAt(uv + vec2<f32>( delta.x, -delta.y)) +
      sampleAt(uv + vec2<f32>(-delta.x,  delta.y)) +
      sampleAt(uv + vec2<f32>( delta.x,  delta.y))
    ) * 0.25;
  }

  // Four-tap pyramid downsample used by Mipmap blur.
  if (params.mode == 4u) {
    let delta = vec2<f32>(0.75) / srcSize;
    color = (
      sampleAt(uv + vec2<f32>(-delta.x, -delta.y)) +
      sampleAt(uv + vec2<f32>( delta.x, -delta.y)) +
      sampleAt(uv + vec2<f32>(-delta.x,  delta.y)) +
      sampleAt(uv + vec2<f32>( delta.x,  delta.y))
    ) * 0.25;
  }

  // Generic square convolution, up to 7x7.
  if (params.mode == 5u) {
    let halfSize = i32(params.radius);
    let kernelSize = halfSize * 2 + 1;
    for (var y = -3; y <= 3; y = y + 1) {
      for (var x = -3; x <= 3; x = x + 1) {
        if (abs(x) <= halfSize && abs(y) <= halfSize) {
          let sampleX = clamp(i32(gid.x) + x, 0, i32(params.srcSize.x) - 1);
          let sampleY = clamp(i32(gid.y) + y, 0, i32(params.srcSize.y) - 1);
          let kernelIndex = u32((y + halfSize) * kernelSize + x + halfSize);
          color += textureLoad(srcTex, vec2<i32>(sampleX, sampleY), 0) * kernelWeights[kernelIndex];
        }
      }
    }
  }

  textureStore(dstTex, vec2<i32>(gid.xy), vec4<f32>(color.rgb, color.a));
}
`;

export class TextureBlurProcessor {
  lastPassCount = 0;

  private readonly device: GPUDevice;
  private readonly kernel: ComputeKernel;
  private readonly sampler: GPUSampler;
  private readonly parameterBuffers: GPUBuffer[];
  private readonly kernelBuffer: GPUBuffer;
  private readonly parameterData = new ArrayBuffer(PARAM_BYTES);
  private readonly parameterFloats = new Float32Array(this.parameterData);
  private readonly parameterUints = new Uint32Array(this.parameterData);
  private readonly kernelData = new Float32Array(KERNEL_BYTES / 4);
  private scratchA: GPUTexture | null = null;
  private scratchB: GPUTexture | null = null;
  private pyramid: GPUTexture[] = [];
  private width = 0;
  private height = 0;
  private passCursor = 0;

  constructor(engine: IEngine) {
    if (!engine.device) throw new Error('TextureBlurProcessor requires an initialized WebGPU engine.');
    this.device = engine.device;
    this.kernel = new ComputeKernel(engine, {
      label: 'Texture blur comparison',
      code: BLUR_SHADER,
      bindGroupLayoutEntries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.sampler = this.device.createSampler({
      label: 'Texture blur linear clamp sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    this.parameterBuffers = Array.from({ length: MAX_PASS_COUNT }, (_, index) => this.device.createBuffer({
      label: `Texture blur parameters ${index}`,
      size: PARAM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    this.kernelBuffer = this.device.createBuffer({
      label: 'Texture blur convolution weights',
      size: KERNEL_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  process(options: TextureBlurProcessOptions): void {
    const { width, height, settings } = options;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError(`Texture blur dimensions must be positive integers; received ${width}x${height}.`);
    }
    this.ensureSizedResources(width, height);
    this.passCursor = 0;
    this.lastPassCount = 0;
    const encoder = this.device.createCommandEncoder({ label: `Texture blur: ${settings.method}` });
    switch (settings.method) {
      case 'none':
        this.encodePass(encoder, options.sourceView, options.destination, width, height, width, height, 0);
        break;
      case 'convolution':
        this.writeBoxKernel(settings.kernelSize);
        this.encodePass(
          encoder,
          options.sourceView,
          options.destination,
          width,
          height,
          width,
          height,
          5,
          0,
          0,
          (settings.kernelSize - 1) / 2,
        );
        break;
      case 'gaussian':
        this.encodeSeparable(encoder, options, 1);
        break;
      case 'box':
        this.encodeSeparable(encoder, options, 2);
        break;
      case 'mipmap':
        this.encodeMipmap(encoder, options);
        break;
      case 'kawase':
        this.encodeKawase(encoder, options);
        break;
    }
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.scratchA?.destroy();
    this.scratchB?.destroy();
    for (const texture of this.pyramid) texture.destroy();
    for (const buffer of this.parameterBuffers) buffer.destroy();
    this.kernelBuffer.destroy();
    this.scratchA = null;
    this.scratchB = null;
    this.pyramid = [];
  }

  private encodeSeparable(
    encoder: GPUCommandEncoder,
    options: TextureBlurProcessOptions,
    mode: 1 | 2,
  ): void {
    const radius = clampInteger(options.settings.radius, 1, MAX_RADIUS);
    const sigma = Math.max(0.5, radius * 0.5);
    this.encodePass(
      encoder,
      options.sourceView,
      this.scratchA!,
      options.width,
      options.height,
      options.width,
      options.height,
      mode,
      1,
      0,
      radius,
      sigma,
    );
    this.encodePass(
      encoder,
      this.scratchA!.createView(),
      options.destination,
      options.width,
      options.height,
      options.width,
      options.height,
      mode,
      0,
      1,
      radius,
      sigma,
    );
  }

  private encodeKawase(encoder: GPUCommandEncoder, options: TextureBlurProcessOptions): void {
    const iterations = clampInteger(options.settings.iterations, 1, 8);
    let sourceView = options.sourceView;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const destination = iteration === iterations - 1
        ? options.destination
        : iteration % 2 === 0 ? this.scratchA! : this.scratchB!;
      this.encodePass(
        encoder,
        sourceView,
        destination,
        options.width,
        options.height,
        options.width,
        options.height,
        3,
        0,
        0,
        0,
        1,
        iteration + 1,
      );
      sourceView = destination.createView();
    }
  }

  private encodeMipmap(encoder: GPUCommandEncoder, options: TextureBlurProcessOptions): void {
    const levelCount = Math.min(
      clampInteger(options.settings.iterations, 1, 8),
      this.pyramid.length,
    );
    let sourceView = options.sourceView;
    let sourceWidth = options.width;
    let sourceHeight = options.height;
    for (let level = 0; level < levelCount; level++) {
      const destination = this.pyramid[level]!;
      const destinationWidth = Math.max(1, Math.floor(sourceWidth / 2));
      const destinationHeight = Math.max(1, Math.floor(sourceHeight / 2));
      this.encodePass(
        encoder,
        sourceView,
        destination,
        sourceWidth,
        sourceHeight,
        destinationWidth,
        destinationHeight,
        4,
      );
      sourceView = destination.createView();
      sourceWidth = destinationWidth;
      sourceHeight = destinationHeight;
    }
    this.encodePass(
      encoder,
      sourceView,
      options.destination,
      sourceWidth,
      sourceHeight,
      options.width,
      options.height,
      0,
    );
  }

  private encodePass(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    destination: GPUTexture,
    sourceWidth: number,
    sourceHeight: number,
    destinationWidth: number,
    destinationHeight: number,
    mode: number,
    directionX = 0,
    directionY = 0,
    radius = 0,
    sigma = 1,
    offset = 0,
  ): void {
    const parameterBuffer = this.parameterBuffers[this.passCursor++];
    if (!parameterBuffer) throw new Error(`Texture blur exceeded ${MAX_PASS_COUNT} passes.`);
    this.parameterUints[0] = sourceWidth;
    this.parameterUints[1] = sourceHeight;
    this.parameterUints[2] = destinationWidth;
    this.parameterUints[3] = destinationHeight;
    this.parameterFloats[4] = directionX;
    this.parameterFloats[5] = directionY;
    this.parameterUints[6] = radius;
    this.parameterUints[7] = mode;
    this.parameterFloats[8] = sigma;
    this.parameterFloats[9] = offset;
    this.parameterUints[10] = 0;
    this.parameterUints[11] = 0;
    this.device.queue.writeBuffer(parameterBuffer, 0, this.parameterData);
    const bindGroup = this.kernel.createBindGroup([
      { binding: 0, resource: sourceView },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: destination.createView() },
      { binding: 3, resource: { buffer: parameterBuffer } },
      { binding: 4, resource: { buffer: this.kernelBuffer } },
    ], `Texture blur pass ${this.passCursor}`);
    this.kernel.dispatch(
      encoder,
      bindGroup,
      Math.ceil(destinationWidth / 8),
      Math.ceil(destinationHeight / 8),
    );
    this.lastPassCount++;
  }

  private writeBoxKernel(size: ConvolutionKernelSize): void {
    this.kernelData.fill(0);
    const count = size * size;
    this.kernelData.fill(1 / count, 0, count);
    this.device.queue.writeBuffer(this.kernelBuffer, 0, this.kernelData);
  }

  private ensureSizedResources(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.scratchA?.destroy();
    this.scratchB?.destroy();
    for (const texture of this.pyramid) texture.destroy();
    this.width = width;
    this.height = height;
    this.scratchA = createWorkingTexture(this.device, width, height, 'Texture blur scratch A');
    this.scratchB = createWorkingTexture(this.device, width, height, 'Texture blur scratch B');
    this.pyramid = [];
    let levelWidth = width;
    let levelHeight = height;
    for (let level = 0; level < 8 && (levelWidth > 1 || levelHeight > 1); level++) {
      levelWidth = Math.max(1, Math.floor(levelWidth / 2));
      levelHeight = Math.max(1, Math.floor(levelHeight / 2));
      this.pyramid.push(createWorkingTexture(
        this.device,
        levelWidth,
        levelHeight,
        `Texture blur pyramid ${level + 1}`,
      ));
    }
  }
}

function createWorkingTexture(
  device: GPUDevice,
  width: number,
  height: number,
  label: string,
): GPUTexture {
  return device.createTexture({
    label,
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
