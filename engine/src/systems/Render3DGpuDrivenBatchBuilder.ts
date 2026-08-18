import type { IEngine } from '../core/IEngine';
import { GPU_FEATURE_INDIRECT_FIRST_INSTANCE, hasGpuFeature } from '../core/GPUFeatures';
import type { RenderCommandContext, RenderFrameContext } from '../core/RenderCommandContext';
import { GpuDrawCommandComputePass } from '../compute/GpuDrawCommandComputePass';
import { Mesh3DGpuCullComputePass } from '../compute/Mesh3DGpuCullComputePass';
import {
  recordComputeResourcePass,
  type ComputeResourcePassToken,
} from '../compute/ComputeResourceAccess';
import { GpuDrivenBatchBuffer } from '../renderer/GpuDrivenBatchBuffer';
import type {
  GpuDrivenBatchCommand,
  GpuDrivenInstanceTableEntry,
  GpuDrivenMaterialTableEntry,
  GpuDrivenMegaBatchRun,
} from '../renderer/GpuDrivenBatchBuffer';
import type { MaterialGpuDrivenBatch, MaterialRendererRegistration } from '../renderer/MaterialRendererRegistry';
import type { Frustum } from '../culling/Frustum';
import type { Render3DRenderItem } from './Render3DContracts';
import type { Render3DOpaqueSceneSortKey, WorldFrameRenderable, WorldFrameState } from './Render3DFrameState';
import type { World, WorldComponentChange, WorldComponentChangeJournal } from '../ecs/World';
import type { FrameData } from '../frame/FrameData';
import { Mesh3D } from '../components/Mesh3D';
import type { Material } from '../material/Material';
import type { Geometry3D } from '../geometry/Geometry3D';
import { FrameRingResource, type FrameRingGenerationInfo } from '../renderer/FrameRingResource';
import { quantizeOpaqueDepthFrontToBack, quantizeTransparentDepthBackToFront } from '../renderer/DepthSortPolicy';

export interface Render3DGpuDrivenBatchBuildStats {
  batchCount: number;
  materialCount: number;
  globalCommandBuilds: number;
  globalCommandUpdates: number;
  commandObjectsCreated: number;
  materialRendererResolutions: number;
}

type MaterialResolver = (material: Material) => MaterialRendererRegistration | null;
type RendererSlotResolver = (registration: MaterialRendererRegistration) => number;
const GPU_DRIVEN_VIEW_RING_FRAMES = 3;

interface GpuDrivenViewGeneration {
  readonly info: FrameRingGenerationInfo;
  readonly batchBuffers: Array<GpuDrivenBatchBuffer | null>;
  readonly drawCommandPasses: Array<GpuDrawCommandComputePass | null>;
  readonly cullCommandPasses: Array<Mesh3DGpuCullComputePass | null>;
}

interface MutableOpaqueSceneSortKey extends Render3DOpaqueSceneSortKey {
  rendererSlot: number;
  materialSlot: number;
  geometrySlot: number;
  entitySlot: number;
}

export class Render3DGpuDrivenBatchBuilder {
  private _globalBatchBuffer: GpuDrivenBatchBuffer | null = null;
  private _currentBatchBuffer: GpuDrivenBatchBuffer | null = null;
  private readonly _viewRing: FrameRingResource<GpuDrivenViewGeneration>;
  private readonly _cullFrustumPlanes = new Float32Array(24);
  private readonly _commands: GpuDrivenBatchCommand[] = [];
  private readonly _globalCommands: GpuDrivenBatchCommand[] = [];
  private readonly _commandPool: GpuDrivenBatchCommand[] = [];
  private readonly _globalCommandPool: GpuDrivenBatchCommand[] = [];
  private readonly _instanceEntries: GpuDrivenInstanceTableEntry[] = [];
  private readonly _instanceEntryPool: GpuDrivenInstanceTableEntry[] = [];
  private readonly _materialEntries: GpuDrivenMaterialTableEntry[] = [];
  private readonly _materialEntryPool: GpuDrivenMaterialTableEntry[] = [];
  private readonly _megaBatchRuns: GpuDrivenMegaBatchRun[] = [];
  private readonly _megaBatchRunPool: GpuDrivenMegaBatchRun[] = [];
  private readonly _instanceTable = new Map<number, number>();
  private readonly _globalObjectSlots = new Map<number, number>();
  private readonly _geometrySlots = new Map<number, number>();
  private readonly _geometrySeenGenerations: number[] = [];
  private readonly _freeGeometrySlots: number[] = [];
  private _nextGeometrySlot = 0;
  private readonly _opaqueSortKeysByObjectSlot: MutableOpaqueSceneSortKey[][] = [];
  private readonly _materialTable = new Map<number, number>();
  private readonly _materialsBySlot: Material[] = [];
  private readonly _materialSeenGenerations: number[] = [];
  private readonly _materialRendererSlots: number[] = [];
  private readonly _materialRendererSortScratch: number[] = [];
  private readonly _rendererSlotsByMaterialId = new Map<number, number>();
  private readonly _registrationsByMaterialId = new Map<number, MaterialRendererRegistration | null>();
  private readonly _globalRenderableOrder: WorldFrameRenderable[] = [];
  private readonly _freeObjectSlots: number[] = [];
  private _objectEntityIds = new Uint32Array(0);
  private _objectMeshIds = new Uint32Array(0);
  private _objectGeometryIds = new Uint32Array(0);
  private _objectGeometryVersions = new Uint32Array(0);
  private _objectMaterialIds = new Uint32Array(0);
  private _objectMaterialRevisions = new Uint32Array(0);
  private _objectTransformVersions = new Uint32Array(0);
  private _objectLodRevisions = new Uint32Array(0);
  private _objectSeenGenerations = new Uint32Array(0);
  private _objectCapacity = 0;
  private _nextObjectSlot = 0;
  private _sceneGeneration = 0;
  private _rendererRegistryRevision = -1;
  private _world: World | null = null;
  private _meshJournal: WorldComponentChangeJournal | null = null;
  private readonly _meshChanges: WorldComponentChange[] = [];
  private readonly _dirtyEntityIds = new Set<number>();
  private readonly _batchMaterialSlots: number[] = [];
  private readonly _batchRendererSlots: number[] = [];
  private readonly _materialBatchContext: MaterialGpuDrivenBatch = {
    batchBuffer: null as unknown as GpuDrivenBatchBuffer,
    batchIndex: 0,
    objectSlot: 0,
    materialSlot: 0,
    rendererSlot: 0,
    indexedIndirectBuffer: null as unknown as GPUBuffer,
    indexedIndirectOffset: 0,
    drawIndirectBuffer: null as unknown as GPUBuffer,
    drawIndirectOffset: 0,
    instanceTableBuffer: null as unknown as GPUBuffer,
    materialTableBuffer: null as unknown as GPUBuffer,
    megaBatchRunBuffer: null as unknown as GPUBuffer,
  };
  private readonly _buildStats: Render3DGpuDrivenBatchBuildStats = {
    batchCount: 0,
    materialCount: 0,
    globalCommandBuilds: 0,
    globalCommandUpdates: 0,
    commandObjectsCreated: 0,
    materialRendererResolutions: 0,
  };
  private _currentViewSlot = 0;
  private _activeMaterialResolver: MaterialResolver | null = null;
  private _activeRendererSlotResolver: RendererSlotResolver | null = null;

