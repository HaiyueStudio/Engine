import type { IEngine } from '../../core/IEngine';
import { BitmapFontData } from '../../font/BitmapFontData';
import { writeBuffer } from '../../renderer/utils';
import { alignUp4 } from '../../utils/align';
import { GuiTextBatch, GUI_TEXT_FLOATS_PER_VERTEX } from './GuiTextBatch';
import { BaseRenderer } from '../../renderer/BaseRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import { getBuiltin2dUiShader } from '../../shader/BuiltinRenderShader';
import { GUI_TEXTURED_VERTEX_LAYOUT } from './GuiVertexLayout';

interface FontGpuData {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
}

interface BatchGpuBuffer {
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  uploadedVersion: number;
}

export class GuiTextRenderer extends BaseRenderer {
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private viewportBindGroupLayout!: GPUBindGroupLayout;
  private fontBindGroupLayout!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private viewportBuffer!: GPUBuffer;
  private viewportBindGroup!: GPUBindGroup;
  private batchBuffers = new WeakMap<GuiTextBatch, BatchGpuBuffer>();
  private readonly liveBatchBuffers = new Set<BatchGpuBuffer>();
  private readonly viewportData = new Float32Array(4);
  private fontCache = new Map<number, FontGpuData>();
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
    this.fontBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const generated = getBuiltin2dUiShader(device, 'gui-text', [
      this.viewportBindGroupLayout,
      this.fontBindGroupLayout,
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
    device.queue.writeTexture(
      { texture: this.defaultTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
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

  render(passEncoder: GPURenderPassEncoder, batch: GuiTextBatch, font: BitmapFontData): void {
    if (!this.initialized || batch.vertexCount <= 0) return;
    const pipeline = this.getPipeline();

    const viewport = this.viewportData;
    viewport[0] = this.engine.displayWidth;
    viewport[1] = this.engine.displayHeight;
    viewport[2] = 0;
    viewport[3] = 0;
    writeBuffer(this.engine.device.queue, this.viewportBuffer, 0, viewport);
    const vertexBuffer = this.uploadBatch(batch);
    const fontData = this.getFontGpuData(font);
    if (!vertexBuffer) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.viewportBindGroup);
    passEncoder.setBindGroup(1, fontData.bindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(batch.vertexCount);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this.getPipelineKey();
    this.addPipelineWarmup(plan, key, 'GUI text', () => this.pipelineDescriptor(), this.engine.device);
  }

  releaseBatch(batch: GuiTextBatch): void {
    const gpuBuffer = this.batchBuffers.get(batch);
    if (!gpuBuffer) return;
    gpuBuffer.vertexBuffer.destroy();
    this.liveBatchBuffers.delete(gpuBuffer);
    this.batchBuffers.delete(batch);
  }

  private uploadBatch(batch: GuiTextBatch): GPUBuffer | null {
    const usedByteLength = batch.vertexCount * GUI_TEXT_FLOATS_PER_VERTEX * 4;
    const byteLength = Math.max(4, usedByteLength);
    let gpuBuffer = this.batchBuffers.get(batch);
    if (!gpuBuffer || gpuBuffer.vertexBufferSize < byteLength) {
      if (gpuBuffer) {
        gpuBuffer.vertexBuffer.destroy();
        this.liveBatchBuffers.delete(gpuBuffer);
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
      this.batchBuffers.set(batch, gpuBuffer);
      this.liveBatchBuffers.add(gpuBuffer);
    }
    if (gpuBuffer.uploadedVersion !== batch.version) {
      writeBuffer(this.engine.device.queue, gpuBuffer.vertexBuffer, 0, batch.vertexData, 0, byteLength);
      gpuBuffer.uploadedVersion = batch.version;
    }
    return gpuBuffer.vertexBuffer;
  }

  private getFontGpuData(font: BitmapFontData): FontGpuData {
    let fontData = this.fontCache.get(font.id);
    if (fontData) return fontData;

    const { device } = this.engine;
    const sampler = this.sampler;
    if (!sampler) throw new Error('GuiTextRenderer sampler owner is not prepared.');
    let texture = this.defaultTexture;

    const source = font.pageImages?.[0];
    if (source) {
      const width = source instanceof HTMLCanvasElement ? source.width : source.width;
      const height = source instanceof HTMLCanvasElement ? source.height : source.height;
      texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: source as HTMLCanvasElement | ImageBitmap | HTMLImageElement },
        { texture },
        [width, height],
      );
    }

    fontData = {
      texture,
      bindGroup: device.createBindGroup({
        layout: this.fontBindGroupLayout,
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: sampler },
        ],
      }),
    };
    this.fontCache.set(font.id, fontData);
    return fontData;
  }

  destroy(): void {
    if (!this.initialized) return;
    this.viewportBuffer.destroy();
    for (const buffer of this.liveBatchBuffers) buffer.vertexBuffer.destroy();
    this.liveBatchBuffers.clear();
    this.batchBuffers = new WeakMap<GuiTextBatch, BatchGpuBuffer>();
    for (const fontData of this.fontCache.values()) {
      if (fontData.texture !== this.defaultTexture) fontData.texture.destroy();
    }
    this.fontCache.clear();
    this.defaultTexture.destroy();
    this.sampler = null;
    this.clearPipelineCache();
    this.initialized = false;
  }

  private getPipeline(): GPURenderPipeline {
    const key = this.getPipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this.pipelineDescriptor()));
  }

  private getPipelineKey(): string {
    return `gui-text|${this.reverseZ ? 1 : 0}|${this.msaaSamples}`;
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
        targets: [{
          format,
          blend: { color: alphaBlend, alpha: alphaBlend },
        }],
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
