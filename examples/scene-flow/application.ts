import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine/ecs';
import { Mesh2D, Transform2D } from '@haiyue/engine/components';
import { Material2D } from '@haiyue/engine/material';
import { ColorSRGB } from '@haiyue/engine/color';
import { createRect2D } from '@haiyue/engine/geometry';
import { GuiRoot, GuiButton, GuiLabel, type GuiElement } from '@haiyue/engine/gui';
import { createSceneFlow } from '@haiyue/extensions/scene-flow';
import type { SceneFlowProgress } from '@haiyue/extensions/scene-flow';
import type { Scene } from '@haiyue/engine/scene';

/** The browser verifier compiles this exact application against installed tarballs. */
export async function createSceneFlowExample(canvas: HTMLCanvasElement, options: { assetUrl?: string; delayMs?: number } = {}) {
  const startedAt = performance.now();
  const engine = new HaiyueEngine({ canvas, timestampQuery: false, diagnostics: { enabled: true }, clearColor: { r: .02, g: .04, b: .08, a: 1 } });
  await engine.init();
  const readyAt = performance.now();
  const assetUrl = options.assetUrl ?? new URL('./level.json', import.meta.url).href;
  const delayMs = options.delayMs ?? 40;
  let running = 0, peakRunning = 0, loads = 0, releases = 0, createdScenes = 0, disposed = false;
  engine.assetManager!.registerLoader<{ title: string }>({
    type: 'scene-flow-level',
    async load(url, context) {
      running++; loads++; peakRunning = Math.max(peakRunning, running);
      try {
        const response = await fetch(url, { signal: context.signal });
        if (!response.ok) throw Error('Level request failed: ' + response.status);
        const value: unknown = await response.json();
        await new Promise<void>((resolve, reject) => {
          const done = () => { context.signal.removeEventListener('abort', abort); resolve(); };
          const timer = setTimeout(done, delayMs);
          const abort = () => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); reject(context.signal.reason); };
          context.signal.addEventListener('abort', abort, { once: true });
          if (context.signal.aborted) abort();
        });
        if (!value || typeof (value as { title?: unknown }).title !== 'string') throw Error('Invalid level descriptor.');
        if (new URL(url).searchParams.has('fail')) throw Error('Demonstration resource failure.');
        return value as { title: string };
      } finally { running--; }
    },
    dispose() { releases++; },
  });
  // This GUI belongs to the application; transitions only own the underlying level scenes.
  const persistentScene = engine.createScene({ name: 'Persistent loading UI', render3D: false, render2D: false, gui: { loadOp: 'load' } });
  const root = new GuiRoot(); persistentScene.add(new Entity('Persistent UI').addComponent(root));
  const place = (element: GuiElement, x: number, y: number, width: number, height: number) => {
    element.layout = () => { element.rect = { x, y, width, height }; };
  };
  const title = root.add(new GuiLabel({ text: 'SCENE FLOW', fontSize: 26 })); place(title, 24, 20, 500, 40);
  const status = root.add(new GuiLabel({ text: 'Menu', fontSize: 18 })); place(status, 24, 64, 720, 32);
  const progress: SceneFlowProgress[] = [];
  const flow = createSceneFlow({ engine, onProgress: value => {
    progress.push(value);
    if (progress.length > 256) progress.shift();
    status.setText(value.phase === 'preparing' ? `Loading ${value.completed}/${value.total}`
      : value.phase === 'failed' ? 'Load failed. Menu is still available.'
      : value.phase === 'cancelled' ? 'Cancelled. Menu is still available.'
      : value.activeId === 'level' ? 'Level ready' : 'Menu');
  } });
  const makeScene = () => { createdScenes++; return engine.createScene('2d'); };
  const rect = (scene: Pick<Scene, 'world'>, index: number, menu = false) => {
    const entity = new Entity('Tile ' + index);
    entity.addComponent(new Transform2D({ x: menu ? 0 : (index % 8 - 3.5) * 58, y: menu ? 0 : (Math.floor(index / 8) - 1.5) * 58 }));
    entity.addComponent(new Mesh2D(createRect2D({ width: menu ? 480 : 48, height: menu ? 250 : 48 }), new Material2D({ color: new ColorSRGB(menu ? .06 : .08 + index / 100, menu ? .14 : .6, menu ? .25 : .9, 1) })));
    scene.world.addEntity(entity);
  };
  const back = () => flow.transition({ id: 'menu', create: () => { const scene = makeScene(); rect(scene, 0, true); return scene; } });
  const start = (settings: { requests?: number; failIndex?: number; signal?: AbortSignal } = {}) => {
    const count = settings.requests ?? 32;
    return flow.transition({ id: 'level', create: makeScene, ...(settings.signal ? { signal: settings.signal } : {}), assets: Array.from({ length: count }, (_, index) => {
      const url = new URL(assetUrl); url.searchParams.set('resource', String(index)); if (index === settings.failIndex) url.searchParams.set('fail', '1');
      return { url: url.href, type: 'scene-flow-level', assign: (_value: unknown, scene: Pick<Scene, 'world'>) => { if (index < 32) rect(scene, index); } };
    }) });
  };
  const runAction = (action: () => Promise<unknown>) => { void action().catch(error => {
    if (!(error && typeof error === 'object' && 'code' in error && ['E_SCENE_FLOW_ABORTED', 'E_SCENE_FLOW_SUPERSEDED'].includes(String(error.code)))) status.setText('Load failed. Try again.');
  }); };
  const enter = root.add(new GuiButton({ text: 'Start level', onClick: () => runAction(() => start()) })); place(enter, 24, 112, 156, 40);
  const cancel = root.add(new GuiButton({ text: 'Cancel loading', onClick: () => flow.cancel() })); place(cancel, 192, 112, 166, 40);
  const leave = root.add(new GuiButton({ text: 'Return to menu', onClick: () => runAction(back) })); place(leave, 370, 112, 182, 40);
  const fail = root.add(new GuiButton({ text: 'Try failed load', onClick: () => runAction(() => start({ failIndex: 3 })) })); place(fail, 564, 112, 176, 40);
  const updateUi = (event: { detail: { time: number; delta: number } }) => persistentScene.update(event.detail.time, event.detail.delta);
  engine.on('after-update', updateUi);
  await back();
  engine.run();
  const coldStart = { startedAt, readyAt, menuActivatedAt: performance.now(), firstRenderedAt: null as number | null };
  requestAnimationFrame(() => { coldStart.firstRenderedAt = performance.now(); });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    flow.dispose();engine.off('after-update', updateUi);persistentScene.destroy();engine.destroy();
  };
  return { engine, flow, persistentScene, root, statusLabel: status, progress, start, back, dispose, coldStart,
    stats: () => ({ running, peakRunning, loads, releases, createdScenes }) };
}
