import type { Material } from '../material/Material';
import { auxiliaryCullMode, auxiliaryFrontFace, auxiliaryUsesDeformation, MATERIAL_COVERAGE_LAYOUT, MaterialCoverageBindings, type MaterialCoverageResources } from './AuxiliaryMaterial';
import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import { getBuiltinDeformationShader } from '../shader/BuiltinDeformationShader';
import { BaseRenderer } from './BaseRenderer';
import { createPrimitiveState } from './gpuDescriptors';
import { getSharedGeometry3DGPUCache } from './SharedGeometry3DGPUCache';
import { encodePrimitivePipelineKey } from './pipelineKey';
import { getSceneFrameGpuArena, type SceneFrameGpuBinding } from './SceneFrameGpuArena';
import { getStripIndexFormat, writeBuffer } from './utils';
import type { LiveIdSet } from './utils';
import type { PipelineWarmupPlan } from './PipelineWarmup';
import { RendererCacheMap } from './RendererCacheMap';
import { alignUp4 } from '../utils/align';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { CLIPPING_BLOCK_FLOATS, clippingStateKey, writeClippingBlock } from './ClippingPlanesGpu';

const MOTION_BASE_FLOATS = 68;
const MOTION_OBJECT_FLOATS = MOTION_BASE_FLOATS;

interface MotionEntityState {
  readonly buffer: GPUBuffer;
  readonly clippingBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly uniformData: Float32Array;
  readonly clippingData: Float32Array;
  readonly previousModel: Float32Array;
  readonly previousMorphWeights: Float32Array;
  previousSkinMatrices: Float32Array;
  currentSkinBuffer: GPUBuffer | null;
  previousSkinBuffer: GPUBuffer | null;
  skinBindGroup: GPUBindGroup;
  skinJointBuffer: GPUBuffer | null;
  skinMatrixByteLength: number;
  geometryId: number;
  deformationEnabled: boolean;
  lastFrameId: number;
  clippingKey: string;
}

interface MotionGeometryDeformationData {
  readonly vertexCount: number;
  readonly morphEnabled: boolean;
  readonly morphSources: readonly (Float32Array | null)[];
  readonly morphNormalSources: readonly (Float32Array | null)[];
  readonly morphBuffers: GPUBuffer[];
  readonly skinning: Geometry3D['skinning'];
  readonly skinJointSource: Float32Array | null;
  readonly skinWeightSource: Float32Array | null;
  readonly skinJointBuffer: GPUBuffer | null;
  readonly skinWeightBuffer: GPUBuffer | null;
}

interface MotionViewState {
  readonly entities: Map<number, MotionEntityState>;
  readonly liveEntities: Set<number>;
  readonly previousViewProjection: Float32Array;
  readonly currentViewProjection: Float32Array;
  readonly previousJitter: Float32Array;
  readonly currentJitter: Float32Array;
  readonly cameraDepth: Float32Array;
  width: number;
  height: number;
  valid: boolean;
  continuous: boolean;
  lastFrameId: number;
  currentFrameId: number;
  lastSeenFrameId: number;
  cameraId: number;
  historyRevision: number;
}

export interface MotionVectorViewOptions {
  readonly viewKey: string;
  readonly frameId: number;
  readonly cameraId: number;
  readonly historyRevision: number;
  readonly near: number;
  readonly far: number;
  readonly isOrthographic: boolean;
  readonly projectionJitter: ArrayLike<number>;
}

/** Unjittered UV velocity, previous linear depth and history validity for temporal consumers. */
export class MotionVectorRenderer extends BaseRenderer {
  readonly type = 'motion-vector';
  reverseZ = false;
  msaaSamples: 1 | 4 = 1;
  /** Optional MRT outputs; location 0 retains the temporal motion ABI. */
  auxiliaryDepth = false;
  auxiliaryNormal = false;

