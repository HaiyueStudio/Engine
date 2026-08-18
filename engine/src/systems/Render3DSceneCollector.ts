import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import { BvhLod3D } from '../components/BvhLod3D';
import { Mesh3D } from '../components/Mesh3D';
import { Transform3D } from '../components/Transform3D';
import { MeshHelper } from '../components/MeshHelper';
import { OutlineTarget } from '../components/OutlineTarget';
import { ClippingPlanes } from '../components/ClippingPlanes';
import { isEntityDisabledInHierarchyCached } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { IDENTITY_MAT4 } from '../math/constants';
import type { BoundingSphere } from '../culling/Frustum';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';
import type { FrameData } from '../frame/FrameData';
import type { Render3DHelperItem, Render3DRenderItem, TransparentMaterialInfo } from './Render3DContracts';
import type { FrameDiagnostics } from '../core/FrameDiagnostics';
import { requiredItemAt, requiredMat4Array } from '../math/arrayAccess';
import type { RenderViewSnapshot } from '../core/RenderView';
import type { Render3DOpaqueSceneSortKey, WorldFrameRenderable, WorldFrameState } from './Render3DFrameState';

interface ResourceSelection {
  geometry: Geometry3D;
  material: Material;
  level: number;
}

interface MutableBoundingSphere extends BoundingSphere {
  center: [number, number, number];
}

interface CachedWorldSphere extends MutableBoundingSphere {
  entityId: number;
  worldVersion: number;
  worldMatrix: Float32Array;
  centerOffsetX: number;
  centerOffsetY: number;
  centerOffsetZ: number;
  geometryId: number;
  geometryVersion: number;
  boundsVersion: number;
  lodRevision: number;
  usesLodBounds: boolean;
  hasSphere: boolean;
}

export interface Render3DTransparentBatchSink {
  clear(): void;
  push(entry: {
    payload: Render3DRenderItem;
    entityId: number;
    materialId: number;
    rendererKey: number;
    viewDepth: number;
    transparentOrder: number;
    depthSort: boolean;
  }): void;
}

export interface Render3DWorldExtractionOptions {
  frameData: FrameData;
  disabledHierarchyCache: EntityHierarchyDisabledCache;
  worldMatrixCache: Map<Entity, Transform3D | null>;
  getWorldBoundingSphere(geometry: Geometry3D, worldMatrix: Float32Array, target?: MutableBoundingSphere): BoundingSphere | null;
}

export interface Render3DViewCollectionOptions {
  diagnostics?: FrameDiagnostics | undefined;
  view: RenderViewSnapshot;
  cameraPosition: Float32Array;
  frustumCull: boolean;
  gpuDrivenCulling: boolean;
  transparentSort: boolean;
  viewMatrix: Float32Array;
  opaqueItems: Render3DRenderItem[];
  transparentItems: Render3DRenderItem[];
  helperItems: Render3DHelperItem[];
  outlineItems: Render3DRenderItem[];
  transparentBatch: Render3DTransparentBatchSink;
  containsSphere(sphere: BoundingSphere): boolean;
  getTransparentMaterialInfo(material: Material): TransparentMaterialInfo;
  getOpaqueSceneSortKey(entityId: number, lodLevel: number): Render3DOpaqueSceneSortKey | null;
  getWorldBoundingSphere(geometry: Geometry3D, worldMatrix: Float32Array): BoundingSphere | null;
  nextRenderItem(
    entityId: number,
    mesh: Mesh3D,
    geometry: Geometry3D,
    material: Material,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    viewDepth: number,
    transparentOrder: number,
    transparentDepthSort: boolean,
    worldSphere: BoundingSphere | null,
    lodLevel: number,
    opaqueSortKey: Render3DOpaqueSceneSortKey | null,
  ): Render3DRenderItem;
  nextHelperItem(
    entityId: number,
    geometry: Geometry3D,
    helper: MeshHelper,
    worldMatrix: Float32Array,
  ): Render3DHelperItem;
}

export interface Render3DShadowCollectionOptions {
  frameData: FrameData;
  shadowItems: Render3DRenderItem[];
  containsSphere(sphere: BoundingSphere): boolean;
  receivesDirectionalShadow(material: Material): boolean;
  getTransparentMaterialInfo(material: Material): TransparentMaterialInfo;
  getWorldBoundingSphere(geometry: Geometry3D, worldMatrix: Float32Array): BoundingSphere | null;
  nextRenderItem(
    entityId: number,
    mesh: Mesh3D,
    geometry: Geometry3D,
    material: Material,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    viewDepth: number,
    transparentOrder: number,
    transparentDepthSort: boolean,
    worldSphere: BoundingSphere | null,
    lodLevel: number,
    opaqueSortKey: Render3DOpaqueSceneSortKey | null,
  ): Render3DRenderItem;
}

