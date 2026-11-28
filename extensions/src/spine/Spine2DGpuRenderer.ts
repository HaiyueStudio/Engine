import {
  alignUp4,
  getExtensionGPUResourceTracker,
  requireEngineDevice,
  type IEngine,
} from '@haiyue/engine/extension-authoring';
import { EngineError, EngineErrorCode } from '@haiyue/engine';
import { ErrorDomain, ErrorRecovery } from '@haiyue/engine/core';
import { createAbortError } from '@haiyue/engine/experimental/async';
import { Spine2DComponent } from './Spine2DComponent';
import { SpineFloatBuilder } from './SpineFloatBuilder';
import { resolveAtlasPageImageUrl, type AtlasRegion } from './SpineAtlasParser';
import { type SpineDrawBatch } from './SpineVertexBuilder';
import {
  createCamera2DGpu,
  createObject2DLayout,
  createTexture2DGpu,
  destroyCamera2DGpu,
  destroyTexture2DGpu,
  type Camera2DGpu,
  type Texture2DGpu,
} from '../utils/render2dGpu';
import spine2dWgsl from '../shaders/generated/2d-ui-spine2d.generated.wgsl';

export interface SpineBufferDirtyRange {
  byteOffset: number;
  byteLength: number;
}

export interface AtlasPageGpu {
  image: HTMLImageElement;
  texture: GPUTexture;
  textureBindGroup: GPUBindGroup;
  width: number;
  height: number;
}

export interface SpineRuntimeGpu {
  pages: Map<string, AtlasPageGpu>;
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  debugVertexBuffer: GPUBuffer;
  debugVertexBufferSize: number;
  batches: SpineDrawBatch[];
  mergedDirtyRanges: SpineBufferDirtyRange[];
  mergedDirtyRangePool: SpineBufferDirtyRange[];
  allocationStats: { dirtyRangePoolMisses: number };
}

export interface SpineRuntimeGpuBuffers {
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  debugVertexBuffer: GPUBuffer;
  debugVertexBufferSize: number;
}

const SPINE_WGSL = spine2dWgsl;

type SpinePipelineMode = 'normal' | 'additive' | 'line';

export class Spine2DGpuRenderer {
  private engine: IEngine | null = null;
  private cameraGpu: Camera2DGpu | null = null;
  private textureGpu: Texture2DGpu | null = null;
  private objectLayoutGpu: GPUBindGroupLayout | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private reverseZ = false;
  private sampleCount: 1 | 4 = 1;
  private readonly pendingBufferDestroys = new Set<GPUBuffer>();

  get cameraBuffer(): GPUBuffer {
    return this.requirePrepared().cameraGpu.buffer;
  }

  get objectLayout(): GPUBindGroupLayout {
    return this.requirePrepared().objectLayout;
  }