  private _engine!: IEngine;
  private _sceneFrameBinding!: SceneFrameGpuBinding;
  private readonly _cameraDynamicOffset = new Uint32Array(1);
  private _objectLayout!: GPUBindGroupLayout;
  private _deformationLayout!: GPUBindGroupLayout;
  private _pipelineLayout!: GPUPipelineLayout;
  private _shader!: GPUShaderModule;
  private _geoCache!: ReturnType<typeof getSharedGeometry3DGPUCache>;
  private _fallbackMatrixBuffer!: GPUBuffer;
  private _fallbackAttributeBuffer!: GPUBuffer;
  private _fallbackDeformationBindGroup!: GPUBindGroup;
  private readonly _deformations = new RendererCacheMap<MotionGeometryDeformationData>(data => this._destroyGeometryDeformation(data));
  private readonly _views = new Map<string, MotionViewState>();
  private _activeView: MotionViewState | null = null;
  private _activeContext: RenderCommandContext | null = null;
  private coverageBindings!: MaterialCoverageBindings;
  private _initialized = false;

  prepare(engine: IEngine): void {
    if (this._initialized) return;
    this._initialized = true;
    this._engine = engine;
    const { device } = engine;
    this._geoCache = getSharedGeometry3DGPUCache(device, getEngineGPUResourceTracker(engine));
    this._sceneFrameBinding = getSceneFrameGpuArena(device).createBinding();
    this._objectLayout = device.createBindGroupLayout({
      label: 'MotionVectorRenderer.objectLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this._deformationLayout = device.createBindGroupLayout({
      label: 'MotionVectorRenderer.deformationLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const coverageLayout = device.createBindGroupLayout({ entries: [...MATERIAL_COVERAGE_LAYOUT] });
    this.coverageBindings = new MaterialCoverageBindings(device, coverageLayout);
    const generated = getBuiltinDeformationShader(device, 'motion-vector', [
      this._sceneFrameBinding.bindGroupLayout,
      this._objectLayout,
      coverageLayout,
      this._deformationLayout,
    ]);
    this._shader = generated.module;
    this._pipelineLayout = generated.pipelineLayout;
    this._createFallbackDeformation();
  }

  beginView(
    sceneFrame: SceneFrameUniformSnapshot,
    options: MotionVectorViewOptions,
    context: RenderCommandContext,
  ): void {
    this._sweepStaleViews(options.frameId, options.viewKey, context);
    let state = this._views.get(options.viewKey);
    if (!state) {
      state = {
        entities: new Map(),
        liveEntities: new Set(),
        previousViewProjection: new Float32Array(16),
        currentViewProjection: new Float32Array(16),
        previousJitter: new Float32Array(2),
        currentJitter: new Float32Array(2),
        cameraDepth: new Float32Array(4),
        width: 0,
        height: 0,
        valid: false,
        continuous: false,
        lastFrameId: -1,
        currentFrameId: options.frameId,
        lastSeenFrameId: options.frameId,
        cameraId: -1,
        historyRevision: -1,
      };
      this._views.set(options.viewKey, state);
    }
    state.currentViewProjection.set(sceneFrame.data.subarray(0, 16));
    const width = sceneFrame.data[52]!;
    const height = sceneFrame.data[53]!;
    state.currentJitter[0] = (options.projectionJitter[0] ?? 0) / Math.max(1, width);
    state.currentJitter[1] = (options.projectionJitter[1] ?? 0) / Math.max(1, height);
    state.currentFrameId = options.frameId;
    state.continuous = state.valid
      && state.lastFrameId + 1 === options.frameId
      && state.cameraId === options.cameraId
      && state.historyRevision === options.historyRevision
      && state.width === width && state.height === height
      && state.cameraDepth[0] === Math.fround(options.near) && state.cameraDepth[1] === Math.fround(options.far)
      && state.cameraDepth[2] === (options.isOrthographic ? 1 : 0)
      && state.cameraDepth[3] === (this.reverseZ ? 1 : 0);
    state.cameraDepth.set([options.near, options.far, options.isOrthographic ? 1 : 0, this.reverseZ ? 1 : 0]);
    state.width = width;
    state.height = height;
    if (!state.continuous) {
      state.previousViewProjection.set(state.currentViewProjection);
      state.previousJitter.set(state.currentJitter);
    }
    state.lastSeenFrameId = options.frameId;
    state.liveEntities.clear();
    this._cameraDynamicOffset[0] = this._sceneFrameBinding.upload(sceneFrame, context);
    this._activeView = state;
    this._activeContext = context;
  }

  render(
    pass: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    worldMatrix: Float32Array,
    clippingPlanes: ClippingPlanes | null = null,
    sourceMaterial: Material | null = null,
    coverage: MaterialCoverageResources | null = null,
  ): void {
    const state = this._activeView;
    if (!state) throw new Error('MotionVectorRenderer.render() requires beginView().');
    const { device } = this._engine;
    const geometryData = this._geoCache.ensure(geometry, this);
    const deformation = this._ensureGeometryDeformation(geometry);
    let entity = state.entities.get(entityId);
    if (!entity) {
      const buffer = device.createBuffer({
        label: `MotionVectorRenderer.entity${entityId}`,
        size: MOTION_OBJECT_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const clippingBuffer = device.createBuffer({
        label: `MotionVectorRenderer.entity${entityId}.clipping`,
        size: CLIPPING_BLOCK_FLOATS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      getEngineGPUResourceTracker(this._engine)?.trackBuffer(buffer, 'MotionVectorRenderer.objectBuffer', MOTION_OBJECT_FLOATS * 4);
      getEngineGPUResourceTracker(this._engine)?.trackBuffer(clippingBuffer, 'MotionVectorRenderer.clippingBuffer', CLIPPING_BLOCK_FLOATS * 4);
      entity = {
        buffer,
        clippingBuffer,
        bindGroup: device.createBindGroup({
          layout: this._objectLayout,
          entries: [
            { binding: 0, resource: { buffer } },
            { binding: 1, resource: { buffer: clippingBuffer } },
          ],
        }),
        uniformData: new Float32Array(MOTION_OBJECT_FLOATS),
        clippingData: new Float32Array(CLIPPING_BLOCK_FLOATS),
        previousModel: new Float32Array(16),
        previousMorphWeights: new Float32Array(4),
        previousSkinMatrices: new Float32Array(0),
        currentSkinBuffer: null,
        previousSkinBuffer: null,
        skinBindGroup: this._fallbackDeformationBindGroup,
        skinJointBuffer: null,
        skinMatrixByteLength: 0,
        geometryId: -1,
        deformationEnabled: true,
        lastFrameId: -1,
        clippingKey: '',
      };
      state.entities.set(entityId, entity);
    }
    const deform = auxiliaryUsesDeformation(sourceMaterial);
    const entityContinuous = state.continuous
      && entity.lastFrameId === state.lastFrameId
      && entity.geometryId === geometry.id
      && entity.deformationEnabled === deform;
    const morphEnabled = deform && deformation.morphEnabled;
    entity.uniformData.set(worldMatrix, 0);
    entity.uniformData.set(entityContinuous ? entity.previousModel : worldMatrix, 16);
    entity.uniformData.set(state.previousViewProjection, 32);
    for (let index = 0; index < 4; index++) {
      const current = morphEnabled ? geometry.morphWeights[index] ?? 0 : 0;
      entity.uniformData[48 + index] = current;
      entity.uniformData[52 + index] = entityContinuous ? entity.previousMorphWeights[index]! : current;
    }
    entity.uniformData[56] = morphEnabled ? 1 : 0;
    entity.uniformData[57] = deform && geometry.skinning ? 1 : 0;
    entity.uniformData[58] = entityContinuous ? 1 : 0;
    entity.uniformData[59] = this.auxiliaryNormal ? 1 : 0;
    entity.uniformData.set(state.cameraDepth, 60);
    entity.uniformData[64] = state.currentJitter[0]! - state.previousJitter[0]!;
    entity.uniformData[65] = state.currentJitter[1]! - state.previousJitter[1]!;
    const clipKey = clippingStateKey(clippingPlanes);
    if (entity.clippingKey !== clipKey) {
      writeClippingBlock(entity.clippingData, 0, clippingPlanes);
      writeBuffer(device.queue, entity.clippingBuffer, 0, entity.clippingData);
      entity.clippingKey = clipKey;
    }
    this._prepareEntitySkinHistory(entity, deformation, geometry, entityContinuous);
    writeBuffer(device.queue, entity.buffer, 0, entity.uniformData);

    const pipeline = this._getPipeline(geometry, sourceMaterial);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this._sceneFrameBinding.bindGroup, this._cameraDynamicOffset);
    pass.setBindGroup(1, entity.bindGroup);
    pass.setBindGroup(2, this.coverageBindings.get(coverage));
    pass.setBindGroup(3, entity.skinBindGroup);
    pass.setVertexBuffer(0, geometryData.positionBuf);
    pass.setVertexBuffer(5, geometryData.uvBuf);
    pass.setVertexBuffer(6, geometryData.uv1Buf ?? geometryData.uvBuf);
    pass.setVertexBuffer(7, geometryData.normalBuf);
    for (let index = 0; index < 4; index++) pass.setVertexBuffer(index + 1, deformation.morphBuffers[index]!);
    if (geometryData.indexBuf) {
      pass.setIndexBuffer(geometryData.indexBuf, geometryData.indexFormat);
      pass.drawIndexed(geometryData.indexCount);
    } else {
      pass.draw(geometryData.vertexCount);
    }
    entity.previousModel.set(worldMatrix);
    entity.previousMorphWeights.set(entity.uniformData.subarray(48, 52));
    if (geometry.skinning) entity.previousSkinMatrices = copyFloat32Array(geometry.skinning.jointMatrices, entity.previousSkinMatrices);
    else entity.previousSkinMatrices = new Float32Array(0);
    entity.geometryId = geometry.id;
    entity.deformationEnabled = deform;
    entity.lastFrameId = state.currentFrameId;
    state.liveEntities.add(entityId);
  }

  endView(options: MotionVectorViewOptions): void {
    const state = this._activeView;
    const context = this._activeContext;
    if (!state || !context) return;
    for (const [entityId, entity] of state.entities) {
      if (state.liveEntities.has(entityId)) continue;
      state.entities.delete(entityId);
      this._retireEntity(entity, context);
    }
    state.previousViewProjection.set(state.currentViewProjection);
    state.previousJitter.set(state.currentJitter);
    state.valid = true;
    state.lastFrameId = options.frameId;
    state.cameraId = options.cameraId;
    state.historyRevision = options.historyRevision;
    this._activeView = null;
    this._activeContext = null;
  }

  releaseGeometriesNotIn(liveGeometries: LiveIdSet): void {
    this._geoCache.releaseUnused(this, liveGeometries);
    this._deformations.releaseNotIn(liveGeometries);
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const key = this._pipelineKey('triangle-list', 'back', 'ccw', undefined);
    const depth = this.auxiliaryDepth, normal = this.auxiliaryNormal;
    this.addPipelineWarmup(plan, key, 'Motion vectors', () => (
      this._pipelineDescriptor('triangle-list', 'back', 'ccw', undefined, depth, normal)
    ), this._engine.device);
  }

  destroy(): void {
    const tracker = getEngineGPUResourceTracker(this._engine);
    for (const state of this._views.values()) for (const entity of state.entities.values()) {
      tracker?.untrackBuffer(entity.buffer);
      tracker?.untrackBuffer(entity.clippingBuffer);
      entity.buffer.destroy();
      entity.clippingBuffer.destroy();
      if (entity.currentSkinBuffer) tracker?.untrackBuffer(entity.currentSkinBuffer);
      if (entity.previousSkinBuffer) tracker?.untrackBuffer(entity.previousSkinBuffer);
      entity.currentSkinBuffer?.destroy();
      entity.previousSkinBuffer?.destroy();
    }
    this._views.clear();
    this._geoCache?.releaseOwner(this);
    this._deformations.clear();
    tracker?.untrackBuffer(this._fallbackMatrixBuffer);
    tracker?.untrackBuffer(this._fallbackAttributeBuffer);
    this._fallbackMatrixBuffer?.destroy();
    this._fallbackAttributeBuffer?.destroy();
    this.coverageBindings?.destroy();
    this._sceneFrameBinding?.destroy();
    this.clearPipelineCache();
    this._activeView = null;
    this._activeContext = null;
    this._initialized = false;
  }

  private _createFallbackDeformation(): void {
    this._fallbackMatrixBuffer = this._makeStorageBuffer(new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]), 'MotionVectorRenderer.fallbackMatrix', 64);
    this._fallbackAttributeBuffer = this._makeStorageBuffer(
      new Float32Array(4),
      'MotionVectorRenderer.fallbackAttribute',
    );
    this._fallbackDeformationBindGroup = this._engine.device.createBindGroup({
      layout: this._deformationLayout,
      entries: [
        { binding: 0, resource: { buffer: this._fallbackMatrixBuffer } },
        { binding: 1, resource: { buffer: this._fallbackMatrixBuffer } },
        { binding: 2, resource: { buffer: this._fallbackAttributeBuffer } },
        { binding: 3, resource: { buffer: this._fallbackAttributeBuffer } },
      ],
    });
  }

  private _ensureGeometryDeformation(geometry: Geometry3D): MotionGeometryDeformationData {
    const morphEnabled = geometry.morphUseGpu && geometry.hasMorphTargets;
    let data = this._deformations.get(geometry.id);
    if (!data || !this._geometryDeformationMatches(data, geometry, morphEnabled)) {
      data = this._createGeometryDeformation(geometry, morphEnabled);
      this._deformations.set(geometry.id, data);
    }
    return data;
  }

  private _geometryDeformationMatches(
    data: MotionGeometryDeformationData,
    geometry: Geometry3D,
    morphEnabled: boolean,
  ): boolean {
    if (data.vertexCount !== geometry.vertexCount || data.morphEnabled !== morphEnabled) return false;
    for (let index = 0; index < 4; index++) {
      if (data.morphSources[index] !== (morphEnabled ? geometry.morphTargets[index]?.positions ?? null : null)) return false;
      if (data.morphNormalSources[index] !== (morphEnabled ? geometry.morphTargets[index]?.normals ?? null : null)) return false;
    }
    const skinning = geometry.skinning;
    return data.skinning === skinning
      && data.skinJointSource === (skinning?.joints ?? null)
      && data.skinWeightSource === (skinning?.weights ?? null);
  }

  private _createGeometryDeformation(
    geometry: Geometry3D,
    morphEnabled: boolean,
  ): MotionGeometryDeformationData {
    const morphSources = Array.from({ length: 4 }, (_, index) =>
      morphEnabled ? geometry.morphTargets[index]?.positions ?? null : null);
    const morphNormalSources = Array.from({ length: 4 }, (_, index) =>
      morphEnabled ? geometry.morphTargets[index]?.normals ?? null : null);
    let zeroMorphBuffer: GPUBuffer | null = null;
    const morphBuffers = morphSources.map((source, index) => {
      const normal = morphNormalSources[index];
      if (!source && !normal) {
        zeroMorphBuffer ??= this._makeVertexBuffer(new Float32Array(geometry.vertexCount * 6), 'MotionVectorRenderer.zeroMorph');
        return zeroMorphBuffer;
      }
      const interleaved = new Float32Array(geometry.vertexCount * 6);
      for (let vertex = 0; vertex < geometry.vertexCount; vertex++) for (let axis = 0; axis < 3; axis++) {
        interleaved[vertex * 6 + axis] = source?.[vertex * 3 + axis] ?? 0;
        interleaved[vertex * 6 + 3 + axis] = normal?.[vertex * 3 + axis] ?? 0;
      }
      return this._makeVertexBuffer(interleaved, `MotionVectorRenderer.morph${index}`);
    });
    const skinning = geometry.skinning;
    return {
      vertexCount: geometry.vertexCount,
      morphEnabled,
      morphSources,
      morphNormalSources,
      morphBuffers,
      skinning,
      skinJointSource: skinning?.joints ?? null,
      skinWeightSource: skinning?.weights ?? null,
      skinJointBuffer: skinning
        ? this._makeStorageBuffer(skinning.joints, 'MotionVectorRenderer.skinJoints')
        : null,
      skinWeightBuffer: skinning
        ? this._makeStorageBuffer(skinning.weights, 'MotionVectorRenderer.skinWeights')
        : null,
    };
  }

  private _prepareEntitySkinHistory(
    entity: MotionEntityState,
    deformation: MotionGeometryDeformationData,
    geometry: Geometry3D,
    continuous: boolean,
  ): void {
    const skinning = geometry.skinning;
    const context = this._activeContext;
    if (!skinning || !deformation.skinJointBuffer || !deformation.skinWeightBuffer) {
      if (entity.currentSkinBuffer) this._retireBuffer(entity.currentSkinBuffer, context);
      if (entity.previousSkinBuffer) this._retireBuffer(entity.previousSkinBuffer, context);
      entity.currentSkinBuffer = null;
      entity.previousSkinBuffer = null;
      entity.skinBindGroup = this._fallbackDeformationBindGroup;
      entity.skinJointBuffer = null;
      entity.skinMatrixByteLength = 0;
      return;
    }

    const byteLength = Math.max(64, alignUp4(skinning.jointMatrices.byteLength));
    if (
      !entity.currentSkinBuffer
      || !entity.previousSkinBuffer
      || entity.skinMatrixByteLength !== byteLength
      || entity.skinJointBuffer !== deformation.skinJointBuffer
    ) {
      if (entity.currentSkinBuffer) this._retireBuffer(entity.currentSkinBuffer, context);
      if (entity.previousSkinBuffer) this._retireBuffer(entity.previousSkinBuffer, context);
      entity.currentSkinBuffer = this._createTrackedBuffer(
        'MotionVectorRenderer.currentSkinMatrices',
        byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      entity.previousSkinBuffer = this._createTrackedBuffer(
        'MotionVectorRenderer.previousSkinMatrices',
        byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      entity.skinBindGroup = this._engine.device.createBindGroup({
        layout: this._deformationLayout,
        entries: [
          { binding: 0, resource: { buffer: entity.currentSkinBuffer } },
          { binding: 1, resource: { buffer: entity.previousSkinBuffer } },
          { binding: 2, resource: { buffer: deformation.skinJointBuffer } },
          { binding: 3, resource: { buffer: deformation.skinWeightBuffer } },
        ],
      });
      entity.skinJointBuffer = deformation.skinJointBuffer;
      entity.skinMatrixByteLength = byteLength;
      continuous = false;
    }

    const previous = continuous && entity.previousSkinMatrices.length === skinning.jointMatrices.length
      ? entity.previousSkinMatrices
      : skinning.jointMatrices;
    writeBuffer(this._engine.device.queue, entity.currentSkinBuffer, 0, skinning.jointMatrices);
    writeBuffer(this._engine.device.queue, entity.previousSkinBuffer, 0, previous);
  }

  private _makeVertexBuffer(data: Float32Array, label: string): GPUBuffer {
    const buffer = this._createTrackedBuffer(
      label,
      Math.max(4, alignUp4(data.byteLength)),
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    );
    if (data.byteLength > 0) writeBuffer(this._engine.device.queue, buffer, 0, data);
    return buffer;
  }

  private _makeStorageBuffer(data: Float32Array, label: string, minimumSize = 16): GPUBuffer {
    const buffer = this._createTrackedBuffer(
      label,
      Math.max(minimumSize, alignUp4(data.byteLength)),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    if (data.byteLength > 0) writeBuffer(this._engine.device.queue, buffer, 0, data);
    return buffer;
  }

  private _createTrackedBuffer(label: string, size: number, usage: number): GPUBuffer {
    const buffer = this._engine.device.createBuffer({ label, size, usage });
    getEngineGPUResourceTracker(this._engine)?.trackBuffer(buffer, label, size);
    return buffer;
  }

  private _destroyGeometryDeformation(data: MotionGeometryDeformationData): void {
    const tracker = getEngineGPUResourceTracker(this._engine);
    for (const buffer of new Set(data.morphBuffers)) {
      tracker?.untrackBuffer(buffer);
      buffer.destroy();
    }
    if (data.skinJointBuffer) tracker?.untrackBuffer(data.skinJointBuffer);
    if (data.skinWeightBuffer) tracker?.untrackBuffer(data.skinWeightBuffer);
    data.skinJointBuffer?.destroy();
    data.skinWeightBuffer?.destroy();
  }

  private _retireBuffer(buffer: GPUBuffer, context: RenderCommandContext | null): void {
    const tracker = getEngineGPUResourceTracker(this._engine);
    const retire = (): void => {
      tracker?.untrackBuffer(buffer);
      buffer.destroy();
    };
    if (context?.afterSubmit) context.afterSubmit(queue => void queue.onSubmittedWorkDone().then(retire, retire));
    else retire();
  }

  private _getPipeline(geometry: Geometry3D, sourceMaterial?: Material | null): GPURenderPipeline {
    const topology = geometry.topology ?? 'triangle-list';
    const cullMode = auxiliaryCullMode(geometry, sourceMaterial);
    const frontFace = auxiliaryFrontFace(geometry, sourceMaterial);
    const stripIndexFormat = getStripIndexFormat(geometry);
    const key = this._pipelineKey(topology, cullMode, frontFace, stripIndexFormat);
    return this.getCachedPipeline(key, () => this._engine.device.createRenderPipeline(
      this._pipelineDescriptor(topology, cullMode, frontFace, stripIndexFormat),
    ));
  }

  private _pipelineDescriptor(
    topology: GPUPrimitiveTopology,
    cullMode: GPUCullMode,
    frontFace: GPUFrontFace,
    stripIndexFormat: GPUIndexFormat | undefined,
    depth = this.auxiliaryDepth,
    normal = this.auxiliaryNormal,
  ): GPURenderPipelineDescriptor {
    return {
      label: 'MotionVectorRenderer.pipeline',
      layout: this._pipelineLayout,
      vertex: {
        module: this._shader,
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          ...Array.from({ length: 4 }, (_, index): GPUVertexBufferLayout => ({
            arrayStride: 24,
            attributes: [
              { shaderLocation: index + 1, offset: 0, format: 'float32x3' },
              { shaderLocation: index + 8, offset: 12, format: 'float32x3' },
            ],
          })),
          { arrayStride: 8, attributes: [{ shaderLocation: 5, offset: 0, format: 'float32x2' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 6, offset: 0, format: 'float32x2' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 7, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: this._shader, entryPoint: 'fs_main', targets: [
        { format: 'rgba16float' }, depth ? { format: 'r32float' } : null, normal ? { format: 'rgba16float' } : null,
      ] },
      primitive: createPrimitiveState(topology, cullMode, frontFace, stripIndexFormat),
      depthStencil: {
        format: this._engine.getDepthFormat(this.reverseZ),
        depthWriteEnabled: true,
        depthCompare: this.reverseZ ? 'greater' : 'less',
      },
      multisample: { count: 1 },
    };
  }

  private _pipelineKey(topology: GPUPrimitiveTopology, cullMode: GPUCullMode, frontFace: GPUFrontFace, stripIndexFormat: GPUIndexFormat | undefined): string {
    return `${encodePrimitivePipelineKey(topology, cullMode, frontFace, stripIndexFormat, this.reverseZ, 1)}:${+this.auxiliaryDepth}:${+this.auxiliaryNormal}`;
  }

  private _sweepStaleViews(frameId: number, activeViewKey: string, context: RenderCommandContext): void {
    for (const [viewKey, state] of this._views) {
      if (viewKey === activeViewKey) continue;
      if (frameId >= state.lastSeenFrameId && frameId - state.lastSeenFrameId <= 120) continue;
      this._views.delete(viewKey);
      for (const entity of state.entities.values()) this._retireEntity(entity, context);
    }
  }

  private _retireEntity(entity: MotionEntityState, context: RenderCommandContext): void {
    const tracker = getEngineGPUResourceTracker(this._engine);
    const retire = (): void => {
      tracker?.untrackBuffer(entity.buffer);
      tracker?.untrackBuffer(entity.clippingBuffer);
      if (entity.currentSkinBuffer) tracker?.untrackBuffer(entity.currentSkinBuffer);
      if (entity.previousSkinBuffer) tracker?.untrackBuffer(entity.previousSkinBuffer);
      entity.buffer.destroy();
      entity.clippingBuffer.destroy();
      entity.currentSkinBuffer?.destroy();
      entity.previousSkinBuffer?.destroy();
    };
    if (context.afterSubmit) context.afterSubmit(queue => void queue.onSubmittedWorkDone().then(retire, retire));
    else retire();
  }
}

function copyFloat32Array(source: Float32Array, target: Float32Array): Float32Array {
  const result = target.length === source.length ? target : new Float32Array(source.length);
  result.set(source);
  return result;
}
