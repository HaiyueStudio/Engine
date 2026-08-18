import { getExtensionGPUResourceTracker, requireEngineDevice, type IEngine } from '@haiyue/engine/extension-authoring';
import type { Tilemap2DComponent } from './Tilemap2DComponent';
import {
  createCamera2DGpu,
  createCamera2DLayout,
  createObject2DGpu,
  createObject2DLayout,
  destroyCamera2DGpu,
  destroyObject2DGpu,
  writeFloatBuffer,
  writeObjectMatrixIfChanged,
  type Camera2DGpu,
  type Object2DGpu,
} from '../utils/render2dGpu';
import tilemap2dWgsl from '../shaders/generated/2d-ui-tilemap2d.generated.wgsl';

const TILEMAP_WGSL = tilemap2dWgsl;

const TILEMAP_INITIAL_VERTEX_FLOATS = 36;
const TILEMAP_INITIAL_VERTEX_BYTES = TILEMAP_INITIAL_VERTEX_FLOATS * 4;

interface EntityGpu {
  objectGpu: Object2DGpu;
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  vertexData: Float32Array;
  vertexByteLength: number;
  vertexCount: number;
  tilemapSignature: string;
}

interface TilemapSignatureCache {
  version: number;
  signature: string;
}

interface TilemapSharedGpu {
  cameraLayout: GPUBindGroupLayout;
  objectLayout: GPUBindGroupLayout;
  shaderModule: GPUShaderModule;
  pipelineLayout: GPUPipelineLayout;
  pipelineCache: Map<number, GPURenderPipeline>;
}

const tilemapSharedGpuCache = new WeakMap<GPUDevice, TilemapSharedGpu>();

function getTilemapSharedGpu(device: GPUDevice): TilemapSharedGpu {
  let shared = tilemapSharedGpuCache.get(device);
  if (shared) return shared;

  const cameraLayout = createCamera2DLayout(device);
  const objectLayout = createObject2DLayout(device);
  const shaderModule = device.createShaderModule({ code: TILEMAP_WGSL });
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [cameraLayout, objectLayout],
  });
  shared = {
    cameraLayout,
    objectLayout,
    shaderModule,
    pipelineLayout,
    pipelineCache: new Map(),
  };
  tilemapSharedGpuCache.set(device, shared);
  return shared;
}

export class Tilemap2DRenderer {
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;

  private engine!: IEngine;
  private cameraGpu!: Camera2DGpu;
  private objectLayout!: GPUBindGroupLayout;
  private shaderModule!: GPUShaderModule;
  private pipelineLayout!: GPUPipelineLayout;
  private sharedGpu!: TilemapSharedGpu;
  private entityCache = new Map<number, EntityGpu>();
  private signatureCache = new WeakMap<Tilemap2DComponent, TilemapSignatureCache>();
  private initialized = false;

  prepare(engine: IEngine): void {
    if (this.initialized) return;
    this.initialized = true;
    this.engine = engine;
    const device = requireEngineDevice(engine);
    this.sharedGpu = getTilemapSharedGpu(device);
    this.cameraGpu = createCamera2DGpu(device, getExtensionGPUResourceTracker(engine), this.sharedGpu.cameraLayout);
    this.objectLayout = this.sharedGpu.objectLayout;
    this.shaderModule = this.sharedGpu.shaderModule;
    this.pipelineLayout = this.sharedGpu.pipelineLayout;
  }

  updateCamera(viewProj: Float32Array): void {
    writeFloatBuffer(requireEngineDevice(this.engine).queue, this.cameraGpu.buffer, viewProj);
  }

  releaseEntitiesNotIn(liveEntities: ReadonlySet<number>): void {
    for (const [entityId, entityGpu] of this.entityCache) {
      if (!liveEntities.has(entityId)) {
        this.destroyEntityGpu(entityGpu);
        this.entityCache.delete(entityId);
      }
    }
  }

