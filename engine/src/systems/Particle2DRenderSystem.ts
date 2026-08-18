import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { ParticleEmitter2D, type ParticleBlendMode } from '../components/ParticleEmitter2D';
import { Camera2D } from '../components/Camera2D';
import { isEntityDisabledInHierarchyCached, type EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { beginRenderCommandPass, type RenderCommandContext } from '../core/RenderCommandContext';
import { cloneRenderPassDescriptor, getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import { getRenderViewPassOptions } from '../core/RenderView';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import { getBuiltin2dUiShader } from '../shader/BuiltinRenderShader';

export interface Particle2DRenderSystemOptions {
  loadOp?: 'clear' | 'load';
  priority?: number;
}

export interface Particle2DRenderStats {
  readonly emitterCount: number;
  readonly particleCount: number;
  readonly uploadedBytes: number;
}

interface EmitterGpu {
  objectBuffer: GPUBuffer;
  objectBindGroup: GPUBindGroup;
  objectData: Float32Array;
  instanceBuffer: GPUBuffer;
  instanceCapacity: number;
  uploadRevision: number;
}

const OBJECT_FLOATS = 20;
const INSTANCE_BYTES = 8 * 4;

export class Particle2DRenderSystem extends System {
  readonly loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'Particle2DRenderSystem' as const };
  private readonly _engine: IEngine;
  private _cameraEntity: Entity;
  private readonly _unregisterRecovery: (() => void) | null;
  private readonly _disabledCache: EntityHierarchyDisabledCache = new Map();
  private readonly _liveEntities = new Set<number>();
  private readonly _emitterGpu = new Map<number, EmitterGpu>();
  private readonly _pipelines = new Map<string, GPURenderPipeline>();
  private _textureBindGroups = new WeakMap<GPUTexture, GPUBindGroup>();
  private _ready = false;
  private _cameraBuffer!: GPUBuffer;
  private _cameraBindGroup!: GPUBindGroup;
  private _cameraLayout!: GPUBindGroupLayout;
  private _objectLayout!: GPUBindGroupLayout;
  private _textureLayout!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _whiteTexture!: GPUTexture;
  private _whiteBindGroup!: GPUBindGroup;
  private _quadBuffer!: GPUBuffer;
  private _shader!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private _emitterCount = 0;
  private _particleCount = 0;
  private _uploadedBytes = 0;

  constructor(engine: IEngine, cameraEntity: Entity, options: Particle2DRenderSystemOptions = {}) {
    super({ all: [ParticleEmitter2D] });
    this.name = 'Particle2DRenderSystem';
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

  get stats(): Particle2DRenderStats {
    return Object.freeze({ emitterCount: this._emitterCount, particleCount: this._particleCount, uploadedBytes: this._uploadedBytes });
  }

  setCameraEntity(entity: Entity): this { this._cameraEntity = entity; return this; }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    if (!this._ready) this._prepare();
    const cameraEntity = context.view?.camera.getComponent(Camera2D) ? context.view.camera : this._cameraEntity;
    const camera = cameraEntity.getComponent(Camera2D);
    if (!camera) return this;
    const frameData = context.frameData ?? world.frameData;
    const cameraFrame = frameData.getCamera2D(
      cameraEntity,
      camera,
      context.view?.displayWidth ?? this._engine.displayWidth,
      context.view?.displayHeight ?? this._engine.displayHeight,
    );
    context.device.queue.writeBuffer(this._cameraBuffer, 0, cameraFrame.viewProjectionMatrix as ArrayBufferView<ArrayBuffer>);

    if (!context.passEncoder) {
      context.descriptor = context.view
        ? cloneRenderPassDescriptor(context.view.target.getRenderPassDescriptor(getRenderViewPassOptions(context.view)), this.loadOp)
        : getCachedRenderPassDescriptor(this._engine, this.loadOp);
      context.loadOp = this.loadOp;
    }
    const { passEncoder, ownsPass } = beginRenderCommandPass(context);
    applyViewport(passEncoder, context);
    passEncoder.setBindGroup(0, this._cameraBindGroup);

    this._disabledCache.clear();
    this._liveEntities.clear();
    let emitterCount = 0;
    let particleCount = 0;
    let uploadedBytes = 0;
    let activePipeline = '';
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledCache)) continue;
      const emitter = entity.getComponent(ParticleEmitter2D);
      if (!emitter || emitter.activeParticles === 0 || emitter.opacity <= 0) continue;
      const gpu = this._getEmitterGpu(entity);
      this._ensureInstanceCapacity(gpu, emitter.activeParticles, context);
      if (gpu.uploadRevision !== emitter.revision) {
        const bytes = emitter.activeParticles * INSTANCE_BYTES;
        context.device.queue.writeBuffer(gpu.instanceBuffer, 0, emitter.instanceData.buffer as ArrayBuffer, emitter.instanceData.byteOffset, bytes);
        gpu.uploadRevision = emitter.revision;
        uploadedBytes += bytes;
      }
      const worldMatrix = frameData.getWorldMatrix2D(entity);
      gpu.objectData.set(worldMatrix, 0);
      gpu.objectData[16] = emitter.opacity;
      gpu.objectData[17] = emitter.radial ? 1 : 0;
      gpu.objectData[18] = 0;
      gpu.objectData[19] = 0;
      context.device.queue.writeBuffer(gpu.objectBuffer, 0, gpu.objectData as ArrayBufferView<ArrayBuffer>);

      const pipelineKey = `${emitter.blendMode}:${context.view?.target.format ?? this._engine.format}:${context.view?.sampleCount ?? this._engine.msaaSamples}:${context.view?.reverseZ ?? this._engine.reverseZ}`;
      if (activePipeline !== pipelineKey) {
        passEncoder.setPipeline(this._getPipeline(
          emitter.blendMode,
          context.view?.target.format ?? this._engine.format,
          context.view?.sampleCount ?? this._engine.msaaSamples,
          context.view?.reverseZ ?? this._engine.reverseZ,
        ));
        activePipeline = pipelineKey;
      }
      const texture = emitter.resolveTexture();
      passEncoder.setBindGroup(1, gpu.objectBindGroup);
      passEncoder.setBindGroup(2, texture ? this._getTextureBindGroup(texture) : this._whiteBindGroup);
      passEncoder.setVertexBuffer(0, this._quadBuffer);
      passEncoder.setVertexBuffer(1, gpu.instanceBuffer);
      passEncoder.draw(6, emitter.activeParticles);
      this._liveEntities.add(entity.id);
      emitterCount++;
      particleCount += emitter.activeParticles;
    }
    if (ownsPass) passEncoder.end();
    this._sweepEmitters(context);
    this._emitterCount = emitterCount;
    this._particleCount = particleCount;
    this._uploadedBytes = uploadedBytes;
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
    this._cameraBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    tracker?.trackBuffer(this._cameraBuffer, 'Particle2D.cameraBuffer', 64);
    this._cameraBindGroup = device.createBindGroup({ layout: this._cameraLayout, entries: [{ binding: 0, resource: { buffer: this._cameraBuffer } }] });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this._whiteTexture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    tracker?.trackTexture(this._whiteTexture, 'Particle2D.whiteTexture', 4);
    device.queue.writeTexture({ texture: this._whiteTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this._whiteBindGroup = this._createTextureBindGroup(this._whiteTexture);
    const quad = new Float32Array([
      -0.5, -0.5, 0, 1,  0.5, -0.5, 1, 1,  0.5, 0.5, 1, 0,
      -0.5, -0.5, 0, 1,  0.5, 0.5, 1, 0,  -0.5, 0.5, 0, 0,
    ]);
    this._quadBuffer = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    tracker?.trackBuffer(this._quadBuffer, 'Particle2D.quadBuffer', quad.byteLength);
    device.queue.writeBuffer(this._quadBuffer, 0, quad as ArrayBufferView<ArrayBuffer>);
    const generated = getBuiltin2dUiShader(device, 'particle2d', [
      this._cameraLayout,
      this._objectLayout,
      this._textureLayout,
    ]);
    this._shader = generated.module;
    this._pipelineLayout = generated.pipelineLayout;
    this._ready = true;
  }

  private _getEmitterGpu(entity: Entity): EmitterGpu {
    let gpu = this._emitterGpu.get(entity.id);
    if (gpu) return gpu;
    const device = this._engine.device;
    const objectBuffer = device.createBuffer({ size: OBJECT_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const instanceCapacity = 64;
    const instanceBuffer = device.createBuffer({ size: instanceCapacity * INSTANCE_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const tracker = getEngineGPUResourceTracker(this._engine);
    tracker?.trackBuffer(objectBuffer, 'Particle2D.objectBuffer', OBJECT_FLOATS * 4);
    tracker?.trackBuffer(instanceBuffer, 'Particle2D.instanceBuffer', instanceCapacity * INSTANCE_BYTES);
    gpu = {
      objectBuffer,
      objectBindGroup: device.createBindGroup({ layout: this._objectLayout, entries: [{ binding: 0, resource: { buffer: objectBuffer } }] }),
      objectData: new Float32Array(OBJECT_FLOATS),
      instanceBuffer,
      instanceCapacity,
      uploadRevision: -1,
    };
    this._emitterGpu.set(entity.id, gpu);
    return gpu;
  }

  private _ensureInstanceCapacity(gpu: EmitterGpu, required: number, context: RenderCommandContext): void {
    if (required <= gpu.instanceCapacity) return;
    let capacity = gpu.instanceCapacity;
    while (capacity < required) capacity = Math.max(capacity + 1, Math.ceil(capacity * 1.5));
    const old = gpu.instanceBuffer;
    const device = this._engine.device;
    gpu.instanceBuffer = device.createBuffer({ size: capacity * INSTANCE_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    gpu.instanceCapacity = capacity;
    gpu.uploadRevision = -1;
    const tracker = getEngineGPUResourceTracker(this._engine);
    tracker?.trackBuffer(gpu.instanceBuffer, 'Particle2D.instanceBuffer', capacity * INSTANCE_BYTES);
    const retire = () => { tracker?.untrackBuffer(old); old.destroy(); };
    if (context.afterSubmit) context.afterSubmit(queue => void queue.onSubmittedWorkDone().then(retire, retire));
    else retire();
  }

  private _getPipeline(blendMode: ParticleBlendMode, format: GPUTextureFormat, sampleCount: 1 | 4, reverseZ: boolean): GPURenderPipeline {
    const key = `${blendMode}:${format}:${sampleCount}:${reverseZ ? 1 : 0}`;
    const cached = this._pipelines.get(key);
    if (cached) return cached;
    const additive = blendMode === 'additive';
    const pipeline = this._engine.device.createRenderPipeline({
      label: `Particle2D.pipeline:${key}`,
      layout: this._pipelineLayout,
      vertex: { module: this._shader, entryPoint: 'vs_main', buffers: [
        { arrayStride: 16, stepMode: 'vertex', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x2' },
        ] },
        { arrayStride: INSTANCE_BYTES, stepMode: 'instance', attributes: [
          { shaderLocation: 2, offset: 0, format: 'float32x2' },
          { shaderLocation: 3, offset: 8, format: 'float32' },
          { shaderLocation: 4, offset: 12, format: 'float32' },
          { shaderLocation: 5, offset: 16, format: 'float32x4' },
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
      depthStencil: { format: this._engine.getDepthFormat(reverseZ), depthWriteEnabled: false, depthCompare: 'always' },
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

  private _sweepEmitters(context: RenderCommandContext): void {
    for (const [id, gpu] of this._emitterGpu) {
      if (this._liveEntities.has(id)) continue;
      this._emitterGpu.delete(id);
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

function applyViewport(pass: GPURenderPassEncoder, context: RenderCommandContext): void {
  const viewport = context.view?.viewport;
  if (viewport) pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, viewport.minDepth ?? 0, viewport.maxDepth ?? 1);
  const scissor = context.view?.scissor;
  if (scissor) pass.setScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
}