  private readonly _compareGlobalRenderables = (a: WorldFrameRenderable, b: WorldFrameRenderable): number => {
    const aMaterial = getGlobalMaterial(a);
    const bMaterial = getGlobalMaterial(b);
    const aRegistration = this._resolveGlobalMaterialRegistration(aMaterial);
    const bRegistration = this._resolveGlobalMaterialRegistration(bMaterial);
    const aTransparent = aRegistration?.isTransparent?.(aMaterial) === true;
    const bTransparent = bRegistration?.isTransparent?.(bMaterial) === true;
    return (Number(aTransparent) - Number(bTransparent))
      || (this._getRendererSlotForMaterial(aMaterial.id) - this._getRendererSlotForMaterial(bMaterial.id))
      || (aMaterial.id - bMaterial.id)
      || (getGlobalGeometry(a).id - getGlobalGeometry(b).id)
      || (a.entityId - b.entityId);
  };

  constructor(private readonly _engine: IEngine) {
    this._viewRing = new FrameRingResource<GpuDrivenViewGeneration>({
      label: 'Render3DSystem.gpuDrivenViews',
      framesInFlight: GPU_DRIVEN_VIEW_RING_FRAMES,
      create: info => ({
        info,
        batchBuffers: new Array<GpuDrivenBatchBuffer | null>(info.slotCount).fill(null),
        drawCommandPasses: new Array<GpuDrawCommandComputePass | null>(info.slotCount).fill(null),
        cullCommandPasses: new Array<Mesh3DGpuCullComputePass | null>(info.slotCount).fill(null),
      }),
      destroy: generation => destroyViewGeneration(generation),
    });
  }

  get batchBuffer(): GpuDrivenBatchBuffer | null {
    return this._currentBatchBuffer;
  }

  get megaBatchRuns(): readonly GpuDrivenMegaBatchRun[] {
    return this._megaBatchRuns;
  }

  get currentViewSlot(): number { return this._currentViewSlot; }

  beginFrame(viewCount: number, context?: RenderCommandContext): void {
    this._viewRing.beginFrame(viewCount, context);
    this._globalBatchBuffer ??= new GpuDrivenBatchBuffer(this._engine, 'Render3DSystem.batches');
    this._currentBatchBuffer = null;
    this._buildStats.globalCommandBuilds = 0;
    this._buildStats.globalCommandUpdates = 0;
    this._buildStats.commandObjectsCreated = 0;
    this._buildStats.materialRendererResolutions = 0;
  }

  getBatchIndexForEntity(entityId: number): number | undefined {
    return this._instanceTable.get(entityId);
  }

  getMaterialSlot(materialId: number): number | undefined {
    return this._materialTable.get(materialId);
  }

  getOpaqueSceneSortKey(entityId: number, lodLevel: number): Render3DOpaqueSceneSortKey | null {
    const objectSlot = this._globalObjectSlots.get(entityId);
    if (objectSlot === undefined) return null;
    const keys = this._opaqueSortKeysByObjectSlot[objectSlot];
    if (!keys) return null;
    return keys[lodLevel < 0 ? 0 : lodLevel + 1] ?? keys[0] ?? null;
  }

  prepareSceneGlobal(
    world: World,
    frameData: FrameData,
    state: WorldFrameState,
    gpuDrivenBatches: boolean,
    gpuDrivenIndirectDraws: boolean,
    resolveMaterial: MaterialResolver,
    getRendererSlot: RendererSlotResolver,
    rendererRegistryRevision: number,
  ): Render3DGpuDrivenBatchBuildStats {
    this._buildStats.globalCommandBuilds = gpuDrivenBatches ? 1 : 0;
    this._buildStats.globalCommandUpdates = 0;
    if (!gpuDrivenBatches) {
      this._buildStats.batchCount = 0;
      this._buildStats.materialCount = 0;
      return this._buildStats;
    }
    this._beginSceneJournal(world, frameData);
    const rendererRegistryChanged = this._rendererRegistryRevision !== rendererRegistryRevision;
    if (rendererRegistryChanged) {
      this._rendererRegistryRevision = rendererRegistryRevision;
      this._rendererSlotsByMaterialId.clear();
      this._registrationsByMaterialId.clear();
    }
    this._sceneGeneration = nextGeneration(this._sceneGeneration);
    this._prepareGlobalRenderableOrder(
      state.renderables,
      resolveMaterial,
      getRendererSlot,
      rendererRegistryChanged || this._globalObjectSlots.size === 0,
    );
    this._collectActiveMaterials(state.renderables, resolveMaterial, getRendererSlot);
    this._collectActiveGeometries(state.renderables);
    this._buildGlobalTables(this._globalRenderableOrder);
    this._buildOpaqueSortKeys(state.renderables);
    this._sweepGeometrySlots();
    const globalBatchBuffer = this._globalBatchBuffer ??= new GpuDrivenBatchBuffer(this._engine, 'Render3DSystem.batches');
    globalBatchBuffer.upload(this._globalCommands, {
      instances: this._instanceEntries,
      materials: this._materialEntries,
    }, {
      gpuUpload: this.canUseIndirectDraws(gpuDrivenIndirectDraws),
    });
    this._sweepObjectSlots();
    this._buildStats.materialCount = this._materialTable.size;
    return this._buildStats;
  }

