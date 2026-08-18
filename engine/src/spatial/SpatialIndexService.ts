import { BvhLod3D } from '../components/BvhLod3D';
import { Mesh3D } from '../components/Mesh3D';
import { Transform2D } from '../components/Transform2D';
import { Transform3D } from '../components/Transform3D';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { Entity } from '../ecs/Entity';
import type { SystemQueryDescriptor } from '../ecs/Query';
import type { World, WorldComponentChange, WorldComponentChangeJournal } from '../ecs/World';
import {
  registerWorldResourceCleanup,
  unregisterWorldResourceCleanup,
} from '../ecs/WorldResourceCleanup';
import type { Geometry3D } from '../geometry/Geometry3D';
import { SpatialIndex, type SpatialIndexKey } from './SpatialIndex';

const MESH_QUERY: SystemQueryDescriptor = Object.freeze({ all: Object.freeze([Mesh3D]) });
const services = new WeakMap<World, WorldSpatialIndexService>();
const SPATIAL_INDEX_RESOURCE = Object.freeze({ name: 'SpatialIndexService' });

export interface MeshSpatialEntry {
  readonly entity: Entity;
  readonly mesh: Mesh3D;
  /** Borrowed frame snapshot. Consumers must not mutate it. */
  readonly worldMatrix: Float32Array;
  readonly worldVersion: number;
  readonly geometryVersion: number;
  readonly geometryBoundsVersion: number;
}

interface MutableMeshSpatialEntry {
  entity: Entity;
  mesh: Mesh3D;
  lod: BvhLod3D | null;
  geometry: Geometry3D;
  readonly worldMatrix: Float32Array;
  worldVersion: number;
  geometryVersion: number;
  geometryBoundsVersion: number;
  lodRevision: number;
  lodDisabled: boolean;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  minOffsetX: number;
  minOffsetY: number;
  minOffsetZ: number;
  maxOffsetX: number;
  maxOffsetY: number;
  maxOffsetZ: number;
  seenGeneration: number;
  indexed: boolean;
}

export interface SpatialIndexService {
  readonly world: World;
  readonly meshIndex: SpatialIndex<MeshSpatialEntry>;
  readonly meshSyncCount: number;
  readonly meshLeafSize: number;
  readonly meshFullScanCount: number;
  readonly meshRefitCount: number;
  readonly meshUpdatedEntryCount: number;
  readonly lastMeshUpdatedEntryCount: number;
  readonly unboundedMeshEntities: ReadonlySet<Entity>;
  readonly destroyed: boolean;
  acquireIndex<T>(owner: SpatialIndexKey, leafSize?: number): SpatialIndex<T>;
  releaseIndex(owner: SpatialIndexKey): boolean;
  syncMeshIndex(leafSize?: number): SpatialIndex<MeshSpatialEntry>;
}

/** World-owned registry for broad-phase spatial data sets. */
class WorldSpatialIndexService implements SpatialIndexService {
  readonly meshIndex = new SpatialIndex<MeshSpatialEntry>();
  private readonly _world: World;
  private readonly _indexes = new Map<SpatialIndexKey, SpatialIndex<unknown>>();
  private readonly _meshEntries = new Map<number, MutableMeshSpatialEntry>();
  private readonly _meshEntryPool: MutableMeshSpatialEntry[] = [];
  private readonly _meshEntriesByGeometry = new Map<Geometry3D, Set<MutableMeshSpatialEntry>>();
  private readonly _dirtyGeometries = new Set<Geometry3D>();
  private readonly _unboundedMeshEntities = new Set<Entity>();
  private readonly _componentChanges: WorldComponentChange[] = [];
  private readonly _componentJournal: WorldComponentChangeJournal;
  private readonly _onGeometryBoundsChanged = (geometry: Geometry3D): void => {
    if (this._meshEntriesByGeometry.has(geometry)) this._dirtyGeometries.add(geometry);
  };
  private _meshGeneration = 0;
  private _meshSyncCount = 0;
  private _meshLeafSize: number | null = null;
  private _transformDirtyRevision = -1;
  private _transformJournalPhase = -1;
  private _transformJournalCursor = 0;
  private _meshFullScanCount = 0;
  private _meshRefitCount = 0;
  private _meshUpdatedEntryCount = 0;
  private _lastMeshUpdatedEntryCount = 0;
  private _destroyed = false;