export interface Render3DShadowCollectionStats {
  readonly casterCount: number;
  readonly receiverCount: number;
  readonly revisionA: number;
  readonly revisionB: number;
}

export interface Render3DSceneCollectionStats {
  visibleCount: number;
  totalCount: number;
}

interface LodSelectionState {
  revision: number;
  level: number;
  lastSeenFrame: number;
}

interface LodViewState {
  readonly selections: Map<number, LodSelectionState>;
  lastSeenFrame: number;
  lastSweepFrame: number;
  seenSelectionCount: number;
}

const LOD_SELECTION_SWEEP_INTERVAL = 120;
const LOD_SELECTION_MIN_CAPACITY = 64;

/** Extracts camera-independent state once, then derives any number of view-local lists. */
export class Render3DSceneCollector {
  private readonly _renderables: WorldFrameRenderable[] = [];
  private readonly _renderablePool: WorldFrameRenderable[] = [];
  private readonly _worldSpherePool: MutableBoundingSphere[] = [];
  private readonly _lodByView = new Map<string, LodViewState>();
  private readonly _worldFrameState: WorldFrameState = {
    frameId: 0,
    phaseRevision: 0,
    renderables: this._renderables,
    totalCount: 0,
  };
  private _poolCursor = 0;
  private _extractionCount = 0;
  private _cacheFrame = 0;
  private readonly _collectionStats: Render3DSceneCollectionStats = { visibleCount: 0, totalCount: 0 };
  private readonly _shadowCollectionStats: Render3DShadowCollectionStats = {
    casterCount: 0,
    receiverCount: 0,
    revisionA: 0,
    revisionB: 0,
  };
  private readonly _resourceSelection = {
    geometry: null as unknown as Geometry3D,
    material: null as unknown as Material,
    level: -1,
  };
  private readonly _transparentEntry = {
    payload: null as unknown as Render3DRenderItem,
    entityId: 0,
    materialId: 0,
    rendererKey: 0,
    viewDepth: 0,
    transparentOrder: 0,
    depthSort: false,
  };

  get extractionCount(): number { return this._extractionCount; }
  get lodViewCacheCount(): number { return this._lodByView.size; }
  get lodSelectionCacheCount(): number {
    let count = 0;
    for (const view of this._lodByView.values()) count += view.selections.size;
    return count;
  }

  beginFrame(cacheFrame: number): this {
    this._cacheFrame = cacheFrame;
    return this;
  }

  sweepViewCaches(): void {
    for (const [viewKey, view] of this._lodByView) {
      if (view.lastSeenFrame !== this._cacheFrame) this._lodByView.delete(viewKey);
    }
  }

  clearViewCaches(): void {
    this._lodByView.clear();
    this._cacheFrame = 0;
  }