  prepare(
    context: RenderCommandContext,
    opaqueItems: readonly Render3DRenderItem[],
    transparentItems: readonly Render3DRenderItem[],
    frustum: Frustum,
    gpuDrivenBatches: boolean,
    gpuDrivenDrawCommands: boolean,
    gpuDrivenIndirectDraws: boolean,
    gpuDrivenCulling: boolean,
    gpuDrivenCullingReadback: boolean,
    viewIndex = 0,
  ): Render3DGpuDrivenBatchBuildStats {
    if (this._viewRing.frameIndex < 0) this.beginFrame(1, context);
    this._currentViewSlot = this._viewRing.slot(Math.max(0, viewIndex | 0));
    const count = opaqueItems.length + transparentItems.length;
    this._instanceTable.clear();
    if (!gpuDrivenBatches || count < 1) {
      this._clearFrameData();
      this._currentBatchBuffer = null;
      this._buildStats.batchCount = 0;
      this._buildStats.materialCount = 0;
      return this._buildStats;
    }

    const commands = this._commands;
    const megaBatchRuns = this._megaBatchRuns;
    commands.length = count;
    megaBatchRuns.length = 0;
    this._batchMaterialSlots.length = count;
    this._batchRendererSlots.length = count;

    let index = 0;
    for (const item of opaqueItems) {
      const objectSlot = this._resolveObjectSlot(item.entityId);
      const command = this._getCommand(commands, this._commandPool, index);
      writeGpuDrivenBatchCommand(command, item, index, objectSlot, false);
      this._registerTableEntry(
        item,
        index,
        objectSlot,
      );
      index++;
    }
    for (const item of transparentItems) {
      const objectSlot = this._resolveObjectSlot(item.entityId);
      const command = this._getCommand(commands, this._commandPool, index);
      writeGpuDrivenBatchCommand(command, item, index, objectSlot, true);
      this._registerTableEntry(
        item,
        index,
        objectSlot,
      );
      index++;
    }
    this._buildMegaBatchRuns(megaBatchRuns, count);

    const globalBatchBuffer = this._globalBatchBuffer ??= new GpuDrivenBatchBuffer(this._engine, 'Render3DSystem.batches');
    const generation = this._viewRing.resource;
    let batchBuffer = generation.batchBuffers[this._currentViewSlot];
    if (!batchBuffer) {
      batchBuffer = new GpuDrivenBatchBuffer(
        this._engine,
        generationLabel('Render3DSystem.batches', generation.info, this._currentViewSlot),
        globalBatchBuffer,
      );
      generation.batchBuffers[this._currentViewSlot] = batchBuffer;
    }
    const canUseIndirectDraws = this.canUseIndirectDraws(gpuDrivenIndirectDraws);
    batchBuffer.upload(commands, { megaBatchRuns }, { gpuUpload: canUseIndirectDraws });
    this._currentBatchBuffer = batchBuffer;

    let indirectProducer: ComputeResourcePassToken | null = null;
    if (gpuDrivenDrawCommands && canUseIndirectDraws) {
      if (context.passEncoder && isRenderFrameContext(context)) context.endPass();
      if (!context.passEncoder) {
        const commandPass = generation.drawCommandPasses[this._currentViewSlot] ??= new GpuDrawCommandComputePass(
          this._engine,
          generationLabel('Render3DSystem.drawCommands', generation.info, this._currentViewSlot),
        );
        indirectProducer = commandPass.generate(context, {
          commandBuffer: batchBuffer.commandBuffer,
          indexedIndirectBuffer: batchBuffer.indexedIndirectBuffer,
          drawIndirectBuffer: batchBuffer.drawIndirectBuffer,
          count: batchBuffer.count,
        });
      }
    }
    if (gpuDrivenCulling && canUseIndirectDraws) {
      if (context.passEncoder && isRenderFrameContext(context)) context.endPass();
      if (!context.passEncoder) {
        const cullPass = generation.cullCommandPasses[this._currentViewSlot] ??= new Mesh3DGpuCullComputePass(
          this._engine,
          generationLabel('Render3DSystem.gpuCull', generation.info, this._currentViewSlot),
        );
        frustum.copyPlanesTo(this._cullFrustumPlanes);
        indirectProducer = cullPass.cull(context, {
          commandBuffer: batchBuffer.commandBuffer,
          boundsBuffer: batchBuffer.boundsBuffer,
          indexedIndirectBuffer: batchBuffer.indexedIndirectBuffer,
          drawIndirectBuffer: batchBuffer.drawIndirectBuffer,
          count: batchBuffer.count,
        }, this._cullFrustumPlanes, {
          after: indirectProducer ? [indirectProducer] : undefined,
          path: 'Render3DSystem.gpuCull.resources',
        });
        if (gpuDrivenCullingReadback) {
          batchBuffer.requestIndexedInstanceCountReadback(context);
        }
      }
    }
    if (indirectProducer) {
      recordComputeResourcePass(context, {
        label: 'Render3DSystem.indirectDrawConsumption',
        path: 'Render3DSystem.indirectDrawConsumption',
        after: [indirectProducer],
        accesses: [
          { resource: batchBuffer.indexedIndirectBuffer, use: 'indirect', path: 'Render3DSystem.indirectDrawConsumption.indexedIndirectBuffer' },
          { resource: batchBuffer.drawIndirectBuffer, use: 'indirect', path: 'Render3DSystem.indirectDrawConsumption.drawIndirectBuffer' },
        ],
      });
    }

    this._buildStats.batchCount = batchBuffer.count;
    this._buildStats.materialCount = this._materialTable.size;
    return this._buildStats;
  }