  constructor(world: World) {
    this._world = world;
    this._componentJournal = world.createComponentChangeJournal([Mesh3D, BvhLod3D, Transform3D, Transform2D]);
  }

  get world(): World { return this._world; }
  get meshSyncCount(): number { return this._meshSyncCount; }
  get meshLeafSize(): number { return this._meshLeafSize ?? this.meshIndex.leafSize; }
  get meshFullScanCount(): number { return this._meshFullScanCount; }
  get meshRefitCount(): number { return this._meshRefitCount; }
  get meshUpdatedEntryCount(): number { return this._meshUpdatedEntryCount; }
  get lastMeshUpdatedEntryCount(): number { return this._lastMeshUpdatedEntryCount; }
  get unboundedMeshEntities(): ReadonlySet<Entity> { return this._unboundedMeshEntities; }
  get destroyed(): boolean { return this._destroyed; }

  acquireIndex<T>(owner: SpatialIndexKey, leafSize = 8): SpatialIndex<T> {
    this._assertAlive();
    let index = this._indexes.get(owner);
    if (!index) {
      index = new SpatialIndex<unknown>(leafSize);
      this._indexes.set(owner, index);
    }
    return index as SpatialIndex<T>;
  }

  releaseIndex(owner: SpatialIndexKey): boolean {
    const index = this._indexes.get(owner);
    if (!index) return false;
    index.dispose();
    return this._indexes.delete(owner);
  }

  /** Synchronize changed Mesh3D state and return the shared world-space AABB index. */
  syncMeshIndex(leafSize = 8): SpatialIndex<MeshSpatialEntry> {
    this._assertAlive();
    const world = this._world;
    const frameData = world.frameData;
    if (frameData.world !== world) frameData.begin(world, null, frameData.time, frameData.delta);

    // Multiple consumers share this tree. Keep the smallest requested leaf so
    // one caller cannot make another caller rebuild it back and forth.
    const requestedLeafSize = Math.max(1, Math.floor(Number.isFinite(leafSize) ? leafSize : 8));
    this._meshLeafSize = this._meshLeafSize === null
      ? requestedLeafSize
      : Math.min(this._meshLeafSize, requestedLeafSize);
    const index = this.meshIndex;
    const hasComponentChanges = world.hasComponentChanges(this._componentJournal);
    const transformDirtyRevision = frameData.transforms.dirtyRevision;
    this._lastMeshUpdatedEntryCount = 0;
    if (
      !hasComponentChanges
      && this._transformDirtyRevision === transformDirtyRevision
      && this._dirtyGeometries.size === 0
      && index.leafSize === this._meshLeafSize
    ) {
      return index;
    }
    let fullSync = this._meshSyncCount === 0 || index.leafSize !== this._meshLeafSize;
    if (!fullSync) {
      fullSync = !world.consumeComponentChanges(this._componentJournal, this._componentChanges);
    }
    if (fullSync) {
      this._fullSyncMeshIndex(index, frameData);
      world.resetComponentChangeJournal(this._componentJournal);
    }
    else this._incrementalSyncMeshIndex(index, frameData, this._componentChanges);
    this._transformDirtyRevision = frameData.transforms.dirtyRevision;
    this._transformJournalPhase = frameData.phaseRevision;
    this._transformJournalCursor = frameData.transforms.changedEntities.length;
    this._componentChanges.length = 0;
    this._dirtyGeometries.clear();
    this._meshSyncCount++;
    return index;
  }

  private _fullSyncMeshIndex(index: SpatialIndex<MeshSpatialEntry>, frameData: World['frameData']): void {
    this._meshGeneration = nextGeneration(this._meshGeneration, this._meshEntries);
    this._clearGeometryLinks();
    this._unboundedMeshEntities.clear();
    index.beginUpdate(this._meshLeafSize ?? index.leafSize);
    try {
      for (const entity of this._world.iterQueryCandidates(MESH_QUERY)) {
        if (entity.world !== this._world || entity.destroyed) continue;
        const mesh = entity.getComponent(Mesh3D);
        if (!mesh) continue;
        const entry = this._getOrCreateMeshEntry(entity, mesh);
        entry.seenGeneration = this._meshGeneration;
        entry.worldVersion = -1;
        this._refreshMeshEntry(entry, entity, mesh, frameData, index, false);
      }
      index.endUpdate();
    } catch (error) {
      index.cancelUpdate();
      throw error;
    }
    for (const [entityId, entry] of this._meshEntries) {
      if (entry.seenGeneration === this._meshGeneration) continue;
      this._meshEntries.delete(entityId);
      releaseMeshSpatialEntry(entry);
      this._meshEntryPool.push(entry);
    }
    this._meshFullScanCount++;
  }

