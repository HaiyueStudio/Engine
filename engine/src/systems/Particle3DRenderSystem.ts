import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { ParticleEmitter3D } from '../components/ParticleEmitter3D';
import type { ParticleBlendMode } from '../components/ParticleEmitter2D';
import { Camera3D } from '../components/Camera3D';
import { isEntityDisabledInHierarchyCached, type EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { beginRenderCommandPass, type RenderCommandContext } from '../core/RenderCommandContext';
import { cloneRenderPassDescriptor, getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import { getRenderViewPassOptions } from '../core/RenderView';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import { getBuiltinSimple3dShader } from '../shader/BuiltinSimple3dShader';

export interface Particle3DRenderSystemOptions {
  loadOp?: 'clear' | 'load';
  priority?: number;
}

export interface Particle3DRenderStats {
  readonly viewCount: number;
  readonly emitterCount: number;
  readonly particleCount: number;
  readonly sortedParticleCount: number;
  readonly uploadedBytes: number;
}

interface EmitterGpu {
  objectBuffer: GPUBuffer;
  objectBindGroup: GPUBindGroup;
  objectData: Float32Array;
  instanceBuffer: GPUBuffer;
  instanceCapacity: number;
  uploadRevision: number;
  sortedData: Float32Array;
  sortKeys: Uint32Array;
  sortIndicesA: Uint32Array;
  sortIndicesB: Uint32Array;
  sortCounts: Uint32Array;
  lastFrame: number;
}

const CAMERA_FLOATS = 24;
const OBJECT_FLOATS = 20;
const INSTANCE_FLOATS = 12;
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

export class Particle3DRenderSystem extends System {
  readonly loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'Particle3DRenderSystem' as const };
  private readonly _engine: IEngine;
  private _cameraEntity: Entity;
  private readonly _unregisterRecovery: (() => void) | null;
  private readonly _disabledCache: EntityHierarchyDisabledCache = new Map();
  private readonly _emitterGpu = new Map<string, EmitterGpu>();
  private readonly _pipelines = new Map<string, GPURenderPipeline>();
  private _textureBindGroups = new WeakMap<GPUTexture, GPUBindGroup>();
  private _ready = false;
  private _cameraBuffer!: GPUBuffer;
  private _cameraBindGroup!: GPUBindGroup;
  private _cameraData = new Float32Array(CAMERA_FLOATS);
  private _cameraLayout!: GPUBindGroupLayout;
  private _objectLayout!: GPUBindGroupLayout;
  private _textureLayout!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _whiteTexture!: GPUTexture;
  private _whiteBindGroup!: GPUBindGroup;
  private _quadBuffer!: GPUBuffer;
  private _shader!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private readonly _floatBits = new Float32Array(1);
  private readonly _uintBits = new Uint32Array(this._floatBits.buffer);
  private _statsFrame = -1;
  private _viewCount = 0;
  private _emitterCount = 0;
  private _particleCount = 0;
  private _sortedParticleCount = 0;
  private _uploadedBytes = 0;

  constructor(engine: IEngine, cameraEntity: Entity, options: Particle3DRenderSystemOptions = {}) {
    super({ all: [ParticleEmitter3D] });
    this.name = 'Particle3DRenderSystem';
    this._engine = engine;
    this._cameraEntity = cameraEntity;
    this.loadOp = options.loadOp ?? 'load';
    if (options.priority !== undefined) this.priority = options.priority;
    this.recoveryLabel = `${this.name}:${this.id}`;
    this._unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
  }

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return { pass: 'isolated', loadOp: this.loadOp, sort: this.priority };
  }

  get stats(): Particle3DRenderStats {
    return Object.freeze({
      viewCount: this._viewCount,
      emitterCount: this._emitterCount,
      particleCount: this._particleCount,
      sortedParticleCount: this._sortedParticleCount,
      uploadedBytes: this._uploadedBytes,
    });
  }

  setCameraEntity(entity: Entity): this { this._cameraEntity = entity; return this; }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    if (!this._ready) this._prepare();
    const cameraEntity = context.view?.camera.getComponent(Camera3D) ? context.view.camera : this._cameraEntity;
    const camera = cameraEntity.getComponent(Camera3D);
    if (!camera) return this;
    const frameData = context.frameData ?? world.frameData;
    const reverseZ = context.view?.reverseZ ?? this._engine.reverseZ;
    const cameraFrame = frameData.getCamera3D(
      cameraEntity,
      camera,
      context.view?.width ?? this._engine.width,
      context.view?.height ?? this._engine.height,
      reverseZ,
    );
    this._cameraData.set(cameraFrame.viewProjectionMatrix, 0);
    this._cameraData[16] = cameraFrame.worldMatrix[0]!;
    this._cameraData[17] = cameraFrame.worldMatrix[1]!;
    this._cameraData[18] = cameraFrame.worldMatrix[2]!;
    this._cameraData[19] = 0;
    this._cameraData[20] = cameraFrame.worldMatrix[4]!;
    this._cameraData[21] = cameraFrame.worldMatrix[5]!;
    this._cameraData[22] = cameraFrame.worldMatrix[6]!;
    this._cameraData[23] = 0;
    context.device.queue.writeBuffer(this._cameraBuffer, 0, this._cameraData as ArrayBufferView<ArrayBuffer>);

    if (!context.passEncoder) {
      context.descriptor = context.view
        ? cloneRenderPassDescriptor(context.view.target.getRenderPassDescriptor(getRenderViewPassOptions(context.view)), this.loadOp)
        : getCachedRenderPassDescriptor(this._engine, this.loadOp);
      context.loadOp = this.loadOp;
    }
    const { passEncoder, ownsPass } = beginRenderCommandPass(context);
    applyViewport(passEncoder, context);
    passEncoder.setBindGroup(0, this._cameraBindGroup);

    const frameId = frameData.frameId;
    if (this._statsFrame !== frameId) {
      this._statsFrame = frameId;
      this._viewCount = 0;
      this._emitterCount = 0;
      this._particleCount = 0;
      this._sortedParticleCount = 0;
      this._uploadedBytes = 0;
    }
    this._viewCount++;
    this._disabledCache.clear();
    let activePipeline = '';
    const viewKey = context.view?.key ?? 'default';
    const format = context.view?.target.format ?? this._engine.format;
    const sampleCount = context.view?.sampleCount ?? this._engine.msaaSamples;
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (context.view?.excludedEntityIds?.has(entity.id)) continue;
      if (isEntityDisabledInHierarchyCached(entity, this._disabledCache)) continue;
      const emitter = entity.getComponent(ParticleEmitter3D);
      if (!emitter || emitter.activeParticles === 0 || emitter.opacity <= 0) continue;
      const gpu = this._getEmitterGpu(`${viewKey}:${entity.id}`, frameId);
      this._ensureInstanceCapacity(gpu, emitter.activeParticles, context);
      const worldMatrix = frameData.transforms.getWorldMatrix(entity);
      let uploadData = emitter.instanceData;
      let shouldUpload = gpu.uploadRevision !== emitter.revision;
      if (emitter.sortMode === 'back-to-front') {
        this._sortBackToFront(gpu, emitter.instanceData, emitter.activeParticles, worldMatrix, cameraFrame.viewMatrix);
        uploadData = gpu.sortedData;
        shouldUpload = true;
        this._sortedParticleCount += emitter.activeParticles;
      }
      if (shouldUpload) {
        const bytes = emitter.activeParticles * INSTANCE_BYTES;
        context.device.queue.writeBuffer(gpu.instanceBuffer, 0, uploadData.buffer as ArrayBuffer, uploadData.byteOffset, bytes);
        gpu.uploadRevision = emitter.revision;
        this._uploadedBytes += bytes;
      }

      gpu.objectData.set(worldMatrix, 0);
      gpu.objectData[16] = emitter.opacity;
      gpu.objectData[17] = emitter.radial ? 1 : 0;
      gpu.objectData[18] = maximumWorldScale(worldMatrix);
      gpu.objectData[19] = 0;
      context.device.queue.writeBuffer(gpu.objectBuffer, 0, gpu.objectData as ArrayBufferView<ArrayBuffer>);

      const pipelineKey = `${emitter.blendMode}:${emitter.depthTest ? 1 : 0}:${emitter.depthWrite ? 1 : 0}:${format}:${sampleCount}:${reverseZ ? 1 : 0}`;
      if (activePipeline !== pipelineKey) {
        passEncoder.setPipeline(this._getPipeline(emitter.blendMode, emitter.depthTest, emitter.depthWrite, format, sampleCount, reverseZ));
        activePipeline = pipelineKey;
      }
      const texture = emitter.resolveTexture();
      passEncoder.setBindGroup(1, gpu.objectBindGroup);
      passEncoder.setBindGroup(2, texture ? this._getTextureBindGroup(texture) : this._whiteBindGroup);
      passEncoder.setVertexBuffer(0, this._quadBuffer);
      passEncoder.setVertexBuffer(1, gpu.instanceBuffer);
      passEncoder.draw(6, emitter.activeParticles);
      this._emitterCount++;
      this._particleCount += emitter.activeParticles;
    }
    if (ownsPass) passEncoder.end();
    this._sweepEmitters(frameId, context);
    return this;
  }

  suspendForDeviceLoss(): void { this._releaseGpu(); }
  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this._ready = false;
  }

  override destroy(): this {
    this._unregisterRecovery?.();
    this._releaseGpu();
    return super.destroy();
  }

  private _prepare(): void {
    const device = this._engine.device;
    const tracker = getEngineGPUResourceTracker(this._engine);
    this._cameraLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    this._objectLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this._textureLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    this._cameraBuffer = device.createBuffer({ size: CAMERA_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    tracker?.trackBuffer(this._cameraBuffer, 'Particle3D.cameraBuffer', CAMERA_FLOATS * 4);
    this._cameraBindGroup = device.createBindGroup({ layout: this._cameraLayout, entries: [{ binding: 0, resource: { buffer: this._cameraBuffer } }] });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this._whiteTexture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    tracker?.trackTexture(this._whiteTexture, 'Particle3D.whiteTexture', 4);
    device.queue.writeTexture({ texture: this._whiteTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this._whiteBindGroup = this._createTextureBindGroup(this._whiteTexture);
    const quad = new Float32Array([
      -0.5, -0.5, 0, 1,  0.5, -0.5, 1, 1,  0.5, 0.5, 1, 0,
      -0.5, -0.5, 0, 1,  0.5, 0.5, 1, 0,  -0.5, 0.5, 0, 0,
    ]);
    this._quadBuffer = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    tracker?.trackBuffer(this._quadBuffer, 'Particle3D.quadBuffer', quad.byteLength);
    device.queue.writeBuffer(this._quadBuffer, 0, quad as ArrayBufferView<ArrayBuffer>);
    const generated = getBuiltinSimple3dShader(device, 'particle3d', [
      this._cameraLayout,
      this._objectLayout,
      this._textureLayout,
    ]);
    this._shader = generated.module;
    this._pipelineLayout = generated.pipelineLayout;
    this._ready = true;
  }

  private _getEmitterGpu(key: string, frameId: number): EmitterGpu {
    let gpu = this._emitterGpu.get(key);
    if (gpu) { gpu.lastFrame = frameId; return gpu; }
    const device = this._engine.device;
    const objectBuffer = device.createBuffer({ size: OBJECT_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const instanceCapacity = 64;
    const instanceBuffer = device.createBuffer({ size: instanceCapacity * INSTANCE_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const tracker = getEngineGPUResourceTracker(this._engine);
    tracker?.trackBuffer(objectBuffer, 'Particle3D.objectBuffer', OBJECT_FLOATS * 4);
    tracker?.trackBuffer(instanceBuffer, 'Particle3D.instanceBuffer', instanceCapacity * INSTANCE_BYTES);
    gpu = {
      objectBuffer,
      objectBindGroup: device.createBindGroup({ layout: this._objectLayout, entries: [{ binding: 0, resource: { buffer: objectBuffer } }] }),
      objectData: new Float32Array(OBJECT_FLOATS),
      instanceBuffer,
      instanceCapacity,
      uploadRevision: -1,
      sortedData: new Float32Array(instanceCapacity * INSTANCE_FLOATS),
      sortKeys: new Uint32Array(instanceCapacity),
      sortIndicesA: new Uint32Array(instanceCapacity),
      sortIndicesB: new Uint32Array(instanceCapacity),
      sortCounts: new Uint32Array(256),
      lastFrame: frameId,
    };
    this._emitterGpu.set(key, gpu);
    return gpu;
  }

  private _ensureInstanceCapacity(gpu: EmitterGpu, required: number, context: RenderCommandContext): void {
    if (required <= gpu.instanceCapacity) return;
    let capacity = gpu.instanceCapacity;
    while (capacity < required) capacity = Math.max(capacity + 1, Math.ceil(capacity * 1.5));
    const old = gpu.instanceBuffer;
    gpu.instanceBuffer = this._engine.device.createBuffer({ size: capacity * INSTANCE_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    gpu.instanceCapacity = capacity;
    gpu.uploadRevision = -1;
    gpu.sortedData = new Float32Array(capacity * INSTANCE_FLOATS);
    gpu.sortKeys = new Uint32Array(capacity);
    gpu.sortIndicesA = new Uint32Array(capacity);
    gpu.sortIndicesB = new Uint32Array(capacity);
    const tracker = getEngineGPUResourceTracker(this._engine);
    tracker?.trackBuffer(gpu.instanceBuffer, 'Particle3D.instanceBuffer', capacity * INSTANCE_BYTES);
    const retire = () => { tracker?.untrackBuffer(old); old.destroy(); };
    if (context.afterSubmit) context.afterSubmit(queue => void queue.onSubmittedWorkDone().then(retire, retire));
    else retire();
  }

  private _sortBackToFront(
    gpu: EmitterGpu,
    source: Float32Array,
    count: number,
    model: Float32Array,
    view: Float32Array,
  ): void {
    let indices = gpu.sortIndicesA;
    let targetIndices = gpu.sortIndicesB;
    for (let index = 0; index < count; index++) {
      const sourceOffset = index * INSTANCE_FLOATS;
      const x = source[sourceOffset]!, y = source[sourceOffset + 1]!, z = source[sourceOffset + 2]!;
      const wx = model[0]! * x + model[4]! * y + model[8]! * z + model[12]!;
      const wy = model[1]! * x + model[5]! * y + model[9]! * z + model[13]!;
      const wz = model[2]! * x + model[6]! * y + model[10]! * z + model[14]!;
      const viewZ = view[2]! * wx + view[6]! * wy + view[10]! * wz + view[14]!;
      this._floatBits[0] = viewZ;
      const bits = this._uintBits[0]!;
      gpu.sortKeys[index] = (bits & 0x8000_0000) !== 0 ? ~bits : (bits ^ 0x8000_0000);
      indices[index] = index;
    }
    for (let shift = 0; shift < 32; shift += 8) {
      gpu.sortCounts.fill(0);
      for (let index = 0; index < count; index++) gpu.sortCounts[(gpu.sortKeys[indices[index]!]! >>> shift) & 0xff]!++;
      let offset = 0;
      for (let bucket = 0; bucket < 256; bucket++) {
        const bucketCount = gpu.sortCounts[bucket]!;
        gpu.sortCounts[bucket] = offset;
        offset += bucketCount;
      }
      for (let index = 0; index < count; index++) {
        const sourceIndex = indices[index]!;
        const bucket = (gpu.sortKeys[sourceIndex]! >>> shift) & 0xff;
        targetIndices[gpu.sortCounts[bucket]!] = sourceIndex;
        gpu.sortCounts[bucket] = gpu.sortCounts[bucket]! + 1;
      }
      const swap = indices; indices = targetIndices; targetIndices = swap;
    }
    for (let index = 0; index < count; index++) {
      const sourceOffset = indices[index]! * INSTANCE_FLOATS;
      const targetOffset = index * INSTANCE_FLOATS;
      for (let word = 0; word < INSTANCE_FLOATS; word++) gpu.sortedData[targetOffset + word] = source[sourceOffset + word]!;
    }
  }

  private _getPipeline(
    blendMode: ParticleBlendMode,
    depthTest: boolean,
    depthWrite: boolean,
    format: GPUTextureFormat,
    sampleCount: 1 | 4,
    reverseZ: boolean,
  ): GPURenderPipeline {
    const key = `${blendMode}:${depthTest ? 1 : 0}:${depthWrite ? 1 : 0}:${format}:${sampleCount}:${reverseZ ? 1 : 0}`;
    const cached = this._pipelines.get(key);
    if (cached) return cached;
    const additive = blendMode === 'additive';
    const pipeline = this._engine.device.createRenderPipeline({
      label: `Particle3D.pipeline:${key}`,
      layout: this._pipelineLayout,
      vertex: { module: this._shader, entryPoint: 'vs_main', buffers: [
        { arrayStride: 16, stepMode: 'vertex', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x2' },
        ] },
        { arrayStride: INSTANCE_BYTES, stepMode: 'instance', attributes: [
          { shaderLocation: 2, offset: 0, format: 'float32x3' },
          { shaderLocation: 3, offset: 12, format: 'float32' },
          { shaderLocation: 4, offset: 16, format: 'float32' },
          { shaderLocation: 5, offset: 32, format: 'float32x4' },
        ] },
      ] },
      fragment: { module: this._shader, entryPoint: 'fs_main', targets: [{ format, blend: additive ? {
        color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      } : {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this._engine.getDepthFormat(reverseZ),
        depthWriteEnabled: depthWrite,
        depthCompare: depthTest ? (reverseZ ? 'greater' : 'less') : 'always',
      },
      multisample: { count: sampleCount },
    });
    this._pipelines.set(key, pipeline);
    return pipeline;
  }

  private _getTextureBindGroup(texture: GPUTexture): GPUBindGroup {
    let group = this._textureBindGroups.get(texture);
    if (!group) { group = this._createTextureBindGroup(texture); this._textureBindGroups.set(texture, group); }
    return group;
  }
  private _createTextureBindGroup(texture: GPUTexture): GPUBindGroup {
    return this._engine.device.createBindGroup({ layout: this._textureLayout, entries: [
      { binding: 0, resource: texture.createView() }, { binding: 1, resource: this._sampler },
    ] });
  }

  private _sweepEmitters(frameId: number, context: RenderCommandContext): void {
    if (frameId === 0) return;
    for (const [key, gpu] of this._emitterGpu) {
      if (gpu.lastFrame >= frameId - 1) continue;
      this._emitterGpu.delete(key);
      const retire = () => this._destroyEmitterGpu(gpu);
      if (context.afterSubmit) context.afterSubmit(queue => void queue.onSubmittedWorkDone().then(retire, retire));
      else retire();
    }
  }
  private _destroyEmitterGpu(gpu: EmitterGpu): void {
    const tracker = getEngineGPUResourceTracker(this._engine);
    tracker?.untrackBuffer(gpu.objectBuffer); gpu.objectBuffer.destroy();
    tracker?.untrackBuffer(gpu.instanceBuffer); gpu.instanceBuffer.destroy();
  }
  private _releaseGpu(): void {
    if (!this._ready) return;
    const tracker = getEngineGPUResourceTracker(this._engine);
    for (const gpu of this._emitterGpu.values()) this._destroyEmitterGpu(gpu);
    this._emitterGpu.clear();
    tracker?.untrackBuffer(this._cameraBuffer); this._cameraBuffer.destroy();
    tracker?.untrackBuffer(this._quadBuffer); this._quadBuffer.destroy();
    tracker?.untrackTexture(this._whiteTexture); this._whiteTexture.destroy();
    this._pipelines.clear();
    this._textureBindGroups = new WeakMap();
    this._ready = false;
  }
}

function maximumWorldScale(matrix: Float32Array): number {
  return Math.max(
    Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!),
    Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!),
    Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!),
  );
}

function applyViewport(pass: GPURenderPassEncoder, context: RenderCommandContext): void {
  const viewport = context.view?.viewport;
  if (viewport) pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, viewport.minDepth ?? 0, viewport.maxDepth ?? 1);
  const scissor = context.view?.scissor;
  if (scissor) pass.setScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
}
