import type { EnginePlugin } from '@haiyue/engine/core';
import type { RenderPipelineEntryOptions } from '@haiyue/engine/extension-authoring';
import { Tilemap2DComponent } from './Tilemap2DComponent';
import { Tilemap2DRenderSystem, type Tilemap2DRenderSystemOptions } from './Tilemap2DRenderSystem';
import {
  EXTENSIONS_PLUGIN_VERSION,
  installEditorRenderSystem,
  removeSystem,
  type EditorViewportContributionContext,
} from '../plugins/pluginUtils';

export interface TilemapPluginOptions {
  system?: Tilemap2DRenderSystemOptions;
  render?: RenderPipelineEntryOptions | false | null;
}

export function createTilemapPlugin(options: TilemapPluginOptions = {}): EnginePlugin {
  let system: Tilemap2DRenderSystem | null = null;
  return {
    name: '@haiyue/extensions/tilemap',
    version: EXTENSIONS_PLUGIN_VERSION,
    installEngine(context) {
      context.registerComponent({ type: 'Tilemap2DComponent', component: Tilemap2DComponent });
    },
    installScene(context) {
      context.registerComponent({ type: 'Tilemap2DComponent', component: Tilemap2DComponent });
      system = new Tilemap2DRenderSystem(context.engine, context.cameraEntity, options.system);
      context.addSystem(system, options.render ?? { pass: 'shared', loadOp: system.loadOp });
    },
    uninstallScene(context) {
      removeSystem(context, system);
      system = null;
    },
    installEditor(context) {
      context.registerContribution({ components: [{
        type: 'Tilemap2DComponent',
        create: () => new Tilemap2DComponent({ columns: 10, rows: 20, cellWidth: 32, cellHeight: 32, gap: 1 }),
        inspector: Tilemap2DComponent.editor,
        serialize(component: Tilemap2DComponent) {
          return {
            type: 'Tilemap2DComponent',
            columns: component.columns,
            rows: component.rows,
            cellWidth: component.cellWidth,
            cellHeight: component.cellHeight,
            originX: component.originX,
            originY: component.originY,
            gap: component.gap,
            cells: Array.from(component.cells),
            palette: component.palette.map(color => [...color]),
          };
        },
        deserialize(data: unknown) {
          const value = data as ConstructorParameters<typeof Tilemap2DComponent>[0] & { type?: unknown };
          return value.type === 'Tilemap2DComponent' ? new Tilemap2DComponent(value) : null;
        },
        clone: (component: Tilemap2DComponent) => component.clone(),
        installViewport(viewport: EditorViewportContributionContext) {
          return installEditorRenderSystem(viewport, Tilemap2DRenderSystem, () => new Tilemap2DRenderSystem(viewport.engine, viewport.camera2DEntity, options.system));
        },
        runtimeExport: {
          imports: [{ from: '@haiyue/extensions/tilemap', names: ['Tilemap2DComponent', 'Tilemap2DRenderSystem'] }],
          systems: ['Tilemap2DRenderSystem'],
          deserializeExpression: 'new Tilemap2DComponent(data)',
          installSystems: `  const tilemapCamera = findCamera2DEntity(world);
  if (tilemapCamera && hasComponentType(world, Tilemap2DComponent)) {
    applyViewportSettingsToCamera2D(tilemapCamera, scene.globals);
    addRenderSystem(new Tilemap2DRenderSystem(engine, tilemapCamera, { loadOp: 'load', priority: 2 }), { pass: 'shared', loadOp: 'load' });
  }`,
          has2D: true,
        },
      }] });
    },
  };
}
