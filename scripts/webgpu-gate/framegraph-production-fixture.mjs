import { createProductionScene } from './framegraph-production-scene.mjs';

const node = document.querySelector('#result'), canvas = document.querySelector('#canvas');
let scene, raw, firstFrame, cpuStart, done = false, started = false;
const frames = [], events = [], resources = [];
const recordEvent = type => events.push({ type, time: performance.now(), visible: document.visibilityState, focused: document.hasFocus() });
for (const type of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(type, () => recordEvent(type));
for (const type of ['blur', 'focus', 'pagehide']) window.addEventListener(type, () => recordEvent(type));
window.__productionProbe = {
  get done() { return done; },
  snapshot() { return { ...raw, frames, events, resources, observedAt:new Date().toISOString(), visible:document.visibilityState, focused:document.hasFocus() }; },
  start(config, spec) {
    if (started) throw Error('Capture already started'); started = true;
    void run(config, spec).catch(error => { raw.error = error.stack; raw.status = 'failed'; scene?.engine.stop(); done = true; });
  },
  async finish() {
    if (!done) throw Error('Capture is not complete');
    if (scene) {
      const start = performance.now();
      try { await scene.engine.device.queue.onSubmittedWorkDone(); raw.finalDrainMs = performance.now() - start; }
      finally { scene.dispose(); raw.cleanup = scene.cleanup(); }
    }
    raw.frames = frames; raw.events = events; raw.resources = resources; raw.finishedAt = new Date().toISOString();
    node.textContent = JSON.stringify(raw); node.dataset.status = raw.status;
  },
};
async function run(config, spec) {
  raw = { schemaVersion: 1, contractId: config.contractId, status: 'captured', caseId: spec.id,
    startedAt: new Date().toISOString(), startMs: performance.now(), errors: [],
    measurement: 'engine-rAF-cadence-visible-canvas', gpuTiming: 'not collected', queueWait: 'only loading submissions and final drain; none after readiness during timing',
    frameColumns: ['rafTimeMs', 'cpuStartMs', 'cpuEndMs', 'visible', 'focused'],
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, dpr: devicePixelRatio, innerWidth, innerHeight } };
  const progress=phase=>{raw.phase=phase;document.querySelector('#progress').textContent=`${spec.id}: ${phase}`;};
  window.addEventListener('error',event=>{raw.errors.push(event.message);raw.error=event.error?.stack??event.message;raw.status='failed';scene?.engine.stop();done=true;},{once:true});
  progress('scene-initialization');
  scene = await createProductionScene(canvas, spec);
  const engine = scene.engine, info = engine.adapter.info;
  raw.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter };
  raw.initial = scene.snapshot();
  engine.device.addEventListener('uncapturederror', e => raw.errors.push(e.error.message));
  engine.on('device-lost', () => { raw.errors.push('device-lost'); engine.stop(); done = true; });
  if (config.readiness) {
    raw.sceneInitializedMs = performance.now(); raw.preparation = [];
    progress('loading-frames');
    for (let i=0;i<config.readiness.frames;i++) {
      const row = { start:performance.now(), visible:document.visibilityState, focused:document.hasFocus() }; raw.preparation.push(row);
      await new Promise(resolve => { engine.once('after-update', () => { engine.stop(); row.submitted=performance.now(); resolve(); }); engine.run(); });
      progress(`loading-gpu-completion-${i+1}`);
      await engine.device.queue.onSubmittedWorkDone(); row.completed=performance.now();
    }
    raw.readyMs = performance.now();
  }
  progress('interactive-capture');
  engine.on('update', ({ detail: { time } }) => { cpuStart = performance.now(); scene.update(time - (firstFrame ?? time)); });
  engine.on('after-update', ({ detail: { time } }) => {
    const end = performance.now();
    if (firstFrame === undefined) { firstFrame = time; raw.firstFrameMs = time; raw.firstSubmissionMs = end; }
    frames.push([time, cpuStart, end, document.visibilityState === 'visible' ? 1 : 0, document.hasFocus() ? 1 : 0]);
    const elapsed = time - firstFrame;
    if (resources.length === 0 || elapsed >= config.warmupBoundary.seconds * 1000 && resources.length === 1) resources.push({ time, ...scene.snapshot() });
    if (elapsed >= (config.warmupBoundary.seconds + config.durationSeconds) * 1000) {
      engine.stop(); raw.final = scene.snapshot(); resources.push({ time, ...raw.final }); done = true;
      progress('capture-complete');
    }
  });
  engine.run();
}
