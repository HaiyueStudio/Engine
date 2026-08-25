import { parseAnimation } from '/__repo/animation-spec/dist/index.js';
import { createDeformableMesh2DFormatRegistry } from '/__repo/animation-spec/dist/deformable2d.js';
import { Animation2DComponent, Animation2DExtensionRegistry, Animation2DRenderSystem, Animation2DSystem } from '/__repo/extensions/dist/animation.js';
import { createDeformableMesh2DRuntimeExtension } from '/__repo/extensions/dist/deformable-animation.js';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '/__repo/engine/dist/index.js';
import { getEngineDiagnosticsSnapshot } from '/__repo/engine/dist/diagnostics.js';

const resultNode = document.querySelector('#result');
const progressNode = document.querySelector('#progress');
const errors = [];

void run().then(result => {
  resultNode.dataset.status = 'passed';
  resultNode.textContent = JSON.stringify({ status: 'passed', ...result });
  progressNode.textContent = 'complete';
}).catch(error => {
  resultNode.dataset.status = 'failed';
  resultNode.textContent = JSON.stringify({ status: 'failed', error: error instanceof Error ? error.stack ?? error.message : String(error), errors });
  progressNode.textContent = 'failed';
});

async function run() {
  const memorySamples = [];
  await sampleMemory(memorySamples, 'baseline');
  const loadStarted = performance.now();
  const response = await fetch('./model.hya', { cache: 'no-store' });
  if (!response.ok) throw new Error(`model.hya returned HTTP ${response.status}.`);
  const hyaBytes = await response.arrayBuffer();
  const networkCompleteAt = performance.now();
  const parseStarted = performance.now();
  const animation = parseAnimation(hyaBytes, { extensions: createDeformableMesh2DFormatRegistry() });
  const parseMs = performance.now() - parseStarted;

  const canvas = document.querySelector('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 5 / 255, g: 8 / 255, b: 23 / 255, a: 1 },
    devicePixelRatio: 1,
    timestampQuery: true,
    renderProfile: 'simple',
    diagnostics: { enabled: true },
  });
  await engine.init();
  engine.device.addEventListener('uncapturederror', event => errors.push(event.error?.message ?? String(event.error)));
  engine.device.pushErrorScope('validation');
  const adapterInfo = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).then(adapter => adapter?.requestAdapterInfo?.()).catch(() => null);

  const camera = new Entity('G07 camera').addComponent(new Camera2D({ width: 719, height: 746, designWidth: 719, designHeight: 746, viewportMode: 'fit' }));
  const scene = engine.createScene({
    name: 'G07 neutral playback', camera: { type: '2d', entity: camera },
    view: { clearColor: { r: 5 / 255, g: 8 / 255, b: 23 / 255, a: 1 } },
    render3D: false, render2D: false, gui: false, pipelineLabel: 'G07Deformable2D.render',
  });
  const extensions = new Animation2DExtensionRegistry();
  let runtimeStatus = { state: 'loading', drawableCount: 0 };
  const unregister = extensions.register(createDeformableMesh2DRuntimeExtension({ onStatus(status) { runtimeStatus = status; if (status.error) errors.push(status.error); } }));
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager }), false);
  const renderer = new Animation2DRenderSystem(engine, camera, { loadOp: 'clear', maxMaskTargets: 16 });
  scene.addSystem(renderer);
  const player = new Animation2DComponent(animation, { autoplay: true, loop: true, runtimeExtensions: extensions });
  scene.add(new Entity('G07 generated HYA').addComponent(new Transform2D()).addComponent(player));
  engine.switchScene(scene);

  const frames = [];
  let frameCount = 0;
  let readyAt = 0;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  engine.on('after-update', () => {
    frameCount++;
    const snapshot = getEngineDiagnosticsSnapshot(engine);
    if (runtimeStatus.state === 'ready' && readyAt === 0 && renderer.stats.visualCount > 0) readyAt = performance.now();
    if (readyAt > 0) {
      frames.push(snapshot);
      if (frames.length % 20 === 0) void sampleMemory(memorySamples, `frame-${frames.length}`);
      if (frames.length >= 132) resolveDone();
    }
  });
  engine.run();
  await Promise.race([done, timeout(60_000, 'HYA runtime did not produce 132 measured frames.')]);
  await engine.device.queue.onSubmittedWorkDone();
  await sampleMemory(memorySamples, 'steady-complete');

  const warmStarted = performance.now();
  player.pause();
  player.seek(0);
  player.play();
  await nextFrame(engine);
  await engine.device.queue.onSubmittedWorkDone();
  const warmFirstFrameMs = performance.now() - warmStarted;
  const validationError = await engine.device.popErrorScope();
  if (validationError) errors.push(validationError.message);
  if (runtimeStatus.state !== 'ready' || renderer.stats.visualCount < 1) errors.push(`Runtime ended in ${runtimeStatus.state} with ${renderer.stats.visualCount} visuals.`);

  const measuredFrames = frames.slice(12, 132);
  const updateRender = measuredFrames.map(snapshot => sumCpu(snapshot.frame.cpuMs));
  const uploadBytes = measuredFrames.reduce((sum, snapshot) => sum + snapshot.frame.counters.bufferUploadBytes, 0);
  const peakEstimatedBytes = Math.max(...frames.map(snapshot => peakGpuBytes(snapshot)));
  const gpuQueueCompletion = [];
  for (let sample = 0; sample < 8; sample++) {
    await nextFrame(engine);
    const started = performance.now();
    await engine.device.queue.onSubmittedWorkDone();
    gpuQueueCompletion.push(performance.now() - started);
  }
  const beforeDestroy = getEngineDiagnosticsSnapshot(engine);
  const runtimeSummary = { state: runtimeStatus.state, drawableCount: runtimeStatus.drawableCount };
  const rendererSummary = { ...renderer.stats };
  unregister();
  engine.destroy();
  await Promise.resolve();
  const afterDestroy = getEngineDiagnosticsSnapshot(engine);
  const resourceEntries = performance.getEntriesByType('resource').map(entry => ({ name: new URL(entry.name).pathname, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, duration: entry.duration }));
  const forbidden = resourceEntries.filter(entry => /(?:live2dcubismcore|\.moc3|\.model3\.json|\.motion3\.json|\.exp3\.json|\.physics3\.json|\.pose3\.json)/iu.test(entry.name));
  if (forbidden.length) errors.push(`Neutral playback requested forbidden Cubism resources: ${forbidden.map(item => item.name).join(', ')}`);
  if (errors.length) throw new Error(errors.join('; '));
  return {
    suite: 'm05-g07-neutral-hya-webgpu',
    hyaBytes: hyaBytes.byteLength,
    network: { requestToBodyMs: networkCompleteAt - loadStarted, entries: resourceEntries },
    parseMs,
    coldFirstFrameMs: readyAt - loadStarted,
    warmFirstFrameMs,
    steady: {
      frameCount: measuredFrames.length,
      cpuUpdateRenderP50Ms: percentile(updateRender, 0.5),
      cpuUpdateRenderP95Ms: percentile(updateRender, 0.95),
      uploadBytes,
      gpuFrameP50Ms: percentile(measuredFrames.map(frame => frame.frame.gpuMs).filter(Number.isFinite), 0.5),
      gpuFrameP95Ms: percentile(measuredFrames.map(frame => frame.frame.gpuMs).filter(Number.isFinite), 0.95),
      gpuQueueCompletionP50Ms: percentile(gpuQueueCompletion, 0.5),
      gpuQueueCompletionP95Ms: percentile(gpuQueueCompletion, 0.95),
      gpuQueueCompletionSamples: gpuQueueCompletion.length,
    },
    gpuMemory: { estimatedBytes: beforeDestroy.gpuResources.totals.estimatedBytes, peakEstimatedBytes },
    peakProcessMemoryBytes: Math.max(...memorySamples.map(sample => sample.bytes)),
    memorySamples,
    runtime: runtimeSummary,
    renderer: rendererSummary,
    adapterInfo,
    cubismRuntimeInBrowser: false,
    forbiddenRequestCount: forbidden.length,
    lifecycle: {
      resourcesBeforeDestroy: beforeDestroy.gpuResources.totals.resources,
      resourcesAfterDestroy: afterDestroy.gpuResources.totals.resources,
      releasedOwnerResiduals: afterDestroy.gpuResources.releasedOwnerResiduals,
      ownersAfterDestroy: afterDestroy.gpuResources.ownerCount,
      cachesAfterDestroy: afterDestroy.gpuResources.cacheCount,
    },
    errors,
  };
}

function nextFrame(engine) { return new Promise(resolve => engine.once('after-update', resolve)); }
function timeout(ms, message) { return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)); }
function sumCpu(cpu) { return cpu.update + cpu.collect + cpu.cull + cpu.sort + cpu['batch-build'] + cpu.upload + cpu.record + cpu.submit; }
function peakGpuBytes(snapshot) { return Math.max(snapshot.gpuResources.totals.estimatedBytes, ...Object.values(snapshot.gpuResources.byType).map(type => type?.peakEstimatedBytes ?? 0)); }
function percentile(values, fraction) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]; }
async function sampleMemory(target, label) {
  let bytes = performance.memory?.usedJSHeapSize ?? 0;
  if (typeof performance.measureUserAgentSpecificMemory === 'function') {
    try { bytes = (await performance.measureUserAgentSpecificMemory()).bytes; } catch { /* supported fallback is recorded below */ }
  }
  target.push({ label, bytes, source: typeof performance.measureUserAgentSpecificMemory === 'function' ? 'measureUserAgentSpecificMemory-or-heap-fallback' : 'usedJSHeapSize' });
}