  extract(
    world: World,
    entities: ReadonlySet<Entity> | undefined,
    options: Render3DWorldExtractionOptions,
  ): WorldFrameState {
    this._poolCursor = 0;
    let renderableCount = 0;
    this._extractionCount++;
    if (entities) {
      for (const entity of entities) {
        if (isEntityDisabledInHierarchyCached(entity, options.disabledHierarchyCache)) continue;
        const mesh = entity.getComponent(Mesh3D);
        if (!mesh) continue;
        const transform = entity.getComponent(Transform3D);
        const transformEntry = options.frameData.transforms.getEntry(entity);
        const worldMatrix = transform ? transformEntry.worldMatrix : IDENTITY_MAT4;
        const worldVersion = transformEntry.worldVersion;
        const lod = entity.getComponent(BvhLod3D);
        const activeLod = lod && !lod.disabled ? lod : null;
        const boundsGeometry = activeLod ? activeLod.levels[0]?.geometry ?? mesh.geometry : mesh.geometry;
        const spherePoolIndex = this._poolCursor;
        let sphereTarget = this._worldSpherePool[spherePoolIndex] as CachedWorldSphere | undefined;
        if (!sphereTarget) {
          sphereTarget = {
            center: [0, 0, 0],
            radius: 0,
            entityId: 0,
            worldVersion: -1,
            worldMatrix: new Float32Array(16),
            centerOffsetX: 0,
            centerOffsetY: 0,
            centerOffsetZ: 0,
            geometryId: 0,
            geometryVersion: -1,
            boundsVersion: -1,
            lodRevision: -1,
            usesLodBounds: false,
            hasSphere: false,
          };
          this._worldSpherePool.push(sphereTarget);
        }
        const usesLodBounds = activeLod?.bounds !== null && activeLod?.bounds !== undefined;
        const geometryId = boundsGeometry?.id ?? 0;
        const geometryVersion = boundsGeometry?.version ?? 0;
        const boundsVersion = boundsGeometry?.boundsVersion ?? 0;
        const lodRevision = activeLod?.revision ?? 0;
        const sphereResourceCacheHit = sphereTarget.entityId === entity.id
          && sphereTarget.geometryId === geometryId
          && sphereTarget.geometryVersion === geometryVersion
          && sphereTarget.boundsVersion === boundsVersion
          && sphereTarget.lodRevision === lodRevision
          && sphereTarget.usesLodBounds === usesLodBounds;
        const sphereCacheHit = sphereResourceCacheHit
          && sphereTarget.worldVersion === worldVersion;
        let worldSphere: BoundingSphere | null;
        if (sphereCacheHit) {
          worldSphere = sphereTarget.hasSphere ? sphereTarget : null;
        } else if (
          sphereResourceCacheHit
          && sameAffineLinearTransform(sphereTarget.worldMatrix, worldMatrix)
        ) {
          if (sphereTarget.hasSphere) {
            sphereTarget.center[0] = (worldMatrix[12] ?? 0) + sphereTarget.centerOffsetX;
            sphereTarget.center[1] = (worldMatrix[13] ?? 0) + sphereTarget.centerOffsetY;
            sphereTarget.center[2] = (worldMatrix[14] ?? 0) + sphereTarget.centerOffsetZ;
          }
          sphereTarget.worldMatrix[12] = worldMatrix[12] ?? 0;
          sphereTarget.worldMatrix[13] = worldMatrix[13] ?? 0;
          sphereTarget.worldMatrix[14] = worldMatrix[14] ?? 0;
          sphereTarget.worldVersion = worldVersion;
          worldSphere = sphereTarget.hasSphere ? sphereTarget : null;
        } else {
          worldSphere = activeLod?.bounds
            ? transformSphere(activeLod.bounds, worldMatrix, sphereTarget)
            : boundsGeometry ? options.getWorldBoundingSphere(boundsGeometry, worldMatrix, sphereTarget) : null;
          if (worldSphere && worldSphere !== sphereTarget) {
            sphereTarget.center[0] = worldSphere.center[0];
            sphereTarget.center[1] = worldSphere.center[1];
            sphereTarget.center[2] = worldSphere.center[2];
            sphereTarget.radius = worldSphere.radius;
            worldSphere = sphereTarget;
          }
          if (worldSphere) {
            sphereTarget.centerOffsetX = worldSphere.center[0] - (worldMatrix[12] ?? 0);
            sphereTarget.centerOffsetY = worldSphere.center[1] - (worldMatrix[13] ?? 0);
            sphereTarget.centerOffsetZ = worldSphere.center[2] - (worldMatrix[14] ?? 0);
          }
          sphereTarget.entityId = entity.id;
          sphereTarget.worldVersion = worldVersion;
          sphereTarget.worldMatrix.set(worldMatrix);
          sphereTarget.geometryId = geometryId;
          sphereTarget.geometryVersion = geometryVersion;
          sphereTarget.boundsVersion = boundsVersion;
          sphereTarget.lodRevision = lodRevision;
          sphereTarget.usesLodBounds = usesLodBounds;
          sphereTarget.hasSphere = worldSphere !== null;
        }
        this._renderables[renderableCount++] = this._nextWorldRenderable(
          entity,
          mesh,
          activeLod,
          entity.getComponent(MeshHelper),
          entity.hasComponent(OutlineTarget),
          entity.getComponent(ClippingPlanes),
          worldMatrix,
          worldVersion,
          worldSphere,
        );
      }
    }
    this._renderables.length = renderableCount;
    const mutable = this._worldFrameState as {
      frameId: number;
      phaseRevision: number;
      totalCount: number;
    };
    mutable.frameId = options.frameData.frameId;
    mutable.phaseRevision = options.frameData.phaseRevision;
    mutable.totalCount = this._renderables.length;
    return this._worldFrameState;
  }

