import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { getEngineFrameDiagnostics } from '../core/EngineDiagnosticsAccess';
import { InstancedMesh3D } from '../components/InstancedMesh3D';
import { Transform3D } from '../components/Transform3D';
import { Camera3D } from '../components/Camera3D';
import { InstancedMesh3DRenderer } from '../renderer/InstancedMesh3DRenderer';
import type { InstancedMesh3DExternalIndirectCommand } from '../renderer/InstancedMesh3DRenderer';
import { GpuDrivenBatchBuffer } from '../renderer/GpuDrivenBatchBuffer';
import type { GpuDrivenBatchCommand } from '../renderer/GpuDrivenBatchBuffer';
import { GpuSortComputePass } from '../compute/GpuSortComputePass';
import { GpuDrawCommandComputePass } from '../compute/GpuDrawCommandComputePass';
import { recordComputeResourcePass } from '../compute/ComputeResourceAccess';
import { mat4 } from 'wgpu-matrix';
import type { ViewportRect, ScissorRect } from '../core/ViewportRect';
import { updateEntityWorldMatrix } from './worldMatrix';
import { IDENTITY_MAT4 } from '../math/constants';
import { isEntityDisabledInHierarchyCached, sweepEntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { cloneRenderPassDescriptor, getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import { beginRenderCommandPass, hasGpuPassTiming } from '../core/RenderCommandContext';
import type { RenderCommandContext, RenderFrameContext } from '../core/RenderCommandContext';
import { Frustum, computeBoundingSphere } from '../culling/Frustum';
import type { BoundingSphere } from '../culling/Frustum';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import { getSceneRenderEnvironment } from '../frame/SceneRenderEnvironment';
import { getSceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getRenderViewPassOptions } from '../core/RenderView';
import { quantizeOpaqueDepthFrontToBack } from '../renderer/DepthSortPolicy';

export type InstancedMesh3DBatchSortMode = 'none' | 'geometry-material' | 'material-geometry' | 'depth-front-to-back' | 'depth-back-to-front';
export type InstancedMesh3DInstanceSortMode = 'none' | 'depth-front-to-back' | 'depth-back-to-front';

export interface InstancedMesh3DRenderSystemOptions {
  reverseZ?: boolean;
  msaaSamples?: 1 | 4;
  viewport?: ViewportRect | null;
  scissor?:  ScissorRect  | null;
  loadOp?: 'clear' | 'load';
  indirect?: boolean;
  gpuCulling?: boolean;
  gpuProfiling?: boolean;
  batchSort?: InstancedMesh3DBatchSortMode;
  gpuSorting?: boolean;
  instanceSorting?: InstancedMesh3DInstanceSortMode;
}

export interface InstancedMesh3DGpuProfile {
  supported: boolean;
  pending: boolean;
  gpuCullMs: number | null;
  gpuRenderMs: number | null;
  visibleCount: number | null;
  batchCount: number;
  gpuSortedBatchCount: number;
}

export interface InstancedMesh3DAllocationStats {
  /** Batch records allocated since construction. Stable after the warm-up high-water mark. */
  readonly batchObjectsCreated: number;
  /** GPU command records allocated since construction. Stable after the warm-up high-water mark. */
  readonly commandObjectsCreated: number;
  /** External indirect views allocated since construction. One per pooled batch record. */
  readonly externalIndirectObjectsCreated: number;
}

const GPU_PROFILE_VISIBLE_READBACK_BATCH_CAPACITY = 1024;

interface InstancedMesh3DBatch {
  entity: Entity;
  mesh: InstancedMesh3D;
  geometryId: number;
  materialId: number;
  sortKey: number;
  batchIndex: number;
  readonly externalIndirect: InstancedMesh3DExternalIndirectCommand;
}

export class InstancedMesh3DRenderSystem extends System {
  private engine: IEngine;
  private cameraEntity: Entity;
  private renderer: InstancedMesh3DRenderer;
  private _prepared = false;
  private _reverseZExplicit: boolean;
  private readonly _viewMatrix = mat4.identity() as Float32Array;
  private readonly _viewProjMatrix = mat4.identity() as Float32Array;
  private readonly _liveEntities = new Set<number>();
  private readonly _liveGeometries = new Set<number>();
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  private readonly _worldMatrixCache = new Map<Entity, Transform3D | null>();
  private readonly _frustum = new Frustum();
  private readonly _frustumPlanes = new Float32Array(24);
  private readonly _geometrySpheres = new Map<number, BoundingSphere>();
  private readonly _batches: InstancedMesh3DBatch[] = [];
  private readonly _batchPool: InstancedMesh3DBatch[] = [];
  private readonly _sortedRenderBatches: InstancedMesh3DBatch[] = [];
  private readonly _batchCommands: GpuDrivenBatchCommand[] = [];
  private readonly _batchCommandPool: GpuDrivenBatchCommand[] = [];
  private _batchBuffer: GpuDrivenBatchBuffer | null = null;
  private _sortComputePass: GpuSortComputePass | null = null;
  private _drawCommandComputePass: GpuDrawCommandComputePass | null = null;
  private _gpuProfiler: InstancedMeshGpuProfiler | null = null;
  private _lastBatchCount = 0;
  private _lastGpuSortedBatchCount = 0;
  private readonly _allocationStats = {
    batchObjectsCreated: 0,
    commandObjectsCreated: 0,
    externalIndirectObjectsCreated: 0,
  };

  reverseZ: boolean;
  msaaSamples: 1 | 4;
  viewport: ViewportRect | null;
  scissor:  ScissorRect  | null;
  loadOp: 'clear' | 'load';
  indirect: boolean;
  gpuCulling: boolean;
  gpuProfiling: boolean;
  batchSort: InstancedMesh3DBatchSortMode;
  gpuSorting: boolean;
  instanceSorting: InstancedMesh3DInstanceSortMode;
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'InstancedMesh3DRenderSystem' as const };
  private readonly _unregisterRecovery: (() => void) | null;

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return { pass: 'shared', loadOp: this.loadOp, sort: this.priority };
  }

  get allocationStats(): InstancedMesh3DAllocationStats { return this._allocationStats; }

  constructor(
    engine: IEngine,
    cameraEntity: Entity,
    options: InstancedMesh3DRenderSystemOptions = {},
  ) {
    super({ all: [InstancedMesh3D] });
    this.engine       = engine;
    this.cameraEntity = cameraEntity;
    this._reverseZExplicit = options.reverseZ !== undefined;
    this.reverseZ     = options.reverseZ    ?? engine.reverseZ;
    this.msaaSamples  = options.msaaSamples ?? engine.msaaSamples;
    this.viewport     = options.viewport    ?? null;
    this.scissor      = options.scissor     ?? null;
    this.loadOp       = options.loadOp      ?? 'clear';
    this.indirect     = options.indirect    ?? false;
    this.gpuCulling   = options.gpuCulling  ?? false;
    this.gpuProfiling = options.gpuProfiling ?? false;
    this.batchSort    = options.batchSort   ?? 'geometry-material';
    this.gpuSorting   = options.gpuSorting  ?? false;
    this.instanceSorting = options.instanceSorting ?? 'none';
    this.renderer     = new InstancedMesh3DRenderer();
    this.name         = 'InstancedMesh3DRenderSystem';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this._unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
  }

  override destroy(): this {
    this._unregisterRecovery?.();
    this.suspendForDeviceLoss();
    this._batches.length = 0;
    this._batchPool.length = 0;
    this._sortedRenderBatches.length = 0;
    this._batchCommands.length = 0;
    this._batchCommandPool.length = 0;
    return super.destroy();
  }

  suspendForDeviceLoss(): void {
    this.renderer.destroy();
    this._gpuProfiler?.destroy();
    this._batchBuffer?.destroy();
    this._sortComputePass?.destroy();
    this._drawCommandComputePass?.destroy();
    this._gpuProfiler = null;
    this._batchBuffer = null;
    this._sortComputePass = null;
    this._drawCommandComputePass = null;
    this._prepared = false;
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.renderer = new InstancedMesh3DRenderer();
    this._prepared = false;
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    this.renderer.prepare(this.engine);
    if (!this._reverseZExplicit) this.reverseZ = this.engine.reverseZ;
    this.renderer.reverseZ = this.reverseZ;
    this.renderer.msaaSamples = this.msaaSamples;
    this.renderer.contributePipelineWarmup(plan);
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    const { device } = context;
    if (!device) return this;

    if (!this._prepared) {
      this.renderer.prepare(this.engine);
      this._gpuProfiler = new InstancedMeshGpuProfiler(this.engine.device, this.engine.timestampQuerySupported === true);
      this._prepared = true;
    }
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._worldMatrixCache.clear();

    const reverseZ = context.view?.reverseZ ?? (this._reverseZExplicit ? this.reverseZ : this.engine.reverseZ);
    const sampleCount = context.view?.sampleCount ?? this.msaaSamples;
    this.renderer.reverseZ = reverseZ;
    this.renderer.msaaSamples = sampleCount;

    const cameraEntity = context.view?.camera.getComponent(Camera3D) ? context.view.camera : this.cameraEntity;
    const camera = cameraEntity.getComponent(Camera3D);
    if (!camera) return this;

    const vpW = context.view?.width ?? this.viewport?.width ?? this.engine.width;
    const vpH = context.view?.height ?? this.viewport?.height ?? this.engine.height;
    const frameData = context.frameData ?? world.frameData;
    const cameraFrame = frameData.getCamera3D(cameraEntity, camera, vpW, vpH, reverseZ);
    this._viewMatrix.set(cameraFrame.viewMatrix);
    this._viewProjMatrix.set(cameraFrame.viewProjectionMatrix);
    const viewMatrix = this._viewMatrix;
    const viewProj = this._viewProjMatrix;
    cameraFrame.frustum.copyPlanesTo(this._frustumPlanes);

    const sceneEnvironment = getSceneRenderEnvironment(frameData, world);
    this.renderer.updateCamera(getSceneFrameUniformSnapshot(cameraFrame, sceneEnvironment.fog), context);
    this.renderer.updateLighting(
      sceneEnvironment.pbrLights,
      sceneEnvironment.environmentLight,
      sceneEnvironment.lightingRevision,
    );

    const shouldGpuSortBatches = this.gpuSorting && this.batchSort !== 'none';
    const shouldSortInstances = this.instanceSorting !== 'none' && !this.gpuCulling;
    const needsComputePrepass = (this.gpuCulling && this.indirect) || shouldGpuSortBatches || shouldSortInstances;
    if (needsComputePrepass && context.passEncoder && isRenderFrameContext(context)) {
      context.endPass();
    }

    const batches = this._collectBatches(world);
    this._lastBatchCount = batches.length;
    this._lastGpuSortedBatchCount = 0;
    const batchBuffer = this._prepareGpuDrivenBatchBuffer(context, batches, shouldGpuSortBatches);
    const canDispatchGpuCulling = this.gpuCulling && this.indirect && !context.passEncoder;
    const pipelineGpuTiming = hasGpuPassTiming(context);
    const profilerFrame = this.gpuProfiling && context.afterSubmit
      ? this._gpuProfiler?.beginFrame(!pipelineGpuTiming) ?? null
      : null;
    let profiledVisibleBatchCount = 0;
    if (canDispatchGpuCulling) {
      for (const batch of batches) {
        const { entity, mesh } = batch;
        this.renderer.dispatchGpuCulling(context, entity.id, mesh.geometry, mesh.material, {
          planes: this._frustumPlanes,
          localSphere: this._getGeometrySphere(mesh.geometry),
          timestampWrites: profilerFrame?.computeTimestampWrites,
          externalIndirect: batchBuffer ? this._getExternalIndirect(batchBuffer, batch) : undefined,
        });
        if (profilerFrame && profiledVisibleBatchCount < profilerFrame.visibleReadbackCapacity) {
          const copied = this.renderer.copyGpuCullingCountTo(
            context,
            entity.id,
            profilerFrame.visibleReadbackSource,
            profiledVisibleBatchCount * 4,
          );
          if (copied) profiledVisibleBatchCount++;
        }
      }
    }

    if (shouldSortInstances) {
      const order = this.instanceSorting === 'depth-back-to-front' ? 'back-to-front' : 'front-to-back';
      for (const batch of batches) {
        this.renderer.dispatchInstanceDepthSort(context, batch.entity.id, batch.mesh.material, {
          viewMatrix,
          order,
        });
      }
    }

    if (!context.passEncoder) {
      const descriptor = context.view
        ? cloneRenderPassDescriptor(
            context.view.target.getRenderPassDescriptor(getRenderViewPassOptions(context.view)),
            this.loadOp,
          )
        : getCachedRenderPassDescriptor(this.engine, this.loadOp);
      context.descriptor = profilerFrame?.renderTimestampWrites
        ? { ...cloneRenderPassDescriptor(descriptor, this.loadOp), timestampWrites: profilerFrame.renderTimestampWrites }
        : descriptor;
      context.loadOp = this.loadOp;
    }
    const { passEncoder, ownsPass } = beginInstancedRenderPass(context);

    const viewport = context.view?.viewport ?? this.viewport;
    const scissor = context.view?.scissor ?? this.scissor;
    if (viewport) {
      const vp = viewport;
      passEncoder.setViewport(vp.x, vp.y, vp.width, vp.height, vp.minDepth ?? 0, vp.maxDepth ?? 1);
    }
    if (scissor) {
      const s = scissor;
      passEncoder.setScissorRect(s.x, s.y, s.width, s.height);
    }

    const renderBatches = this._getRenderBatches(batches, shouldGpuSortBatches);
    for (const batch of renderBatches) {
      const { entity, mesh } = batch;
      this.renderer.render(passEncoder, entity.id, mesh.geometry, mesh.material, {
        indirect: this.indirect,
        gpuCulling: canDispatchGpuCulling,
        instanceSorted: shouldSortInstances,
        externalIndirect: this.indirect && batchBuffer ? this._getExternalIndirect(batchBuffer, batch) : undefined,
      });
    }

    if (ownsPass) {
      passEncoder.end();
    } else if (profilerFrame && isRenderFrameContext(context)) {
      context.endPass();
    }
    profilerFrame?.finish(context, profiledVisibleBatchCount);
    const frameDiagnostics = getEngineFrameDiagnostics(this.engine);
    if (this.gpuProfiling && !pipelineGpuTiming && frameDiagnostics?.enabled) {
      const profile = this.getGpuProfile();
      if (profile.gpuCullMs !== null || profile.gpuRenderMs !== null) {
        frameDiagnostics.setGpuDuration((profile.gpuCullMs ?? 0) + (profile.gpuRenderMs ?? 0));
      }
    }
    this.renderer.releaseEntitiesNotIn(this._liveEntities);
    this.renderer.releaseGeometriesNotIn(this._liveGeometries);
    sweepEntityHierarchyDisabledCache(this._disabledHierarchyCache, world.entities);
    return this;
  }

  getGpuProfile(): InstancedMesh3DGpuProfile {
    const profile = this._gpuProfiler?.getProfile() ?? {
      supported: false,
      pending: false,
      gpuCullMs: null,
      gpuRenderMs: null,
      visibleCount: null,
      batchCount: this._lastBatchCount,
      gpuSortedBatchCount: this._lastGpuSortedBatchCount,
    };
    return { ...profile, batchCount: this._lastBatchCount, gpuSortedBatchCount: this._lastGpuSortedBatchCount };
  }

  private _collectBatches(world: World): InstancedMesh3DBatch[] {
    const batches = this._batches;
    batches.length = 0;
    const entities = this.entitySet.get(world);
    if (!entities) return batches;

    for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      const mesh = entity.getComponent(InstancedMesh3D);
      if (!mesh || mesh.material.activeInstanceCount < 1) continue;
      updateEntityWorldMatrix(entity, this._worldMatrixCache, world.frameData);
      this._liveEntities.add(entity.id);
      this._liveGeometries.add(mesh.geometry.id);
      const batchIndex = batches.length;
      let batch = this._batchPool[batchIndex];
      if (!batch) {
        batch = {
          entity,
          mesh,
          geometryId: 0,
          materialId: 0,
          sortKey: 0,
          batchIndex,
          externalIndirect: createExternalIndirectCommand(),
        };
        this._batchPool[batchIndex] = batch;
        this._allocationStats.batchObjectsCreated++;
        this._allocationStats.externalIndirectObjectsCreated++;
      }
      batch.entity = entity;
      batch.mesh = mesh;
      batch.geometryId = mesh.geometry.id;
      batch.materialId = mesh.material.id;
      batch.sortKey = makeBatchSortKey(
        batch.geometryId,
        batch.materialId,
        entity.id,
        this.batchSort,
        transformDepthKey(entity, this._viewMatrix),
      );
      batch.batchIndex = batchIndex;
      batches.push(batch);
    }

    if (!this.gpuSorting && this.batchSort !== 'none' && batches.length > 1) batches.sort(compareBatchSortKey);
    for (const [i, batch] of batches.entries()) batch.batchIndex = i;
    return batches;
  }

  private _getRenderBatches(
    batches: readonly InstancedMesh3DBatch[],
    shouldGpuSortBatches: boolean,
  ): readonly InstancedMesh3DBatch[] {
    if (!shouldGpuSortBatches || !this._batchBuffer || batches.length < 2) return batches;
    const sortedIndices = this._batchBuffer.getSortedIndices(batches.length);
    if (!sortedIndices) return batches;
    const sorted = this._sortedRenderBatches;
    sorted.length = 0;
    for (let i = 0; i < sortedIndices.length; i++) {
      const index = sortedIndices[i];
      const batch = index === undefined ? undefined : batches[index];
      if (batch) sorted.push(batch);
    }
    return sorted.length === batches.length ? sorted : batches;
  }

  private _prepareGpuDrivenBatchBuffer(
    context: RenderCommandContext,
    batches: readonly InstancedMesh3DBatch[],
    shouldGpuSortBatches: boolean,
  ): GpuDrivenBatchBuffer | null {
    if ((!this.indirect && !shouldGpuSortBatches) || batches.length < 1) return null;
    const batchBuffer = this._batchBuffer ??= new GpuDrivenBatchBuffer(this.engine, 'InstancedMesh3D.batches');
    const commands = this._writeBatchCommands(batches);
    batchBuffer.upload(commands);
    if (this.indirect) {
      const commandPass = this._drawCommandComputePass ??= new GpuDrawCommandComputePass(this.engine, 'InstancedMesh3D.drawCommands');
      const token = commandPass.generate(context, {
        commandBuffer: batchBuffer.commandBuffer,
        indexedIndirectBuffer: batchBuffer.indexedIndirectBuffer,
        drawIndirectBuffer: batchBuffer.drawIndirectBuffer,
        count: batchBuffer.count,
      });
      if (token) {
        recordComputeResourcePass(context, {
          label: 'InstancedMesh3D.indirectDrawConsumption',
          path: 'InstancedMesh3D.indirectDrawConsumption',
          after: [token],
          accesses: [
            { resource: batchBuffer.indexedIndirectBuffer, use: 'indirect', path: 'InstancedMesh3D.indirectDrawConsumption.indexedIndirectBuffer' },
            { resource: batchBuffer.drawIndirectBuffer, use: 'indirect', path: 'InstancedMesh3D.indirectDrawConsumption.drawIndirectBuffer' },
          ],
        });
      }
    }
    if (shouldGpuSortBatches && batches.length > 1) {
      const sortPass = this._sortComputePass ??= new GpuSortComputePass(this.engine, 'InstancedMesh3D.batchSort');
      const token = sortPass.sort(context, batchBuffer);
      if (token) {
        recordComputeResourcePass(context, {
          label: 'InstancedMesh3D.sortedIndexReadback',
          path: 'InstancedMesh3D.sortedIndexReadback',
          after: [token],
          accesses: [{ resource: batchBuffer.sortIndexBuffer, use: 'copy-read', path: 'InstancedMesh3D.sortedIndexReadback.sortIndexBuffer' }],
        });
      }
      batchBuffer.requestSortedIndexReadback(context);
      this._lastGpuSortedBatchCount = batchBuffer.count;
    }
    return batchBuffer;
  }

  private _writeBatchCommands(batches: readonly InstancedMesh3DBatch[]): readonly GpuDrivenBatchCommand[] {
    const commands = this._batchCommands;
    commands.length = batches.length;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      let command = this._batchCommandPool[i];
      if (!command) {
        command = createBatchCommand();
        this._batchCommandPool[i] = command;
        this._allocationStats.commandObjectsCreated++;
      }
      command.entityId = batch.entity.id;
      command.geometryId = batch.geometryId;
      command.materialId = batch.materialId;
      command.instanceCount = batch.mesh.material.activeInstanceCount;
      command.indexCount = batch.mesh.geometry.indexCount;
      command.vertexCount = batch.mesh.geometry.vertexCount;
      command.sortKey = batch.sortKey;
      commands[i] = command;
    }
    return commands;
  }

  private _getExternalIndirect(
    batchBuffer: GpuDrivenBatchBuffer,
    batch: InstancedMesh3DBatch,
  ): InstancedMesh3DExternalIndirectCommand {
    return batchBuffer.writeIndirectCommandView(batch.batchIndex, batch.externalIndirect);
  }

  private _getGeometrySphere(geometry: InstancedMesh3D['geometry']): BoundingSphere {
    let sphere = this._geometrySpheres.get(geometry.id);
    if (!sphere) {
      sphere = computeBoundingSphere(geometry.positions);
      this._geometrySpheres.set(geometry.id, sphere);
    }
    return sphere;
  }

}

