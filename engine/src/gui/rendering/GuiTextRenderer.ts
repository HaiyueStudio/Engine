import type {RenderCommandContext} from '../../core/RenderCommandContext';
import {GuiGpuResources} from './GuiGpuResources';
import {guiLinearSurface,updateGuiViewport,type GuiRenderSurface} from './GuiRenderSurface';
import type { IEngine } from '../../core/IEngine';
import { BitmapFontData } from '../../font/BitmapFontData';
import { GuiTextBatch, GUI_TEXT_FLOATS_PER_VERTEX } from './GuiTextBatch';
import { BaseRenderer } from '../../renderer/BaseRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import { getBuiltinGuiShader } from '../../shader/BuiltinRenderShader';
import { GUI_TEXTURED_VERTEX_LAYOUT } from './GuiVertexLayout';

interface FontGpuData {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
}

export class GuiTextRenderer extends BaseRenderer {
  surface: GuiRenderSurface | null = null;
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private viewportBindGroupLayout!: GPUBindGroupLayout;
  private fontBindGroupLayout!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private resources!:GuiGpuResources;
  private readonly viewportKey={};
  private viewportGroups=new WeakMap<GPUBuffer,GPUBindGroup>();
  private viewportVersion=0;
  private readonly viewportData = new Float32Array(4);
  private fontCache = new Map<number, FontGpuData>();
  private defaultTexture!: GPUTexture;
  private sampler: GPUSampler | null = null;
  private initialized = false;
  private viewportUploaded = false;

  constructor(private readonly readAtlasPixels?: (canvas: HTMLCanvasElement) => Uint8Array) { super(); }

  prepare(engine: IEngine): void {
    if (this.initialized && this.engine.device === engine.device) return;
    if (this.initialized) this.destroy();
    this.engine = engine;
    this.resources=new GuiGpuResources(engine.device);
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
    const generated = getBuiltinGuiShader(device, 'gui-text', [
      this.viewportBindGroupLayout,
      this.fontBindGroupLayout,
    ]);
    this.shader = generated.module;
    this.pipelineLayout = generated.pipelineLayout;
    const viewport=this.resources.reserve(this.viewportKey,16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'gui-text:viewport');
    this.viewportGroups.set(viewport,device.createBindGroup({layout:this.viewportBindGroupLayout,entries:[{binding:0,resource:{buffer:viewport}}]}));
    this.defaultTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.resources.own(this.defaultTexture);
    device.queue.writeTexture(
      { texture: this.defaultTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
      this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this.initialized = true;
    } catch (error) {
      this.resources.destroy();

      this.sampler = null;
      this.clearPipelineCache();
      this.initialized = false;
      throw error;
    }
  }

  render(passEncoder: GPURenderPassEncoder, batch: GuiTextBatch, font: BitmapFontData, context?:RenderCommandContext, range?: {first: number; count: number}): void {
    if (!this.initialized || batch.vertexCount <= 0) return;
    const pipeline = this.getPipeline();

    const viewport = this.viewportData;
    if (updateGuiViewport(viewport,this.surface,this.engine,this.viewportUploaded)) {
      this.viewportVersion++;
      this.viewportUploaded = true;
    }
    const viewportBuffer=this.resources.upload(this.viewportKey,this.viewportVersion,viewport,16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'gui-text:viewport',context);
    let viewportGroup=this.viewportGroups.get(viewportBuffer);if(!viewportGroup){viewportGroup=this.engine.device.createBindGroup({layout:this.viewportBindGroupLayout,entries:[{binding:0,resource:{buffer:viewportBuffer}}]});this.viewportGroups.set(viewportBuffer,viewportGroup);}

    const vertexBuffer = this.uploadBatch(batch,context);
    const fontData = this.getFontGpuData(font);
    if (!vertexBuffer) return;
    this.resources.retain(fontData.texture,context);

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, viewportGroup);
    passEncoder.setBindGroup(1, fontData.bindGroup);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.draw(range?.count ?? batch.vertexCount, 1, range?.first ?? 0);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this.getPipelineKey();
    this.addPipelineWarmup(plan, key, 'GUI text', () => this.pipelineDescriptor(), this.engine.device);
  }

  releaseBatch(batch: GuiTextBatch): void {this.resources?.release(batch);}

  /** Retire an atlas only after the work submitted with its previous generation is complete. */
  releaseFont(font: BitmapFontData): void {
    const data=this.fontCache.get(font.id);if(!data)return;this.fontCache.delete(font.id);
    if(data.texture!==this.defaultTexture)this.resources.retire(data.texture,true);
  }

  private uploadBatch(batch: GuiTextBatch,context?:RenderCommandContext): GPUBuffer | null {
    const size=batch.vertexCount*GUI_TEXT_FLOATS_PER_VERTEX*4;if(!size)return null;
    return this.resources.upload(batch,batch.version,batch.vertexData,size,GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,'gui-text:vertices',context);
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
      const width = source.width;
      const height = source.height;
      texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      try {
        if (this.readAtlasPixels) {
          const pixels = this.readAtlasPixels(source as HTMLCanvasElement);
          if (pixels.byteLength !== width * height * 4) throw new RangeError('GUI font atlas requires tightly packed RGBA8 pixels.');
          device.queue.writeTexture({ texture }, new Uint8Array(pixels).buffer, { bytesPerRow: width * 4 }, [width, height]);
        } else {
          device.queue.copyExternalImageToTexture(
            { source: source as HTMLCanvasElement | ImageBitmap | HTMLImageElement }, { texture }, [width, height],
          );
        }
      } catch (error) {
        texture.destroy();
        throw error;
      }
    }

    if(texture!==this.defaultTexture)this.resources.own(texture);
    try{fontData = {
      texture,
      bindGroup: device.createBindGroup({
        layout: this.fontBindGroupLayout,
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: sampler },
        ],
      }),
    };
    }catch(error){if(texture!==this.defaultTexture)this.resources.retire(texture);throw error;}
    this.fontCache.set(font.id, fontData);
    return fontData;
  }

  destroy(): void {
    if(!this.initialized)return;
    this.resources.destroy();this.viewportGroups=new WeakMap();this.viewportUploaded=false;this.viewportVersion=0;
    this.fontCache.clear();
    this.sampler=null;
    this.clearPipelineCache();this.initialized=false;
  }

  private getPipeline(): GPURenderPipeline {
    const key = this.getPipelineKey();
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this.pipelineDescriptor()));
  }

  private getPipelineKey(): string {
    return `gui-text|${this.surface?.format??this.engine.format}|${this.reverseZ ? 1 : 0}|${this.msaaSamples}`;
  }

  private pipelineDescriptor(): GPURenderPipelineDescriptor {
    const format = this.surface?.format ?? this.engine.format;
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
        constants: {GUI_LINEAR_OUTPUT:guiLinearSurface(this.surface,this.engine)?1:0},
        buffers: [GUI_TEXTURED_VERTEX_LAYOUT.gpu],
      },
      fragment: {
        module: this.shader,
        entryPoint: 'fs_main',
        constants: {GUI_LINEAR_OUTPUT:guiLinearSurface(this.surface,this.engine)?1:0},
        targets: [{
          format,
          blend: { color: alphaBlend, alpha: {...alphaBlend,srcFactor:'one'} },
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