  collectView(state: WorldFrameState, options: Render3DViewCollectionOptions): Render3DSceneCollectionStats {
    const {
      helperItems,
      opaqueItems,
      outlineItems,
      transparentBatch,
      transparentItems,
      viewMatrix,
    } = options;
    transparentBatch.clear();
    let lodView = this._lodByView.get(options.view.key);
    if (lodView) {
      lodView.lastSeenFrame = this._cacheFrame;
      lodView.seenSelectionCount = 0;
    }

    let visibleCount = 0;
    let opaqueCount = 0;
    let transparentCount = 0;
    let helperCount = 0;
    let outlineCount = 0;
    const excludedEntityIds = options.view.excludedEntityIds;
    for (let renderableIndex = 0; renderableIndex < state.renderables.length; renderableIndex++) {
      const renderable = requiredItemAt(
        state.renderables,
        renderableIndex,
        'Render3D world-frame renderables',
      );
      if (excludedEntityIds?.has(renderable.entityId)) continue;
      if (renderable.lod && !lodView) lodView = this._createLodView(options.view.key);
      const resources = this._selectResources(renderable, lodView, options.cameraPosition);
      const transparentInfo = options.getTransparentMaterialInfo(resources.material);
      let worldSphere = renderable.worldSphere;
      if (resources.geometry !== renderable.mesh.geometry && !renderable.lod?.bounds) {
        worldSphere = options.getWorldBoundingSphere(resources.geometry, renderable.worldMatrix);
      }
      let cameraCulled: boolean;
      if (options.diagnostics?.enabled) {
        const startedAt = options.diagnostics.startMeasure();
        cameraCulled = Boolean(options.frustumCull && worldSphere && !options.containsSphere(worldSphere));
        options.diagnostics.finishMeasure('cull', startedAt);
      } else {
        cameraCulled = Boolean(options.frustumCull && worldSphere && !options.containsSphere(worldSphere));
      }

      const item = options.nextRenderItem(
        renderable.entityId,
        renderable.mesh,
        resources.geometry,
        resources.material,
        renderable.clippingPlanes && !renderable.clippingPlanes.disabled ? renderable.clippingPlanes : null,
        renderable.worldMatrix,
        computeViewDepth(renderable.worldMatrix, viewMatrix),
        transparentInfo.order,
        transparentInfo.depthSort,
        worldSphere,
        resources.level,
        transparentInfo.transparent
          ? null
          : options.getOpaqueSceneSortKey(renderable.entityId, resources.level),
      );
      if (cameraCulled && !options.gpuDrivenCulling) continue;

      if (!cameraCulled) visibleCount++;
      if (transparentInfo.transparent) {
        transparentItems[transparentCount++] = item;
        if (options.transparentSort) {
          const entry = this._transparentEntry;
          entry.payload = item;
          entry.entityId = renderable.entityId;
          entry.materialId = resources.material.id;
          entry.rendererKey = transparentInfo.rendererKey;
          entry.viewDepth = item.viewDepth;
          entry.transparentOrder = item.transparentOrder;
          entry.depthSort = item.transparentDepthSort;
          transparentBatch.push(entry);
        }
      } else {
        opaqueItems[opaqueCount++] = item;
      }
      if (!cameraCulled && renderable.outlined) outlineItems[outlineCount++] = item;
      if (!cameraCulled && renderable.helper) {
        helperItems[helperCount++] = options.nextHelperItem(
          renderable.entityId,
          resources.geometry,
          renderable.helper,
          renderable.worldMatrix,
        );
      }
    }
    opaqueItems.length = opaqueCount;
    transparentItems.length = transparentCount;
    helperItems.length = helperCount;
    outlineItems.length = outlineCount;
    this._collectionStats.visibleCount = visibleCount;
    this._collectionStats.totalCount = state.totalCount;
    if (lodView) this._sweepLodSelections(lodView);
    return this._collectionStats;
  }