function createBatchCommand(): GpuDrivenBatchCommand {
  return {
    entityId: 0,
    geometryId: 0,
    materialId: 0,
    instanceCount: 0,
    indexCount: 0,
    vertexCount: 0,
    sortKey: 0,
  };
}

function createExternalIndirectCommand(): InstancedMesh3DExternalIndirectCommand {
  return {
    indexedIndirectBuffer: null as unknown as GPUBuffer,
    drawIndirectBuffer: null as unknown as GPUBuffer,
    indexedIndirectOffset: 0,
    drawIndirectOffset: 0,
  };
}

function compareBatchSortKey(a: InstancedMesh3DBatch, b: InstancedMesh3DBatch): number {
  return (a.sortKey - b.sortKey) || (a.entity.id - b.entity.id);
}

function makeBatchSortKey(
  geometryId: number,
  materialId: number,
  entityId: number,
  mode: InstancedMesh3DBatchSortMode,
  depthKey: number,
): number {
  if (mode === 'material-geometry') return packSortKey(materialId, geometryId, entityId);
  if (mode === 'depth-front-to-back') return packDepthSortKey(depthKey, materialId, entityId);
  if (mode === 'depth-back-to-front') return packDepthSortKey(0xffff - depthKey, materialId, entityId);
  return packSortKey(geometryId, materialId, entityId);
}