  private _incrementalSyncMeshIndex(
    index: SpatialIndex<MeshSpatialEntry>,
    frameData: World['frameData'],
    componentChanges: readonly WorldComponentChange[],
  ): void {
    const refitBefore = index.refitCount;
    index.beginIncrementalUpdate(this._meshLeafSize ?? index.leafSize);
    try {
      for (const change of componentChanges) {
        if (change.component instanceof Mesh3D) {
          if (change.kind === 'remove') this._removeMeshEntry(change.entity.id, index);
          else this._syncMeshEntity(change.entity, frameData, index);
        } else if (change.component instanceof BvhLod3D) {
          this._syncMeshEntity(change.entity, frameData, index);
        } else if (change.component instanceof Transform3D || change.component instanceof Transform2D) {
          frameData.transforms.markDirty(change.entity);
        }
      }
      const changedTransforms = frameData.transforms.flushDirtyWorldVersions();
      const changedStart = this._transformJournalPhase === frameData.phaseRevision
        ? Math.min(this._transformJournalCursor, changedTransforms.length)
        : 0;
      for (let i = changedStart; i < changedTransforms.length; i++) {
        const entity = changedTransforms[i];
        if (!entity) continue;
        const entry = this._meshEntries.get(entity.id);
        if (entry) this._refreshMeshEntry(entry, entity, entry.mesh, frameData, index, true);
      }
      for (const geometry of this._dirtyGeometries) {
        const entries = this._meshEntriesByGeometry.get(geometry);
        if (!entries) continue;
        for (const entry of entries) this._refreshMeshEntry(entry, entry.entity, entry.mesh, frameData, index, true);
      }
      index.endIncrementalUpdate();
    } catch (error) {
      index.cancelIncrementalUpdate();
      throw error;
    }
    if (index.refitCount > refitBefore) this._meshRefitCount += index.refitCount - refitBefore;
  }

  private _syncMeshEntity(entity: Entity, frameData: World['frameData'], index: SpatialIndex<MeshSpatialEntry>): void {
    if (entity.world !== this._world || entity.destroyed) {
      this._removeMeshEntry(entity.id, index);
      return;
    }
    const mesh = entity.getComponent(Mesh3D);
    if (!mesh) {
      this._removeMeshEntry(entity.id, index);
      return;
    }
    const entry = this._getOrCreateMeshEntry(entity, mesh);
    this._refreshMeshEntry(entry, entity, mesh, frameData, index, true);
  }

  private _getOrCreateMeshEntry(entity: Entity, mesh: Mesh3D): MutableMeshSpatialEntry {
    let entry = this._meshEntries.get(entity.id);
    if (!entry) {
      entry = this._meshEntryPool.pop() ?? createMeshSpatialEntry();
      entry.entity = entity;
      entry.mesh = mesh;
      this._meshEntries.set(entity.id, entry);
    }
    return entry;
  }

