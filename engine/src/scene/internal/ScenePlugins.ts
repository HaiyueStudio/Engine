import { EngineError, EngineErrorCode } from '../../core/EngineError';
import type {
  ComponentRegistration,
  EnginePlugin,
  EnginePluginInstallTracker,
  RegistrationToken,
  ScenePluginContext,
  ScenePluginScene,
} from '../../core/EnginePlugin';
import { EnginePluginHost } from '../../core/EnginePluginHost';
import { EngineRegistryHub } from '../../core/EngineRegistryHub';
import type { IEngine } from '../../core/IEngine';
import { getEngineGPUResourceTracker } from '../../core/EngineDiagnosticsAccess';
import type { SceneSystems } from './SceneSystems';

export class ScenePlugins {
  readonly registries = new EngineRegistryHub();
  readonly pluginHost: EnginePluginHost<ScenePluginContext>;

  constructor(
    private readonly _engine: IEngine,
    private readonly _scene: ScenePluginScene,
    private readonly _systems: SceneSystems,
  ) {
    this.pluginHost = new EnginePluginHost({
      scope: 'scene',
      installHint: 'Check the plugin installScene() implementation and whether this scene has the required render systems.',
      lifecycleHint: 'Check the plugin enableScene() implementation and dependency enabled state.',
      hasDependency: name => this.hasPlugin(name),
      isDependencyEnabled: name => this.isPluginEnabled(name),
      createContext: tracker => this._createContext(tracker),
      gpuResourceTracker: getEngineGPUResourceTracker(_engine),
    });
  }

  install(plugin: EnginePlugin): void { this.pluginHost.installPlugin(plugin); }
  enable(name: string): void { this.pluginHost.enablePlugin(name); }
  disable(name: string): void { this.pluginHost.disablePlugin(name); }
  remove(name: string): void { this.pluginHost.removePlugin(name); }
  destroy(): void { this.pluginHost.clear(); }
  disableAll(): void { this.pluginHost.disableAll(); }
  enableAll(): void { this.pluginHost.enableAll(); }

  hasPlugin(name: string): boolean {
    return this.pluginHost.hasPlugin(name) || isPluginHost(this._engine) && this._engine.hasPlugin(name);
  }

  isPluginEnabled(name: string): boolean {
    return this.pluginHost.isPluginEnabled(name)
      || isPluginEnableHost(this._engine) && this._engine.isPluginEnabled(name);
  }

  registerComponent(registration: ComponentRegistration): void {
    this.registries.registerComponent(registration);
    if (isComponentRegistryHost(this._engine)) this._engine.registerComponent(registration);
  }

  getRegisteredComponent(type: string): ComponentRegistration | undefined {
    return this.registries.getRegisteredComponent(type)
      ?? (isComponentRegistryHost(this._engine) ? this._engine.getRegisteredComponent(type) : undefined);
  }

  private _createContext(tracker: EnginePluginInstallTracker): ScenePluginContext {
    return {
      scope: 'scene',
      engine: this._engine,
      scene: this._scene,
      world: this._scene.world,
      cameraEntity: this._systems.cameraEntity,
      assetManager: this._engine.assetManager,
      rollback: tracker,
      hasPlugin: name => this.hasPlugin(name),
      unregister: () => tracker.unregister(),
      registerComponent: registration => this._registerComponent(registration, tracker),
      addSystem: (system, renderOptions) => {
        this._systems.addSystem(system, renderOptions);
        return tracker.track(() => this._scene.world.removeSystem(system));
      },
      registerMaterialRenderer: registration => {
        const render3D = this._systems.render3DSystem;
        if (!render3D) {
          throw new EngineError(
            EngineErrorCode.PluginInstallFailed,
            'Scene has no Render3DSystem for material renderer registration.',
            {
              hint: 'Create the scene with render3D enabled, or register the material renderer on a Render3DSystem directly.',
              docsPath: 'errors/E_PLUGIN_INSTALL_FAILED',
            },
          );
        }
        render3D.registerMaterialRenderer(registration);
        return tracker.track(() => render3D.unregisterMaterialRenderer(registration.materialType));
      },
      registerAssetLoader: registration => {
        const assets = this._engine.assetManager;
        if (!assets) {
          throw new EngineError(
            EngineErrorCode.PluginInstallFailed,
            'AssetManager is not available.',
            {
              hint: 'Call engine.init() before installing plugins that register asset loaders.',
              docsPath: 'errors/E_PLUGIN_INSTALL_FAILED',
            },
          );
        }
        assets.registerLoader(registration);
        return tracker.track(() => assets.unregisterLoader(registration.type));
      },
    };
  }

  private _registerComponent(
    registration: ComponentRegistration,
    tracker: EnginePluginInstallTracker,
  ): RegistrationToken {
    const previousScene = this.registries.getRegisteredComponent(registration.type);
    const previousEngine = isComponentRegistryHost(this._engine)
      ? this._engine.getRegisteredComponent(registration.type)
      : undefined;
    this.registerComponent(registration);
    return tracker.track(() => {
      if (previousScene) this.registries.registerComponent(previousScene);
      else this.registries.unregisterComponent(registration.type);
      if (isComponentRegistryHost(this._engine)) {
        if (previousEngine) this._engine.registerComponent(previousEngine);
        else this._engine.unregisterComponent?.(registration.type);
      }
    });
  }
}

function isPluginHost(engine: IEngine): engine is IEngine & { hasPlugin(name: string): boolean } {
  return typeof (engine as { hasPlugin?: unknown }).hasPlugin === 'function';
}

function isPluginEnableHost(engine: IEngine): engine is IEngine & { isPluginEnabled(name: string): boolean } {
  return typeof (engine as { isPluginEnabled?: unknown }).isPluginEnabled === 'function';
}

function isComponentRegistryHost(engine: IEngine): engine is IEngine & {
  registerComponent(registration: ComponentRegistration): unknown;
  unregisterComponent?(type: string): unknown;
  getRegisteredComponent(type: string): ComponentRegistration | undefined;
} {
  return typeof (engine as { registerComponent?: unknown }).registerComponent === 'function'
    && typeof (engine as { getRegisteredComponent?: unknown }).getRegisteredComponent === 'function';
}
