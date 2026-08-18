import { HaiyueEngine } from '@haiyue/engine';
import type { RecoverableGpuResource } from '@haiyue/engine/core';
import { beginRenderCommandPass, type RenderCommandContext } from '@haiyue/engine/extension-authoring';
import { RenderPipeline } from '@haiyue/engine/experimental/renderer';
import type { World } from '@haiyue/engine/ecs';
import type { LoadedWindData } from './windData';
import {
  COASTLINE_SHADER,
  TRAIL_FADE_SHADER,
  WIND_COMPOSITE_SHADER,
  WIND_PARTICLE_SHADER,
  WIND_UPDATE_SHADER,
} from './windShaders';

const PARTICLE_COUNT = 32_768;
const PARTICLE_BYTES = 16;
const PARAMETER_BYTES = 64;
const TRAIL_FORMAT: GPUTextureFormat = 'rgba8unorm';

export interface WindFieldSettings {
  running: boolean;
  speedFactor: number;
  fadeOpacity: number;
  dropRate: number;
  dropRateBump: number;
}

interface TrailResources {
  width: number;
  height: number;
  textures: [GPUTexture, GPUTexture];
  fadeBindGroups: [GPUBindGroup, GPUBindGroup];
  compositeBindGroups: [GPUBindGroup, GPUBindGroup];
}

interface WindGpuState {
  device: GPUDevice;
  windTexture: GPUTexture;
  uniformBuffer: GPUBuffer;
  particleBuffers: [GPUBuffer, GPUBuffer];
  coastlineBuffer: GPUBuffer;
  coastlineSegmentCount: number;
  computePipeline: GPUComputePipeline;
  particlePipeline: GPURenderPipeline;
  fadePipeline: GPURenderPipeline;
  compositePipeline: GPURenderPipeline;
  coastlinePipeline: GPURenderPipeline;
  coastlineBindGroup: GPUBindGroup;
  computeBindGroups: [GPUBindGroup, GPUBindGroup];
  particleBindGroups: [GPUBindGroup, GPUBindGroup];
  screenSampler: GPUSampler;
  fadeBindGroupLayout: GPUBindGroupLayout;
  compositeBindGroupLayout: GPUBindGroupLayout;
  trails: TrailResources;
}

export class WindFieldRenderer implements RecoverableGpuResource<LoadedWindData> {
  readonly recoveryLabel = 'Wind field particle renderer';
  readonly recoverySource: LoadedWindData;
  readonly settings: WindFieldSettings = {
    running: true,
    speedFactor: 0.25,
    fadeOpacity: 0.965,
    dropRate: 0.0025,
    dropRateBump: 0.008,
  };
  readonly particleCount = PARTICLE_COUNT;

  private readonly engine: HaiyueEngine;
  private readonly unregisterRecovery: () => void;
  private readonly parameterData = new Float32Array(PARAMETER_BYTES / 4);
  private gpu: WindGpuState | null = null;
  private particleIndex = 0;
  private trailIndex = 0;
  private frame = 0;
  private disposed = false;

  constructor(engine: HaiyueEngine, windData: LoadedWindData) {
    this.engine = engine;
    this.recoverySource = windData;
    this.gpu = this.createGpuState(engine.device);
    this.unregisterRecovery = engine.registerDeviceRecoveryParticipant(this);
  }

  install(pipeline: RenderPipeline): void {
    pipeline
      .add({
        record: (_world: World, delta: number, context: RenderCommandContext): void => {
          this.recordParticleUpdate(delta, context);
        },
      }, { passType: 'compute', recordMode: 'delta', sort: 0 })
      .add({
        record: (_world: World, context: RenderCommandContext): void => {
          this.recordTrails(context);
        },
      }, { passType: 'render', pass: 'isolated', depth: false, sort: 1 })
      .add({
        record: (_world: World, context: RenderCommandContext): void => {
          this.recordComposite(context);
        },
      }, { passType: 'render', pass: 'shared', loadOp: 'clear', depth: false, sort: 2 });
  }