  private _refreshMeshEntry(
    entry: MutableMeshSpatialEntry,
    entity: Entity,
    mesh: Mesh3D,
    frameData: World['frameData'],
    index: SpatialIndex<MeshSpatialEntry>,
    incremental: boolean,
  ): void {
    const lod = entity.getComponent(BvhLod3D);
    const activeLod = lod && !lod.disabled ? lod : null;
    const geometry = activeLod?.levels[0]?.geometry ?? mesh.geometry;
    const transform = frameData.transforms.getEntry(entity);
    const geometryChanged = entry.geometry !== geometry;
    const resourceBoundsChanged = entry.entity !== entity
      || entry.mesh !== mesh
      || entry.lod !== lod
      || entry.lodRevision !== (lod?.revision ?? -1)
      || entry.lodDisabled !== (lod?.disabled ?? false)
      || geometryChanged
      || entry.geometryVersion !== geometry.version
      || entry.geometryBoundsVersion !== geometry.boundsVersion;
    const transformChanged = entry.worldVersion !== transform.worldVersion;
    const boundsChanged = resourceBoundsChanged || transformChanged;
    const translationOnlyBoundsChange = transformChanged
      && !resourceBoundsChanged
      && entry.indexed
      && sameAffineLinearTransform(entry.worldMatrix, transform.worldMatrix);
    if (geometryChanged) {
      this._unlinkGeometry(entry);
      entry.geometry = geometry;
    }
    if (geometryChanged || !this._meshEntriesByGeometry.has(geometry)) {
      this._linkGeometry(entry);
    }
    entry.entity = entity;
    entry.mesh = mesh;
    entry.lod = lod;
    entry.lodRevision = lod?.revision ?? -1;
    entry.lodDisabled = lod?.disabled ?? false;
    entry.worldVersion = transform.worldVersion;
    entry.geometryVersion = geometry.version;
    entry.geometryBoundsVersion = geometry.boundsVersion;
    if (!boundsChanged) return;
    let bounded: boolean;
    if (translationOnlyBoundsChange) {
      const translationX = transform.worldMatrix[12] ?? 0;
      const translationY = transform.worldMatrix[13] ?? 0;
      const translationZ = transform.worldMatrix[14] ?? 0;
      entry.worldMatrix[12] = translationX;
      entry.worldMatrix[13] = translationY;
      entry.worldMatrix[14] = translationZ;
      entry.minX = translationX + entry.minOffsetX;
      entry.maxX = translationX + entry.maxOffsetX;
      entry.minY = translationY + entry.minOffsetY;
      entry.maxY = translationY + entry.maxOffsetY;
      entry.minZ = translationZ + entry.minOffsetZ;
      entry.maxZ = translationZ + entry.maxOffsetZ;
      bounded = true;
    } else {
      entry.worldMatrix.set(transform.worldMatrix);
      bounded = activeLod?.bounds
        ? writeSphereBounds(entry, activeLod.bounds, entry.worldMatrix)
        : writeGeometryBounds(entry, geometry, entry.worldMatrix);
      if (bounded) {
        entry.minOffsetX = entry.minX - (entry.worldMatrix[12] ?? 0);
        entry.minOffsetY = entry.minY - (entry.worldMatrix[13] ?? 0);
        entry.minOffsetZ = entry.minZ - (entry.worldMatrix[14] ?? 0);
        entry.maxOffsetX = entry.maxX - (entry.worldMatrix[12] ?? 0);
        entry.maxOffsetY = entry.maxY - (entry.worldMatrix[13] ?? 0);
        entry.maxOffsetZ = entry.maxZ - (entry.worldMatrix[14] ?? 0);
      }
    }
    if (bounded) {
      this._unboundedMeshEntities.delete(entity);
      if (incremental) {
        index.upsertIncremental(entity.id, entry, entry.minX, entry.minY, entry.minZ, entry.maxX, entry.maxY, entry.maxZ);
      } else {
        index.upsert(entity.id, entry, entry.minX, entry.minY, entry.minZ, entry.maxX, entry.maxY, entry.maxZ);
      }
      entry.indexed = true;
    } else {
      this._unboundedMeshEntities.add(entity);
      if (incremental && entry.indexed) index.removeIncremental(entity.id);
      entry.indexed = false;
    }
    this._meshUpdatedEntryCount++;
    this._lastMeshUpdatedEntryCount++;
  }

  private _removeMeshEntry(entityId: number, index: SpatialIndex<MeshSpatialEntry>): void {
    const entry = this._meshEntries.get(entityId);
    if (!entry) return;
    this._meshEntries.delete(entityId);
    this._unlinkGeometry(entry);
    this._unboundedMeshEntities.delete(entry.entity);
    if (entry.indexed) index.removeIncremental(entityId);
    releaseMeshSpatialEntry(entry);
    this._meshEntryPool.push(entry);
  }

  private _linkGeometry(entry: MutableMeshSpatialEntry): void {
    let entries = this._meshEntriesByGeometry.get(entry.geometry);
    if (!entries) {
      entries = new Set();
      this._meshEntriesByGeometry.set(entry.geometry, entries);
      entry.geometry.addBoundsChangeListener(this._onGeometryBoundsChanged);
    }
    entries.add(entry);
  }

