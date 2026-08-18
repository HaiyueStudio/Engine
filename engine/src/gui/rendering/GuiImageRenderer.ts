import type { IEngine } from '../../core/IEngine';
import type { SampleableTextureSource } from '../../material/BasicMaterial';
import { writeBuffer } from '../../renderer/utils';
import { alignUp4 } from '../../utils/align';
import type { GuiImageSource } from '../components/GuiImage';
import { GUI_IMAGE_FLOATS_PER_VERTEX, GuiImageBatch, type GuiImageGroup } from './GuiImageBatch';
import { BaseRenderer } from '../../renderer/BaseRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import { getBuiltin2dUiShader } from '../../shader/BuiltinRenderShader';
import { GUI_TEXTURED_VERTEX_LAYOUT } from './GuiVertexLayout';

interface ImageGpuData {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  ownsTexture: boolean;
  version?: number | undefined;
}

interface GroupGpuBuffer {
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  uploadedVersion: number;
}

export class GuiImageRenderer extends BaseRenderer {
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private viewportBindGroupLayout!: GPUBindGroupLayout;
  private imageBindGroupLayout!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private viewportBuffer!: GPUBuffer;
  private viewportBindGroup!: GPUBindGroup;
  private readonly viewportData = new Float32Array(4);
  private imageCache = new WeakMap<object, ImageGpuData>();
  private readonly liveImageData = new Set<ImageGpuData>();
  private groupBuffers = new WeakMap<GuiImageGroup, GroupGpuBuffer>();
  private readonly liveGroupBuffers = new Set<GroupGpuBuffer>();
  private defaultTexture!: GPUTexture;
  private sampler: GPUSampler | null = null;
  private initialized = false;

