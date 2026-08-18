import type { TextureAssetOptions } from '../../assets/AssetManager';
import type { SceneCameraDefaults, SceneDefaults } from '../../core/EngineDefaults';
import type { ScenePluginScene } from '../../core/EnginePlugin';
import type { Entity } from '../../ecs/Entity';
import type { GuiSystemOptions } from '../../gui/systems/GuiSystem';
import type { Mesh2DRenderSystemOptions } from '../../systems/Mesh2DRenderSystem';
import type { Render3DSystemOptions } from '../../systems/Render3DSystem';
import type { RenderDepthConvention, RenderSampleCount, RenderViewTarget } from '../../core/RenderView';
import type { ScissorRect, ViewportRect } from '../../core/ViewportRect';

export interface SceneCameraOptions extends SceneCameraDefaults {
  entity?: Entity;
}

export interface SceneRenderViewOptions {
  target?: RenderViewTarget;
  clearColor?: GPUColorDict;
  depthConvention?: RenderDepthConvention;
  sampleCount?: RenderSampleCount;
  viewport?: ViewportRect | null;
  scissor?: ScissorRect | null;
}

export interface SceneOptions {
  name?: string;
  camera?: SceneCameraOptions | Entity;
  render3D?: boolean | Render3DSystemOptions;
  render2D?: boolean | Mesh2DRenderSystemOptions;
  gui?: boolean | GuiSystemOptions;
  pipelineLabel?: string;
  defaults?: Partial<SceneDefaults>;
  /** Per-scene camera/target state. It is snapshotted when the render pipeline records a frame. */
  view?: SceneRenderViewOptions;
}

export type ScenePreset = '3d' | '2d' | 'gui' | 'mixed';
export type SceneCreateOptions = SceneOptions | ScenePreset;
export type SceneAssetRequest<T = unknown> =
  | string
  | {
      key?: string;
      url: string;
      type?: string;
      mimeType?: string;
      alias?: string;
      options?: TextureAssetOptions;
      signal?: AbortSignal;
      assign?: (asset: T, scene: ScenePluginScene) => void;
    };
export type SceneLoadedAssets<T = unknown> = Map<string, T>;
