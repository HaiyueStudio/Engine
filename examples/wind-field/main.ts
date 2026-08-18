import { HaiyueEngine } from '@haiyue/engine';
import { World } from '@haiyue/engine/ecs';
import { RenderPipeline } from '@haiyue/engine/experimental/renderer';
import { WindFieldRenderer } from './WindFieldRenderer';
import { loadWindData } from './windData';

async function main(): Promise<void> {
  const canvas = requiredElement<HTMLCanvasElement>('#canvas');
  const status = requiredElement<HTMLOutputElement>('#status');
  const result = requiredElement<HTMLOutputElement>('#result');
  const pauseButton = requiredElement<HTMLButtonElement>('#pause');
  const resetButton = requiredElement<HTMLButtonElement>('#reset');
  const speedInput = requiredElement<HTMLInputElement>('#speed');
  const speedValue = requiredElement<HTMLOutputElement>('#speed-value');
  const trailInput = requiredElement<HTMLInputElement>('#trail');
  const trailValue = requiredElement<HTMLOutputElement>('#trail-value');
  const fpsOutput = requiredElement<HTMLOutputElement>('#fps');
  const abortController = new AbortController();
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.008, g: 0.024, b: 0.042, a: 1 },
    alphaMode: 'opaque',
    renderProfile: 'batched',
  });
  const world = new World('Wind field visualization');
  const pipeline = new RenderPipeline(engine);
  let renderer: WindFieldRenderer | null = null;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    abortController.abort();
    engine.stop();
    pipeline.clear();
    renderer?.destroy();
    renderer = null;
    engine.destroy();
  };
  window.addEventListener('beforeunload', dispose, { once: true });

  try {
    status.textContent = '正在初始化 WebGPU…';
    await engine.init();
    status.textContent = '正在载入 2016-11-20 风场数据…';
    const windData = await loadWindData(abortController.signal);
    if (disposed) return;

    renderer = new WindFieldRenderer(engine, windData);
    renderer.install(pipeline);
    const activeRenderer = renderer;

    const syncControls = (): void => {
      activeRenderer.settings.speedFactor = Number(speedInput.value);
      activeRenderer.settings.fadeOpacity = Number(trailInput.value);
      speedValue.textContent = `${activeRenderer.settings.speedFactor.toFixed(2)}×`;
      trailValue.textContent = `${(activeRenderer.settings.fadeOpacity * 100).toFixed(1)}%`;
      pauseButton.textContent = activeRenderer.settings.running ? '暂停' : '继续';
      pauseButton.dataset.active = String(!activeRenderer.settings.running);
    };
    speedInput.value = String(activeRenderer.settings.speedFactor);
    trailInput.value = String(activeRenderer.settings.fadeOpacity);
    speedInput.addEventListener('input', syncControls);
    trailInput.addEventListener('input', syncControls);
    pauseButton.addEventListener('click', () => {
      activeRenderer.settings.running = !activeRenderer.settings.running;
      syncControls();
    });
    resetButton.addEventListener('click', () => activeRenderer.reset());
    window.addEventListener('keydown', event => {
      if (event.code !== 'Space' || event.repeat) return;
      event.preventDefault();
      activeRenderer.settings.running = !activeRenderer.settings.running;
      syncControls();
    });
    syncControls();

    let frameCount = 0;
    let fpsFrames = 0;
    let fpsStartedAt = performance.now();
    engine.on('update', ({ detail: { time, delta } }) => {
      pipeline.execute(world, time, delta, { label: 'WindField.pipeline' });
    });
    engine.on('after-update', ({ detail: { time } }) => {
      frameCount++;
      fpsFrames++;
      const elapsed = time - fpsStartedAt;
      if (elapsed >= 500) {
        fpsOutput.textContent = `${Math.round(fpsFrames * 1000 / elapsed)} FPS`;
        fpsFrames = 0;
        fpsStartedAt = time;
      }
      if (frameCount === 12) {
        document.body.dataset.renderStatus = 'passed';
        result.dataset.status = 'passed';
        result.textContent = JSON.stringify({
          status: 'passed',
          date: windData.metadata.date,
          particles: activeRenderer.particleCount,
          gpuSimulation: true,
          trailPingPong: true,
        });
      }
    });
    status.textContent = `${windData.metadata.date.replace('T', ' ').replace('Z', ' UTC')} · ${activeRenderer.particleCount.toLocaleString()} 个 GPU 粒子`;
    engine.run();
  } catch (error) {
    dispose();
    if (abortController.signal.aborted && error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  }
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

void main().catch(error => {
  const result = document.querySelector<HTMLOutputElement>('#result');
  const status = document.querySelector<HTMLOutputElement>('#status');
  const message = error instanceof Error ? error.message : String(error);
  if (status) status.textContent = `启动失败：${message}`;
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({ status: 'failed', error: message });
  }
  const compatibility = HaiyueEngine.webGpuCompatibility.classifyError(error);
  if (compatibility) {
    HaiyueEngine.webGpuCompatibility.renderPage(document.body, compatibility, {
      productName: 'Haiyue Wind Field',
    });
  } else {
    console.error(error);
  }
});
