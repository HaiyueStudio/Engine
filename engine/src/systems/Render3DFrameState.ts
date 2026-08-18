import type { Mesh3D } from '../components/Mesh3D';
import type { MeshHelper } from '../components/MeshHelper';
import type { BvhLod3D } from '../components/BvhLod3D';
import type { BoundingSphere, Frustum } from '../culling/Frustum';
import type { Entity } from '../ecs/Entity';
import type { Camera3DFrameData } from '../frame/FrameData';
import type { RenderViewSnapshot } from '../core/RenderView';
import type { Render3DHelperItem, Render3DRenderItem } from './Render3DContracts';
import type { ClippingPlanes } from '../components/ClippingPlanes';

/** Camera-independent opaque batching key prepared once for every selectable LOD resource set. */
export interface Render3DOpaqueSceneSortKey {
  readonly rendererSlot: number;
  readonly materialSlot: number;
  readonly geometrySlot: number;
  readonly entitySlot: number;
}

export interface WorldFrameRenderable {
  readonly entity: Entity;
  readonly entityId: number;
  readonly mesh: Mesh3D;
  readonly lod: BvhLod3D | null;
  readonly helper: MeshHelper | null;
  readonly outlined: boolean;
  readonly clippingPlanes: ClippingPlanes | null;
  readonly worldMatrix: Float32Array;
  readonly worldVersion: number;
  readonly worldSphere: BoundingSphere | null;
}

/** Camera-independent scene extraction owned by one logical World frame. */
export interface WorldFrameState {
  readonly frameId: number;
  readonly phaseRevision: number;
  readonly renderables: readonly WorldFrameRenderable[];
  readonly totalCount: number;
}

/** Camera-dependent products derived from one WorldFrameState. */
export interface RenderViewFrame {
  readonly view: RenderViewSnapshot;
  readonly cameraFrame: Camera3DFrameData;
  readonly frustum: Frustum;
  readonly uniformSlot: number;
  readonly opaqueItems: readonly Render3DRenderItem[];
  readonly transparentItems: readonly Render3DRenderItem[];
  readonly helperItems: readonly Render3DHelperItem[];
  readonly outlineItems: readonly Render3DRenderItem[];
  readonly visibleCount: number;
  readonly totalCount: number;
}
