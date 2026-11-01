import { createCameraExample } from './application.js';
void createCameraExample(document.querySelector<HTMLCanvasElement>('canvas')!).then(app => {
  addEventListener('pagehide', app.dispose, { once: true });
  const state = document.querySelector<HTMLElement>('#state')!;
  app.engine.on('after-update', () => { const p = app.controller.state.position; state.textContent = `Camera ${p[0].toFixed(1)}, ${p[1].toFixed(1)} · ${app.character.state.grounded ? 'grounded' : 'air'}`; });
  if (new URLSearchParams(location.search).has('verify')) {
    const ready = () => { if (app.character.state.tick < 90) return; app.engine.off('after-update', ready); const result = document.querySelector<HTMLElement>('#result')!; const passed = app.character.state.grounded && app.stats().activeWorlds === 1; result.textContent = JSON.stringify({ status: passed ? 'passed' : 'failed', state: app.controller.state, stats: app.stats(), qualification: false }); result.dataset.status = passed ? 'passed' : 'failed'; };
    app.engine.on('after-update', ready);
  }
}).catch(error => { document.querySelector<HTMLElement>('#state')!.textContent = String(error); const result = document.querySelector<HTMLElement>('#result')!; result.textContent = JSON.stringify({ status: 'failed', error: String(error) }); result.dataset.status = 'failed'; });