  prepare(engine: IEngine): void {
    if (this.engine === engine && this.cameraGpu && this.textureGpu && this.objectLayoutGpu) return;
    if (this.engine && this.engine !== engine) this.destroy();
    this.engine = engine;
    const device = requireEngineDevice(engine);
    this.cameraGpu = createCamera2DGpu(device, getExtensionGPUResourceTracker(engine));
    this.objectLayoutGpu = createObject2DLayout(device);
    this.textureGpu = createTexture2DGpu(device, 255, getExtensionGPUResourceTracker(engine));
    this.shaderModule = device.createShaderModule({ code: SPINE_WGSL });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.cameraGpu.layout, this.objectLayoutGpu, this.textureGpu.layout],
    });
  }

  destroy(): void {
    if (this.cameraGpu) destroyCamera2DGpu(this.cameraGpu);
    if (this.textureGpu) destroyTexture2DGpu(this.textureGpu);
    this.flushPendingBufferDestroys();
    this.cameraGpu = null;
    this.textureGpu = null;
    this.objectLayoutGpu = null;
    this.shaderModule = null;
    this.pipelineLayout = null;
    this.pipelines.clear();
  }

  setRenderView(reverseZ: boolean, sampleCount: 1 | 4): void {
    this.reverseZ = reverseZ;
    this.sampleCount = sampleCount;
  }

  createRuntimeBuffers(): SpineRuntimeGpuBuffers {
    const engine = this.requireEngine();
    const vertexBufferSize = 1024;
    const debugVertexBufferSize = 1024;
    const vertexBuffer = engine.device.createBuffer({
      size: vertexBufferSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    try {
      getExtensionGPUResourceTracker(engine)?.trackBuffer(vertexBuffer, 'Spine2D.vertexBuffer', vertexBufferSize);
      const debugVertexBuffer = engine.device.createBuffer({
        size: debugVertexBufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      try {
        getExtensionGPUResourceTracker(engine)?.trackBuffer(debugVertexBuffer, 'Spine2D.debugVertexBuffer', debugVertexBufferSize);
      } catch (error) {
        getExtensionGPUResourceTracker(engine)?.untrackBuffer(debugVertexBuffer);
        debugVertexBuffer.destroy();
        throw error;
      }
      return { vertexBuffer, vertexBufferSize, debugVertexBuffer, debugVertexBufferSize };
    } catch (error) {
      getExtensionGPUResourceTracker(engine)?.untrackBuffer(vertexBuffer);
      vertexBuffer.destroy();
      throw error;
    }
  }

  async loadAtlasPages(
    component: Spine2DComponent,
    atlas: Map<string, AtlasRegion>,
    signal?: AbortSignal,
  ): Promise<Map<string, AtlasPageGpu>> {
    const engine = this.requireEngine();
    const textureGpu = this.requirePrepared().textureGpu;
    const pageNames = Array.from(new Set(Array.from(atlas.values()).map(region => region.page).filter(Boolean)));
    const pages = new Map<string, AtlasPageGpu>();
    const textures = new Set<GPUTexture>();
    const tracker = getExtensionGPUResourceTracker(engine);
    const names = pageNames.length ? pageNames : [''];
    try {
      for (const pageName of names) {
        const imageUrl = resolveAtlasPageImageUrl({
          atlasUrl: component.atlasUrl,
          imageUrl: component.imageUrl,
          imageUrls: component.imageUrls,
        }, atlas, pageName);
        const image = await loadImage(imageUrl, signal);
        if (signal?.aborted) throw createAbortError('Spine load aborted.', signal.reason);
        if (this.engine !== engine || this.textureGpu !== textureGpu) throw spineRendererStateError();
        const width = Math.max(1, image.naturalWidth || image.width);
        const height = Math.max(1, image.naturalHeight || image.height);
        const texture = engine.device.createTexture({
          size: [width, height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        textures.add(texture);
        tracker?.trackTexture(texture, 'Spine2D.atlasTexture', width * height * 4);
        engine.device.queue.copyExternalImageToTexture({ source: image }, { texture }, [width, height]);
        const textureBindGroup = engine.device.createBindGroup({
          layout: textureGpu.layout,
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: textureGpu.sampler },
          ],
        });
        pages.set(pageName, { image, texture, textureBindGroup, width, height });
      }
      return pages;
    } catch (error) {
      for (const texture of textures) {
        tracker?.untrackTexture(texture);
        texture.destroy();
      }
      throw error;
    }
  }

  /** Own pages and buffers until the runtime factory successfully accepts them. */
  createRuntime<T>(pages: Map<string, AtlasPageGpu>, build: (buffers: SpineRuntimeGpuBuffers) => T, signal?: AbortSignal): T {
    let buffers: SpineRuntimeGpuBuffers | undefined;
    try {
      if (signal?.aborted) throw createAbortError('Spine load aborted.', signal.reason);
      buffers = this.createRuntimeBuffers();
      return build(buffers);
    } catch (error) {
      if (buffers) this.destroyRuntime({ ...buffers, pages, batches: [] });
      else {
        for (const page of pages.values()) this.releaseAtlasPage(page);
        pages.clear();
      }
      throw error;
    }
  }

  writeVertices(runtime: SpineRuntimeGpu, vertices: SpineFloatBuilder, dirtyRanges: SpineBufferDirtyRange[]): void {
    const engine = this.requireEngine();
    if (vertices.byteLength > runtime.vertexBufferSize) {
      const nextSize = nextGpuBufferSize(vertices.byteLength, runtime.vertexBufferSize);
      const nextBuffer = engine.device.createBuffer({
        size: nextSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.deferBufferDestroy(runtime.vertexBuffer);
      runtime.vertexBuffer = nextBuffer;
      runtime.vertexBufferSize = nextSize;
      getExtensionGPUResourceTracker(engine)?.trackBuffer(runtime.vertexBuffer, 'Spine2D.vertexBuffer', nextSize);
      engine.device.queue.writeBuffer(runtime.vertexBuffer, 0, vertices.data.buffer as ArrayBuffer, 0, vertices.byteLength);
      return;
    }
    this.writeDirtyRanges(runtime, runtime.vertexBuffer, vertices, dirtyRanges, runtime.mergedDirtyRanges);
  }

  writeDebugVertices(runtime: SpineRuntimeGpu, vertices: SpineFloatBuilder, dirtyRanges: SpineBufferDirtyRange[]): void {
    const engine = this.requireEngine();
    if (vertices.byteLength > runtime.debugVertexBufferSize) {
      const nextSize = nextGpuBufferSize(vertices.byteLength, runtime.debugVertexBufferSize);
      const nextBuffer = engine.device.createBuffer({
        size: nextSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.deferBufferDestroy(runtime.debugVertexBuffer);
      runtime.debugVertexBuffer = nextBuffer;
      runtime.debugVertexBufferSize = nextSize;
      getExtensionGPUResourceTracker(engine)?.trackBuffer(runtime.debugVertexBuffer, 'Spine2D.debugVertexBuffer', nextSize);
      engine.device.queue.writeBuffer(runtime.debugVertexBuffer, 0, vertices.data.buffer as ArrayBuffer, 0, vertices.byteLength);
      return;
    }
    this.writeDirtyRanges(runtime, runtime.debugVertexBuffer, vertices, dirtyRanges, runtime.mergedDirtyRanges);
  }

  drawRuntime(
    pass: GPURenderPassEncoder,
    runtime: SpineRuntimeGpu,
    objectBindGroup: GPUBindGroup,
    debugVertexCount: number,
  ): void {
    const { cameraGpu, textureGpu } = this.requirePrepared();
    pass.setPipeline(this.getPipeline('normal'));
    pass.setBindGroup(0, cameraGpu.bindGroup);
    pass.setBindGroup(1, objectBindGroup);
    pass.setVertexBuffer(0, runtime.vertexBuffer);
    let currentBlend: 'normal' | 'additive' = 'normal';
    let currentPage = '';
    for (const batch of runtime.batches) {
      if (batch.blend !== currentBlend) {
        currentBlend = batch.blend;
        pass.setPipeline(this.getPipeline(currentBlend));
        pass.setBindGroup(0, cameraGpu.bindGroup);
        pass.setBindGroup(1, objectBindGroup);
        pass.setVertexBuffer(0, runtime.vertexBuffer);
      }
      if (batch.page !== currentPage) {
        currentPage = batch.page;
        pass.setBindGroup(2, runtime.pages.get(batch.page)?.textureBindGroup ?? textureGpu.fallbackBindGroup);
      }
      pass.draw(batch.vertexCount, 1, batch.firstVertex);
    }
    if (debugVertexCount > 0) {
      pass.setPipeline(this.getPipeline('line'));
      pass.setBindGroup(0, cameraGpu.bindGroup);
      pass.setBindGroup(1, objectBindGroup);
      pass.setBindGroup(2, textureGpu.fallbackBindGroup);
      pass.setVertexBuffer(0, runtime.debugVertexBuffer);
      pass.draw(debugVertexCount);
    }
  }

  destroyRuntime(runtime: Pick<SpineRuntimeGpu, 'vertexBuffer' | 'debugVertexBuffer' | 'pages' | 'batches'>): void {
    const engine = this.requireEngine();
    getExtensionGPUResourceTracker(engine)?.untrackBuffer(runtime.vertexBuffer);
    getExtensionGPUResourceTracker(engine)?.untrackBuffer(runtime.debugVertexBuffer);
    runtime.vertexBuffer.destroy();
    runtime.debugVertexBuffer.destroy();
    for (const page of runtime.pages.values()) this.releaseAtlasPage(page);
    runtime.pages.clear();
    runtime.batches.length = 0;
  }

  private releaseAtlasPage(page: AtlasPageGpu): void {
    const engine = this.requireEngine();
    getExtensionGPUResourceTracker(engine)?.untrackTexture(page.texture);
    page.texture.destroy();
  }

  private getPipeline(blend: SpinePipelineMode): GPURenderPipeline {
    const key = `${blend}:${this.reverseZ ? 1 : 0}:${this.sampleCount}`;
    const cached = this.pipelines.get(key);
    if (cached) return cached;
    const engine = this.requireEngine();
    const prepared = this.requirePrepared();
    const pipeline = engine.device.createRenderPipeline({
      layout: prepared.pipelineLayout,
      vertex: {
        module: prepared.shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32x4' },
          ],
        }],
      },
      fragment: {
        module: prepared.shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: engine.format,
          blend: {
            color: blend === 'additive'
              ? { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }
              : { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: blend === 'line' ? 'line-list' : 'triangle-list' },
      depthStencil: {
        format: engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: false,
        depthCompare: this.reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: this.sampleCount },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private writeDirtyRanges(
    runtime: SpineRuntimeGpu,
    buffer: GPUBuffer,
    vertices: SpineFloatBuilder,
    dirtyRanges: SpineBufferDirtyRange[],
    mergedRanges: SpineBufferDirtyRange[],
  ): void {
    const engine = this.requireEngine();
    for (const range of mergeDirtyRanges(
      dirtyRanges,
      mergedRanges,
      runtime.mergedDirtyRangePool,
      runtime.allocationStats,
    )) {
      if (range.byteLength <= 0) continue;
      engine.device.queue.writeBuffer(
        buffer,
        range.byteOffset,
        vertices.data.buffer as ArrayBuffer,
        range.byteOffset,
        range.byteLength,
      );
    }
  }

  private deferBufferDestroy(buffer: GPUBuffer): void {
    const engine = this.requireEngine();
    this.pendingBufferDestroys.add(buffer);
    void engine.device.queue.onSubmittedWorkDone().finally(() => {
      if (!this.pendingBufferDestroys.delete(buffer)) return;
      getExtensionGPUResourceTracker(engine)?.untrackBuffer(buffer);
      buffer.destroy();
    });
  }

  private flushPendingBufferDestroys(): void {
    const engine = this.engine;
    for (const buffer of this.pendingBufferDestroys) {
      if (engine) getExtensionGPUResourceTracker(engine)?.untrackBuffer(buffer);
      buffer.destroy();
    }
    this.pendingBufferDestroys.clear();
  }

  private requireEngine(): IEngine & { device: GPUDevice } {
    if (!this.engine) throw spineRendererStateError();
    requireEngineDevice(this.engine);
    return this.engine as IEngine & { device: GPUDevice };
  }

  private requirePrepared(): {
    cameraGpu: Camera2DGpu;
    textureGpu: Texture2DGpu;
    objectLayout: GPUBindGroupLayout;
    shaderModule: GPUShaderModule;
    pipelineLayout: GPUPipelineLayout;
  } {
    if (
      !this.cameraGpu
      || !this.textureGpu
      || !this.objectLayoutGpu
      || !this.shaderModule
      || !this.pipelineLayout
    ) {
      throw spineRendererStateError();
    }
    return {
      cameraGpu: this.cameraGpu,
      textureGpu: this.textureGpu,
      objectLayout: this.objectLayoutGpu,
      shaderModule: this.shaderModule,
      pipelineLayout: this.pipelineLayout,
    };
  }
}

function nextGpuBufferSize(requiredBytes: number, currentBytes: number): number {
  const required = Math.max(4, alignUp4(requiredBytes));
  let next = Math.max(1024, currentBytes);
  while (next < required) next *= 2;
  return next;
}

function mergeDirtyRanges(
  ranges: SpineBufferDirtyRange[],
  out: SpineBufferDirtyRange[],
  pool: SpineBufferDirtyRange[],
  allocationStats: { dirtyRangePoolMisses: number },
): SpineBufferDirtyRange[] {
  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a.byteOffset - b.byteOffset);
  out.length = 0;
  for (const range of ranges) {
    const last = out[out.length - 1];
    if (!last) {
      pushMergedRange(out, pool, range.byteOffset, range.byteLength, allocationStats);
      continue;
    }
    const lastEnd = last.byteOffset + last.byteLength;
    if (range.byteOffset <= lastEnd) {
      last.byteLength = Math.max(lastEnd, range.byteOffset + range.byteLength) - last.byteOffset;
    } else {
      pushMergedRange(out, pool, range.byteOffset, range.byteLength, allocationStats);
    }
  }
  return out;
}

function pushMergedRange(
  out: SpineBufferDirtyRange[],
  pool: SpineBufferDirtyRange[],
  byteOffset: number,
  byteLength: number,
  allocationStats: { dirtyRangePoolMisses: number },
): void {
  const index = out.length;
  let range = pool[index];
  if (!range) {
    range = { byteOffset, byteLength };
    pool.push(range);
    allocationStats.dirtyRangePoolMisses++;
  } else {
    range.byteOffset = byteOffset;
    range.byteLength = byteLength;
  }
  out.push(range);
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(createAbortError('Spine load aborted.', signal.reason)); return; }
    const image = new Image();
    const finish = (): void => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      finish();
      try { image.src = ''; } catch { /* A host may reject clearing src; cancellation still settles below. */ }
      reject(createAbortError('Spine load aborted.', signal?.reason));
    };
    image.crossOrigin = 'anonymous';
    image.onload = () => { finish(); resolve(image); };
    image.onerror = () => { finish(); reject(new EngineError(EngineErrorCode.AssetLoadFailed, `Failed to load Spine image: ${url}`, {
      domain: ErrorDomain.Component,
      recovery: ErrorRecovery.Retry,
      context: { url, resourceType: 'skeleton/spine-image' },
      path: 'spine.atlas.pages',
    })); };
    signal?.addEventListener('abort', abort, { once: true });
    try { image.src = url; } catch (error) { finish(); reject(error); }
  });
}

function spineRendererStateError(): EngineError {
  return new EngineError(EngineErrorCode.RendererResourceNotReady, 'Spine2DGpuRenderer is not prepared.', {
    domain: ErrorDomain.Component,
    recovery: ErrorRecovery.TerminateRuntime,
    path: 'spine.renderer',
  });
}
