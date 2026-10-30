import type { Scene } from '../Scene';
import type { RenderIntegration } from '../../renderer/RenderIntegration';
import type { RenderPipeline } from '../../renderer/RenderPipeline';

interface SceneRenderOwner {
  readonly renderPipeline: RenderPipeline;
  readonly renderIntegration: RenderIntegration;
}

// Accessors borrow the Scene owner. Reading its pipeline must not import scene
// construction, built-in renderers or GUI assembly into a focused consumer.
const owners = new WeakMap<Scene, SceneRenderOwner>();

export function bindSceneRenderOwner(scene: Scene, owner: SceneRenderOwner): void {
  owners.set(scene, owner);
}

/** Experimental scheduler accessor. Import from `@haiyue/engine/experimental`. */
export function getSceneRenderPipeline(scene: Scene): RenderPipeline {
  return owners.get(scene)!.renderPipeline;
}

/** Experimental scheduler accessor. Import from `@haiyue/engine/experimental`. */
export function getSceneRenderIntegration(scene: Scene): RenderIntegration {
  return owners.get(scene)!.renderIntegration;
}