  /**
   * Builds the camera-independent directional-shadow caster list once.
   * BvhLod3D shadows intentionally use level zero (highest detail), keeping
   * the shadow map stable when reflection and main cameras choose other LODs.
   */
  collectShadowCasters(
    state: WorldFrameState,
    options: Render3DShadowCollectionOptions,
  ): Render3DShadowCollectionStats {
    const items = options.shadowItems;
    let count = 0;
    let receiverCount = 0;
    let revisionA = 0x811c9dc5;
    let revisionB = 0x9e3779b9;
    for (const renderable of state.renderables) {
      if (options.receivesDirectionalShadow(renderable.mesh.material)) {
        receiverCount++;
      } else if (renderable.lod) {
        for (const level of renderable.lod.levels) {
          if (options.receivesDirectionalShadow(level.material ?? renderable.mesh.material)) {
            receiverCount++;
            break;
          }
        }
      }
      const resources = this._selectShadowResources(renderable);
      const transparentInfo = options.getTransparentMaterialInfo(resources.material);
      if (transparentInfo.transparent) continue;
      let worldSphere = renderable.worldSphere;
      if (resources.geometry !== renderable.mesh.geometry && !renderable.lod?.bounds) {
        worldSphere = options.getWorldBoundingSphere(resources.geometry, renderable.worldMatrix);
      }
      if (worldSphere && !options.containsSphere(worldSphere)) continue;
      items[count++] = options.nextRenderItem(
        renderable.entityId,
        renderable.mesh,
        resources.geometry,
        resources.material,
        renderable.clippingPlanes && !renderable.clippingPlanes.disabled ? renderable.clippingPlanes : null,
        renderable.worldMatrix,
        0,
        0,
        false,
        worldSphere,
        resources.level,
        null,
      );
      const geometry = resources.geometry;
      revisionA = mixShadowRevision(revisionA, renderable.entityId);
      revisionA = mixShadowRevision(revisionA, renderable.worldVersion);
      revisionA = mixShadowRevision(revisionA, geometry.id);
      revisionA = mixShadowRevision(revisionA, geometry.version);
      revisionA = mixShadowRevision(revisionA, geometry.boundsVersion);
      revisionA = mixShadowRevision(revisionA, geometry.morphVersion);
      revisionA = mixShadowRevision(revisionA, geometry.skinning?.version ?? 0);
      revisionA = mixShadowRevision(revisionA, resources.material.id);
      revisionA = mixShadowRevision(revisionA, resources.material.revision);
      revisionA = mixShadowRevision(revisionA, renderable.clippingPlanes?.revision ?? 0);
      revisionA = mixShadowRevision(revisionA, renderable.clippingPlanes?.disabled ? 1 : 0);
      revisionA = mixShadowRevision(revisionA, renderable.lod?.revision ?? 0);
      revisionA = mixShadowRevision(revisionA, resources.level + 1);
      revisionB = mixShadowRevision(revisionB, revisionA ^ count);
    }
    items.length = count;
    const stats = this._shadowCollectionStats as {
      casterCount: number;
      receiverCount: number;
      revisionA: number;
      revisionB: number;
    };
    stats.casterCount = count;
    stats.receiverCount = receiverCount;
    stats.revisionA = revisionA >>> 0;
    stats.revisionB = revisionB >>> 0;
    return this._shadowCollectionStats;
  }

  private _selectResources(
    renderable: WorldFrameRenderable,
    view: LodViewState | undefined,
    cameraPosition: Float32Array,
  ): ResourceSelection {
    const lod = renderable.lod;
    const result = this._resourceSelection;
    if (!lod) {
      result.geometry = renderable.mesh.geometry;
      result.material = renderable.mesh.material;
      result.level = -1;
      return result;
    }
    const lodView = view as LodViewState;
    const levels = lodView.selections;
    let selection = levels.get(renderable.entityId);
    if (!selection) {
      selection = { revision: lod.revision, level: -1, lastSeenFrame: this._cacheFrame };
      levels.set(renderable.entityId, selection);
    } else if (selection.revision !== lod.revision) {
      selection.revision = lod.revision;
      selection.level = -1;
    }
    selection.lastSeenFrame = this._cacheFrame;
    lodView.seenSelectionCount++;
    const sphere = renderable.worldSphere;
    const x = sphere?.center[0] ?? renderable.worldMatrix[12] ?? 0;
    const y = sphere?.center[1] ?? renderable.worldMatrix[13] ?? 0;
    const z = sphere?.center[2] ?? renderable.worldMatrix[14] ?? 0;
    const distance = Math.max(0, Math.hypot(
      (cameraPosition[0] ?? 0) - x,
      (cameraPosition[1] ?? 0) - y,
      (cameraPosition[2] ?? 0) - z,
    ) - (sphere?.radius ?? 0));
    selection.level = lod.selectLevel(distance, selection.level);
    const level = lod.levels[selection.level] ?? lod.levels[lod.levels.length - 1];
    result.geometry = level?.geometry ?? renderable.mesh.geometry;
    result.material = level?.material ?? renderable.mesh.material;
    result.level = selection.level;
    return result;
  }

