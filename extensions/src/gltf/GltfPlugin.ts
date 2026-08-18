import type { EnginePlugin } from '@haiyue/engine/core';
import { GltfModelComponent, type GltfModelComponentOptions } from './GltfModelComponent';
import { GltfModelSystem, type GltfModelSystemOptions } from './GltfModelSystem';
import {
  EXTENSIONS_PLUGIN_VERSION,
  ownedEditorViewportSystem,
  removeSystem,
  type EditorViewportContributionContext,
} from '../plugins/pluginUtils';

export interface GltfPluginOptions {
  system?: GltfModelSystemOptions;
}

export function createGltfPlugin(options: GltfPluginOptions = {}): EnginePlugin {
  let system: GltfModelSystem | null = null;
  return {
    name: '@haiyue/extensions/gltf',
    version: EXTENSIONS_PLUGIN_VERSION,
    installEngine(context) {
      context.registerComponent({ type: 'GltfModelComponent', component: GltfModelComponent });
    },
    installScene(context) {
      context.registerComponent({ type: 'GltfModelComponent', component: GltfModelComponent });
      system = new GltfModelSystem({
        ...options.system,
        assetManager: options.system?.assetManager ?? context.assetManager ?? null,
      });
      context.addSystem(system, false);
    },
    uninstallScene(context) {
      removeSystem(context, system);
      system = null;
    },
    installEditor(context) {
      context.registerContribution({ components: [{
        type: 'GltfModelComponent',
        create: () => new GltfModelComponent({ src: '', autoLoad: true }),
        inspector: GltfModelComponent.editor,
        serialize(component: GltfModelComponent) {
          return {
            type: 'GltfModelComponent',
            src: component.src,
            scene: component.scene,
            autoLoad: component.autoLoad,
            clearPrevious: component.clearPrevious,
            baseColorFactor: [...component.baseColorFactor],
          };
        },
        deserialize(data: unknown) {
          const value = data as GltfModelComponentOptions & { type?: unknown; scene?: number | null };
          if (value.type !== 'GltfModelComponent') return null;
          return new GltfModelComponent({ ...value, ...(typeof value.scene === 'number' ? { scene: value.scene } : {}) });
        },
        clone: (component: GltfModelComponent) => component.clone(),
        getIgnoredChildren: (component: GltfModelComponent) => component.runtimeRoot ? [component.runtimeRoot] : [],
        collectDependencies(component: GltfModelComponent, dependencyContext: { resolveModelBySrc(src: string): string | null }) {
          const dependency = dependencyContext.resolveModelBySrc(component.src);
          return dependency ? [dependency] : [];
        },
        collectSerializedDependencies(data: unknown, dependencyContext: { resolveModelBySrc(src: string): string | null }) {
          const value = data as { type?: unknown; src?: unknown };
          const dependency = value.type === 'GltfModelComponent' && typeof value.src === 'string'
            ? dependencyContext.resolveModelBySrc(value.src)
            : null;
          return dependency ? [dependency] : [];
        },
        installViewport(viewport: EditorViewportContributionContext) {
          const existing = viewport.world.getSystem(GltfModelSystem);
          const viewportSystem = existing ?? new GltfModelSystem({ priority: 0 });
          if (!existing) viewport.world.addSystem(viewportSystem);
          return ownedEditorViewportSystem(viewport.world, viewportSystem, existing === null);
        },
        runtimeExport: {
          imports: [{ from: '@haiyue/extensions/gltf', names: ['GltfModelComponent', 'GltfModelSystem'] }],
          systems: ['GltfModelSystem'],
          deserializeExpression: 'new GltfModelComponent(data)',
          installSystems: '  if (hasComponentType(world, GltfModelComponent)) world.addSystem(new GltfModelSystem({ priority: 0 }));',
          has3D: true,
        },
      }] });
    },
  };
}
