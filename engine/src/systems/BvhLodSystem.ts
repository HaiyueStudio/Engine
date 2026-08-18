import { BvhLod3D } from '../components/BvhLod3D';
import { Camera3D } from '../components/Camera3D';
import { Mesh3D } from '../components/Mesh3D';
import { Transform2D } from '../components/Transform2D';
import { Transform3D } from '../components/Transform3D';
import type { BoundingSphere } from '../culling/Frustum';
import { computeBoundingSphere } from '../culling/Frustum';
import type { Entity } from '../ecs/Entity';
import { System } from '../ecs/System';
import type { World, WorldComponentChange, WorldComponentChangeJournal } from '../ecs/World';
import type { Geometry3D } from '../geometry/Geometry3D';
import { getSpatialIndexService, type SpatialIndexService } from '../spatial/SpatialIndexService';
import type { SpatialIndex } from '../spatial/SpatialIndex';

export interface BvhLodSystemOptions {
  /** Maximum number of objects in one BVH leaf. Defaults to 8. */
  leafSize?: number;
  /** System priority. Defaults to -900 so selection runs before render systems. */
  priority?: number;
}

export interface BvhLodSystemStats {
  readonly objectCount: number;
  readonly candidateCount: number;
  readonly switchCount: number;
  readonly nodeCount: number;
  readonly rebuildCount: number;
  readonly refitCount: number;
  readonly fullScanCount: number;
  readonly updatedObjectCount: number;
  readonly rebuilt: boolean;
}

interface MutableBvhLodSystemStats {
  objectCount: number;
  candidateCount: number;
  switchCount: number;
  nodeCount: number;
  rebuildCount: number;
  refitCount: number;
  fullScanCount: number;
  updatedObjectCount: number;
  rebuilt: boolean;
}

interface LodState {
  entity: Entity;
  lod: BvhLod3D;
  mesh: Mesh3D;
  boundsGeometry: Geometry3D | null;
  localSphere: BoundingSphere;
  sourceGeometryVersion: number;
  lodRevision: number;
  worldVersion: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  activeLevel: number;
  lodDisabled: boolean;
  indexed: boolean;
  seenFrame: number;
}

const REFRESH_CHANGED = 1 << 0;
const REFRESH_INDEXED = 1 << 1;

/**
 * Experimental camera-distance LOD diagnostics backed by a persistent
 * world-space BVH.
 *
 * The BVH stores each object's high-detail activation volume. Objects outside
 * that volume remain on their final fallback level, so a frame only performs
 * exact distance selection for nearby candidates. It never owns or mutates
 * Mesh3D resources; the Render3D collector performs the authoritative,
 * view-local resource pick and does not depend on this optional system. This
 * observer is exported only from the experimental entry point.
 */
export class BvhLodSystem extends System {
  private _cameraEntity: Entity;
  private readonly _leafSize: number;
  private readonly _states = new Map<number, LodState>();
  private _index: SpatialIndex<LodState> | null = null;
  private _indexService: SpatialIndexService | null = null;
  private readonly _currentCandidates = new Set<LodState>();
  private readonly _previousCandidates = new Set<LodState>();
  private readonly _componentChanges: WorldComponentChange[] = [];
  private _componentJournal: WorldComponentChangeJournal | null = null;
  private readonly _dirtyEntities = new Set<Entity>();
  private readonly _statesByGeometry = new Map<Geometry3D, Set<LodState>>();
  private readonly _dirtyGeometries = new Set<Geometry3D>();
  private readonly _onGeometryBoundsChanged = (geometry: Geometry3D): void => {
    if (this._statesByGeometry.has(geometry)) this._dirtyGeometries.add(geometry);
  };
  private _syncFrame = 0;
  private _componentJournalRevision = -1;
  private _transformJournalPhase = -1;
  private _transformJournalCursor = 0;
  private readonly _stats: MutableBvhLodSystemStats = {
    objectCount: 0,
    candidateCount: 0,
    switchCount: 0,
    nodeCount: 0,
    rebuildCount: 0,
    refitCount: 0,
    fullScanCount: 0,
    updatedObjectCount: 0,
    rebuilt: false,
  };

  constructor(cameraEntity: Entity, options: BvhLodSystemOptions = {}) {
    super({ all: [BvhLod3D, Mesh3D] });
    this.name = 'BvhLodSystem';
    this._cameraEntity = cameraEntity;
    this._leafSize = Math.max(1, Math.floor(options.leafSize ?? 8));
    this.priority = options.priority ?? -900;
  }

