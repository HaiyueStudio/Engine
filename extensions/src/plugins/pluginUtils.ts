import type { ScenePluginContext } from '@haiyue/engine/core';
import type { RenderPipelineEntryOptions } from '@haiyue/engine/extension-authoring';
import type { System } from '@haiyue/engine/ecs';
import type { Entity, HaiyueEngine, World } from '@haiyue/engine';

export const EXTENSIONS_PLUGIN_VERSION = '0.1.0';

export interface EditorViewportContributionContext {
  world: World;
  engine: HaiyueEngine;
  camera2DEntity: Entity;
  registerRenderSystem?: (system: System, options?: RenderPipelineEntryOptions) => void;
}

/** The factory owns the system; the scene's addSystem token only detaches it. */
export function installOwnedSceneSystem(
  context: ScenePluginContext,
  system: System,
  renderOptions?: RenderPipelineEntryOptions | false | null,
): void {
  // Register before attachment so a partially failed add also releases resources.
  context.rollback.track(() => system.destroy());
  context.addSystem(system, renderOptions);
}

export function installEditorRenderSystem<T extends System & { autoUpdate: boolean; setCameraEntity?(entity: Entity): unknown }>(
  context: EditorViewportContributionContext,
  constructor: new (...args: never[]) => T,
  create: () => T,
): { dispose(): void } {
  let system = context.world.getSystem(constructor) as T | null;
  const created = system === null;
  if (!system) system = create();
  const previousAutoUpdate = system.autoUpdate;
  try {
    if (created) context.world.addSystem(system);
    system.setCameraEntity?.(context.camera2DEntity);
    if (context.registerRenderSystem) {
      system.autoUpdate = false;
      context.registerRenderSystem(system);
    } else {
      system.autoUpdate = true;
    }
    return ownedEditorViewportSystem(system, created);
  } catch (error) {
    if (created) system.destroy();
    else system.autoUpdate = previousAutoUpdate;
    throw error;
  }
}
export function ownedEditorViewportSystem(
  system: System,
  owned: boolean,
): { dispose(): void } {
  return {
    dispose() {
      if (!owned) return;
      owned = false;
      system.destroy();
    },
  };
}