function packSortKey(primary: number, secondary: number, tieBreaker: number): number {
  return (((primary & 0xfff) << 20) | ((secondary & 0xfff) << 8) | (tieBreaker & 0xff)) >>> 0;
}

function packDepthSortKey(depthKey: number, materialId: number, tieBreaker: number): number {
  return (((depthKey & 0xffff) << 16) | ((materialId & 0xff) << 8) | (tieBreaker & 0xff)) >>> 0;
}

function transformDepthKey(entity: Entity, viewMatrix: Float32Array): number {
  const transform = entity.getComponent(Transform3D);
  const world = transform?.worldMatrix;
  if (!world) return 0;
  const x = world[12] ?? 0;
  const y = world[13] ?? 0;
  const z = world[14] ?? 0;
  const viewZ = (viewMatrix[2] ?? 0) * x + (viewMatrix[6] ?? 0) * y + (viewMatrix[10] ?? 0) * z + (viewMatrix[14] ?? 0);
  const cameraDepth = quantizeOpaqueDepthFrontToBack(-viewZ);
  return cameraDepth;
}

function isRenderFrameContext(context: RenderCommandContext): context is RenderFrameContext {
  return typeof (context as Partial<RenderFrameContext>).endPass === 'function'
    && typeof (context as Partial<RenderFrameContext>).beginPass === 'function';
}