  get stats(): BvhLodSystemStats { return this._stats; }

  setCameraEntity(cameraEntity: Entity): this {
    this._cameraEntity = cameraEntity;
    this._previousCandidates.clear();
    return this;
  }

  getActiveLevel(entity: Entity): number {
    return this._states.get(entity.id)?.activeLevel ?? -1;
  }

  override update(world: World, _time: number, _delta: number): this {
    if (this.disabled) return this;
    const camera = this._cameraEntity.getComponent(Camera3D);
    if (!camera) return this;

    this._stats.switchCount = 0;
    this._stats.updatedObjectCount = 0;
    this._syncStates(world);
    this._stats.objectCount = this._states.size;

    const cameraFrame = world.frameData.getCamera3D(this._cameraEntity, camera);
    const cameraPosition = cameraFrame.position;
    const candidates = this._currentCandidates;
    candidates.clear();
    this._index?.queryPoint(cameraPosition[0] ?? 0, cameraPosition[1] ?? 0, cameraPosition[2] ?? 0, candidates);

    for (const previous of this._previousCandidates) {
      if (!candidates.has(previous) && !previous.lod.disabled) {
        this._applyLevel(previous, previous.lod.levels.length - 1);
      }
    }
    for (const state of candidates) {
      const dx = (cameraPosition[0] ?? 0) - state.centerX;
      const dy = (cameraPosition[1] ?? 0) - state.centerY;
      const dz = (cameraPosition[2] ?? 0) - state.centerZ;
      const distance = Math.max(0, Math.hypot(dx, dy, dz) - state.radius);
      this._applyLevel(state, state.lod.selectLevel(distance, state.activeLevel));
    }

    this._stats.candidateCount = candidates.size;
    this._previousCandidates.clear();
    for (const state of candidates) this._previousCandidates.add(state);
    return this;
  }

  override destroy(): this {
    for (const state of this._states.values()) {
      this._clearSelection(state);
      this._unlinkGeometry(state);
    }
    this._states.clear();
    this._currentCandidates.clear();
    this._previousCandidates.clear();
    this._dirtyEntities.clear();
    this._dirtyGeometries.clear();
    this._componentChanges.length = 0;
    this._indexService?.releaseIndex(this);
    this._index = null;
    this._indexService = null;
    this._componentJournal = null;
    return super.destroy();
  }

  private _getIndex(world: World): SpatialIndex<LodState> {
    const service = getSpatialIndexService(world);
    if (service !== this._indexService) {
      this._indexService?.releaseIndex(this);
      this._indexService = service;
      this._index = service.acquireIndex<LodState>(this, this._leafSize);
      this._componentJournal = world.createComponentChangeJournal([BvhLod3D, Mesh3D, Transform3D, Transform2D]);
      this._componentJournalRevision = -1;
      this._transformJournalPhase = -1;
      this._transformJournalCursor = 0;
    }
    return this._index as SpatialIndex<LodState>;
  }

  private _syncStates(world: World): void {
    const index = this._getIndex(world);
    const componentJournal = this._componentJournal!;
    const rebuildBefore = index.rebuildCount;
    let fullSync = this._componentJournalRevision < 0;
    if (!fullSync) {
      fullSync = !world.consumeComponentChanges(componentJournal, this._componentChanges);
    }
    if (fullSync) {
      this._fullSyncStates(world, index);
      world.resetComponentChangeJournal(componentJournal);
    }
    else this._incrementalSyncStates(world, index, this._componentChanges);
    this._componentJournalRevision = 0;
    this._transformJournalPhase = world.frameData.phaseRevision;
    this._transformJournalCursor = world.frameData.transforms.changedEntities.length;
    this._componentChanges.length = 0;
    this._dirtyEntities.clear();
    this._dirtyGeometries.clear();
    this._stats.nodeCount = index.nodeCount;
    this._stats.rebuildCount = index.rebuildCount;
    this._stats.refitCount = index.refitCount;
    this._stats.rebuilt = index.rebuildCount > rebuildBefore;
  }