  getMaterialBatch(batchIndex: number, gpuDrivenBatches: boolean, gpuDrivenIndirectDraws: boolean): MaterialGpuDrivenBatch | undefined {
    const batchBuffer = this._currentBatchBuffer;
    if (
      !gpuDrivenBatches ||
      !this.canUseIndirectDraws(gpuDrivenIndirectDraws) ||
      !batchBuffer ||
      batchIndex < 0 ||
      batchIndex >= batchBuffer.count
    ) {
      return undefined;
    }
    const context = this._materialBatchContext;
    context.batchBuffer = batchBuffer;
    context.batchIndex = batchIndex;
    context.objectSlot = batchBuffer.getObjectSlot(batchIndex);
    context.materialSlot = this._batchMaterialSlots[batchIndex] ?? 0;
    context.rendererSlot = this._batchRendererSlots[batchIndex] ?? 0;
    batchBuffer.writeIndirectCommandView(batchIndex, context);
    context.instanceTableBuffer = batchBuffer.instanceTableBuffer;
    context.materialTableBuffer = batchBuffer.materialTableBuffer;
    context.megaBatchRunBuffer = batchBuffer.megaBatchRunBuffer;
    return context;
  }

  canUseIndirectDraws(gpuDrivenIndirectDraws: boolean): boolean {
    return gpuDrivenIndirectDraws && hasGpuFeature(this._engine.device?.features, GPU_FEATURE_INDIRECT_FIRST_INSTANCE);
  }

  clearFrameData(): void {
    this._clearFrameData();
  }

  destroy(): void {
    this._globalBatchBuffer?.destroy();
    this._viewRing.reset();
    this._globalBatchBuffer = null;
    this._currentBatchBuffer = null;
    this.clearFrameData();
    this._instanceTable.clear();
    this._globalObjectSlots.clear();
    this._geometrySlots.clear();
    this._geometrySeenGenerations.length = 0;
    this._freeGeometrySlots.length = 0;
    this._nextGeometrySlot = 0;
    this._opaqueSortKeysByObjectSlot.length = 0;
    this._materialTable.clear();
    this._materialsBySlot.length = 0;
    this._materialSeenGenerations.length = 0;
    this._materialRendererSlots.length = 0;
    this._rendererSlotsByMaterialId.clear();
    this._registrationsByMaterialId.clear();
    this._globalRenderableOrder.length = 0;
    this._commands.length = 0;
    this._commandPool.length = 0;
    this._globalCommands.length = 0;
    this._globalCommandPool.length = 0;
    this._instanceEntries.length = 0;
    this._instanceEntryPool.length = 0;
    this._materialEntries.length = 0;
    this._materialEntryPool.length = 0;
    this._megaBatchRuns.length = 0;
    this._megaBatchRunPool.length = 0;
    this._materialRendererSortScratch.length = 0;
    this._freeObjectSlots.length = 0;
    this._objectCapacity = 0;
    this._nextObjectSlot = 0;
    this._rendererRegistryRevision = -1;
    this._objectEntityIds = new Uint32Array(0);
    this._objectMeshIds = new Uint32Array(0);
    this._objectGeometryIds = new Uint32Array(0);
    this._objectGeometryVersions = new Uint32Array(0);
    this._objectMaterialIds = new Uint32Array(0);
    this._objectMaterialRevisions = new Uint32Array(0);
    this._objectTransformVersions = new Uint32Array(0);
    this._objectLodRevisions = new Uint32Array(0);
    this._objectSeenGenerations = new Uint32Array(0);
    this._world = null;
    this._meshJournal = null;
    this._meshChanges.length = 0;
    this._dirtyEntityIds.clear();
  }

  private _resolveObjectSlot(entityId: number): number {
    const existing = this._globalObjectSlots.get(entityId);
    if (existing !== undefined) return existing;
    const objectSlot = this._freeObjectSlots.pop() ?? this._nextObjectSlot++;
    this._ensureObjectCapacity(objectSlot + 1);
    this._globalObjectSlots.set(entityId, objectSlot);
    this._objectEntityIds[objectSlot] = entityId;
    return objectSlot;
  }

  private _registerTableEntry(
    item: Render3DRenderItem,
    batchIndex: number,
    objectSlot: number,
  ): void {
    this._instanceTable.set(item.entityId, batchIndex);
    const materialId = item.material?.id;
    let rendererSlot = 0;
    let materialSlot = 0;
    if (materialId !== undefined) {
      const existing = this._materialTable.get(materialId);
      if (existing !== undefined) {
        materialSlot = existing;
        rendererSlot = this._materialRendererSlots[existing] ?? 0;
      } else {
        // Scene-global preparation registers base and every LOD material.
        // A miss means the item was mutated during record(); keep the view
        // valid and let the next scene-global pass publish the new slot.
        materialSlot = 0;
        rendererSlot = 0;
      }
    }
    this._batchMaterialSlots[batchIndex] = materialSlot;
    this._batchRendererSlots[batchIndex] = rendererSlot;
  }