  private _unlinkGeometry(entry: MutableMeshSpatialEntry): void {
    const entries = this._meshEntriesByGeometry.get(entry.geometry);
    if (!entries) return;
    entries.delete(entry);
    if (entries.size > 0) return;
    entry.geometry.removeBoundsChangeListener(this._onGeometryBoundsChanged);
    this._meshEntriesByGeometry.delete(entry.geometry);
    this._dirtyGeometries.delete(entry.geometry);
  }

  private _clearGeometryLinks(): void {
    for (const geometry of this._meshEntriesByGeometry.keys()) {
      geometry.removeBoundsChangeListener(this._onGeometryBoundsChanged);
    }
    this._meshEntriesByGeometry.clear();
    this._dirtyGeometries.clear();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.meshIndex.dispose();
    for (const index of this._indexes.values()) index.dispose();
    this._indexes.clear();
    this._clearGeometryLinks();
    for (const entry of this._meshEntries.values()) releaseMeshSpatialEntry(entry);
    this._meshEntries.clear();
    this._meshEntryPool.length = 0;
    this._unboundedMeshEntities.clear();
    this._componentChanges.length = 0;
  }

  private _assertAlive(): void {
    if (this._destroyed || this._world.destroyed) {
      throw spatialWorldDestroyedError(this._world, 'SpatialIndexService cannot be used after its World has been destroyed.');
    }
  }
}

export function getSpatialIndexService(world: World): SpatialIndexService {
  if (world.destroyed) throw spatialWorldDestroyedError(world, 'Cannot create a SpatialIndexService for a destroyed World.');
  let service = services.get(world);
  if (!service) {
    service = new WorldSpatialIndexService(world);
    services.set(world, service);
    registerWorldResourceCleanup(world, SPATIAL_INDEX_RESOURCE, () => {
      const ownedService = services.get(world);
      if (!ownedService) return;
      services.delete(world);
      ownedService.destroy();
    });
  }
  return service;
}

export function destroySpatialIndexService(world: World): void {
  const service = services.get(world);
  if (!service) return;
  services.delete(world);
  unregisterWorldResourceCleanup(world, SPATIAL_INDEX_RESOURCE);
  service.destroy();
}

function spatialWorldDestroyedError(world: World, message: string): EngineError {
  return new EngineError(EngineErrorCode.EcsWorldDestroyed, message, {
    context: { worldId: world.id, worldName: world.name },
  });
}

function createMeshSpatialEntry(): MutableMeshSpatialEntry {
  return {
    entity: null as unknown as Entity,
    mesh: null as unknown as Mesh3D,
    lod: null,
    geometry: null as unknown as Geometry3D,
    worldMatrix: new Float32Array(16),
    worldVersion: -1,
    geometryVersion: -1,
    geometryBoundsVersion: -1,
    lodRevision: -1,
    lodDisabled: false,
    minX: 0, minY: 0, minZ: 0,
    maxX: 0, maxY: 0, maxZ: 0,
    minOffsetX: 0, minOffsetY: 0, minOffsetZ: 0,
    maxOffsetX: 0, maxOffsetY: 0, maxOffsetZ: 0,
    seenGeneration: 0,
    indexed: false,
  };
}

function releaseMeshSpatialEntry(entry: MutableMeshSpatialEntry): void {
  entry.entity = null as unknown as Entity;
  entry.mesh = null as unknown as Mesh3D;
  entry.lod = null;
  entry.geometry = null as unknown as Geometry3D;
  entry.lodRevision = -1;
  entry.lodDisabled = false;
  entry.seenGeneration = 0;
  entry.indexed = false;
}

function nextGeneration(
  generation: number,
  entries: ReadonlyMap<number, MutableMeshSpatialEntry>,
): number {
  const next = generation >= 0xffff_ffff ? 1 : generation + 1;
  if (next === 1) for (const entry of entries.values()) entry.seenGeneration = 0;
  return next;
}