  private _fullSyncStates(world: World, index: SpatialIndex<LodState>): void {
    this._syncFrame = (this._syncFrame + 1) >>> 0;
    if (this._syncFrame === 0) this._syncFrame = 1;
    const entities = this.entitySet.get(world);
    index.beginUpdate(this._leafSize);
    try {
      if (entities) {
        for (const entity of entities) {
          const lod = entity.getComponent(BvhLod3D);
          const mesh = entity.getComponent(Mesh3D);
          if (!lod || !mesh) continue;
          let state = this._states.get(entity.id);
          if (state && (state.lod !== lod || state.mesh !== mesh)) {
            this._removeState(state);
            state = undefined;
          }
          if (!state) {
            state = createLodState(entity, lod, mesh);
            this._states.set(entity.id, state);
          }
          state.seenFrame = this._syncFrame;
          const refresh = this._refreshState(state, world);
          if ((refresh & REFRESH_INDEXED) !== 0) {
            index.upsert(
              entity.id,
              state,
              state.minX, state.minY, state.minZ,
              state.maxX, state.maxY, state.maxZ,
            );
            state.indexed = true;
          } else {
            state.indexed = false;
          }
          this._stats.updatedObjectCount++;
        }
      }
      for (const state of this._states.values()) {
        if (state.seenFrame !== this._syncFrame) this._removeState(state);
      }
      index.endUpdate();
    } catch (error) {
      index.cancelUpdate();
      throw error;
    }
    this._stats.fullScanCount++;
  }

  private _incrementalSyncStates(
    world: World,
    index: SpatialIndex<LodState>,
    changes: readonly WorldComponentChange[],
  ): void {
    for (const change of changes) {
      if (change.component instanceof BvhLod3D || change.component instanceof Mesh3D) {
        this._dirtyEntities.add(change.entity);
      } else if (change.component instanceof Transform3D || change.component instanceof Transform2D) {
        world.frameData.transforms.markDirty(change.entity);
      }
    }
    const changedTransforms = world.frameData.transforms.flushDirtyWorldVersions();
    const changedStart = this._transformJournalPhase === world.frameData.phaseRevision
      ? Math.min(this._transformJournalCursor, changedTransforms.length)
      : 0;
    for (let i = changedStart; i < changedTransforms.length; i++) {
      const entity = changedTransforms[i];
      if (entity && this._states.has(entity.id)) this._dirtyEntities.add(entity);
    }
    for (const geometry of this._dirtyGeometries) {
      const states = this._statesByGeometry.get(geometry);
      if (!states) continue;
      for (const state of states) this._dirtyEntities.add(state.entity);
    }
    if (this._dirtyEntities.size === 0) return;

    index.beginIncrementalUpdate(this._leafSize);
    try {
      for (const entity of this._dirtyEntities) this._syncStateEntity(entity, world, index);
      index.endIncrementalUpdate();
    } catch (error) {
      index.cancelIncrementalUpdate();
      throw error;
    }
  }

  private _syncStateEntity(entity: Entity, world: World, index: SpatialIndex<LodState>): void {
    const lod = entity.world === world && !entity.destroyed ? entity.getComponent(BvhLod3D) : null;
    const mesh = entity.world === world && !entity.destroyed ? entity.getComponent(Mesh3D) : null;
    let state = this._states.get(entity.id);
    if (!lod || !mesh) {
      if (!state) return;
      if (state.indexed) index.removeIncremental(entity.id);
      this._removeState(state);
      this._stats.updatedObjectCount++;
      return;
    }
    if (state && (state.lod !== lod || state.mesh !== mesh)) {
      if (state.indexed) index.removeIncremental(entity.id);
      this._removeState(state);
      state = undefined;
    }
    if (!state) {
      state = createLodState(entity, lod, mesh);
      this._states.set(entity.id, state);
    }
    const refresh = this._refreshState(state, world);
    if ((refresh & REFRESH_CHANGED) === 0) return;
    if ((refresh & REFRESH_INDEXED) !== 0) {
      index.upsertIncremental(
        entity.id,
        state,
        state.minX, state.minY, state.minZ,
        state.maxX, state.maxY, state.maxZ,
      );
      state.indexed = true;
    } else if (state.indexed) {
      index.removeIncremental(entity.id);
      state.indexed = false;
    }
    this._stats.updatedObjectCount++;
  }

