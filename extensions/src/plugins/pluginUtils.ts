import type { EnginePlugin, RenderPipelineEntryOptions, ScenePluginContext, System } from '@haiyue/engine/experimental';
import type { Entity, HaiyueEngine, World } from '@haiyue/engine';

export const EXTENSIONS_PLUGIN_VERSION = '0.1.0';

export interface EditorViewportContributionContext {
  world: World;
  engine: HaiyueEngine;
  camera2DEntity: Entity;
  registerRenderSystem?: (system: System, options?: RenderPipelineEntryOptions) => void;
}

export function removeSystem(context: ScenePluginContext, system: System | null): void {
  if (system) context.world.removeSystem(system);
}

export function installEditorRenderSystem<T extends System & { autoUpdate: boolean; setCameraEntity?(entity: Entity): unknown }>(
  context: EditorViewportContributionContext,
  constructor: new (...args: never[]) => T,
  create: () => T,
): { dispose(): void } {
  let system = context.world.getSystem(constructor) as T | null;
  const created = system === null;
  if (!system) {
    system = create();
    context.world.addSystem(system);
  }
  system.setCameraEntity?.(context.camera2DEntity);
  if (context.registerRenderSystem) {
    system.autoUpdate = false;
    context.registerRenderSystem(system);
  } else {
    system.autoUpdate = true;
  }
  return ownedEditorViewportSystem(context.world, system, created);
}

export function ownedEditorViewportSystem(
  world: World,
  system: System,
  owned: boolean,
): { dispose(): void } {
  return {
    dispose() {
      if (owned && world.hasSystem(system)) world.removeSystem(system);
    },
  };
}

export type { EnginePlugin, RenderPipelineEntryOptions };
