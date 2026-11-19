import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import type { HaiyueEngine, RenderViewTarget } from '@haiyue/engine/core';
import { RttEngine } from '@haiyue/engine/rtt';
import type { Scene } from '@haiyue/engine/scene';
import type { SavePresentation, SavePresentationHost } from './VisualNovelSaveSession';

export interface SaveScene extends Omit<SavePresentation, 'prepare'> {
  readonly scene: Scene;
  active?(active: boolean): void;
}

function animationFrame(signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const cancel = () => { cancelAnimationFrame(frame); reject(signal.reason); };
    const frame = requestAnimationFrame(time => { signal.removeEventListener('abort', cancel); resolve(time); });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** Prepare a fresh scene against an offscreen target with the live view's logical geometry. */
export function createSceneSaveHost(
  engine: HaiyueEngine, construct: (mode: 'play' | 'replay') => SaveScene, nextFrame = animationFrame,
): SavePresentationHost {
  const surfaces = new WeakMap<SavePresentation, {
    readonly config: SaveScene;
    readonly liveTarget: RenderViewTarget;
    releaseTarget(): void;
  }>();
  return {
    create(mode) {
      const config = construct(mode);
      const { scene } = config;
      if (scene.engine !== engine || scene === engine.activeScene || scene.state !== 'created') {
        throw new EngineError(EngineErrorCode.SceneInvalidState, 'Save presentation requires a fresh scene.');
      }
      let scratch: RttEngine | undefined;
      try {
        scene.world.disabled = true;
        const liveTarget = scene.renderView.target;
        const target = scratch = new RttEngine(engine, liveTarget.width, liveTarget.height, scene.renderView.clearColor,
          'Visual novel candidate', null, liveTarget.format);
        const preparationTarget: RenderViewTarget = {
          key: target.key, format: target.format,
          get width() { return target.width; }, get height() { return target.height; },
          get displayWidth() { return liveTarget.displayWidth; }, get displayHeight() { return liveTarget.displayHeight; },
          getOutputView: () => target.getOutputView(),
          getRenderPassDescriptor: options => target.getRenderPassDescriptor(options),
          getRenderPassDescriptorVersion: () => target.getRenderPassDescriptorVersion(),
        };
        scene.renderView.target = preparationTarget;
        const releaseTarget = () => {
          if (scene.renderView.target === preparationTarget) scene.renderView.target = liveTarget;
          scratch?.destroy();
          scratch = undefined;
        };
        const update = (time: number) => {
          if (liveTarget.width !== target.width || liveTarget.height !== target.height) target.resize(liveTarget.width, liveTarget.height);
          const focus = engine.activeScene?.guiSystem?.focus;
          const before = focus?.focused ?? null;
          scene.world.disabled = false;
          try { scene.update(time, 0); }
          finally {
            scene.world.disabled = true;
            focus?.focus(before);
          }
        };
        const surface: SavePresentation = {
          stage: config.stage,
          ...(config.audio ? { audio: config.audio } : {}),
          ...(config.music ? { music: config.music } : {}),
          ...(config.thumbnail ? { thumbnail: () => config.thumbnail!() } : {}),
          mount: reading => config.mount(reading),
          async prepare(stageReady, signal) {
            let ready = false;
            const stage = stageReady.finally(() => { ready = true; });
            void stage.catch(() => {});
            while (!ready) {
              const time = await nextFrame(signal);
              signal.throwIfAborted();
              if (!ready) update(time);
            }
            await stage;
            const time = await nextFrame(signal);
            signal.throwIfAborted();
            update(time);
            await engine.device.queue.onSubmittedWorkDone();
          },
          dispose() { try { releaseTarget(); } finally { config.dispose(); } },
        };
        surfaces.set(surface, { config, liveTarget, releaseTarget });
        return surface;
      } catch (error) {
        scratch?.destroy();
        config.dispose();
        throw error;
      }
    },
    present(next, previous) {
      const nextScene = next && surfaces.get(next), oldScene = previous && surfaces.get(previous);
      const before = engine.activeScene;
      if ((next && !nextScene) || (previous && oldScene?.config.scene !== before)) {
        throw new EngineError(EngineErrorCode.SceneInvalidState, 'Save presentation is detached from its scene host.');
      }
      try {
        if (nextScene) nextScene.config.scene.renderView.target = nextScene.liveTarget;
        engine.switchScene(nextScene ? nextScene.config.scene : null);
        oldScene && oldScene.config.active?.(false);
        nextScene && nextScene.config.active?.(true);
      } catch (error) {
        try {
          engine.switchScene(before);
          nextScene && nextScene.config.active?.(false);
          oldScene && oldScene.config.active?.(true);
        } catch (rollback) {
          throw new EngineError(EngineErrorCode.SceneInvalidState, 'Save presentation could not roll back scene activation.',
            { cause: new AggregateError([error, rollback]) });
        }
        throw error;
      }
      if (nextScene) nextScene.releaseTarget();
    },
  };
}