  private _buildMegaBatchRuns(runs: GpuDrivenMegaBatchRun[], count: number): void {
    if (count < 1) return;
    let firstBatch = 0;
    let materialSlot = this._batchMaterialSlots[0] ?? 0;
    let rendererSlot = this._batchRendererSlots[0] ?? 0;
    for (let batchIndex = 1; batchIndex < count; batchIndex++) {
      const nextMaterialSlot = this._batchMaterialSlots[batchIndex] ?? 0;
      const nextRendererSlot = this._batchRendererSlots[batchIndex] ?? 0;
      if (nextMaterialSlot === materialSlot && nextRendererSlot === rendererSlot) continue;
      this._writeMegaBatchRun(runs, runs.length, firstBatch, batchIndex - firstBatch, materialSlot, rendererSlot);
      firstBatch = batchIndex;
      materialSlot = nextMaterialSlot;
      rendererSlot = nextRendererSlot;
    }
    this._writeMegaBatchRun(runs, runs.length, firstBatch, count - firstBatch, materialSlot, rendererSlot);
  }

  private _clearFrameData(): void {
    this._commands.length = 0;
    this._megaBatchRuns.length = 0;
    this._batchMaterialSlots.length = 0;
    this._batchRendererSlots.length = 0;
  }

  private _getCommand(
    commands: GpuDrivenBatchCommand[],
    pool: GpuDrivenBatchCommand[],
    index: number,
  ): GpuDrivenBatchCommand {
    let command = pool[index];
    if (command) {
      commands[index] = command;
      return command;
    }
    command = createGpuDrivenBatchCommand();
    pool[index] = command;
    commands[index] = command;
    this._buildStats.commandObjectsCreated++;
    return command;
  }

  private _writeMegaBatchRun(
    runs: GpuDrivenMegaBatchRun[],
    index: number,
    firstBatch: number,
    batchCount: number,
    materialSlot: number,
    rendererSlot: number,
  ): void {
    let run = this._megaBatchRunPool[index];
    if (!run) {
      run = { firstBatch, batchCount, materialSlot, rendererSlot };
      this._megaBatchRunPool[index] = run;
    }
    runs[index] = run;
    run.firstBatch = firstBatch;
    run.batchCount = batchCount;
    run.materialSlot = materialSlot;
    run.rendererSlot = rendererSlot;
  }

  private _beginSceneJournal(world: World, frameData: FrameData): void {
    this._dirtyEntityIds.clear();
    if (this._world !== world || !this._meshJournal) {
      this._world = world;
      this._meshJournal = world.createComponentChangeJournal([Mesh3D]);
      for (const renderable of world.iterQueryCandidates({ all: [Mesh3D] })) {
        this._dirtyEntityIds.add(renderable.id);
      }
    } else {
      const complete = world.consumeComponentChanges(this._meshJournal, this._meshChanges);
      if (!complete) {
        for (const entity of world.iterQueryCandidates({ all: [Mesh3D] })) this._dirtyEntityIds.add(entity.id);
      } else {
        for (const change of this._meshChanges) this._dirtyEntityIds.add(change.entity.id);
      }
    }
    for (const entity of frameData.transforms.changedEntities) this._dirtyEntityIds.add(entity.id);
  }

  private _collectActiveMaterials(
    renderables: readonly WorldFrameRenderable[],
    resolveMaterial: MaterialResolver,
    getRendererSlot: RendererSlotResolver,
  ): void {
    for (const renderable of renderables) {
      this._ensureMaterialSlot(renderable.mesh.material, resolveMaterial, getRendererSlot);
      for (const level of renderable.lod?.levels ?? []) {
        this._ensureMaterialSlot(level.material ?? renderable.mesh.material, resolveMaterial, getRendererSlot);
      }
    }
    let stale = false;
    for (let slot = 0; slot < this._materialsBySlot.length; slot++) {
      if ((this._materialSeenGenerations[slot] ?? 0) !== this._sceneGeneration) {
        stale = true;
        break;
      }
    }
    if (stale) {
      for (let slot = 0; slot < this._materialsBySlot.length; slot++) {
        if ((this._materialSeenGenerations[slot] ?? 0) === this._sceneGeneration) continue;
        const staleMaterialId = this._materialsBySlot[slot]?.id;
        if (staleMaterialId === undefined) continue;
        this._rendererSlotsByMaterialId.delete(staleMaterialId);
        this._registrationsByMaterialId.delete(staleMaterialId);
      }
      this._materialTable.clear();
      this._materialsBySlot.length = 0;
      this._materialSeenGenerations.length = 0;
      this._materialRendererSlots.length = 0;
      for (const renderable of renderables) {
        this._ensureMaterialSlot(renderable.mesh.material, resolveMaterial, getRendererSlot);
        for (const level of renderable.lod?.levels ?? []) {
          this._ensureMaterialSlot(level.material ?? renderable.mesh.material, resolveMaterial, getRendererSlot);
        }
      }
    }
    this._normalizeMaterialSlots();
    this._materialEntries.length = this._materialsBySlot.length;
    for (let slot = 0; slot < this._materialsBySlot.length; slot++) {
      const material = this._materialsBySlot[slot]!;
      let entry = this._materialEntryPool[slot];
      if (!entry) {
        entry = { materialId: 0, materialSlot: 0, rendererSlot: 0, firstBatch: 0, batchCount: 0 };
        this._materialEntryPool[slot] = entry;
      }
      entry.materialId = material.id;
      entry.materialSlot = slot;
      entry.rendererSlot = this._materialRendererSlots[slot] ?? 0;
      entry.firstBatch = 0;
      entry.batchCount = 0;
      this._materialEntries[slot] = entry;
    }
  }

