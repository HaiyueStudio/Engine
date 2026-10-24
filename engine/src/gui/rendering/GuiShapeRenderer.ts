import type {RenderCommandContext} from '../../core/RenderCommandContext';
import {GuiGpuResources} from './GuiGpuResources';
import {guiLinearSurface,updateGuiViewport,type GuiRenderSurface} from './GuiRenderSurface';
import type { IEngine } from '../../core/IEngine';
import { GuiBatch, GUI_SHAPE_FLOATS_PER_VERTEX } from './GuiBatch';
import { BaseRenderer } from '../../renderer/BaseRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import { getBuiltinGuiShader } from '../../shader/BuiltinRenderShader';
import { GUI_SHAPE_VERTEX_LAYOUT } from './GuiVertexLayout';

export class GuiShapeRenderer extends BaseRenderer {
  surface: GuiRenderSurface | null = null;
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private bindGroupLayout!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private resources!:GuiGpuResources;
  private readonly viewportKey={};
  private viewportGroups=new WeakMap<GPUBuffer,GPUBindGroup>();
  private viewportVersion=0;
  private readonly viewportData = new Float32Array(4);
  private initialized = false;
  private viewportUploaded = false;

  prepare(engine: IEngine): void {
    if (this.initialized && this.engine.device === engine.device) return;
    if (this.initialized) this.destroy();
    this.engine = engine;
    this.resources=new GuiGpuResources(engine.device);
    const { device } = engine;
    try {
      this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const generated = getBuiltinGuiShader(device, 'gui-shape', [this.bindGroupLayout]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
    const viewport=this.resources.reserve(this.viewportKey,16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'gui-shape:viewport');
    this.viewportGroups.set(viewport,device.createBindGroup({layout:this.bindGroupLayout,entries:[{binding:0,resource:{buffer:viewport}}]}));
      this.initialized = true;
    } catch (error) {
      this.resources.destroy();
      this.clearPipelineCache();
      this.initialized = false;
      throw error;
    }
  }

  render(passEncoder: GPURenderPassEncoder, batch: GuiBatch, context?:RenderCommandContext, range?: {first: number; count: number}): void {
    if (!this.initialized || batch.vertexCount <= 0) return;
    const pipeline = this.getPipeline();

    const viewport = this.viewportData;
    if (updateGuiViewport(viewport,this.surface,this.engine,this.viewportUploaded)) {
      this.viewportVersion++;
      this.viewportUploaded = true;
    }
    const viewportBuffer=this.resources.upload(this.viewportKey,this.viewportVersion,viewport,16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'gui-shape:viewport',context);
    let viewportGroup=this.viewportGroups.get(viewportBuffer);if(!viewportGroup){viewportGroup=this.engine.device.createBindGroup({layout:this.bindGroupLayout,entries:[{binding:0,resource:{buffer:viewportBuffer}}]});this.viewportGroups.set(viewportBuffer,viewportGroup);}

    const vertexBuffer = this.uploadBatch(batch,context);
    if (!vertexBuffer) return;

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, viewportGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(range?.count ?? batch.vertexCount, 1, range?.first ?? 0);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this.getPipelineKey();
    this.addPipelineWarmup(plan, key, 'GUI shapes', () => this.pipelineDescriptor(), this.engine.device);
  }

  releaseBatch(batch: GuiBatch): void {this.resources?.release(batch);}

  private uploadBatch(batch: GuiBatch,context?:RenderCommandContext): GPUBuffer | null {
    const size=batch.vertexCount*GUI_SHAPE_FLOATS_PER_VERTEX*4;if(!size)return null;
    return this.resources.upload(batch,batch.version,batch.vertexData,size,GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,'gui-shape:vertices',context);
  }

  destroy(): void {
    if(!this.initialized)return;
    this.resources.destroy();this.viewportGroups=new WeakMap();this.viewportUploaded=false;this.viewportVersion=0;
    this.clearPipelineCache();this.initialized=false;
  }

  private getPipeline(): GPURenderPipeline {
    const key = this.getPipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this.pipelineDescriptor()));
  }

  private getPipelineKey(): string {
    return `gui-shape|${this.surface?.format??this.engine.format}|${this.reverseZ ? 1 : 0}|${this.msaaSamples}`;
  }

  private pipelineDescriptor(): GPURenderPipelineDescriptor {
    const format = this.surface?.format ?? this.engine.format;
    return {
      layout: this.pipelineLayout,
      vertex: {
        module: this.shader,
        entryPoint: 'vs_main',
        constants: {GUI_LINEAR_OUTPUT:guiLinearSurface(this.surface,this.engine)?1:0},
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