function writeGeometryBounds(
  out: MutableMeshSpatialEntry,
  geometry: Geometry3D,
  matrix: Float32Array,
): boolean {
  if (geometry.boundsMode !== 'static') {
    const bounds = geometry.localBounds;
    if (!bounds) return false;
    const x = bounds.center[0];
    const y = bounds.center[1];
    const z = bounds.center[2];
    const radius = bounds.radius;
    const centerX = (matrix[0] ?? 1) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
    const centerY = (matrix[1] ?? 0) * x + (matrix[5] ?? 1) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
    const centerZ = (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 1) * z + (matrix[14] ?? 0);
    const extentX = radius * Math.hypot(matrix[0] ?? 1, matrix[4] ?? 0, matrix[8] ?? 0);
    const extentY = radius * Math.hypot(matrix[1] ?? 0, matrix[5] ?? 1, matrix[9] ?? 0);
    const extentZ = radius * Math.hypot(matrix[2] ?? 0, matrix[6] ?? 0, matrix[10] ?? 1);
    out.minX = centerX - extentX;
    out.minY = centerY - extentY;
    out.minZ = centerZ - extentZ;
    out.maxX = centerX + extentX;
    out.maxY = centerY + extentY;
    out.maxZ = centerZ + extentZ;
    return true;
  }
  const bounds = geometry.getBoundingBox();
  writeTransformedBounds(out, bounds.min, bounds.max, matrix);
  return true;
}

function writeSphereBounds(
  out: MutableMeshSpatialEntry,
  bounds: { readonly center: readonly [number, number, number]; readonly radius: number },
  matrix: Float32Array,
): boolean {
  const x = bounds.center[0];
  const y = bounds.center[1];
  const z = bounds.center[2];
  const radius = bounds.radius;
  const centerX = (matrix[0] ?? 1) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
  const centerY = (matrix[1] ?? 0) * x + (matrix[5] ?? 1) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
  const centerZ = (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 1) * z + (matrix[14] ?? 0);
  const extentX = radius * Math.hypot(matrix[0] ?? 1, matrix[4] ?? 0, matrix[8] ?? 0);
  const extentY = radius * Math.hypot(matrix[1] ?? 0, matrix[5] ?? 1, matrix[9] ?? 0);
  const extentZ = radius * Math.hypot(matrix[2] ?? 0, matrix[6] ?? 0, matrix[10] ?? 1);
  out.minX = centerX - extentX;
  out.minY = centerY - extentY;
  out.minZ = centerZ - extentZ;
  out.maxX = centerX + extentX;
  out.maxY = centerY + extentY;
  out.maxZ = centerZ + extentZ;
  return true;
}

function writeTransformedBounds(
  out: MutableMeshSpatialEntry,
  localMin: Float32Array,
  localMax: Float32Array,
  matrix: Float32Array,
): void {
  const minX = localMin[0] ?? 0, minY = localMin[1] ?? 0, minZ = localMin[2] ?? 0;
  const maxX = localMax[0] ?? 0, maxY = localMax[1] ?? 0, maxZ = localMax[2] ?? 0;
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const extentX = (maxX - minX) * 0.5;
  const extentY = (maxY - minY) * 0.5;
  const extentZ = (maxZ - minZ) * 0.5;
  const m0 = matrix[0] ?? 1, m1 = matrix[1] ?? 0, m2 = matrix[2] ?? 0;
  const m4 = matrix[4] ?? 0, m5 = matrix[5] ?? 1, m6 = matrix[6] ?? 0;
  const m8 = matrix[8] ?? 0, m9 = matrix[9] ?? 0, m10 = matrix[10] ?? 1;
  const worldCenterX = m0 * centerX + m4 * centerY + m8 * centerZ + (matrix[12] ?? 0);
  const worldCenterY = m1 * centerX + m5 * centerY + m9 * centerZ + (matrix[13] ?? 0);
  const worldCenterZ = m2 * centerX + m6 * centerY + m10 * centerZ + (matrix[14] ?? 0);
  const worldExtentX = Math.abs(m0) * extentX + Math.abs(m4) * extentY + Math.abs(m8) * extentZ;
  const worldExtentY = Math.abs(m1) * extentX + Math.abs(m5) * extentY + Math.abs(m9) * extentZ;
  const worldExtentZ = Math.abs(m2) * extentX + Math.abs(m6) * extentY + Math.abs(m10) * extentZ;
  out.minX = worldCenterX - worldExtentX;
  out.minY = worldCenterY - worldExtentY;
  out.minZ = worldCenterZ - worldExtentZ;
  out.maxX = worldCenterX + worldExtentX;
  out.maxY = worldCenterY + worldExtentY;
  out.maxZ = worldCenterZ + worldExtentZ;
}

function sameAffineLinearTransform(a: Float32Array, b: Float32Array): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
    && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[7] === b[7]
    && a[8] === b[8] && a[9] === b[9] && a[10] === b[10] && a[11] === b[11]
    && a[15] === b[15];
}
