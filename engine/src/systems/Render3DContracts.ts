import type { Entity } from '../ecs/Entity';
import type { Mesh3D } from '../components/Mesh3D';
import type { MeshHelper } from '../components/MeshHelper';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';
import type { MaterialRendererRegistry } from '../renderer/MaterialRendererRegistry';
import type { BoundingSphere } from '../culling/Frustum';
import type { ScissorRect, ViewportRect } from '../core/ViewportRect';
import type { RenderProfileName } from '../core/RenderProfile';
import type { Render3DOpaqueSceneSortKey } from './Render3DFrameState';
import type { MirrorViewPlannerOptions } from './MirrorViewPlanner';
import type { ClippingPlanes } from '../components/ClippingPlanes';

/** Public construction policy for the 3-D render orchestrator. */
export interface Render3DSystemOptions {
  clearColor?: { r: number; g: number; b: number; a: number };
  reverseZ?: boolean;
  msaaSamples?: 1 | 4;
  viewport?: ViewportRect | null;
  scissor?: ScissorRect | null;
  loadOp?: 'clear' | 'load';
  renderProfile?: RenderProfileName;
  transparentSort?: boolean;
  materialRenderers?: MaterialRendererRegistry;
  registerDefaultMaterialRenderers?: boolean | DefaultMaterialRendererOptions;
  spatialCullingThreshold?: number;
  spatialLeafSize?: number;
  planarMirrorPlanner?: MirrorViewPlannerOptions;
  priority?: number;
}

/** Selects which built-in material adapters are installed into a registry. */
export interface DefaultMaterialRendererOptions {
  basic?: boolean;
  pbr?: boolean;
  depth?: boolean;
  normal?: boolean;
  volume?: boolean;
  planarMirror?: boolean;
}

/** Mutable pooled DTO shared by extraction, sorting, batching, and submission. */
export interface Render3DRenderItem {
  entityId: number;
  mesh: Mesh3D | null;
  geometry: Geometry3D | null;
  material: Material | null;
  clippingPlanes: ClippingPlanes | null;
  worldMatrix: Float32Array | null;
  viewDepth: number;
  transparentOrder: number;
  transparentDepthSort: boolean;
  worldSphere: BoundingSphere | null;
  lodLevel: number;
  opaqueSortKey: Render3DOpaqueSceneSortKey | null;
  opaqueDepthKey: number;
}

/** Cached policy returned by the material registry during scene collection. */
export interface TransparentMaterialInfo {
  transparent: boolean;
  order: number;
  depthSort: boolean;
  rendererKey: number;
}

/** Mutable pooled helper-render DTO. */
export interface Render3DHelperItem {
  entityId: number;
  geometry: Geometry3D | null;
  helper: MeshHelper | null;
  worldMatrix: Float32Array | null;
}

export type Render3DEntitySet = ReadonlySet<Entity>;
