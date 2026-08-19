import type { AnimationExtensionComponent } from '../types';

export const DEFORMABLE_MESH_2D_EXTENSION_ID = 'org.haiyue.deformable-mesh-2d@1' as const;
export const DEFORMABLE_MESH_2D_DATA_FORMAT = 'haiyue-deformable-mesh-2d' as const;
export const DEFORMABLE_MESH_2D_DATA_VERSION = 1 as const;

export interface DeformableMesh2DComponent extends AnimationExtensionComponent {
  readonly type: typeof DEFORMABLE_MESH_2D_EXTENSION_ID;
  readonly dataResource: string;
  readonly textures: readonly string[];
}

export type DeformableMesh2DBlendMode = 'normal' | 'additive' | 'multiplicative';

export interface DeformableMesh2DDrawableSource {
  readonly id: string;
  readonly textureIndex: number;
  readonly blendMode: DeformableMesh2DBlendMode;
  readonly culling: boolean;
  readonly masks: readonly string[];
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** Absolute screen-y-down xy values, frame-major. */
  readonly positions: Float32Array;
  readonly opacities: Float32Array;
  readonly renderOrders: Float32Array;
}

export interface DeformableMesh2DDataSource {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly duration: number;
  readonly frameRate: number;
  readonly times: Float32Array;
  readonly drawables: readonly DeformableMesh2DDrawableSource[];
}

export interface ParsedDeformableMesh2DDrawable extends DeformableMesh2DDrawableSource {
  readonly vertexCount: number;
}

export interface ParsedDeformableMesh2DData {
  readonly format: typeof DEFORMABLE_MESH_2D_DATA_FORMAT;
  readonly version: typeof DEFORMABLE_MESH_2D_DATA_VERSION;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly duration: number;
  readonly frameRate: number;
  readonly times: Float32Array;
  readonly drawables: readonly ParsedDeformableMesh2DDrawable[];
  readonly backingBuffer: ArrayBuffer;
}

export interface DeformableMesh2DParseLimits {
  readonly maxInputBytes?: number;
  readonly maxMetadataBytes?: number;
  readonly maxDrawables?: number;
  readonly maxVertices?: number;
  readonly maxFrames?: number;
  readonly maxMaskReferences?: number;
}

