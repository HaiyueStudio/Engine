import { RealRendererGpuTimestampProbe } from './real-renderer-gpu-timestamp.mjs';

const progress = document.querySelector('#progress');
const result = document.querySelector('#result');
const frame = document.querySelector('iframe');
const scenario = new URLSearchParams(location.search).get('scenario');
const check = (condition, message) => { if (!condition) throw Error(message); };
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
async function until(label, predicate, ms = 20_000) {
  progress.textContent = label;
  const end = performance.now() + ms;
  do {
    if (predicate()) return;
    await nextFrame();
  } while (performance.now() < end);
  throw Error('Timeout: ' + label);
}

async function capture() {
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.src = './index.html';
  await loaded;
  const browser = frame.contentWindow;
  const canvas = browser.document.getElementById('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:1280px;height:720px;z-index:2';
  const app = (await browser.eval("import('./bundle.js')")).app;
  await app.ready;
  const moduleToReadyMs = performance.timeOrigin + performance.now() - app.moduleStartedAt;
  const { engine, session, mixer } = app;
  const device = engine.device;
  const gpuErrors = [];
  device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
  const adapter = engine.adapter.info;
  check(!adapter.isFallbackAdapter && !/swiftshader|software|llvmpipe|lavapipe|warp/iu.test(JSON.stringify(adapter)), 'Native GPU required.');
  await mixer.unlock();
  const boot = performance.now();
  await session.start('cold-production');
  await nextFrame();
  await device.queue.onSubmittedWorkDone();
  const submittedAt = performance.now();
  const submittedEpoch = performance.timeOrigin + submittedAt;
  const cold = { navigationToSubmittedMs: submittedEpoch - browser.performance.timeOrigin,
    moduleToSubmittedMs: submittedEpoch - app.moduleStartedAt,
    moduleToReadyMs, startToSubmittedMs: submittedAt - boot };
  check(Object.values(cold).every(time => Number.isFinite(time) && time >= 0), 'Invalid cold timing clock.');
  await until('1280x720 native output', () => canvas.width === 1280 && canvas.height === 720);
  const sampleCanvas = browser.document.createElement('canvas');
  sampleCanvas.width = 32; sampleCanvas.height = 18;
  const pixels = sampleCanvas.getContext('2d', { willReadFrequently: true });
  const read = new Promise(resolve => engine.once('after-update', () => {
    const start = performance.now();
    pixels.drawImage(canvas, 0, 0, 32, 18);
    resolve({ sampled: pixels.getImageData(0, 0, 32, 18).data, durationMs: performance.now() - start });
  }));
  session.setPreferences({ highContrast: true });
  const { sampled, durationMs } = await read;
  const uniqueColors = new Set();
  for (let i = 0; i < sampled.length; i += 4) uniqueColors.add(sampled.slice(i, i + 4).join());
  check(uniqueColors.size >= 4, 'The submitted stage was blank.');
  const coldPixels = { durationMs, colors: uniqueColors.size };
  session.setPreferences({ highContrast: false, textSpeed: 0 });
  const node = id => until(id, () => session.view.reading?.nodeId === id && !session.view.transitioning);
  await node('arrival/watch');
  const geometry = session.view.slots.map(slot => slot.assetId);
  const expected = (scenario === 'static-dialogue' || scenario === 'continuous-background') ? ['harbor'] : ['harbor','keeper','traveler','rain'];
  check(expected.join() === geometry.join(), 'Scenario stage did not contain its required layers.');

  const switches = [];
  const visits = [];
  if (scenario === 'prepared-shot-switch' || scenario === 'repeated-resume') {
    check(session.advance(), 'Unable to reach the branch for the multi-slot workload.');
    await node('arrival/fork');
    await session.save('slot-1', { thumbnail: true });
    check(session.choose('stay'), 'Failed to select the first route.');
    await node('pier/story');
    await session.save('slot-2');
    const screenSave = Object.values(browser.localStorage).some(value => /data:image\/webp;/.test(value));
    check(screenSave, 'The native save did not contain an encoded thumbnail.');
  }
  for (let i = 0; i < 60; i++) await nextFrame();
  const rows = [];
  let currentTime = performance.now();
  const settleFrameAudit = () => {
    const now = performance.now();
    const snapshot = app.diagnostics();
    const resources = session.view.resources;
    rows.push({ frame: snapshot.frame.frame, intervalMs: now - currentTime, cpuMs: snapshot.frame.cpuMs,
      gpuResources: snapshot.gpuResources.totals, releasedOwnerResiduals: snapshot.gpuResources.releasedOwnerResiduals,
      cachedRegions: resources?.cachedRegions ?? 0, retainedColorBytes: resources?.retainedColorBytes ?? 0,
      workingColorBytes: resources?.workingColorBytes ?? 0, retiringColorBytes: resources?.workingRetiringColorBytes ?? 0 });
    currentTime = now;
  };
  let finished = false;
  const collect = async () => {
    while (rows.length < 180 || !finished) { await nextFrame(); settleFrameAudit(); }
  };
  const exercise = async (collectTiming = true) => {
    if (scenario === 'prepared-shot-switch') {
      for (let step = 0; step < 12; step++) {
        await session.load('slot-1');
        await node('arrival/fork');
        check(session.choose(step % 2 ? 'leave' : 'stay'), 'Invalid route choice.');
        await node('pier/story');
        const t = performance.now();
        check(session.advance(), 'Unable to start the one-shot effect.');
        await node(step % 2 ? 'ending/tide' : 'ending/lantern');
        if (collectTiming) switches.push(performance.now() - t);
      }
    } else if (scenario === 'repeated-resume') {
      for (let step = 0; step < 24; step++) {
        const id = step % 2 ? 'slot-2' : 'slot-1', from = performance.now();
        check(await session.load(id), 'Unable to reopen ' + id);
        await node(step % 2 ? 'pier/story' : 'arrival/fork');
        if (collectTiming) visits.push({ id, durationMs: performance.now() - from });
      }
    }
  };
  await Promise.all([collect(), exercise().finally(() => { finished = true; })]);
  const gpuFrames = [];
  if (scenario !== 'static-dialogue') {
    const probe = new RealRendererGpuTimestampProbe(device, { includeCompute: true });
    check(probe.supported, 'Native timestamp-query required for the active scene.');
    const descriptor = Object.getOwnPropertyDescriptor(device, 'createCommandEncoder');
    const original = device.createCommandEncoder;
    const encoderFactory = original.bind(device);
    let armed = false;
    let workDone = false;
    Object.defineProperty(device, 'createCommandEncoder', { configurable: true, value: options => {
      const encoder = encoderFactory(options);
      if (!armed) return encoder;
      const render = encoder.beginRenderPass.bind(encoder);
      const compute = encoder.beginComputePass.bind(encoder);
      Object.defineProperty(encoder, 'beginRenderPass', { configurable: true, value: pass => render(probe.decorateRenderPass(pass)) });
      Object.defineProperty(encoder, 'beginComputePass', { configurable: true, value: (pass = {}) => compute(probe.decorateComputePass(pass)) });
      return encoder;
    } });
    try {
      const sampleGpu = async () => {
        for (let sample = 0; sample < 120 && (gpuFrames.length < 30 || !workDone); sample++) {
          probe.beginFrame();
          armed = true;
          await new Promise(resolve => engine.once('after-update', () => { armed = false; resolve(); }));
          if (!probe.queryCount) continue;
          const encoder = encoderFactory();
          probe.resolve(encoder);
          device.queue.submit([encoder.finish()]);
          const waitStart = performance.now();
          await device.queue.onSubmittedWorkDone();
          const waitMs = performance.now() - waitStart;
          const readStart = performance.now();
          const timing = await probe.readFrame();
          gpuFrames.push({ index: sample, totalMs: timing.totalMs, passes: timing.passes, waitMs, readbackMs: performance.now() - readStart });
        }
      };
      await Promise.all([sampleGpu(), exercise(false).finally(() => { workDone = true; })]);
    } finally {
      if (descriptor) Object.defineProperty(device, 'createCommandEncoder', descriptor);
      else delete device.createCommandEncoder;
      probe.destroy();
    }
    check(gpuFrames.length >= 30, 'Native GPU sample population incomplete.');
  }
  await device.queue.onSubmittedWorkDone();
  const final = app.diagnostics().gpuResources;
  check(rows.length >= 180 && rows.every(row => row.cachedRegions <= 8 && row.retainedColorBytes <= 64 * 1024 * 1024),
    'Region cache budget exceeded.');
  check(!gpuErrors.length && final.releasedOwnerResiduals === 0, 'GPU validation or released owner error: ' + gpuErrors.join());
  await session.dispose();
  await device.queue.onSubmittedWorkDone();
  const retired = app.diagnostics().gpuResources;
  check(retired.releasedOwnerResiduals === 0, 'A released visual novel owner still holds GPU resources.');
  await app.dispose();
  const audioAfterDispose = mixer.stats;
  check(audioAfterDispose.voices === 0 && audioAfterDispose.buffers === 0 && audioAfterDispose.audioNodes === 0, 'Audio residual after disposal.');
  return { scenario, geometry, cold, coldPixels, rows, gpuFrames, switches, visits, final, retired,
    audioAfterDispose, gpuErrors, adapter: { vendor: adapter.vendor, architecture: adapter.architecture } };
}

try { result.textContent = JSON.stringify(await capture()); result.dataset.status = 'passed'; }
catch (error) { result.textContent = JSON.stringify({ scenario, progress: progress.textContent, error: error.stack }); result.dataset.status = 'failed'; }
