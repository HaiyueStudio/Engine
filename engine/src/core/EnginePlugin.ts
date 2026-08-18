import type { AssetLoaderRegistration, AssetManager } from '../assets/AssetManager';
import type { Entity } from '../ecs/Entity';
import type { System } from '../ecs/System';
import type { World } from '../ecs/World';
import type { IEngine } from './IEngine';
import type { Material } from '../material/Material';
import type { MaterialRendererRegistration } from '../renderer/MaterialRendererRegistry';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import { EngineError, EngineErrorCode } from './EngineError';
import type { PluginLifecycleState } from './Lifecycle';
import type { GPUResourceOwner } from './GPUResourceTracker';

export interface ComponentRegistration {
  type: string;
  component: Function;
}

export interface PluginRollbackScope {
  track(cleanup: () => void): RegistrationToken;
  unregister(): void;
}

/** A single, idempotent registration owned by a plugin install transaction. */
export interface RegistrationToken {
  readonly active: boolean;
  unregister(): void;
}

export interface ScenePluginScene {
  readonly engine: IEngine;
  readonly world: World;
  readonly cameraEntity: Entity;
  readonly activeCameraEntity: Entity;
  addSystem(system: System, renderOptions?: RenderPipelineEntryOptions | false | null): ScenePluginScene;
  registerComponent(registration: ComponentRegistration): ScenePluginScene;
}

export interface EnginePluginContext {
  readonly scope: 'engine';
  readonly engine: IEngine;
  readonly assetManager?: AssetManager | undefined;
  readonly rollback: PluginRollbackScope;
  hasPlugin(name: string): boolean;
  unregister(): void;
  registerComponent(registration: ComponentRegistration): RegistrationToken;
  registerAssetLoader<T>(registration: AssetLoaderRegistration<T>): RegistrationToken;
}

export interface ScenePluginContext {
  readonly scope: 'scene';
  readonly engine: IEngine;
  readonly scene: ScenePluginScene;
  readonly world: World;
  readonly cameraEntity: Entity;
  readonly assetManager?: AssetManager | undefined;
  readonly rollback: PluginRollbackScope;
  hasPlugin(name: string): boolean;
  unregister(): void;
  registerComponent(registration: ComponentRegistration): RegistrationToken;
  addSystem(system: System, renderOptions?: RenderPipelineEntryOptions | false | null): RegistrationToken;
  registerMaterialRenderer<M extends Material>(registration: MaterialRendererRegistration<M>): RegistrationToken;
  registerAssetLoader<T>(registration: AssetLoaderRegistration<T>): RegistrationToken;
}

export interface EditorPluginContext<
  ComponentDescriptor = unknown,
  InspectorRenderer = unknown,
  ResourceImporter = unknown,
  StarterKit = unknown,
  Contribution = unknown,
> {
  readonly scope: 'editor';
  readonly rollback: PluginRollbackScope;
  unregister(): void;
  registerComponentDescriptor(descriptor: ComponentDescriptor): RegistrationToken;
  registerContribution(contribution: Contribution): RegistrationToken;
  registerInspectorRenderer(key: string | Function, renderer: InspectorRenderer): RegistrationToken;
  registerResourceImporter(importer: ResourceImporter): RegistrationToken;
  registerStarterKit(kit: StarterKit): RegistrationToken;
}

export interface EnginePlugin {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: string[];
  installEngine?(context: EnginePluginContext): void;
  uninstallEngine?(context: EnginePluginContext): void;
  enableEngine?(context: EnginePluginContext): void;
  disableEngine?(context: EnginePluginContext): void;
  installScene?(context: ScenePluginContext): void;
  uninstallScene?(context: ScenePluginContext): void;
  enableScene?(context: ScenePluginContext): void;
  disableScene?(context: ScenePluginContext): void;
  installEditor?(context: EditorPluginContext): void;
  uninstallEditor?(context: EditorPluginContext): void;
  enableEditor?(context: EditorPluginContext): void;
  disableEditor?(context: EditorPluginContext): void;
}

export type PluginRuntimeContext = EnginePluginContext | ScenePluginContext | EditorPluginContext;

export interface InstalledEnginePlugin<TContext extends PluginRuntimeContext = PluginRuntimeContext> {
  plugin: EnginePlugin;
  context: TContext;
  enabled: boolean;
  state: PluginLifecycleState;
  resourceOwner?: GPUResourceOwner | undefined;
}

export class EnginePluginInstallTracker implements PluginRollbackScope {
  private readonly _tokens: RegistrationToken[] = [];
  private _unregistered = false;

  track(cleanup: () => void): RegistrationToken {
    const token = createRegistrationToken(cleanup);
    if (this._unregistered) {
      token.unregister();
      return token;
    }
    this._tokens.push(token);
    return token;
  }

  unregister(): void {
    if (this._unregistered) return;
    this._unregistered = true;
    let token: RegistrationToken | undefined;
    while ((token = this._tokens.pop())) {
      try {
        token.unregister();
      } catch {
        // Plugin rollback is best-effort; user uninstall hooks should remain the
        // primary place for plugin-specific teardown errors.
      }
    }
  }
}

export function createRegistrationToken(cleanup: () => void): RegistrationToken {
  let active = true;
  return {
    get active() { return active; },
    unregister() {
      if (!active) return;
      active = false;
      cleanup();
    },
  };
}

export function assertPluginDependencies(
  plugin: EnginePlugin,
  hasPlugin: (name: string) => boolean,
): void {
  for (const dependency of plugin.dependencies ?? []) {
    if (!hasPlugin(dependency)) {
      throw new EngineError(
        EngineErrorCode.PluginDependencyMissing,
        `Plugin "${plugin.name}" requires dependency "${dependency}".`,
        {
          hint: 'Install the dependency plugin before installing this plugin.',
          docsPath: 'errors/E_PLUGIN_DEPENDENCY_MISSING',
        },
      );
    }
  }
}
