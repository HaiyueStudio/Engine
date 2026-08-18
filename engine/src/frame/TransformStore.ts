import { mat4 } from 'wgpu-matrix';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import { Transform2D } from '../components/Transform2D';
import { Transform3D } from '../components/Transform3D';
import { IDENTITY_MAT4 } from '../math/constants';
import { requiredItemAt, requiredNumberAt } from '../math/arrayAccess';
import { getWorldStructureVersion } from '../ecs/WorldStructure';

const MATRIX_WORDS = 16;

export interface TransformFrameEntry {
  entity: Entity;
  worldMatrix: Float32Array;
  localMatrix: Float32Array;
  worldVersion: number;
  hasTransform: boolean;
}

export class TransformStore {
  private _world: World | null = null;
  private _worldStructureVersion = -1;
  private _worldStructureChanged = false;
  private _phaseRevision = 0;
  private _capacity = 0;
  private _nextSlot = 0;
  private _activeSlotCount = 0;
  private _worldMatrices = new Float32Array(0);
  private _localMatrices = new Float32Array(0);
  private _worldVersions = new Uint32Array(0);
  private _visitedFrames = new Uint32Array(0);
  private _dirtyVisitedGenerations = new Uint32Array(0);
  private _hasTransforms = new Uint8Array(0);
  private readonly _entitySlots = new Map<number, number>();
  private readonly _slotEntities: Array<Entity | null> = [];
  private readonly _entries: TransformFrameEntry[] = [];
  private readonly _freeSlots: number[] = [];
  private readonly _resolveStack: Entity[] = [];
  private readonly _dirtyRoots = new Set<Entity>();
  private readonly _dirtyStack: Entity[] = [];
  private readonly _dirtyEntitiesScratch: Entity[] = [];
  private readonly _changedEntities: Entity[] = [];
  private _dirtyRevision = 0;
  private _dirtyTraversalGeneration = 0;
  private _lastDirtyTraversalCount = 0;
  private readonly _identityEntry: TransformFrameEntry = {
    entity: null as unknown as Entity,
    worldMatrix: IDENTITY_MAT4,
    localMatrix: IDENTITY_MAT4,
    worldVersion: 0,
    hasTransform: false,
  };

  beginPhase(world: World): void {
    if (this._world !== world) this._resetForWorld(world);
    this._world = world;
    this._changedEntities.length = 0;
    const structureVersion = getWorldStructureVersion(world);
    this._worldStructureChanged = structureVersion !== this._worldStructureVersion;
    if (structureVersion !== this._worldStructureVersion) {
      this._reconcileEntitySlots(world);
      this._worldStructureVersion = structureVersion;
    }
    this._phaseRevision = (this._phaseRevision + 1) >>> 0;
    if (this._phaseRevision === 0) {
      this._phaseRevision = 1;
      this._visitedFrames.fill(0);
    }
  }

  get phaseRevision(): number {
    return this._phaseRevision;
  }

  get dirtyRevision(): number { return this._dirtyRevision; }
  get changedEntities(): readonly Entity[] { return this._changedEntities; }
  /** Unique entities visited by the most recent dirty-subtree flush. */
  get lastDirtyTraversalCount(): number { return this._lastDirtyTraversalCount; }

  /** Marks a transform root whose complete descendant subtree needs world-version evaluation. */
  markDirty(entity: Entity): void {
    if (this._dirtyRoots.has(entity)) return;
    this._dirtyRoots.add(entity);
    this._dirtyRevision = this._dirtyRevision >= Number.MAX_SAFE_INTEGER ? 1 : this._dirtyRevision + 1;
  }