  private _ensureMaterialSlot(
    material: Material,
    resolveMaterial: MaterialResolver,
    getRendererSlot: RendererSlotResolver,
  ): number {
    let slot = this._materialTable.get(material.id);
    if (slot === undefined) {
      slot = this._materialsBySlot.length;
      this._materialTable.set(material.id, slot);
      this._materialsBySlot[slot] = material;
    }
    this._materialRendererSlots[slot] = this._ensureRendererSlot(material, resolveMaterial, getRendererSlot);
    this._materialSeenGenerations[slot] = this._sceneGeneration;
    return slot;
  }

  private _normalizeMaterialSlots(): void {
    let ordered = true;
    for (let index = 1; index < this._materialsBySlot.length; index++) {
      if (this._materialsBySlot[index - 1]!.id > this._materialsBySlot[index]!.id) {
        ordered = false;
        break;
      }
    }
    if (ordered) return;
    this._materialsBySlot.sort(compareMaterialIds);
    this._materialRendererSortScratch.length = this._materialsBySlot.length;
    for (let slot = 0; slot < this._materialsBySlot.length; slot++) {
      const material = this._materialsBySlot[slot]!;
      const oldSlot = this._materialTable.get(material.id) ?? slot;
      this._materialRendererSortScratch[slot] = this._materialRendererSlots[oldSlot] ?? 0;
    }
    this._materialTable.clear();
    for (let slot = 0; slot < this._materialsBySlot.length; slot++) {
      this._materialTable.set(this._materialsBySlot[slot]!.id, slot);
      this._materialRendererSlots[slot] = this._materialRendererSortScratch[slot] ?? 0;
      this._materialSeenGenerations[slot] = this._sceneGeneration;
    }
  }

  private _buildGlobalTables(renderables: readonly WorldFrameRenderable[]): void {
    const count = renderables.length;
    this._globalCommands.length = Math.max(this._globalCommands.length, this._nextObjectSlot);
    this._instanceEntries.length = Math.max(this._instanceEntries.length, this._nextObjectSlot);
    for (let index = 0; index < count; index++) {
      const renderable = renderables[index]!;
      const objectSlot = this._resolveObjectSlot(renderable.entityId);
      if (this._globalCommands.length <= objectSlot) this._globalCommands.length = objectSlot + 1;
      if (this._instanceEntries.length <= objectSlot) this._instanceEntries.length = objectSlot + 1;
      this._objectSeenGenerations[objectSlot] = this._sceneGeneration;
      const geometry = getGlobalGeometry(renderable);
      const material = getGlobalMaterial(renderable);
      const transformVersion = renderable.worldVersion;
      const geometryVersion = mixResourceVersion(
        geometry.version,
        geometry.boundsVersion,
        geometry.morphVersion,
        geometry.skinning?.version ?? 0,
      );
      const lodRevision = renderable.lod?.revision ?? 0;
      const command = this._getCommand(this._globalCommands, this._globalCommandPool, objectSlot);
      const dirty = this._dirtyEntityIds.has(renderable.entityId)
        || command.entityId !== renderable.entityId
        || this._objectMeshIds[objectSlot] !== renderable.mesh.id
        || this._objectGeometryIds[objectSlot] !== geometry.id
        || this._objectGeometryVersions[objectSlot] !== geometryVersion
        || this._objectMaterialIds[objectSlot] !== material.id
        || this._objectMaterialRevisions[objectSlot] !== material.revision
        || this._objectTransformVersions[objectSlot] !== transformVersion
        || this._objectLodRevisions[objectSlot] !== lodRevision;
      if (dirty) {
        writeGlobalGpuDrivenBatchCommand(command, renderable, geometry, material, objectSlot);
        this._buildStats.globalCommandUpdates++;
      }
      this._objectMeshIds[objectSlot] = renderable.mesh.id;
      this._objectGeometryIds[objectSlot] = geometry.id;
      this._objectGeometryVersions[objectSlot] = geometryVersion;
      this._objectMaterialIds[objectSlot] = material.id;
      this._objectMaterialRevisions[objectSlot] = material.revision;
      this._objectTransformVersions[objectSlot] = transformVersion;
      this._objectLodRevisions[objectSlot] = lodRevision;

      const materialSlot = this._materialTable.get(material.id) ?? 0;
      let instance = this._instanceEntryPool[objectSlot];
      if (!instance) {
        instance = { entityId: 0, batchIndex: 0, geometryId: 0, materialSlot: 0 };
        this._instanceEntryPool[objectSlot] = instance;
      }
      instance.entityId = renderable.entityId;
      instance.batchIndex = objectSlot;
      instance.geometryId = geometry.id;
      instance.materialSlot = materialSlot;
      this._instanceEntries[objectSlot] = instance;
      const materialEntry = this._materialEntries[materialSlot];
      if (materialEntry) {
        if (materialEntry.batchCount === 0) materialEntry.firstBatch = objectSlot;
        materialEntry.batchCount++;
      }
    }
  }

  private _sweepObjectSlots(): void {
    for (const [entityId, slot] of this._globalObjectSlots) {
      if (this._objectSeenGenerations[slot] === this._sceneGeneration) continue;
      this._globalObjectSlots.delete(entityId);
      this._objectEntityIds[slot] = 0;
      this._objectSeenGenerations[slot] = 0;
      const command = this._globalCommandPool[slot];
      if (command) clearGpuDrivenBatchCommand(command);
      const instance = this._instanceEntryPool[slot];
      if (instance) clearGpuDrivenInstanceTableEntry(instance);
      const sortKeys = this._opaqueSortKeysByObjectSlot[slot];
      if (sortKeys) sortKeys.length = 0;
      this._freeObjectSlots.push(slot);
    }
  }