  private _selectShadowResources(renderable: WorldFrameRenderable): ResourceSelection {
    const result = this._resourceSelection;
    const lod = renderable.lod;
    if (!lod) {
      result.geometry = renderable.mesh.geometry;
      result.material = renderable.mesh.material;
      result.level = -1;
      return result;
    }
    const level = lod.levels[0];
    result.geometry = level?.geometry ?? renderable.mesh.geometry;
    result.material = level?.material ?? renderable.mesh.material;
    result.level = 0;
    return result;
  }

  private _createLodView(viewKey: string): LodViewState {
    const view: LodViewState = {
      selections: new Map(),
      lastSeenFrame: this._cacheFrame,
      lastSweepFrame: this._cacheFrame,
      seenSelectionCount: 0,
    };
    this._lodByView.set(viewKey, view);
    return view;
  }

  private _sweepLodSelections(view: LodViewState): void {
    const selections = view.selections;
    const capacityLimit = Math.max(LOD_SELECTION_MIN_CAPACITY, view.seenSelectionCount * 2);
    const periodicSweep = this._cacheFrame - view.lastSweepFrame >= LOD_SELECTION_SWEEP_INTERVAL;
    if (!periodicSweep && selections.size <= capacityLimit) return;
    for (const [entityId, selection] of selections) {
      if (selection.lastSeenFrame !== this._cacheFrame) selections.delete(entityId);
    }
    view.lastSweepFrame = this._cacheFrame;
  }

  private _nextWorldRenderable(
    entity: Entity,
    mesh: Mesh3D,
    lod: BvhLod3D | null,
    helper: MeshHelper | null,
    outlined: boolean,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    worldVersion: number,
    worldSphere: BoundingSphere | null,
  ): WorldFrameRenderable {
    let item = this._renderablePool[this._poolCursor++] as MutableWorldFrameRenderable | undefined;
    if (!item) {
      item = { entity, entityId: entity.id, mesh, lod, helper, outlined, clippingPlanes, worldMatrix, worldVersion, worldSphere };
      this._renderablePool.push(item);
    } else {
      item.entity = entity;
      item.entityId = entity.id;
      item.mesh = mesh;
      item.lod = lod;
      item.helper = helper;
      item.outlined = outlined;
      item.clippingPlanes = clippingPlanes;
      item.worldMatrix = worldMatrix;
      item.worldVersion = worldVersion;
      item.worldSphere = worldSphere;
    }
    return item;
  }
}

type MutableWorldFrameRenderable = {
  -readonly [K in keyof WorldFrameRenderable]: WorldFrameRenderable[K];
};

function computeViewDepth(worldMatrix: Float32Array, viewMatrix: Float32Array): number {
  const world = requiredMat4Array(worldMatrix, 'Render3D item world matrix');
  const view = requiredMat4Array(viewMatrix, 'Render3D view matrix');
  const x = world[12];
  const y = world[13];
  const z = world[14];
  const viewZ = view[2] * x + view[6] * y + view[10] * z + view[14];
  return -viewZ;
}

function transformSphere(sphere: BoundingSphere, matrix: Float32Array, target: MutableBoundingSphere): BoundingSphere {
  const x = sphere.center[0];
  const y = sphere.center[1];
  const z = sphere.center[2];
  const scaleX = Math.hypot(matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0);
  const scaleY = Math.hypot(matrix[4] ?? 0, matrix[5] ?? 1, matrix[6] ?? 0);
  const scaleZ = Math.hypot(matrix[8] ?? 0, matrix[9] ?? 0, matrix[10] ?? 1);
  target.center[0] = (matrix[0] ?? 1) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
  target.center[1] = (matrix[1] ?? 0) * x + (matrix[5] ?? 1) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
  target.center[2] = (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 1) * z + (matrix[14] ?? 0);
  target.radius = sphere.radius * Math.max(scaleX, scaleY, scaleZ);
  return target;
}

function sameAffineLinearTransform(a: Float32Array, b: Float32Array): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
    && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[7] === b[7]
    && a[8] === b[8] && a[9] === b[9] && a[10] === b[10] && a[11] === b[11]
    && a[15] === b[15];
}

function mixShadowRevision(hash: number, value: number): number {
  hash ^= value >>> 0;
  return Math.imul(hash, 0x01000193) >>> 0;
}