  reset(): void {
    const gpu = this.gpu;
    if (!gpu || this.disposed) return;
    const particles = createInitialParticleState(PARTICLE_COUNT);
    for (const buffer of gpu.particleBuffers) writeFloatBuffer(gpu.device.queue, buffer, particles);
    clearTrailTextures(gpu.device, gpu.trails.textures);
    this.particleIndex = 0;
    this.trailIndex = 0;
    this.frame = 0;
  }

  suspendForDeviceLoss(): void {
    this.destroyGpuState();
  }

  recoverGpuResource(device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted || this.disposed) throw new Error('Wind field recovery was aborted.');
    this.destroyGpuState();
    this.gpu = this.createGpuState(device);
    this.particleIndex = 0;
    this.trailIndex = 0;
    this.frame = 0;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterRecovery();
    this.destroyGpuState();
  }

  private recordParticleUpdate(deltaMs: number, context: RenderCommandContext): void {
    const gpu = this.gpu;
    if (!gpu || this.disposed) return;
    this.ensureTrailSize(gpu);
    this.writeParameters(gpu, deltaMs);

    const computePass = context.encoder.beginComputePass({ label: 'Wind field particle update' });
    computePass.setPipeline(gpu.computePipeline);
    computePass.setBindGroup(0, gpu.computeBindGroups[this.particleIndex]);
    computePass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 256));
    computePass.end();
    this.particleIndex = 1 - this.particleIndex;
    if (this.settings.running) this.frame++;
  }

  private recordTrails(context: RenderCommandContext): void {
    const gpu = this.gpu;
    if (!gpu || this.disposed) return;
    const outputIndex = 1 - this.trailIndex;
    const outputTexture = gpu.trails.textures[outputIndex]!;
    const pass = context.encoder.beginRenderPass({
      label: 'Wind field trail accumulation',
      colorAttachments: [{
        view: outputTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(gpu.fadePipeline);
    pass.setBindGroup(0, gpu.trails.fadeBindGroups[this.trailIndex]);
    pass.draw(3);
    pass.setPipeline(gpu.particlePipeline);
    pass.setBindGroup(0, gpu.particleBindGroups[this.particleIndex]);
    pass.draw(1, PARTICLE_COUNT);
    pass.end();
    this.trailIndex = outputIndex;
  }

  private recordComposite(context: RenderCommandContext): void {
    const gpu = this.gpu;
    if (!gpu || this.disposed) return;
    const { passEncoder, ownsPass } = beginRenderCommandPass(context);
    passEncoder.setPipeline(gpu.compositePipeline);
    passEncoder.setBindGroup(0, gpu.trails.compositeBindGroups[this.trailIndex]);
    passEncoder.draw(3);
    passEncoder.setPipeline(gpu.coastlinePipeline);
    passEncoder.setBindGroup(0, gpu.coastlineBindGroup);
    passEncoder.setVertexBuffer(0, gpu.coastlineBuffer);
    passEncoder.draw(6, gpu.coastlineSegmentCount);
    if (ownsPass) passEncoder.end();
  }

  private writeParameters(gpu: WindGpuState, deltaMs: number): void {
    const { metadata } = this.recoverySource;
    const frameScale = this.settings.running ? Math.min(Math.max(deltaMs, 0), 50) / (1000 / 60) : 0;
    this.parameterData[0] = metadata.uMin;
    this.parameterData[1] = metadata.vMin;
    this.parameterData[2] = metadata.uMax;
    this.parameterData[3] = metadata.vMax;
    this.parameterData[4] = metadata.width;
    this.parameterData[5] = metadata.height;
    this.parameterData[6] = frameScale;
    this.parameterData[7] = this.settings.speedFactor;
    this.parameterData[8] = this.settings.dropRate;
    this.parameterData[9] = this.settings.dropRateBump;
    this.parameterData[10] = (this.frame % 10_000) * 0.0001 + 0.173;
    this.parameterData[11] = this.settings.running ? this.settings.fadeOpacity : 1;
    this.parameterData[12] = gpu.trails.width;
    this.parameterData[13] = gpu.trails.height;
    this.parameterData[14] = PARTICLE_COUNT;
    this.parameterData[15] = 0;
    writeFloatBuffer(gpu.device.queue, gpu.uniformBuffer, this.parameterData);
  }

  private ensureTrailSize(gpu: WindGpuState): void {
    const width = Math.max(1, this.engine.width);
    const height = Math.max(1, this.engine.height);
    if (gpu.trails.width === width && gpu.trails.height === height) return;
    destroyTrailResources(gpu.trails);
    gpu.trails = this.createTrailResources(gpu, width, height);
    this.trailIndex = 0;
  }

  private createGpuState(device: GPUDevice): WindGpuState {
    const { metadata, pixels, coastlineSegments } = this.recoverySource;
    const windTexture = device.createTexture({
      label: `Wind field ${metadata.date}`,
      size: [metadata.width, metadata.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: windTexture },
      pixels,
      { bytesPerRow: metadata.width * 4, rowsPerImage: metadata.height },
      [metadata.width, metadata.height],
    );
    const windSampler = device.createSampler({
      label: 'Wind field bilinear sampler',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const screenSampler = device.createSampler({
      label: 'Wind field trail sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const uniformBuffer = device.createBuffer({
      label: 'Wind field parameters',
      size: PARAMETER_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const particleBuffers: [GPUBuffer, GPUBuffer] = [0, 1].map(index => device.createBuffer({
      label: `Wind field particles ${index}`,
      size: PARTICLE_COUNT * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })) as [GPUBuffer, GPUBuffer];
    const initialParticles = createInitialParticleState(PARTICLE_COUNT);
    for (const buffer of particleBuffers) writeFloatBuffer(device.queue, buffer, initialParticles);

    const coastlineBuffer = device.createBuffer({
      label: 'Natural Earth coastline segments',
      size: Math.max(4, coastlineSegments.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    writeFloatBuffer(device.queue, coastlineBuffer, coastlineSegments);

    const computeBindGroupLayout = device.createBindGroupLayout({
      label: 'Wind field update layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const particleBindGroupLayout = device.createBindGroupLayout({
      label: 'Wind field particle render layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    const fadeBindGroupLayout = device.createBindGroupLayout({
      label: 'Wind field trail fade layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const compositeBindGroupLayout = device.createBindGroupLayout({
      label: 'Wind field composite layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const coastlineBindGroupLayout = device.createBindGroupLayout({
      label: 'Wind field coastline layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });

    const computeModule = device.createShaderModule({ label: 'Wind field update shader', code: WIND_UPDATE_SHADER });
    const particleModule = device.createShaderModule({ label: 'Wind field particle shader', code: WIND_PARTICLE_SHADER });
    const fadeModule = device.createShaderModule({ label: 'Wind field fade shader', code: TRAIL_FADE_SHADER });
    const compositeModule = device.createShaderModule({ label: 'Wind field composite shader', code: WIND_COMPOSITE_SHADER });
    const coastlineModule = device.createShaderModule({ label: 'Wind field coastline shader', code: COASTLINE_SHADER });
    const computePipeline = device.createComputePipeline({
      label: 'Wind field particle update pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] }),
      compute: { module: computeModule, entryPoint: 'main' },
    });
    const particlePipeline = device.createRenderPipeline({
      label: 'Wind field particle trail pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [particleBindGroupLayout] }),
      vertex: { module: particleModule, entryPoint: 'vertexMain' },
      fragment: {
        module: particleModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: TRAIL_FORMAT,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'point-list' },
    });
    const fadePipeline = device.createRenderPipeline({
      label: 'Wind field trail fade pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [fadeBindGroupLayout] }),
      vertex: { module: fadeModule, entryPoint: 'vertexMain' },
      fragment: { module: fadeModule, entryPoint: 'fragmentMain', targets: [{ format: TRAIL_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const compositePipeline = device.createRenderPipeline({
      label: 'Wind field composite pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [compositeBindGroupLayout] }),
      vertex: { module: compositeModule, entryPoint: 'vertexMain' },
      fragment: { module: compositeModule, entryPoint: 'fragmentMain', targets: [{ format: this.engine.format }] },
      primitive: { topology: 'triangle-list' },
    });
    const coastlinePipeline = device.createRenderPipeline({
      label: 'Wind field coastline pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [coastlineBindGroupLayout] }),
      vertex: {
        module: coastlineModule,
        entryPoint: 'vertexMain',
        buffers: [{
          arrayStride: 16,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module: coastlineModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: this.engine.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const coastlineBindGroup = device.createBindGroup({
      label: 'Wind field coastline parameters',
      layout: coastlineBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    const computeBindGroups = particleBuffers.map((input, index) => device.createBindGroup({
      label: `Wind field update ${index}`,
      layout: computeBindGroupLayout,
      entries: [
        { binding: 0, resource: windTexture.createView() },
        { binding: 1, resource: windSampler },
        { binding: 2, resource: { buffer: input } },
        { binding: 3, resource: { buffer: particleBuffers[1 - index]! } },
        { binding: 4, resource: { buffer: uniformBuffer } },
      ],
    })) as [GPUBindGroup, GPUBindGroup];
    const particleBindGroups = particleBuffers.map((buffer, index) => device.createBindGroup({
      label: `Wind field particle render ${index}`,
      layout: particleBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: windTexture.createView() },
        { binding: 2, resource: windSampler },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    })) as [GPUBindGroup, GPUBindGroup];

    const partialState = {
      device,
      windTexture,
      uniformBuffer,
      particleBuffers,
      coastlineBuffer,
      coastlineSegmentCount: coastlineSegments.length / 4,
      computePipeline,
      particlePipeline,
      fadePipeline,
      compositePipeline,
      coastlinePipeline,
      coastlineBindGroup,
      computeBindGroups,
      particleBindGroups,
      screenSampler,
      fadeBindGroupLayout,
      compositeBindGroupLayout,
    };
    const trails = this.createTrailResources(
      partialState,
      Math.max(1, this.engine.width),
      Math.max(1, this.engine.height),
    );
    return { ...partialState, trails };
  }

  private createTrailResources(
    gpu: Pick<WindGpuState, 'device' | 'screenSampler' | 'uniformBuffer' | 'fadeBindGroupLayout' | 'compositeBindGroupLayout'>,
    width: number,
    height: number,
  ): TrailResources {
    const textures: [GPUTexture, GPUTexture] = [0, 1].map(index => gpu.device.createTexture({
      label: `Wind field trails ${index}`,
      size: [width, height],
      format: TRAIL_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })) as [GPUTexture, GPUTexture];
    const fadeBindGroups = textures.map((texture, index) => gpu.device.createBindGroup({
      label: `Wind field trail fade ${index}`,
      layout: gpu.fadeBindGroupLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: gpu.screenSampler },
        { binding: 2, resource: { buffer: gpu.uniformBuffer } },
      ],
    })) as [GPUBindGroup, GPUBindGroup];
    const compositeBindGroups = textures.map((texture, index) => gpu.device.createBindGroup({
      label: `Wind field composite ${index}`,
      layout: gpu.compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: gpu.screenSampler },
      ],
    })) as [GPUBindGroup, GPUBindGroup];
    clearTrailTextures(gpu.device, textures);
    return { width, height, textures, fadeBindGroups, compositeBindGroups };
  }

  private destroyGpuState(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    destroyTrailResources(gpu.trails);
    gpu.windTexture.destroy();
    gpu.uniformBuffer.destroy();
    gpu.coastlineBuffer.destroy();
    for (const buffer of gpu.particleBuffers) buffer.destroy();
    this.gpu = null;
  }
}

function createInitialParticleState(particleCount: number): Float32Array {
  const particles = new Float32Array(particleCount * (PARTICLE_BYTES / 4));
  let state = 0x6d2b79f5;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = 0; index < particleCount; index++) {
    const offset = index * 4;
    const x = random();
    const y = random();
    particles[offset] = x;
    particles[offset + 1] = y;
    particles[offset + 2] = x;
    particles[offset + 3] = y;
  }
  return particles;
}

function clearTrailTextures(device: GPUDevice, textures: readonly GPUTexture[]): void {
  const encoder = device.createCommandEncoder({ label: 'Clear wind field trails' });
  for (const texture of textures) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
}

function destroyTrailResources(trails: TrailResources): void {
  for (const texture of trails.textures) texture.destroy();
}

function writeFloatBuffer(queue: GPUQueue, buffer: GPUBuffer, data: Float32Array): void {
  queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}