  private _ensureObjectCapacity(required: number): void {
    if (required <= this._objectCapacity) return;
    let capacity = Math.max(64, this._objectCapacity);
    while (capacity < required) capacity *= 2;
    this._objectEntityIds = growUint32(this._objectEntityIds, capacity);
    this._objectMeshIds = growUint32(this._objectMeshIds, capacity);
    this._objectGeometryIds = growUint32(this._objectGeometryIds, capacity);
    this._objectGeometryVersions = growUint32(this._objectGeometryVersions, capacity);
    this._objectMaterialIds = growUint32(this._objectMaterialIds, capacity);
    this._objectMaterialRevisions = growUint32(this._objectMaterialRevisions, capacity);
    this._objectTransformVersions = growUint32(this._objectTransformVersions, capacity);
    this._objectLodRevisions = growUint32(this._objectLodRevisions, capacity);
    this._objectSeenGenerations = growUint32(this._objectSeenGenerations, capacity);
    this._objectCapacity = capacity;
  }

  private _getRendererSlotForMaterial(materialId: number): number {
    return this._rendererSlotsByMaterialId.get(materialId) ?? 0;
  }

  private _collectActiveGeometries(renderables: readonly WorldFrameRenderable[]): void {
    for (const renderable of renderables) {
      this._ensureGeometrySlot(renderable.mesh.geometry);
      for (const level of renderable.lod?.levels ?? []) this._ensureGeometrySlot(level.geometry);
    }
  }

  private _ensureGeometrySlot(geometry: Geometry3D): number {
    let slot = this._geometrySlots.get(geometry.id);
    if (slot === undefined) {
      slot = this._freeGeometrySlots.pop() ?? this._nextGeometrySlot++;
      this._geometrySlots.set(geometry.id, slot);
    }
    this._geometrySeenGenerations[slot] = this._sceneGeneration;
    return slot;
  }

  private _sweepGeometrySlots(): void {
    for (const [geometryId, slot] of this._geometrySlots) {
      if ((this._geometrySeenGenerations[slot] ?? 0) === this._sceneGeneration) continue;
      this._geometrySlots.delete(geometryId);
      this._geometrySeenGenerations[slot] = 0;
      this._freeGeometrySlots.push(slot);
    }
  }

  private _buildOpaqueSortKeys(renderables: readonly WorldFrameRenderable[]): void {
    for (const renderable of renderables) {
      const objectSlot = this._globalObjectSlots.get(renderable.entityId);
      if (objectSlot === undefined) continue;
      let keys = this._opaqueSortKeysByObjectSlot[objectSlot];
      if (!keys) {
        keys = [];
        this._opaqueSortKeysByObjectSlot[objectSlot] = keys;
      }
      this._writeOpaqueSortKey(keys, 0, renderable.mesh.geometry, renderable.mesh.material, objectSlot);
      const levels = renderable.lod?.levels ?? [];
      for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
        const level = levels[levelIndex]!;
        this._writeOpaqueSortKey(
          keys,
          levelIndex + 1,
          level.geometry,
          level.material ?? renderable.mesh.material,
          objectSlot,
        );
      }
      keys.length = levels.length + 1;
    }
  }

  private _writeOpaqueSortKey(
    keys: MutableOpaqueSceneSortKey[],
    index: number,
    geometry: Geometry3D,
    material: Material,
    entitySlot: number,
  ): void {
    let key = keys[index];
    if (!key) {
      key = { rendererSlot: 0, materialSlot: 0, geometrySlot: 0, entitySlot };
      keys[index] = key;
    }
    const materialSlot = this._materialTable.get(material.id) ?? 0;
    key.rendererSlot = this._materialRendererSlots[materialSlot] ?? 0;
    key.materialSlot = materialSlot;
    key.geometrySlot = this._geometrySlots.get(geometry.id) ?? 0;
    key.entitySlot = entitySlot;
  }

  private _prepareGlobalRenderableOrder(
    renderables: readonly WorldFrameRenderable[],
    resolveMaterial: MaterialResolver,
    getRendererSlot: RendererSlotResolver,
    sort: boolean,
  ): void {
    this._globalRenderableOrder.length = renderables.length;
    for (let index = 0; index < renderables.length; index++) {
      this._globalRenderableOrder[index] = renderables[index]!;
    }
    this._activeMaterialResolver = resolveMaterial;
    this._activeRendererSlotResolver = getRendererSlot;
    if (sort && this._globalRenderableOrder.length > 1) {
      this._globalRenderableOrder.sort(this._compareGlobalRenderables);
    } else if (this._globalRenderableOrder.length === 1) {
      this._resolveGlobalMaterialRegistration(getGlobalMaterial(this._globalRenderableOrder[0]!));
    }
    this._activeMaterialResolver = null;
    this._activeRendererSlotResolver = null;
  }

  private _resolveGlobalMaterialRegistration(material: Material): MaterialRendererRegistration | null {
    const cached = this._registrationsByMaterialId.get(material.id);
    if (cached !== undefined || this._registrationsByMaterialId.has(material.id)) return cached ?? null;
    const resolveMaterial = this._activeMaterialResolver;
    const getRendererSlot = this._activeRendererSlotResolver;
    if (!resolveMaterial || !getRendererSlot) return null;
    const registration = resolveMaterial(material);
    this._registrationsByMaterialId.set(material.id, registration);
    this._rendererSlotsByMaterialId.set(material.id, registration ? getRendererSlot(registration) : 0);
    this._buildStats.materialRendererResolutions++;
    return registration;
  }

  private _ensureRendererSlot(
    material: Material,
    resolveMaterial: MaterialResolver,
    getRendererSlot: RendererSlotResolver,
  ): number {
    const cached = this._rendererSlotsByMaterialId.get(material.id);
    if (cached !== undefined) return cached;
    const registration = resolveMaterial(material);
    const rendererSlot = registration ? getRendererSlot(registration) : 0;
    this._registrationsByMaterialId.set(material.id, registration);
    this._rendererSlotsByMaterialId.set(material.id, rendererSlot);
    this._buildStats.materialRendererResolutions++;
    return rendererSlot;
  }
}

