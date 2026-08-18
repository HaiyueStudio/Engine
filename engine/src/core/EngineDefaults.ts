import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import type { Render3DSystemOptions } from '../systems/Render3DSystem';
import type { Mesh2DRenderSystemOptions } from '../systems/Mesh2DRenderSystem';
import type { GuiSystemOptions } from '../gui/systems/GuiSystem';
import type { AssetManagerOptions } from '../assets/AssetManager';
import type { Camera2D } from '../components/Camera2D';
import type { Camera3D } from '../components/Camera3D';
import type { SphericalTransform3D } from '../components/SphericalTransform3D';

export interface EngineClearColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type AssetManagerDefaults = AssetManagerOptions;

export interface SceneCameraDefaults {
  name?: string;
  type?: '3d' | '2d';
  camera3D?: ConstructorParameters<typeof Camera3D>[0];
  camera2D?: ConstructorParameters<typeof Camera2D>[0];
  orbit?: ConstructorParameters<typeof SphericalTransform3D>[0];
}

export interface RenderPipelineDefaults {
  label?: string;
  entry?: RenderPipelineEntryOptions;
}

export interface SceneDefaults {
  clearColor?: EngineClearColor;
  reverseZ?: boolean;
  camera?: SceneCameraDefaults;
  render3D?: Render3DSystemOptions;
  render2D?: Mesh2DRenderSystemOptions;
  gui?: GuiSystemOptions;
  renderPipeline?: RenderPipelineDefaults;
  assetManager?: AssetManagerDefaults;
}

export interface EngineDefaults extends SceneDefaults {
  scene?: SceneDefaults;
}

export type EngineDefaultsInput = Partial<EngineDefaults>;

const DEFAULT_CLEAR_COLOR: EngineClearColor = { r: 0.1, g: 0.1, b: 0.1, a: 1 };

export const DEFAULT_ENGINE_DEFAULTS: EngineDefaults = {
  clearColor: DEFAULT_CLEAR_COLOR,
  reverseZ: false,
  camera: {
    type: '3d',
    camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
    orbit: {
      radius: 6,
      theta: Math.PI * 0.2,
      phi: Math.PI * 0.3,
      target: [0, 0, 0],
    },
  },
  render3D: { loadOp: 'clear' },
  render2D: { loadOp: 'load' },
  gui: { loadOp: 'load' },
  renderPipeline: {
    entry: { pass: 'shared' },
  },
  assetManager: {
    texture: { format: 'rgba8unorm' },
  },
};

export function mergeEngineDefaults(...inputs: Array<EngineDefaultsInput | undefined>): EngineDefaults {
  return mergeSceneDefaults(DEFAULT_ENGINE_DEFAULTS, ...inputs);
}

export function mergeSceneDefaults(...inputs: Array<Partial<SceneDefaults> | undefined>): SceneDefaults {
  const result: SceneDefaults = {};
  for (const input of inputs) {
    if (!input) continue;
    if (input.clearColor) result.clearColor = cloneClearColor(input.clearColor);
    if (input.reverseZ !== undefined) result.reverseZ = input.reverseZ === true;
    if (input.camera) result.camera = mergeCameraOptions(result.camera, input.camera);
    if (input.render3D) result.render3D = { ...(result.render3D ?? {}), ...input.render3D };
    if (input.render2D) result.render2D = { ...(result.render2D ?? {}), ...input.render2D };
    if (input.gui) result.gui = { ...(result.gui ?? {}), ...input.gui };
    if (input.renderPipeline) {
      result.renderPipeline = {
        ...(result.renderPipeline ?? {}),
        ...input.renderPipeline,
        entry: {
          ...(result.renderPipeline?.entry ?? {}),
          ...(input.renderPipeline.entry ?? {}),
        },
      };
    }
    if (input.assetManager) {
      result.assetManager = {
        ...(result.assetManager ?? {}),
        ...input.assetManager,
        texture: {
          ...(result.assetManager?.texture ?? {}),
          ...(input.assetManager.texture ?? {}),
        },
      };
    }
    if ('scene' in input && input.scene) {
      const engineResult = result as EngineDefaults;
      engineResult.scene = mergeSceneDefaults(engineResult.scene, input.scene);
    }
  }
  return result;
}

export function cloneClearColor(color: EngineClearColor): EngineClearColor {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

function mergeCameraOptions(base: SceneCameraDefaults | undefined, input: SceneCameraDefaults): SceneCameraDefaults {
  return {
    ...(base ?? {}),
    ...input,
    camera3D: input.camera3D ? { ...(base?.camera3D ?? {}), ...input.camera3D } : base?.camera3D,
    camera2D: input.camera2D ? { ...(base?.camera2D ?? {}), ...input.camera2D } : base?.camera2D,
    orbit: input.orbit ? { ...(base?.orbit ?? {}), ...input.orbit } : base?.orbit,
  };
}