  /** Resolves dirty subtrees and returns a phase-local, non-destructive changed-entity journal. */
  flushDirtyWorldVersions(): readonly Entity[] {
    this._lastDirtyTraversalCount = 0;
    if (!this._world || this._dirtyRoots.size === 0) return this._changedEntities;
    this._dirtyTraversalGeneration = (this._dirtyTraversalGeneration + 1) >>> 0;
    if (this._dirtyTraversalGeneration === 0) {
      this._dirtyTraversalGeneration = 1;
      this._dirtyVisitedGenerations.fill(0);
    }
    const generation = this._dirtyTraversalGeneration;
    const dirtyStack = this._dirtyStack;
    const dirtyEntities = this._dirtyEntitiesScratch;
    dirtyStack.length = 0;
    dirtyEntities.length = 0;
    for (const root of this._dirtyRoots) dirtyStack.push(root);
    this._dirtyRoots.clear();
    while (dirtyStack.length > 0) {
      const entity = dirtyStack.pop();
      if (!entity || entity.world !== this._world) continue;
      const slot = this._getSlot(entity);
      if (this._dirtyVisitedGenerations[slot] === generation) continue;
      this._dirtyVisitedGenerations[slot] = generation;
      this._visitedFrames[slot] = 0;
      dirtyEntities.push(entity);
      for (let i = 0; i < entity.children.length; i++) {
        const child = entity.children[i];
        if (child) dirtyStack.push(child);
      }
    }
    this._lastDirtyTraversalCount = dirtyEntities.length;
    for (let i = dirtyEntities.length - 1; i >= 0; i--) {
      const entity = dirtyEntities[i];
      if (entity) this.getEntry(entity);
    }
    dirtyStack.length = 0;
    dirtyEntities.length = 0;
    return this._changedEntities;
  }

  /** Allocated slot capacity; useful for churn diagnostics and capacity planning. */
  get capacity(): number { return this._capacity; }

  /** Number of entity slots currently retained by this frame store. */
  get activeSlotCount(): number { return this._activeSlotCount; }

  getWorldMatrix(entity: Entity): Float32Array {
    return this.getEntry(entity).worldMatrix;
  }

  getEntry(entity: Entity): TransformFrameEntry {
    if (this._world && this._world.entities.get(entity.id) !== entity) {
      this._identityEntry.entity = entity;
      return this._identityEntry;
    }
    const slot = this._getSlot(entity);
    if (this._visitedFrames[slot] === this._phaseRevision) return this._makeEntry(entity, slot);
    if (!entity.parent) {
      this._computeEntity(entity);
      return this._makeEntry(entity, slot);
    }
    this._resolveStack.length = 0;
    let cursor: Entity | null = entity;
    while (cursor) {
      const cursorSlot = this._getSlot(cursor);
      if (this._visitedFrames[cursorSlot] === this._phaseRevision) break;
      this._resolveStack.push(cursor);
      cursor = cursor.parent as Entity | null;
    }
    for (let i = this._resolveStack.length - 1; i >= 0; i--) {
      this._computeEntity(requiredItemAt(this._resolveStack, i, 'TransformStore resolve stack'));
    }
    this._resolveStack.length = 0;
    return this._makeEntry(entity, slot);
  }