  render(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    tilemap: Tilemap2DComponent,
    worldMatrix: Float32Array,
  ): void {
    const device = requireEngineDevice(this.engine);
    const signature = this.computeSignature(tilemap);

    let entityGpu = this.entityCache.get(entityId);
    if (!entityGpu) {
      entityGpu = {
        objectGpu: createObject2DGpu(device, this.objectLayout, getExtensionGPUResourceTracker(this.engine)),
        vertexBuffer: device.createBuffer({
          size: TILEMAP_INITIAL_VERTEX_BYTES,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
        vertexBufferSize: TILEMAP_INITIAL_VERTEX_BYTES,
        vertexData: new Float32Array(TILEMAP_INITIAL_VERTEX_FLOATS),
        vertexByteLength: 0,
        vertexCount: 0,
        tilemapSignature: '',
      };
      getExtensionGPUResourceTracker(this.engine)?.trackBuffer(entityGpu.vertexBuffer, 'Tilemap2DRenderer.vertexBuffer', entityGpu.vertexBufferSize);
      this.entityCache.set(entityId, entityGpu);
    }

    if (entityGpu.tilemapSignature !== signature) {
      this.buildVertices(tilemap, entityGpu);
      entityGpu.tilemapSignature = signature;
      if (entityGpu.vertexByteLength > entityGpu.vertexBufferSize) {
        getExtensionGPUResourceTracker(this.engine)?.untrackBuffer(entityGpu.vertexBuffer);
        entityGpu.vertexBuffer.destroy();
        entityGpu.vertexBufferSize = Math.max(entityGpu.vertexByteLength, entityGpu.vertexBufferSize * 2);
        entityGpu.vertexBuffer = device.createBuffer({
          size: entityGpu.vertexBufferSize,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        getExtensionGPUResourceTracker(this.engine)?.trackBuffer(entityGpu.vertexBuffer, 'Tilemap2DRenderer.vertexBuffer', entityGpu.vertexBufferSize);
      }
      if (entityGpu.vertexByteLength > 0) {
        device.queue.writeBuffer(
          entityGpu.vertexBuffer,
          0,
          entityGpu.vertexData.buffer as ArrayBuffer,
          entityGpu.vertexData.byteOffset,
          entityGpu.vertexByteLength,
        );
      }
    }

    if (entityGpu.vertexCount === 0) return;

    writeObjectMatrixIfChanged(device.queue, entityGpu.objectGpu, worldMatrix);

    passEncoder.setPipeline(this.getPipeline());
    passEncoder.setBindGroup(0, this.cameraGpu.bindGroup);
    passEncoder.setBindGroup(1, entityGpu.objectGpu.bindGroup);
    passEncoder.setVertexBuffer(0, entityGpu.vertexBuffer);
    passEncoder.draw(entityGpu.vertexCount);
  }

  private computeSignature(tilemap: Tilemap2DComponent): string {
    const cached = this.signatureCache.get(tilemap);
    if (cached && cached.version === tilemap.version) {
      return cached.signature;
    }

    const signature = String(tilemap.version);
    this.signatureCache.set(tilemap, {
      version: tilemap.version,
      signature,
    });
    return signature;
  }

  private buildVertices(tilemap: Tilemap2DComponent, entityGpu: EntityGpu): void {
    let count = 0;
    for (const cell of tilemap.cells) {
      if (cell > 0) count++;
    }
    if (count === 0) {
      entityGpu.vertexByteLength = 0;
      entityGpu.vertexCount = 0;
      return;
    }

    const requiredFloats = count * 6 * 6;
    if (entityGpu.vertexData.length < requiredFloats) {
      entityGpu.vertexData = new Float32Array(Math.max(requiredFloats, entityGpu.vertexData.length * 2, 36));
    }
    const vertices = entityGpu.vertexData;
    let offset = 0;
    const gap = tilemap.gap;
    const w = Math.max(0, tilemap.cellWidth - gap);
    const h = Math.max(0, tilemap.cellHeight - gap);

    const push = (x: number, y: number, color: readonly number[]) => {
      vertices[offset++] = x;
      vertices[offset++] = y;
      vertices[offset++] = color[0] ?? 1;
      vertices[offset++] = color[1] ?? 1;
      vertices[offset++] = color[2] ?? 1;
      vertices[offset++] = color[3] ?? 1;
    };

    for (let row = 0; row < tilemap.rows; row++) {
      for (let column = 0; column < tilemap.columns; column++) {
        const value = tilemap.getCell(column, row);
        if (value <= 0) continue;
        const color = tilemap.palette[value] ?? tilemap.palette[1] ?? [1, 1, 1, 1];
        const x0 = tilemap.originX + column * tilemap.cellWidth + gap * 0.5;
        const y0 = tilemap.originY + row * tilemap.cellHeight + gap * 0.5;
        const x1 = x0 + w;
        const y1 = y0 + h;
        push(x0, y0, color);
        push(x1, y0, color);
        push(x1, y1, color);
        push(x0, y0, color);
        push(x1, y1, color);
        push(x0, y1, color);
      }
    }
    entityGpu.vertexByteLength = requiredFloats * 4;
    entityGpu.vertexCount = count * 6;
  }

  private getPipeline(): GPURenderPipeline {
    const depthFormat = this.engine.getDepthFormat(this.reverseZ);
    const key = (this.reverseZ ? 1 : 0) | ((this.msaaSamples > 1 ? 1 : 0) << 1);
    let pipeline = this.sharedGpu.pipelineCache.get(key);
    if (pipeline) return pipeline;

    const device = requireEngineDevice(this.engine);
    const { format } = this.engine;
    const created = device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x4' },
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
        format: depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
      multisample: { count: this.msaaSamples },
    });
    this.sharedGpu.pipelineCache.set(key, created);
    return created;
  }

  destroy(): void {
    if (this.cameraGpu) destroyCamera2DGpu(this.cameraGpu);
    for (const entity of this.entityCache.values()) this.destroyEntityGpu(entity);
    this.entityCache.clear();
  }

  private destroyEntityGpu(entity: EntityGpu): void {
    destroyObject2DGpu(entity.objectGpu);
    getExtensionGPUResourceTracker(this.engine)?.untrackBuffer(entity.vertexBuffer);
    entity.vertexBuffer.destroy();
  }
}