function beginInstancedRenderPass(context: RenderCommandContext): { passEncoder: GPURenderPassEncoder; ownsPass: boolean } {
  if (context.passEncoder) return { passEncoder: context.passEncoder, ownsPass: false };
  if (isRenderFrameContext(context)) {
    return { passEncoder: context.beginPass(context.descriptor, context.loadOp), ownsPass: false };
  }
  return beginRenderCommandPass(context);
}

interface InstancedMeshGpuProfilerFrame {
  visibleReadbackSource: GPUBuffer;
  visibleReadbackCapacity: number;
  computeTimestampWrites?: GPUComputePassTimestampWrites;
  renderTimestampWrites?: GPURenderPassTimestampWrites;
  finish(context: RenderCommandContext, visibleBatchCount: number): void;
}

class InstancedMeshGpuProfiler {
  private readonly _querySet: GPUQuerySet | null = null;
  private readonly _resolveBuffer: GPUBuffer | null = null;
  private readonly _timestampReadbackBuffer: GPUBuffer | null = null;
  private readonly _visibleReadbackSource: GPUBuffer | null = null;
  private readonly _visibleReadbackBuffer: GPUBuffer | null = null;
  private _pending = false;
  private _frameReady = false;
  private _captureTimestamps = true;
  private _visibleBatchCount = 0;
  private _last: InstancedMesh3DGpuProfile;

