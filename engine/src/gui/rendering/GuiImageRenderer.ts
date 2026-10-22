import type {RenderCommandContext} from '../../core/RenderCommandContext';
import {GuiGpuResources} from './GuiGpuResources';
import {guiLinearSurface,updateGuiViewport,type GuiRenderSurface} from './GuiRenderSurface';
import type { IEngine } from '../../core/IEngine';
import type { SampleableTextureSource } from '../../material/BasicMaterial';
import type { GuiImageSource } from '../components/GuiImage';
import { GUI_IMAGE_FLOATS_PER_VERTEX, GuiImageBatch, type GuiImageGroup } from './GuiImageBatch';
import { BaseRenderer } from '../../renderer/BaseRenderer';
import type { PipelineWarmupPlan } from '../../renderer/PipelineWarmup';
import { getBuiltin2dUiShader } from '../../shader/BuiltinRenderShader';
import { GUI_TEXTURED_VERTEX_LAYOUT } from './GuiVertexLayout';
import {guiImageSourceReady} from './GuiImageSources';

interface ImageGpuData {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  ownsTexture: boolean;
  version?: string | undefined;
}

export class GuiImageRenderer extends BaseRenderer {
  surface: GuiRenderSurface | null = null;
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private viewportBindGroupLayout!: GPUBindGroupLayout;
  private imageBindGroupLayout!: GPUBindGroupLayout;
  private shader!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private resources!:GuiGpuResources;
  private readonly viewportKey={};
  private viewportGroups=new WeakMap<GPUBuffer,GPUBindGroup>();
  private viewportVersion=0;
  private readonly viewportData = new Float32Array(4);
  private readonly groups=new Map<GuiImageBatch,Set<GuiImageGroup>>();
  private readonly batchVersions=new Map<GuiImageBatch,number>();
  private readonly batchSources=new Map<GuiImageBatch,Set<NonNullable<GuiImageSource>>>();
  private readonly sourceUsers=new Map<NonNullable<GuiImageSource>,Set<GuiImageBatch>>();
  private imageCache = new WeakMap<object, ImageGpuData>();
  private readonly liveImageData = new Set<ImageGpuData>();
  private defaultTexture!: GPUTexture;
  private sampler: GPUSampler | null = null;
  private initialized = false;
  private viewportUploaded = false;

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
    const viewport=this.resources.reserve(this.viewportKey,16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'gui-image:viewport');
    this.viewportGroups.set(viewport,device.createBindGroup({layout:this.viewportBindGroupLayout,entries:[{binding:0,resource:{buffer:viewport}}]}));
    this.defaultTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.resources.own(this.defaultTexture);
    device.queue.writeTexture({ texture: this.defaultTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
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

  render(passEncoder: GPURenderPassEncoder, batch: GuiImageBatch, context?:RenderCommandContext, range?: {group: GuiImageGroup; first: number; count: number}): void {
    if (!this.initialized) return;
    this.syncBatch(batch);
    if(batch.groups.length<1)return;
    const viewport = this.viewportData;
    if (updateGuiViewport(viewport,this.surface,this.engine,this.viewportUploaded)) {
      this.viewportVersion++;
      this.viewportUploaded = true;
    }
    const viewportBuffer=this.resources.upload(this.viewportKey,this.viewportVersion,viewport,16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'gui-image:viewport',context);
    let viewportGroup=this.viewportGroups.get(viewportBuffer);if(!viewportGroup){viewportGroup=this.engine.device.createBindGroup({layout:this.viewportBindGroupLayout,entries:[{binding:0,resource:{buffer:viewportBuffer}}]});this.viewportGroups.set(viewportBuffer,viewportGroup);}

    passEncoder.setBindGroup(0, viewportGroup);
    for (const group of range ? [range.group] : batch.groups) {
      const imageData = this.getImageGpuData(group.source);
      if(!imageData)continue;
      if(imageData.ownsTexture)this.resources.retain(imageData.texture,context);
      const vertexBuffer = this.uploadGroup(group,context);
      if (!vertexBuffer) continue;
      const linearTexture = imageData.texture.format.endsWith('-srgb') || ['rgba16float','rgba32float','rg11b10ufloat'].includes(imageData.texture.format);
      passEncoder.setPipeline(this.getPipeline(linearTexture));
      passEncoder.setBindGroup(1, imageData.bindGroup);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.draw(range?.count ?? group.vertexCount, 1, range?.first ?? 0);
    }
  }

  syncBatch(batch: GuiImageBatch): void {
    if (!this.initialized) return;
    if(this.batchVersions.get(batch)!==batch.layoutVersion){
      this.syncSources(batch,new Set(batch.groups.map(group=>group.source)));
      const previous=this.groups.get(batch)??new Set<GuiImageGroup>(),current=new Set(batch.groups);for(const group of previous)if(!current.has(group))this.resources.release(group);this.groups.set(batch,current);
      this.batchVersions.set(batch,batch.layoutVersion);
    }
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this.getPipelineKey();
    this.addPipelineWarmup(plan, key, 'GUI images', () => this.pipelineDescriptor(), this.engine.device);
  }

  releaseBatch(batch: GuiImageBatch): void {for(const group of this.groups.get(batch)??[])this.resources.release(group);this.groups.delete(batch);this.batchVersions.delete(batch);this.syncSources(batch,new Set());this.batchSources.delete(batch);}

  destroy(): void {
    if(!this.initialized)return;
    this.resources.destroy();this.viewportGroups=new WeakMap();this.viewportUploaded=false;this.viewportVersion=0;
    this.groups.clear();this.batchVersions.clear();this.batchSources.clear();this.sourceUsers.clear();this.liveImageData.clear();this.imageCache=new WeakMap();
    this.sampler=null;
    this.clearPipelineCache();this.initialized=false;
  }

  private uploadGroup(group: GuiImageGroup,context?:RenderCommandContext): GPUBuffer | null {
    const size=group.vertexCount*GUI_IMAGE_FLOATS_PER_VERTEX*4;if(!size)return null;
    return this.resources.upload(group,group.version,group.vertexData,size,GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,'gui-image:vertices',context);
  }

  private syncSources(batch:GuiImageBatch,current:Set<NonNullable<GuiImageSource>>):void {
    const previous=this.batchSources.get(batch)??new Set<NonNullable<GuiImageSource>>();
    for(const source of previous)if(!current.has(source)){
      const users=this.sourceUsers.get(source);users?.delete(batch);
      if(!users?.size){this.sourceUsers.delete(source);this.invalidateSource(source);}
    }
    for(const source of current)if(!previous.has(source)){let users=this.sourceUsers.get(source);if(!users){users=new Set();this.sourceUsers.set(source,users);}users.add(batch);}
    this.batchSources.set(batch,current);
  }
  invalidateSource(source:GuiImageSource):void {
    if(!source)return;const previous=this.imageCache.get(source);this.imageCache.delete(source);if(previous){this.liveImageData.delete(previous);this.retireImage(previous)}
  }
  private retireImage(data:ImageGpuData):void {if(data.ownsTexture)this.resources.retire(data.texture,true);}
  private getImageGpuData(source: NonNullable<GuiImageSource>): ImageGpuData|null {
    if(!guiImageSourceReady(source))return null;
    const cacheKey = isGpuTextureSource(source) ? source : source as object;
    const dimensions=isSampleableTextureSource(source)?source.texture:source;
    const sourceVersion = JSON.stringify([isSampleableTextureSource(source)?source.version:0,'width'in dimensions?dimensions.width:0,'height'in dimensions?dimensions.height:0,'currentSrc'in source?source.currentSrc:undefined]);
    const cached = this.imageCache.get(cacheKey);
    if (cached && cached.version === sourceVersion) return cached;
    const texture = isGpuTextureSource(source)
      ? source
      : isSampleableTextureSource(source)
        ? source.texture
        : this.createTextureFromImage(source);
    const sampler = this.sampler;
    if (!sampler) throw new Error('GuiImageRenderer sampler owner is not prepared.');
    const ownsTexture=!isGpuTextureSource(source)&&!isSampleableTextureSource(source);
    if(ownsTexture)this.resources.own(texture);
    let data:ImageGpuData;try{data = {
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
    }catch(error){if(ownsTexture)this.resources.retire(texture);throw error;}
    if (cached) {
      this.liveImageData.delete(cached);
      this.retireImage(cached);
    }
    this.imageCache.set(cacheKey, data);
    if (data.ownsTexture) this.liveImageData.add(data);
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
    try{this.engine.device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height]);return texture;}catch(error){texture.destroy();throw error;}
  }

  private getPipeline(linearTexture = false): GPURenderPipeline {
    const key = this.getPipelineKey(linearTexture);
    return this.getCachedPipeline(key, () => this.engine.device.createRenderPipeline(this.pipelineDescriptor(linearTexture)));
  }

  private getPipelineKey(linearTexture = false): string {
    return `gui-image|${this.surface?.format??this.engine.format}|${this.reverseZ ? 1 : 0}|${this.msaaSamples}|${linearTexture?1:0}`;
  }

  private pipelineDescriptor(linearTexture = false): GPURenderPipelineDescriptor {
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
        constants: {GUI_LINEAR_OUTPUT:guiLinearSurface(this.surface,this.engine)?1:0,GUI_LINEAR_TEXTURE:linearTexture?1:0},
        targets: [{ format, blend: { color: alphaBlend, alpha: {...alphaBlend,srcFactor:'one'} } }],
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

function isHtmlImageElement(source: NonNullable<GuiImageSource>): source is HTMLImageElement {
  return typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement;
}