  private _computeEntity(entity: Entity): void {
    const slot = this._getSlot(entity);
    if (this._visitedFrames[slot] === this._phaseRevision) return;
    const parent = entity.parent as Entity | null;
    const parentSlot = parent ? this._getSlot(parent) : -1;
    const parentReady = parentSlot >= 0 && this._visitedFrames[parentSlot] === this._phaseRevision;
    const parentHasTransform = parentReady && this._hasTransforms[parentSlot] === 1;
    const parentWorld = parentHasTransform ? this._getWorldView(parentSlot) : undefined;
    const parentVersion = parentHasTransform ? this._worldVersions[parentSlot] : Number.NaN;
    const transform3D = entity.getComponent(Transform3D);
    const transform2D = transform3D ? null : entity.getComponent(Transform2D);
    const worldView = this._getWorldView(slot);
    const localView = this._getLocalView(slot);
    const previousWorldVersion = this._worldVersions[slot] ?? 0;
    const previousHasTransform = this._hasTransforms[slot] === 1;

    if (transform3D) {
      transform3D.updateWorldMatrix(parentWorld, parentVersion);
      const worldVersion = transform3D.worldVersion >>> 0;
      if (
        this._worldStructureChanged
        || !previousHasTransform
        || worldVersion !== previousWorldVersion
      ) {
        localView.set(transform3D.localMatrix);
        worldView.set(transform3D.worldMatrix);
      }
      this._worldVersions[slot] = worldVersion;
      this._hasTransforms[slot] = 1;
    } else if (transform2D) {
      transform2D.updateWorldMatrix(parentWorld, parentVersion);
      const worldVersion = transform2D.worldVersion >>> 0;
      if (
        this._worldStructureChanged
        || !previousHasTransform
        || worldVersion !== previousWorldVersion
      ) {
        localView.set(transform2D.localMatrix);
        worldView.set(transform2D.worldMatrix);
      }
      this._worldVersions[slot] = worldVersion;
      this._hasTransforms[slot] = 1;
    } else {
      const worldVersion = parentReady
        ? requiredNumberAt(this._worldVersions, parentSlot, 'TransformStore world versions')
        : 0;
      if (
        this._worldStructureChanged
        || previousHasTransform
        || worldVersion !== previousWorldVersion
      ) {
        localView.set(IDENTITY_MAT4);
        if (parentWorld) worldView.set(parentWorld);
        else worldView.set(IDENTITY_MAT4);
      }
      this._worldVersions[slot] = worldVersion;
      this._hasTransforms[slot] = 0;
    }

    this._visitedFrames[slot] = this._phaseRevision;
    if ((this._worldVersions[slot] ?? 0) !== previousWorldVersion) this._changedEntities.push(entity);
  }

  getWorldVersion(entity: Entity): number {
    return this.getEntry(entity).worldVersion;
  }

  clear(): void {
    this._world = null;
    this._worldStructureVersion = -1;
    this._worldStructureChanged = false;
    this._entitySlots.clear();
    this._slotEntities.length = 0;
    this._entries.length = 0;
    this._freeSlots.length = 0;
    this._capacity = 0;
    this._nextSlot = 0;
    this._activeSlotCount = 0;
    this._worldMatrices = new Float32Array(0);
    this._localMatrices = new Float32Array(0);
    this._worldVersions = new Uint32Array(0);
    this._visitedFrames = new Uint32Array(0);
    this._dirtyVisitedGenerations = new Uint32Array(0);
    this._hasTransforms = new Uint8Array(0);
    this._resolveStack.length = 0;
    this._dirtyRoots.clear();
    this._dirtyStack.length = 0;
    this._dirtyEntitiesScratch.length = 0;
    this._changedEntities.length = 0;
  }

  private _makeEntry(entity: Entity, slot: number): TransformFrameEntry {
    const entry = requiredItemAt(this._entries, slot, 'TransformStore entries');
    entry.entity = entity;
    entry.worldVersion = requiredNumberAt(this._worldVersions, slot, 'TransformStore world versions');
    entry.hasTransform = this._hasTransforms[slot] === 1;
    return entry;
  }

  private _getSlot(entity: Entity): number {
    let slot = this._entitySlots.get(entity.id);
    if (slot !== undefined) return slot;
    slot = this._freeSlots.pop() ?? this._nextSlot++;
    this._entitySlots.set(entity.id, slot);
    this._ensureCapacity(slot + 1);
    this._slotEntities[slot] = entity;
    let entry = this._entries[slot];
    if (!entry) {
      entry = {
        entity,
        worldMatrix: this._worldMatrices.subarray(slot * MATRIX_WORDS, slot * MATRIX_WORDS + MATRIX_WORDS),
        localMatrix: this._localMatrices.subarray(slot * MATRIX_WORDS, slot * MATRIX_WORDS + MATRIX_WORDS),
        worldVersion: 0,
        hasTransform: false,
      };
      this._entries[slot] = entry;
    } else {
      entry.entity = entity;
      entry.worldVersion = 0;
      entry.hasTransform = false;
    }
    this._visitedFrames[slot] = 0;
    this._dirtyVisitedGenerations[slot] = 0;
    this._worldVersions[slot] = 0;
    this._hasTransforms[slot] = 0;
    this._activeSlotCount++;
    return slot;
  }