  constructor(private readonly _device: GPUDevice | null, supported: boolean) {
    this._last = {
      supported,
      pending: false,
      gpuCullMs: null,
      gpuRenderMs: null,
      visibleCount: null,
      batchCount: 0,
      gpuSortedBatchCount: 0,
    };
    if (!_device || !supported) return;
    this._querySet = _device.createQuerySet({ type: 'timestamp', count: 4 });
    this._resolveBuffer = _device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this._timestampReadbackBuffer = _device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this._visibleReadbackSource = _device.createBuffer({
      size: GPU_PROFILE_VISIBLE_READBACK_BATCH_CAPACITY * 4,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this._visibleReadbackBuffer = _device.createBuffer({
      size: GPU_PROFILE_VISIBLE_READBACK_BATCH_CAPACITY * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  beginFrame(captureTimestamps = true): InstancedMeshGpuProfilerFrame | null {
    if (!this._querySet || !this._resolveBuffer || !this._timestampReadbackBuffer || !this._visibleReadbackSource || !this._visibleReadbackBuffer) return null;
    if (this._pending) return null;
    this._frameReady = false;
    this._captureTimestamps = captureTimestamps;
    this._visibleBatchCount = 0;
    const frame: InstancedMeshGpuProfilerFrame = {
      visibleReadbackSource: this._visibleReadbackSource,
      visibleReadbackCapacity: GPU_PROFILE_VISIBLE_READBACK_BATCH_CAPACITY,
      ...(captureTimestamps ? {
        computeTimestampWrites: {
          querySet: this._querySet,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
        renderTimestampWrites: {
          querySet: this._querySet,
          beginningOfPassWriteIndex: 2,
          endOfPassWriteIndex: 3,
        },
      } : {}),
      finish: (context, visibleBatchCount) => {
        if (!this._querySet || !this._resolveBuffer || !this._timestampReadbackBuffer || !this._visibleReadbackSource || !this._visibleReadbackBuffer) return;
        if (!context.afterSubmit) return;
        if (captureTimestamps) {
          context.encoder.resolveQuerySet(this._querySet, 0, 4, this._resolveBuffer, 0);
          context.encoder.copyBufferToBuffer(this._resolveBuffer, 0, this._timestampReadbackBuffer, 0, 32);
        }
        if (visibleBatchCount > 0) {
          context.encoder.copyBufferToBuffer(this._visibleReadbackSource, 0, this._visibleReadbackBuffer, 0, visibleBatchCount * 4);
        }
        this._visibleBatchCount = visibleBatchCount;
        this._frameReady = true;
        context.afterSubmit(() => this._startReadback());
      },
    };
    return frame;
  }

  getProfile(): InstancedMesh3DGpuProfile {
    return { ...this._last, pending: this._pending };
  }

  private _startReadback(): void {
    if (!this._device || !this._timestampReadbackBuffer || !this._visibleReadbackBuffer || !this._frameReady || this._pending) {
      return;
    }
    this._pending = true;
    this._frameReady = false;
    const visibleBatchCount = this._visibleBatchCount;
    const timestampReadbackBuffer = this._timestampReadbackBuffer;
    const visibleReadbackBuffer = this._visibleReadbackBuffer;
    const captureTimestamps = this._captureTimestamps;
    const timestampPromise = captureTimestamps ? timestampReadbackBuffer.mapAsync(GPUMapMode.READ) : Promise.resolve();
    const visiblePromise = visibleBatchCount > 0 ? visibleReadbackBuffer.mapAsync(GPUMapMode.READ) : Promise.resolve();
    void Promise.all([timestampPromise, visiblePromise])
      .then(() => {
        const timestamps = captureTimestamps ? new BigUint64Array(timestampReadbackBuffer.getMappedRange()) : null;
        const visibleCounts = visibleBatchCount > 0 ? new Uint32Array(visibleReadbackBuffer.getMappedRange()) : null;
        let visible: number | null = null;
        if (visibleCounts) {
          visible = 0;
          for (let i = 0; i < visibleBatchCount; i++) visible += visibleCounts[i] ?? 0;
        }
        const cullStart = timestamps?.[0] ?? 0n;
        const cullEnd = timestamps?.[1] ?? 0n;
        const renderStart = timestamps?.[2] ?? 0n;
        const renderEnd = timestamps?.[3] ?? 0n;
        const cullNs = cullEnd > cullStart ? cullEnd - cullStart : 0n;
        const renderNs = renderEnd > renderStart ? renderEnd - renderStart : 0n;
        this._last = {
          supported: true,
          pending: false,
          gpuCullMs: captureTimestamps ? Number(cullNs) / 1_000_000 : null,
          gpuRenderMs: captureTimestamps ? Number(renderNs) / 1_000_000 : null,
          visibleCount: visible,
          batchCount: this._last.batchCount,
          gpuSortedBatchCount: this._last.gpuSortedBatchCount,
        };
      })
      .catch(() => {
        this._last = {
          supported: true,
          pending: false,
          gpuCullMs: null,
          gpuRenderMs: null,
          visibleCount: null,
          batchCount: this._last.batchCount,
          gpuSortedBatchCount: this._last.gpuSortedBatchCount,
        };
      })
      .finally(() => {
        if (captureTimestamps) safeUnmap(timestampReadbackBuffer);
        if (visibleBatchCount > 0) safeUnmap(visibleReadbackBuffer);
        this._pending = false;
      });
  }

  destroy(): void {
    this._querySet?.destroy();
    this._resolveBuffer?.destroy();
    this._timestampReadbackBuffer?.destroy();
    this._visibleReadbackSource?.destroy();
    this._visibleReadbackBuffer?.destroy();
  }
}

function safeUnmap(buffer: GPUBuffer): void {
  try {
    buffer.unmap();
  } catch {
    // The buffer may never have reached the mapped state if mapAsync failed.
  }
}