  private _refreshState(state: LodState, world: World): number {
    const lod = state.lod;
    const boundsGeometry = lod.disabled || lod.bounds ? null : lod.levels[0]?.geometry ?? null;
    const geometryChanged = state.boundsGeometry !== boundsGeometry;
    if (geometryChanged) {
      this._unlinkGeometry(state);
      state.boundsGeometry = boundsGeometry;
      this._linkGeometry(state);
    }
    const geometryVersion = boundsGeometry?.version ?? -1;
    const disabledChanged = state.lodDisabled !== lod.disabled;
    const definitionChanged = state.lodRevision !== lod.revision
      || state.sourceGeometryVersion !== geometryVersion
      || geometryChanged;
    const transformEntry = world.frameData.transforms.getEntry(state.entity);
    const transformChanged = state.worldVersion !== transformEntry.worldVersion;
    if (!definitionChanged && !disabledChanged && !transformChanged) {
      return state.indexed ? REFRESH_INDEXED : 0;
    }
    state.lodDisabled = lod.disabled;
    state.lodRevision = lod.revision;
    state.sourceGeometryVersion = geometryVersion;
    if (lod.disabled) {
      this._clearSelection(state);
      return REFRESH_CHANGED;
    }
    if (definitionChanged || disabledChanged || state.activeLevel < 0) {
      state.localSphere = resolveLocalSphere(lod);
      state.activeLevel = -1;
      this._applyLevel(state, lod.levels.length - 1);
    }
    if (definitionChanged || transformChanged || disabledChanged) {
      updateWorldActivationBounds(state, transformEntry.worldMatrix);
      state.worldVersion = transformEntry.worldVersion;
    }
    return REFRESH_CHANGED | (lod.activationDistance > 0 ? REFRESH_INDEXED : 0);
  }

  private _linkGeometry(state: LodState): void {
    const geometry = state.boundsGeometry;
    if (!geometry) return;
    let states = this._statesByGeometry.get(geometry);
    if (!states) {
      states = new Set();
      this._statesByGeometry.set(geometry, states);
      geometry.addBoundsChangeListener(this._onGeometryBoundsChanged);
    }
    states.add(state);
  }

  private _unlinkGeometry(state: LodState): void {
    const geometry = state.boundsGeometry;
    if (!geometry) return;
    const states = this._statesByGeometry.get(geometry);
    if (!states) return;
    states.delete(state);
    if (states.size > 0) return;
    geometry.removeBoundsChangeListener(this._onGeometryBoundsChanged);
    this._statesByGeometry.delete(geometry);
    this._dirtyGeometries.delete(geometry);
  }

  private _removeState(state: LodState): void {
    this._clearSelection(state);
    this._unlinkGeometry(state);
    this._states.delete(state.entity.id);
    this._previousCandidates.delete(state);
    this._currentCandidates.delete(state);
  }

  private _applyLevel(state: LodState, levelIndex: number): void {
    if (state.activeLevel === levelIndex) return;
    const level = state.lod.levels[levelIndex];
    if (!level) return;
    state.activeLevel = levelIndex;
    this._stats.switchCount++;
  }

  private _clearSelection(state: LodState): void {
    state.activeLevel = -1;
  }
}

function createLodState(entity: Entity, lod: BvhLod3D, mesh: Mesh3D): LodState {
  const localSphere = resolveLocalSphere(lod);
  return {
    entity,
    lod,
    mesh,
    boundsGeometry: null,
    localSphere,
    sourceGeometryVersion: -1,
    lodRevision: -1,
    worldVersion: -1,
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    radius: 0,
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
    activeLevel: -1,
    lodDisabled: lod.disabled,
    indexed: false,
    seenFrame: 0,
  };
}

function resolveLocalSphere(lod: BvhLod3D): BoundingSphere {
  if (lod.bounds) return lod.bounds;
  const geometry = lod.levels[0]?.geometry;
  if (!geometry || geometry.positions.length < 3) return { center: [0, 0, 0], radius: 0 };
  return geometry.localBounds ?? computeBoundingSphere(geometry.positions);
}

function updateWorldActivationBounds(state: LodState, matrix: Float32Array): void {
  const [x, y, z] = state.localSphere.center;
  state.centerX = (matrix[0] ?? 1) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
  state.centerY = (matrix[1] ?? 0) * x + (matrix[5] ?? 1) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
  state.centerZ = (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 1) * z + (matrix[14] ?? 0);
  const scaleX = Math.hypot(matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0);
  const scaleY = Math.hypot(matrix[4] ?? 0, matrix[5] ?? 1, matrix[6] ?? 0);
  const scaleZ = Math.hypot(matrix[8] ?? 0, matrix[9] ?? 0, matrix[10] ?? 1);
  state.radius = state.localSphere.radius * Math.max(scaleX, scaleY, scaleZ);
  const extent = state.lod.activationDistance * (1 + state.lod.hysteresis) + state.radius;
  state.minX = state.centerX - extent;
  state.minY = state.centerY - extent;
  state.minZ = state.centerZ - extent;
  state.maxX = state.centerX + extent;
  state.maxY = state.centerY + extent;
  state.maxZ = state.centerZ + extent;
}
