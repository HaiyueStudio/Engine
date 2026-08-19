import { parseAnimation } from '@haiyue/animation-spec';
import { createDeformableMesh2DFormatRegistry } from '@haiyue/animation-spec/deformable2d';
import { Animation2DComponent, Animation2DExtensionRegistry, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { createDeformableMesh2DRuntimeExtension, type DeformableMesh2DRuntimeStatus } from '@haiyue/extensions/deformable-animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';

const WIDTH = 512;
const HEIGHT = 512;

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const response = await fetch('./assets/mascot.hya');
  if (!response.ok) throw new Error(`HYA request failed with HTTP ${response.status}.`);
  const hyaBytes = await response.arrayBuffer();
  const animation = parseAnimation(hyaBytes, { extensions: createDeformableMesh2DFormatRegistry() });
  const engine = new HaiyueEngine({ canvas, clearColor: { r: 0.015, g: 0.025, b: 0.065, a: 1 } });
  await engine.init();
  const errors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraEntity = new Entity('Live2D HYA camera').addComponent(new Camera2D({ width: WIDTH, height: HEIGHT, designWidth: WIDTH, designHeight: HEIGHT, viewportMode: 'fit' }));
  const scene = engine.createScene({
    name: 'Live2D to HYA offline conversion', camera: { type: '2d', entity: cameraEntity }, render3D: false, render2D: false, gui: false, pipelineLabel: 'Live2DHya.render',
  });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  const renderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 4 });
  scene.addSystem(renderer);

  const runtimeExtensions = new Animation2DExtensionRegistry();
  let runtimeStatus: DeformableMesh2DRuntimeStatus = { state: 'loading', drawableCount: 0 };
  runtimeExtensions.register(createDeformableMesh2DRuntimeExtension({ onStatus(status) {
    runtimeStatus = status;
    query<HTMLElement>('#runtime-state').textContent = status.state;
    query<HTMLElement>('#drawable-count').textContent = String(status.drawableCount);
    if (status.error) {
      errors.push(status.error);
      document.body.dataset.renderStatus = 'failed';
      const result = query<HTMLElement>('#result');
      result.dataset.status = 'failed';
      result.textContent = JSON.stringify({ status: 'failed', errors, runtime: status });
    }
  } }));
  const player = new Animation2DComponent(animation, { autoplay: true, loop: true, runtimeExtensions });
  scene.add(new Entity('Converted Cubism model').addComponent(new Transform2D()).addComponent(player));
  query<HTMLElement>('#hya-size').textContent = formatBytes(hyaBytes.byteLength);
  query<HTMLElement>('#frame-count').textContent = String(Math.round(animation.duration * (animation.frameRate ?? 60)) + 1);
  bindTransport(player, animation.duration);

  engine.switchScene(scene);
  engine.run();
  let frameCount = 0;
  let validationFinished = false;
  engine.on('after-update', () => {
    frameCount++;
    query<HTMLInputElement>('#timeline').value = String(player.currentTime);
    query<HTMLElement>('#time').textContent = `${player.currentTime.toFixed(2)}s`;
    if (!validationFinished && runtimeStatus.state === 'ready' && frameCount >= 12) {
      validationFinished = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scoped = await engine.device.popErrorScope();
    if (scoped) errors.push(scoped.message);
    if (renderer.stats.visualCount < 1) errors.push('No deformable visuals reached Animation2DRenderSystem.');
    if (runtimeStatus.drawableCount !== 1) errors.push(`Expected one drawable, received ${runtimeStatus.drawableCount}.`);
    const status = errors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderStatus = status;
    const result = query<HTMLElement>('#result');
    result.dataset.status = status;
    result.textContent = JSON.stringify({ status, errors, source: animation.source, runtime: runtimeStatus, renderer: renderer.stats, cubismRuntimeInBrowser: false });
  }
}

function bindTransport(player: Animation2DComponent, duration: number): void {
  const button = query<HTMLButtonElement>('#play-pause');
  button.addEventListener('click', () => {
    if (player.playing) player.pause(); else player.play();
    button.textContent = player.playing ? '暂停' : '播放';
  });
  const timeline = query<HTMLInputElement>('#timeline');
  timeline.max = String(duration);
  timeline.addEventListener('input', () => player.seek(Number(timeline.value)));
}

function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`; }
function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new ReferenceError(`Missing example element: ${selector}`);
  return element;
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  const result = document.querySelector<HTMLElement>('#result');
  if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: message }); }
});
