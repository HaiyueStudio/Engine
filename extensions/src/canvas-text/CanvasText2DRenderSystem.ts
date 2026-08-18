import {
  beginRenderCommandPass,
  getExtensionGPUResourceTracker,
  requireEngineDevice,
  type IEngine,
  type RenderCommandContext,
} from '@haiyue/engine/extension-authoring';
import { Transform2D } from '@haiyue/engine/components';
import { Entity, type World } from '@haiyue/engine/ecs';
import { CanvasTextComponent } from './CanvasTextComponent';
import { RenderSystem2DBase, type RenderSystem2DBaseOptions } from '../utils/RenderSystem2DBase';
import {
  createCamera2DGpu,
  createObject2DLayout,
  createTexture2DGpu,
  destroyCamera2DGpu,
  destroyTexture2DGpu,
  writeObjectMatrixIfChanged,
  type Camera2DGpu,
  type Object2DGpu,
  type Texture2DGpu,
} from '../utils/render2dGpu';
import canvasText2dWgsl from '../shaders/generated/2d-ui-canvas-text-2d.generated.wgsl';

export type CanvasText2DRenderSystemOptions = RenderSystem2DBaseOptions;

const CANVAS_TEXT_2D_WGSL = canvasText2dWgsl;

interface EntityGpu {
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  vertexData: Float32Array;
  vertexDirty: boolean;
  vertexWidth: number;
  vertexHeight: number;
  objectGpu: Object2DGpu;
  texture: GPUTexture | null;
  textureSource: unknown;
  textureVersion: number;
  textureWidth: number;
  textureHeight: number;
  textureBindGroup: GPUBindGroup | null;
}

function textureSize(source: ImageBitmap | HTMLCanvasElement | HTMLImageElement): { width: number; height: number } {
  return {
    width: Math.max(1, source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width),
    height: Math.max(1, source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height),
  };
}

export class CanvasText2DRenderSystem extends RenderSystem2DBase {
  private rendererReady = false;

  private cameraGpu!: Camera2DGpu;
  private objectLayout!: GPUBindGroupLayout;
  private textureGpu!: Texture2DGpu;
  private shaderModule!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private pipelineCache = new Map<number, GPURenderPipeline>();
  private entityGpu = new Map<number, EntityGpu>();