  private _ensureCapacity(required: number): void {
    if (required <= this._capacity) return;
    let next = Math.max(64, this._capacity);
    while (next < required) next *= 2;
    const worldMatrices = new Float32Array(next * MATRIX_WORDS);
    const localMatrices = new Float32Array(next * MATRIX_WORDS);
    const worldVersions = new Uint32Array(next);
    const visitedFrames = new Uint32Array(next);
    const dirtyVisitedGenerations = new Uint32Array(next);
    const hasTransforms = new Uint8Array(next);
    worldMatrices.set(this._worldMatrices);
    localMatrices.set(this._localMatrices);
    worldVersions.set(this._worldVersions);
    visitedFrames.set(this._visitedFrames);
    dirtyVisitedGenerations.set(this._dirtyVisitedGenerations);
    hasTransforms.set(this._hasTransforms);
    for (let i = this._capacity; i < next; i++) {
      const base = i * MATRIX_WORDS;
      worldMatrices.set(IDENTITY_MAT4, base);
      localMatrices.set(IDENTITY_MAT4, base);
    }
    this._capacity = next;
    this._worldMatrices = worldMatrices;
    this._localMatrices = localMatrices;
    this._worldVersions = worldVersions;
    this._visitedFrames = visitedFrames;
    this._dirtyVisitedGenerations = dirtyVisitedGenerations;
    this._hasTransforms = hasTransforms;
    for (let slot = 0; slot < this._nextSlot; slot++) {
      const entry = this._entries[slot];
      if (!entry) continue;
      entry.worldMatrix = worldMatrices.subarray(slot * MATRIX_WORDS, slot * MATRIX_WORDS + MATRIX_WORDS);
      entry.localMatrix = localMatrices.subarray(slot * MATRIX_WORDS, slot * MATRIX_WORDS + MATRIX_WORDS);
    }
  }

  private _getWorldView(slot: number): Float32Array {
    return requiredItemAt(this._entries, slot, 'TransformStore entries').worldMatrix;
  }

  private _getLocalView(slot: number): Float32Array {
    return requiredItemAt(this._entries, slot, 'TransformStore entries').localMatrix;
  }

  private _resetForWorld(world: World): void {
    this._entitySlots.clear();
    this._freeSlots.length = 0;
    for (let slot = 0; slot < this._nextSlot; slot++) {
      this._slotEntities[slot] = null;
      this._visitedFrames[slot] = 0;
      this._dirtyVisitedGenerations[slot] = 0;
    }
    this._nextSlot = 0;
    this._activeSlotCount = 0;
    this._dirtyRoots.clear();
    this._dirtyStack.length = 0;
    this._dirtyEntitiesScratch.length = 0;
    this._changedEntities.length = 0;
    this._world = world;
    this._worldStructureVersion = -1;
  }

  private _reconcileEntitySlots(world: World): void {
    for (const [entityId, slot] of this._entitySlots) {
      const entity = this._slotEntities[slot];
      if (entity && world.entities.get(entityId) === entity) continue;
      this._entitySlots.delete(entityId);
      this._slotEntities[slot] = null;
      this._visitedFrames[slot] = 0;
      this._dirtyVisitedGenerations[slot] = 0;
      this._hasTransforms[slot] = 0;
      this._freeSlots.push(slot);
      this._activeSlotCount--;
    }
  }
}

export function composeViewProjection(worldMatrix: Float32Array, projectionMatrix: Float32Array, outView: Float32Array, outViewProjection: Float32Array): Float32Array {
  const view = mat4.inverse(worldMatrix, outView) as Float32Array;
  return mat4.multiply(projectionMatrix, view, outViewProjection) as Float32Array;
}