function destroyViewGeneration(generation: GpuDrivenViewGeneration): void {
  for (const buffer of generation.batchBuffers) buffer?.destroy();
  for (const pass of generation.drawCommandPasses) pass?.destroy();
  for (const pass of generation.cullCommandPasses) pass?.destroy();
  generation.batchBuffers.length = 0;
  generation.drawCommandPasses.length = 0;
  generation.cullCommandPasses.length = 0;
}

function generationLabel(prefix: string, info: FrameRingGenerationInfo, slot: number): string {
  void info;
  return `${prefix}.view.${slot}`;
}

function createGpuDrivenBatchCommand(): GpuDrivenBatchCommand {
  return {
    entityId: 0,
    geometryId: 0,
    materialId: 0,
    instanceCount: 1,
    indexCount: 0,
    vertexCount: 0,
    sortKey: 0,
    flags: 0,
    firstInstance: 0,
    boundsCenterX: 0,
    boundsCenterY: 0,
    boundsCenterZ: 0,
    boundsRadius: Number.POSITIVE_INFINITY,
  };
}

function writeGpuDrivenBatchCommand(
  command: GpuDrivenBatchCommand,
  item: Render3DRenderItem,
  batchIndex: number,
  objectSlot: number,
  transparent: boolean,
): void {
  const geometry = item.geometry;
  const material = item.material;
  command.entityId = item.entityId;
  command.geometryId = geometry?.id ?? 0;
  command.materialId = material?.id ?? 0;
  command.instanceCount = 1;
  command.indexCount = geometry?.indexCount ?? 0;
  command.vertexCount = geometry?.vertexCount ?? 0;
  command.sortKey = makeRender3DBatchSortKey(item, batchIndex, transparent);
  command.flags = transparent ? 1 : 0;
  command.firstInstance = objectSlot;
  command.boundsCenterX = item.worldSphere?.center[0];
  command.boundsCenterY = item.worldSphere?.center[1];
  command.boundsCenterZ = item.worldSphere?.center[2];
  command.boundsRadius = item.worldSphere?.radius;
}

function writeGlobalGpuDrivenBatchCommand(
  command: GpuDrivenBatchCommand,
  renderable: WorldFrameRenderable,
  geometry: WorldFrameRenderable['mesh']['geometry'],
  material: Material,
  objectSlot: number,
): void {
  command.entityId = renderable.entityId;
  command.geometryId = geometry.id;
  command.materialId = material.id;
  command.instanceCount = 1;
  command.indexCount = geometry.indexCount;
  command.vertexCount = geometry.vertexCount;
  command.sortKey = 0;
  command.flags = 0;
  command.firstInstance = objectSlot;
  command.boundsCenterX = renderable.worldSphere?.center[0];
  command.boundsCenterY = renderable.worldSphere?.center[1];
  command.boundsCenterZ = renderable.worldSphere?.center[2];
  command.boundsRadius = renderable.worldSphere?.radius;
}

function clearGpuDrivenBatchCommand(command: GpuDrivenBatchCommand): void {
  command.entityId = 0;
  command.geometryId = 0;
  command.materialId = 0;
  command.instanceCount = 0;
  command.indexCount = 0;
  command.vertexCount = 0;
  command.sortKey = 0;
  command.flags = 0;
  command.firstInstance = 0;
  command.boundsCenterX = 0;
  command.boundsCenterY = 0;
  command.boundsCenterZ = 0;
  command.boundsRadius = 0;
}

function clearGpuDrivenInstanceTableEntry(entry: GpuDrivenInstanceTableEntry): void {
  entry.entityId = 0;
  entry.batchIndex = 0;
  entry.geometryId = 0;
  entry.materialSlot = 0;
}

function getGlobalGeometry(renderable: WorldFrameRenderable): WorldFrameRenderable['mesh']['geometry'] {
  return renderable.lod?.levels[0]?.geometry ?? renderable.mesh.geometry;
}

function getGlobalMaterial(renderable: WorldFrameRenderable): Material {
  return renderable.lod?.levels[0]?.material ?? renderable.mesh.material;
}

function makeRender3DBatchSortKey(item: Render3DRenderItem, batchIndex: number, transparent: boolean): number {
  if (transparent) {
    const order = Math.max(0, Math.min(255, item.transparentOrder | 0));
    const sortFlag = item.transparentDepthSort ? 0 : 1;
    const depth = item.transparentDepthSort ? quantizeTransparentDepthBackToFront(item.viewDepth) : 0x7fff;
    return ((1 << 31) | (order << 23) | (sortFlag << 22) | (depth << 7) | (batchIndex & 0x7f)) >>> 0;
  }
  const depth = quantizeOpaqueDepthFrontToBack(item.viewDepth);
  const materialId = item.material?.id ?? 0;
  return ((depth << 16) | ((materialId & 0xff) << 8) | (batchIndex & 0xff)) >>> 0;
}

function isRenderFrameContext(context: RenderCommandContext): context is RenderFrameContext {
  return typeof (context as Partial<RenderFrameContext>).endPass === 'function'
    && typeof (context as Partial<RenderFrameContext>).beginPass === 'function';
}

function growUint32(source: Uint32Array, capacity: number): Uint32Array<ArrayBuffer> {
  const result = new Uint32Array(capacity);
  result.set(source);
  return result;
}

function mixResourceVersion(a: number, b: number, c: number, d: number): number {
  let hash = 0x811c9dc5;
  hash = Math.imul(hash ^ (a >>> 0), 0x01000193);
  hash = Math.imul(hash ^ (b >>> 0), 0x01000193);
  hash = Math.imul(hash ^ (c >>> 0), 0x01000193);
  hash = Math.imul(hash ^ (d >>> 0), 0x01000193);
  return hash >>> 0;
}

function nextGeneration(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function compareMaterialIds(a: Material, b: Material): number {
  return a.id - b.id;
}