  prepare(engine: IEngine): void {
    if (this.initialized && this.engine.device === engine.device) return;
    if (this.initialized) this.destroy();
    this.engine = engine;
    const { device } = engine;
    try {
      this.viewportBindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.imageBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const generated = getBuiltin2dUiShader(device, 'gui-image', [
      this.viewportBindGroupLayout,
      this.imageBindGroupLayout,
    ]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
    this.viewportBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.viewportBindGroup = device.createBindGroup({
      layout: this.viewportBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewportBuffer } }],
    });
    this.defaultTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.defaultTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
      this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this.initialized = true;
    } catch (error) {
      this.viewportBuffer?.destroy();
      this.defaultTexture?.destroy();
      this.sampler = null;
      this.clearPipelineCache();
      this.initialized = false;
      throw error;
    }
  }

  render(passEncoder: GPURenderPassEncoder, batch: GuiImageBatch): void {
    if (!this.initialized || batch.groups.length < 1) return;
    const pipeline = this.getPipeline();
    const viewport = this.viewportData;
    viewport[0] = this.engine.displayWidth;
    viewport[1] = this.engine.displayHeight;
    writeBuffer(this.engine.device.queue, this.viewportBuffer, 0, viewport);

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.viewportBindGroup);
    for (const group of batch.groups) {
      const vertexBuffer = this.uploadGroup(group);
      if (!vertexBuffer) continue;
      const imageData = this.getImageGpuData(group.source);
      passEncoder.setBindGroup(1, imageData.bindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(group.vertexCount);
    }
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this.getPipelineKey();
    this.addPipelineWarmup(plan, key, 'GUI images', () => this.pipelineDescriptor(), this.engine.device);
  }

  releaseBatch(batch: GuiImageBatch): void {
    for (const group of batch.groups) {
      const gpuBuffer = this.groupBuffers.get(group);
      if (!gpuBuffer) continue;
      gpuBuffer.vertexBuffer.destroy();
      this.liveGroupBuffers.delete(gpuBuffer);
      this.groupBuffers.delete(group);
    }
  }

  destroy(): void {
    if (!this.initialized) return;
    this.viewportBuffer.destroy();
    this.defaultTexture.destroy();
    for (const buffer of this.liveGroupBuffers) buffer.vertexBuffer.destroy();
    this.liveGroupBuffers.clear();
    for (const data of this.liveImageData) {
      if (data.ownsTexture) data.texture.destroy();
    }
    this.liveImageData.clear();
    this.groupBuffers = new WeakMap();
    this.imageCache = new WeakMap();
    this.sampler = null;
    this.clearPipelineCache();
    this.initialized = false;
  }

  private uploadGroup(group: GuiImageGroup): GPUBuffer | null {
    const usedByteLength = group.vertexCount * GUI_IMAGE_FLOATS_PER_VERTEX * 4;
    const byteLength = Math.max(4, usedByteLength);
    let gpuBuffer = this.groupBuffers.get(group);
    if (!gpuBuffer || gpuBuffer.vertexBufferSize < byteLength) {
      if (gpuBuffer) {
        gpuBuffer.vertexBuffer.destroy();
        this.liveGroupBuffers.delete(gpuBuffer);
      }
      const vertexBufferSize = alignUp4(byteLength);
      gpuBuffer = {
        vertexBufferSize,
        uploadedVersion: -1,
        vertexBuffer: this.engine.device.createBuffer({
          size: vertexBufferSize,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      };
      this.groupBuffers.set(group, gpuBuffer);
      this.liveGroupBuffers.add(gpuBuffer);
    }
    if (gpuBuffer.uploadedVersion !== group.version) {
      writeBuffer(this.engine.device.queue, gpuBuffer.vertexBuffer, 0, group.vertexData, 0, byteLength);
      gpuBuffer.uploadedVersion = group.version;
    }
    return gpuBuffer.vertexBuffer;
  }

  private getImageGpuData(source: NonNullable<GuiImageSource>): ImageGpuData {
    const cacheKey = isGpuTextureSource(source) ? source : source as object;
    const sourceVersion = isSampleableTextureSource(source) ? source.version : undefined;
    const cached = this.imageCache.get(cacheKey);
    if (cached && cached.version === sourceVersion) return cached;
    const texture = isGpuTextureSource(source)
      ? source
      : isSampleableTextureSource(source)
        ? source.texture
        : this.createTextureFromImage(source);
    const sampler = this.sampler;
    if (!sampler) throw new Error('GuiImageRenderer sampler owner is not prepared.');
    const data = {
      texture,
      ownsTexture: !isGpuTextureSource(source) && !isSampleableTextureSource(source),
      version: sourceVersion,
      bindGroup: this.engine.device.createBindGroup({
        layout: this.imageBindGroupLayout,
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: sampler },
        ],
      }),
    };
    if (cached) {
      this.liveImageData.delete(cached);
      if (cached.ownsTexture) cached.texture.destroy();
    }
    this.imageCache.set(cacheKey, data);
    this.liveImageData.add(data);
    return data;
  }

  private createTextureFromImage(source: HTMLCanvasElement | HTMLImageElement | ImageBitmap): GPUTexture {
    const isImageElement = isHtmlImageElement(source);
    const width = Math.max(1, isImageElement ? source.naturalWidth || source.width : source.width);
    const height = Math.max(1, isImageElement ? source.naturalHeight || source.height : source.height);
    const texture = this.engine.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.engine.device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height]);
    return texture;
  }

  private getPipeline(): GPURenderPipeline {
    const key = this.getPipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this.pipelineDescriptor()));
  }

  private getPipelineKey(): string {
    return `gui-image|${this.reverseZ ? 1 : 0}|${this.msaaSamples}`;
  }

  private pipelineDescriptor(): GPURenderPipelineDescriptor {
    const { format } = this.engine;
    const alphaBlend: GPUBlendComponent = {
      srcFactor: 'src-alpha',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    };
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shader,
        entryPoint: 'vs_main',
        buffers: [GUI_TEXTURED_VERTEX_LAYOUT.gpu],
      },
      fragment: {
        module: this.shader,
        entryPoint: 'fs_main',
        targets: [{ format, blend: { color: alphaBlend, alpha: alphaBlend } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
      multisample: { count: this.msaaSamples },
    };
  }
}

function isSampleableTextureSource(source: GuiImageSource): source is SampleableTextureSource {
  return !!source && typeof (source as Partial<SampleableTextureSource>).texture === 'object';
}

function isGpuTextureSource(source: GuiImageSource): source is GPUTexture {
  return !!source && typeof (source as Partial<GPUTexture>).createView === 'function';
}

function isHtmlImageElement(source: HTMLCanvasElement | HTMLImageElement | ImageBitmap): source is HTMLImageElement {
  return typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement;
}
