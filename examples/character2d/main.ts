import { createCharacterExample } from './application.js';
void createCharacterExample(document.querySelector<HTMLCanvasElement>('canvas')!, { shape: new URLSearchParams(location.search).get('shape') === 'circle' ? 'circle' : 'box' }).then(app => {
  addEventListener('pagehide', app.dispose, { once: true });
  for (const [id, value] of [['left', -1], ['right', 1]] as const) {
    const button = document.getElementById(id)!;
    button.addEventListener('pointerdown', event => { button.setPointerCapture(event.pointerId); app.move(value); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => app.move(0));
  }
  document.getElementById('jump')!.onclick = app.jump; document.getElementById('reset')!.onclick = app.reset;
  let paused = false; document.getElementById('pause')!.onclick = () => { paused = !paused; app.pause(paused); document.getElementById('pause')!.textContent = paused ? 'Resume' : 'Pause'; };
  const state = document.getElementById('state')!;
  const update = () => { const s = app.controller.state; state.textContent = `tick ${s.tick} · ${s.grounded ? 'grounded' : s.onWall ? 'wall' : 'air'}${s.stuck ? ' · overlap' : ''}`; };
  app.engine.on('after-update', update);
  if (new URLSearchParams(location.search).get('verify') === '1') {
    const result = document.querySelector<HTMLElement>('#result')!;
    const verify = () => { if (app.controller.state.tick < 90) return; app.engine.off('after-update', verify); const passed = app.controller.state.grounded && !app.controller.state.stuck && app.stats().activeWorlds === 1; result.textContent = JSON.stringify({ status: passed ? 'passed' : 'failed', state: app.controller.state, stats: app.stats(), qualification: false }); result.dataset.status = passed ? 'passed' : 'failed'; };
    app.engine.on('after-update', verify);
  }
}).catch(error => { document.getElementById('state')!.textContent = String(error); const result = document.querySelector<HTMLElement>('#result')!; result.textContent = JSON.stringify({ status: 'failed', error: String(error) }); result.dataset.status = 'failed'; });
