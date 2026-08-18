import type { IEngine } from '../../core/IEngine';
import { writeBuffer } from '../../renderer/utils';
import { alignUp4 } from '../../utils/align';
import { GuiBatch, GUI_SHAPE_FLOATS_PER_VERTEX } from './GuiBatch';
import { BaseRenderer } from '../../renderer/BaseRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import { getBuiltin2dUiShader } from '../../shader/BuiltinRenderShader';
import { GUI_SHAPE_VERTEX_LAYOUT } from './GuiVertexLayout';

interface BatchGpuBuffer {
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  uploadedVersion: number;
}

export class GuiShapeRenderer extends BaseRenderer {
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private bindGroupLayout!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private viewportBuffer!: GPUBuffer;
  private viewportBindGroup!: GPUBindGroup;
  private batchBuffers = new WeakMap<GuiBatch, BatchGpuBuffer>();
  private readonly liveBatchBuffers = new Set<BatchGpuBuffer>();
  private readonly viewportData = new Float32Array(4);
  private initialized = false;

  prepare(engine: IEngine): void {
    if (this.initialized && this.engine.device === engine.device) return;
    if (this.initialized) this.destroy();
    this.engine = engine;
    const { device } = engine;
    try {
      this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const generated = getBuiltin2dUiShader(device, 'gui-shape', [this.bindGroupLayout]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
    this.viewportBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
      this.viewportBindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewportBuffer } }],
      });
      this.initialized = true;
    } catch (error) {
      this.viewportBuffer?.destroy();
      this.clearPipelineCache();
      this.initialized = false;
      throw error;
    }
  }

  render(passEncoder: GPURenderPassEncoder, batch: GuiBatch): void {
    if (!this.initialized || batch.vertexCount <= 0) return;
    const pipeline = this.getPipeline();

    const viewport = this.viewportData;
    viewport[0] = this.engine.displayWidth;
    viewport[1] = this.engine.displayHeight;
    viewport[2] = 0;
    viewport[3] = 0;
    writeBuffer(this.engine.device.queue, this.viewportBuffer, 0, viewport);

    const vertexBuffer = this.uploadBatch(batch);
    if (!vertexBuffer) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, this.viewportBindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(batch.vertexCount);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this.getPipelineKey();
    this.addPipelineWarmup(plan, key, 'GUI shapes', () => this.pipelineDescriptor(), this.engine.device);
  }

  releaseBatch(batch: GuiBatch): void {
    const gpuBuffer = this.batchBuffers.get(batch);
    if (!gpuBuffer) return;
    gpuBuffer.vertexBuffer.destroy();
    this.liveBatchBuffers.delete(gpuBuffer);
    this.batchBuffers.delete(batch);
  }

  private uploadBatch(batch: GuiBatch): GPUBuffer | null {
    const usedByteLength = batch.vertexCount * GUI_SHAPE_FLOATS_PER_VERTEX * 4;
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

  destroy(): void {
    if (!this.initialized) return;
    this.viewportBuffer.destroy();
    for (const buffer of this.liveBatchBuffers) buffer.vertexBuffer.destroy();
    this.liveBatchBuffers.clear();
    this.batchBuffers = new WeakMap<GuiBatch, BatchGpuBuffer>();
    this.clearPipelineCache();
    this.initialized = false;
  }

  private getPipeline(): GPURenderPipeline {
    const key = this.getPipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this.pipelineDescriptor()));
  }

  private getPipelineKey(): string {
    return `gui-shape|${this.reverseZ ? 1 : 0}|${this.msaaSamples}`;
  }

  private pipelineDescriptor(): GPURenderPipelineDescriptor {
    const { format } = this.engine;
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shader,
        entryPoint: 'vs_main',
        buffers: [GUI_SHAPE_VERTEX_LAYOUT.gpu],
      },
      fragment: {
        module: this.shader,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
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