  constructor(engine: IEngine, cameraEntity: Entity, options: CanvasText2DRenderSystemOptions = {}) {
    super(
      { all: [CanvasTextComponent, Transform2D] },
      engine,
      cameraEntity,
      options,
      'CanvasText2DRenderSystem',
    );
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    const { device } = context;
    if (!this.rendererReady) this.prepare();
    const liveEntities = this.beginLiveEntityTracking();

    if (!this.writeCameraBuffer(device.queue, this.cameraGpu.buffer, context)) return this;

    const { passEncoder, ownsPass } = beginRenderCommandPass(context);
    passEncoder.setPipeline(this.getPipeline(
      context.view?.reverseZ ?? this.engine.reverseZ,
      context.view?.sampleCount ?? this.engine.msaaSamples,
    ));
    passEncoder.setBindGroup(0, this.cameraGpu.bindGroup);

    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (!this.isEntityRenderable(entity)) continue;
      const component = entity.getComponent(CanvasTextComponent);
      if (!component) continue;
      const textureBindGroup = this.getTextureBindGroup(entity, component);
      const gpu = this.getEntityGpu(entity);
      const vertices = this.buildVertices(component, gpu);
      let shouldUploadVertices = gpu.vertexDirty;
      if (vertices.byteLength > gpu.vertexBufferSize) {
        getExtensionGPUResourceTracker(this.engine)?.untrackBuffer(gpu.vertexBuffer);
        gpu.vertexBuffer.destroy();
        gpu.vertexBufferSize = Math.max(vertices.byteLength, gpu.vertexBufferSize * 2);
        gpu.vertexBuffer = device.createBuffer({
          size: gpu.vertexBufferSize,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        getExtensionGPUResourceTracker(this.engine)?.trackBuffer(gpu.vertexBuffer, 'CanvasText2D.vertexBuffer', gpu.vertexBufferSize);
        shouldUploadVertices = true;
      }
      if (shouldUploadVertices) {
        device.queue.writeBuffer(gpu.vertexBuffer, 0, vertices.buffer as ArrayBuffer, vertices.byteOffset, vertices.byteLength);
        gpu.vertexDirty = false;
      }
      const worldMatrix = this.getWorldMatrix2D(entity, context);
      writeObjectMatrixIfChanged(device.queue, gpu.objectGpu, worldMatrix);
      passEncoder.setBindGroup(1, gpu.objectGpu.bindGroup);
      passEncoder.setBindGroup(2, textureBindGroup);
      passEncoder.setVertexBuffer(0, gpu.vertexBuffer);
      passEncoder.draw(6);
      this.markEntityLive(entity);
    }

    if (ownsPass) passEncoder.end();
    this.releaseEntityGpuEntriesNotIn(this.entityGpu, gpu => this.destroyEntityGpu(gpu), liveEntities);
    return this;
  }

  override destroy(): this {
    this.releaseGpuResourcesForRecovery();
    return super.destroy();
  }

  protected releaseGpuResourcesForRecovery(): void {
    if (this.cameraGpu) destroyCamera2DGpu(this.cameraGpu);
    if (this.textureGpu) destroyTexture2DGpu(this.textureGpu);
    this.destroyEntityGpuEntries(this.entityGpu, gpu => this.destroyEntityGpu(gpu));
    this.pipelineCache.clear();
    this.rendererReady = false;
  }

  private prepare(): void {
    this.rendererReady = true;
    const device = requireEngineDevice(this.engine);
    this.cameraGpu = createCamera2DGpu(device, getExtensionGPUResourceTracker(this.engine));
    this.objectLayout = createObject2DLayout(device);
    this.textureGpu = createTexture2DGpu(device, 0, getExtensionGPUResourceTracker(this.engine));
    this.shaderModule = device.createShaderModule({ code: CANVAS_TEXT_2D_WGSL });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.cameraGpu.layout, this.objectLayout, this.textureGpu.layout],
    });
  }

  private getPipeline(reverseZ: boolean, sampleCount: 1 | 4): GPURenderPipeline {
    const key = (reverseZ ? 1 : 0) | ((sampleCount > 1 ? 1 : 0) << 1);
    const cached = this.pipelineCache.get(key);
    if (cached) return cached;

    const device = requireEngineDevice(this.engine);
    const { format } = this.engine;
    const pipeline = device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module: this.shaderModule,
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
        format: this.engine.getDepthFormat(reverseZ),
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
      multisample: { count: sampleCount },
    });
    this.pipelineCache.set(key, pipeline);
    return pipeline;
  }

  private getEntityGpu(entity: Entity): EntityGpu {
    return this.getOrCreateEntityGpu(this.entityGpu, entity, () => {
      const device = requireEngineDevice(this.engine);
      const gpu = {
        vertexBuffer: device.createBuffer({ size: 96, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
        vertexBufferSize: 96,
        vertexData: new Float32Array(24),
        vertexDirty: true,
        vertexWidth: 0,
        vertexHeight: 0,
        objectGpu: this.createObjectGpu(this.objectLayout),
        texture: null,
        textureSource: null,
        textureVersion: -1,
        textureWidth: 0,
        textureHeight: 0,
        textureBindGroup: null,
      };
      getExtensionGPUResourceTracker(this.engine)?.trackBuffer(gpu.vertexBuffer, 'CanvasText2D.vertexBuffer', gpu.vertexBufferSize);
      return gpu;
    });
  }

  private getTextureBindGroup(entity: Entity, component: CanvasTextComponent): GPUBindGroup {
    const device = requireEngineDevice(this.engine);
    const source = component.material.texture;
    if (!source || !(source instanceof ImageBitmap || source instanceof HTMLCanvasElement || source instanceof HTMLImageElement)) {
      return this.textureGpu.fallbackBindGroup;
    }
    const gpu = this.getEntityGpu(entity);
    const size = textureSize(source);
    const textureVersion = component.material.textureVersion;
    if (
      gpu.textureBindGroup &&
      gpu.textureSource === source &&
      gpu.textureVersion === textureVersion &&
      gpu.textureWidth === size.width &&
      gpu.textureHeight === size.height
    ) {
      return gpu.textureBindGroup;
    }

    const canReuseTexture = gpu.texture && gpu.textureWidth === size.width && gpu.textureHeight === size.height;
    if (!canReuseTexture) {
      if (gpu.texture) getExtensionGPUResourceTracker(this.engine)?.untrackTexture(gpu.texture);
      gpu.texture?.destroy();
      const texture = device.createTexture({
        size: [size.width, size.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      gpu.texture = texture;
      getExtensionGPUResourceTracker(this.engine)?.trackTexture(texture, 'CanvasText2D.texture', size.width * size.height * 4);
      gpu.textureBindGroup = device.createBindGroup({
        layout: this.textureGpu.layout,
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: this.textureGpu.sampler },
        ],
      });
    }
    const texture = gpu.texture;
    const textureBindGroup = gpu.textureBindGroup;
    if (!texture || !textureBindGroup) throw new Error('CanvasText2D texture GPU state is incomplete.');
    device.queue.copyExternalImageToTexture({ source }, { texture }, [size.width, size.height]);
    gpu.textureSource = source;
    gpu.textureVersion = textureVersion;
    gpu.textureWidth = size.width;
    gpu.textureHeight = size.height;
    return textureBindGroup;
  }

  private buildVertices(component: CanvasTextComponent, gpu: EntityGpu): Float32Array {
    const width = Math.max(1, Number(component.style.width ?? 256));
    const height = Math.max(1, Number(component.style.height ?? 96));
    if (gpu.vertexWidth !== width || gpu.vertexHeight !== height) {
      gpu.vertexWidth = width;
      gpu.vertexHeight = height;
      gpu.vertexData.set([
        0, 0, 0, 1,
        width, 0, 1, 1,
        width, height, 1, 0,
        0, 0, 0, 1,
        width, height, 1, 0,
        0, height, 0, 0,
      ]);
      gpu.vertexDirty = true;
    }
    return gpu.vertexData;
  }

  private destroyEntityGpu(gpu: EntityGpu): void {
    getExtensionGPUResourceTracker(this.engine)?.untrackBuffer(gpu.vertexBuffer);
    gpu.vertexBuffer.destroy();
    this.destroyObjectGpu(gpu.objectGpu);
    if (gpu.texture) getExtensionGPUResourceTracker(this.engine)?.untrackTexture(gpu.texture);
    gpu.texture?.destroy();
  }
}
