import { createSceneFlowExample } from './application.js';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
void createSceneFlowExample(canvas).then(async app => {
  window.addEventListener('pagehide', app.dispose, { once: true });
  if (new URLSearchParams(location.search).get('verify') === '1') {
    const errors: string[] = [];
    app.engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    app.engine.device.pushErrorScope('validation');
    const gui = app.persistentScene;
    await app.start();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const levelReady = app.statusLabel.text === 'Level ready';
    await app.back();
    await new Promise(requestAnimationFrame);
    await app.engine.device.queue.onSubmittedWorkDone();
    const error = await app.engine.device.popErrorScope();
    if (error) errors.push(error.message);
    const passed = levelReady && app.flow.progress.activeId === 'menu' && gui.state === 'created'
      && app.engine.assetManager!.size === 0 && app.stats().peakRunning <= 4 && errors.length === 0;
    const result = document.querySelector<HTMLElement>('#result')!;
    result.textContent = JSON.stringify({ status: passed ? 'passed' : 'failed', qualification: false, levelReady, stats: app.stats(), coldStart: app.coldStart, errors });
    result.dataset.status = passed ? 'passed' : 'failed';
  }
}).catch(error => {
  document.querySelector('#error')!.textContent = String(error);
  const result = document.querySelector<HTMLElement>('#result')!;
  result.textContent = JSON.stringify({ status: 'failed', error: String(error) }); result.dataset.status = 'failed';
  console.error(error);
});
