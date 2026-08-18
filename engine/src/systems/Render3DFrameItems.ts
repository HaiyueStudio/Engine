import type { Mesh3D } from '../components/Mesh3D';
import type { MeshHelper } from '../components/MeshHelper';
import type { BoundingSphere } from '../culling/Frustum';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';
import { requiredItemAt } from '../math/arrayAccess';
import type {
  Render3DHelperItem,
  Render3DRenderItem,
} from './Render3DContracts';
import type { Render3DOpaqueSceneSortKey } from './Render3DFrameState';
import type { ClippingPlanes } from '../components/ClippingPlanes';

/**
 * Sole owner of frame-local render lists and their reusable DTO pools.
 * Collection and submission may mutate list contents, but neither retains
 * references after clearReferences() closes the logical frame.
 */
export class Render3DFrameItems {
  readonly opaqueItems: Render3DRenderItem[] = [];
  readonly transparentItems: Render3DRenderItem[] = [];
  readonly helperItems: Render3DHelperItem[] = [];
  readonly outlineItems: Render3DRenderItem[] = [];
  readonly postItems: Render3DRenderItem[] = [];
  readonly renderItemPool: Render3DRenderItem[] = [];
  readonly helperItemPool: Render3DHelperItem[] = [];

  private _renderItemCursor = 0;
  private _helperItemCursor = 0;

  beginFrame(): void {
    this._renderItemCursor = 0;
    this._helperItemCursor = 0;
  }

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
  ): Render3DRenderItem {
    let item = this.renderItemPool[this._renderItemCursor++];
    if (!item) {
      item = {
        entityId,
        mesh,
        geometry,
        material,
        clippingPlanes,
        worldMatrix,
        viewDepth,
        transparentOrder,
        transparentDepthSort,
        worldSphere,
        lodLevel,
        opaqueSortKey,
        opaqueDepthKey: 0,
      };
      this.renderItemPool.push(item);
      return item;
    }
    item.entityId = entityId;
    item.mesh = mesh;
    item.geometry = geometry;
    item.material = material;
    item.clippingPlanes = clippingPlanes;
    item.worldMatrix = worldMatrix;
    item.viewDepth = viewDepth;
    item.transparentOrder = transparentOrder;
    item.transparentDepthSort = transparentDepthSort;
    item.worldSphere = worldSphere;
    item.lodLevel = lodLevel;
    item.opaqueSortKey = opaqueSortKey;
    item.opaqueDepthKey = 0;
    return item;
  }

  nextHelperItem(
    entityId: number,
    geometry: Geometry3D,
    helper: MeshHelper,
    worldMatrix: Float32Array,
  ): Render3DHelperItem {
    let item = this.helperItemPool[this._helperItemCursor++];
    if (!item) {
      item = { entityId, geometry, helper, worldMatrix };
      this.helperItemPool.push(item);
      return item;
    }
    item.entityId = entityId;
    item.geometry = geometry;
    item.helper = helper;
    item.worldMatrix = worldMatrix;
    return item;
  }

  preparePostItems(): readonly Render3DRenderItem[] {
    const postItems = this.postItems;
    postItems.length = 0;
    for (const item of this.opaqueItems) postItems.push(item);
    for (const item of this.transparentItems) postItems.push(item);
    return postItems;
  }

  clearReferences(): void {
    this.clearLists();
    for (let index = 0; index < this._renderItemCursor; index++) {
      const item = requiredItemAt(
        this.renderItemPool,
        index,
        'Render3D render-item pool',
      );
      item.mesh = null;
      item.geometry = null;
      item.material = null;
      item.clippingPlanes = null;
      item.worldMatrix = null;
      item.viewDepth = 0;
      item.transparentOrder = 0;
      item.transparentDepthSort = false;
      item.worldSphere = null;
      item.lodLevel = -1;
      item.opaqueSortKey = null;
      item.opaqueDepthKey = 0;
    }
    for (let index = 0; index < this._helperItemCursor; index++) {
      const item = requiredItemAt(
        this.helperItemPool,
        index,
        'Render3D helper-item pool',
      );
      item.geometry = null;
      item.helper = null;
      item.worldMatrix = null;
    }
  }

  clearLists(): void {
    this.opaqueItems.length = 0;
    this.transparentItems.length = 0;
    this.helperItems.length = 0;
    this.outlineItems.length = 0;
    this.postItems.length = 0;
  }
}
