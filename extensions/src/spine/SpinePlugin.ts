import type { EnginePlugin } from '@haiyue/engine/core';
import type { RenderPipelineEntryOptions } from '@haiyue/engine/extension-authoring';
import { Spine2DComponent } from './Spine2DComponent';
import { Spine2DRenderSystem, type Spine2DRenderSystemOptions } from './Spine2DRenderSystem';
import {
  EXTENSIONS_PLUGIN_VERSION,
  installEditorRenderSystem,
  removeSystem,
  type EditorViewportContributionContext,
} from '../plugins/pluginUtils';

export interface SpinePluginOptions {
  system?: Spine2DRenderSystemOptions;
  render?: RenderPipelineEntryOptions | false | null;
}

export function createSpinePlugin(options: SpinePluginOptions = {}): EnginePlugin {
  let system: Spine2DRenderSystem | null = null;
  return {
    name: '@haiyue/extensions/spine',
    version: EXTENSIONS_PLUGIN_VERSION,
    installEngine(context) {
      context.registerComponent({ type: 'Spine2DComponent', component: Spine2DComponent });
    },
    installScene(context) {
      context.registerComponent({ type: 'Spine2DComponent', component: Spine2DComponent });
      system = new Spine2DRenderSystem(context.engine, context.cameraEntity, options.system);
      context.addSystem(system, options.render ?? { pass: 'shared', loadOp: system.loadOp });
    },
    uninstallScene(context) {
      removeSystem(context, system);
      system = null;
    },
    installEditor(context) {
      context.registerContribution({ components: [{
        type: 'Spine2DComponent',
        create: () => new Spine2DComponent({ jsonUrl: '', atlasUrl: '', imageUrl: '', scale: 1 }),
        inspector: Spine2DComponent.editor,
        serialize(component: Spine2DComponent) {
          return {
            type: 'Spine2DComponent',
            jsonUrl: component.jsonUrl,
            atlasUrl: component.atlasUrl,
            imageUrl: component.imageUrl,
            imageUrls: { ...component.imageUrls },
            skin: component.skin,
            animation: component.animation,
            loop: component.loop,
            timeScale: component.timeScale,
            scale: component.scale,
            premultipliedAlpha: component.premultipliedAlpha,
          };
        },
        deserialize(data: unknown) {
          const value = data as ConstructorParameters<typeof Spine2DComponent>[0] & { type?: unknown };
          return value.type === 'Spine2DComponent' ? new Spine2DComponent(value) : null;
        },
        clone: (component: Spine2DComponent) => component.clone(),
        installViewport(viewport: EditorViewportContributionContext) {
          return installEditorRenderSystem(viewport, Spine2DRenderSystem, () => new Spine2DRenderSystem(viewport.engine, viewport.camera2DEntity, options.system));
        },
        runtimeExport: {
          imports: [{ from: '@haiyue/extensions/spine', names: ['Spine2DComponent', 'Spine2DRenderSystem'] }],
          systems: ['Spine2DRenderSystem'],
          deserializeExpression: 'new Spine2DComponent(data)',
          installSystems: `  const spineCamera = findCamera2DEntity(world);
  if (spineCamera && hasComponentType(world, Spine2DComponent)) {
    applyViewportSettingsToCamera2D(spineCamera, scene.globals);
    addRenderSystem(new Spine2DRenderSystem(engine, spineCamera, { loadOp: 'load', priority: 3 }), { pass: 'shared', loadOp: 'load' });
  }`,
          has2D: true,
        },
      }] });
    },
  };
}
