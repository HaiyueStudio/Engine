import { Entity, HaiyueEngine } from '@haiyue/engine';
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';
import { createRenderFrameContext, getSceneRenderIntegration, getSceneRenderPipeline } from '@haiyue/engine/experimental';
import { beginRenderCommandPass } from '@haiyue/engine/extension-authoring';
import { GuiButton, GuiRoot } from '@haiyue/engine/gui';
import { RttEngine } from '@haiyue/engine/rtt';
import { createHyaPlayer } from '@haiyue/extensions/hya-player';
import { NarrativeRuntime, connectNarrativeActions } from '@haiyue/extensions/narrative';
import { createSceneFlow } from '@haiyue/extensions/scene-flow';
import { createHyaStage } from 'g03:stage';
import { stageActionHandler } from 'g03:stage-action';
import { catalogue, design, shot } from './assets.mjs';

const [width, height] = (new URLSearchParams(location.search).get('size') ?? '320x200').split('x').map(Number);
const canvas = document.querySelector('#stage'), result = document.querySelector('#result');
canvas.width = width; canvas.height = height;
const black = { r: 0, g: 0, b: 0, a: 1 };
const cases = [], errors = [], profiles = [], slots = new Set();
const calls = { source: 0, resource: 0, released: 0 };
const ceiling = 64 * 1024 * 1024;
const now = () => performance.now();
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
const check = (ok, message) => { if (!ok) throw Error(message); };
const equal = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
const pass = (id, details = {}) => cases.push({ id, ...details });
const dropped = reason => reason == null ? null : String(reason?.message ?? reason);
let engine, active, reference, environment, serial = 0, scoped = false, assets, assetManifest, image, imageBytes, failResource = false, barrier;

const show = (...entries) => ({ op: 'show', presetId: 'shot', slots: entries });
const hide = slotId => ({ op: 'hide', slotId });
const waitFor = (slotId, event) => ({ op: 'wait', kind: 'event', wait: { kind: 'event', slotId, event } });
const transition = (slotId, seconds, decorative) => ({ op: 'transition', slotId, transitionId: 'arrive', seconds, decorative });
const dim = value => Math.round(value);
function rect(bounds, w, h) {
  const scale = Math.min(w / design[0], h / design[1]);
  const offsetX = (w - design[0] * scale) / 2, offsetY = (h - design[1] * scale) / 2;
  const left = dim(offsetX + bounds[0] * scale), top = dim(offsetY + bounds[1] * scale);
  return { x: left, y: top, width: dim(offsetX + (bounds[0] + bounds[2]) * scale) - left,
    height: dim(offsetY + (bounds[1] + bounds[3]) * scale) - top };
}
const boundsOf = ({ target }) => ({ x: 0, y: 0, width: target.width, height: target.height });

function resourceHost() {
  return { async acquire(request) {
    calls.resource++;
    const blocked = barrier;
    blocked?.entered.resolve();
    if (blocked) await blocked.wait.promise;
    if (failResource) throw Error('G03 missing HYA texture');
    const missing = request.asset !== 'tiny' || request.integrity !== image.integrity;
    if (missing) throw Error('Unexpected HYA resource request');
    return { value: imageBytes.slice(), bytes: imageBytes.length, generation: 1, release() { calls.released++; } };
  } };
}
function assetFor(key) {
  const record = assets[key];
  if (!record) throw Error(`G03 source missing: ${key}`);
  return { bytes: new TextEncoder().encode(JSON.stringify(record.source)).length, designSize: record.size, source: record.source,
    playback: record.playback, states: record.states, transitions: record.transitions, parameters: record.parameters,
    host: () => ({ resources: resourceHost() }) };
}

function makeScene(name, useStage) {
  const target = new RttEngine(engine, width, height, black);
  const scene = engine.createScene({ name, render3D: false, render2D: false, gui: { loadOp: 'load' } });
  scene.renderView.target = target.renderTarget;
  scene.renderView.sampleCount = 1;
  const pipeline = getSceneRenderPipeline(scene);
  const region = role => scene.renderView.createRegion({ id: name + ':' + role, bounds: boundsOf({ target }), clearMode: 'on-update', updateMode: 'demand', visible: true });
  const clear = region('clear'), overlay = region('gui');
  pipeline.add({ record(_world, context) {
    const { passEncoder, ownsPass } = beginRenderCommandPass(context);
    if (ownsPass) passEncoder.end();
  } }, { sort: -100, pass: 'isolated', loadOp: 'clear', depth: false, region: clear });
  pipeline.add(scene.guiSystem, { sort: 10000, pass: 'shared', loadOp: 'load', region: overlay });
  const gui = new GuiRoot();
  scene.add(new Entity(name + ' GUI').addComponent(gui));
  let badge;
  const owner = { scene, target, pipeline, clear, overlay, raw: [], recordSubmitMs: 0 };
  const execute = pipeline.execute.bind(pipeline);
  pipeline.execute = (...args) => {
    const start = now();
    try { return owner.gpuProbe ? owner.gpuProbe(execute, args) : execute(...args); }
    finally { owner.recordSubmitMs = now() - start; }
  };
  const updateOverlay = () => {
    const box = rect([143, 65, 13, 13], target.width, target.height);
    if (badge) gui.root.remove(badge);
    badge = gui.add(new GuiButton({ ...box, text: '', pointerFilter: 'none', style: { backgroundColor: '#00ffff', radius: 0 } }));
    owner.badge = badge;
  };
  owner.gui = gui;
  owner.resize = (w, h) => {
    target.resize(w, h); scene.renderView.target = target.renderTarget;
    clear.setBounds(boundsOf(owner)); overlay.setBounds(boundsOf(owner)); updateOverlay();
  };
  if (useStage) owner.stage = createHyaStage({
    scene, designViewport: design, onError: error => errors.push(dropped(error)),
    resolve(key) { return { key, async load(signal) { calls.source++; signal.throwIfAborted(); return assetFor(key); } }; },
  });
  updateOverlay();
  slots.add(owner);
  return owner;
}

function frame(owner, delta = 0, cached = true) {
  const t = now();
  getSceneRenderIntegration(owner.scene).setExecuteOptions({ view: owner.scene.renderView, regionCache: cached });
  for (const entry of owner.raw) {
    if (delta && entry.asset.playback.mode !== 'hold') entry.player.advance({ sequence: ++entry.sequence, deltaSeconds: delta, viewport: entry.viewport, dpr: 1 });
  }
  owner.scene.update(++serial, delta * 1000);
  const recordSubmitMs = owner.recordSubmitMs, updateMs = now() - t - recordSubmitMs;
  const regions = owner.pipeline.getDebugSnapshot().regions;
  check(regions.cachedRegions <= 8 && regions.retainedColorBytes <= ceiling, 'Inherited region cache limit exceeded');
  return { updateMs, recordSubmitMs, regions };
}

async function settle(owner, promise, delta = 0, budgetMs = 12_000) {
  let outcome;
  void promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  const start = now(), stats = [];
  while (!outcome && now() - start < budgetMs) {
    await turn();
    stats.push(frame(owner, delta).regions);
  }
  check(outcome, 'Timed out waiting for an ordered stage handoff');
  if (outcome.error) throw outcome.error;
  return { outcome: outcome.value, stats, wallMs: now() - start };
}

async function manual(owner, specifications) {
  for (const entry of owner.raw.splice(0)) { entry.player.dispose(); entry.region.dispose(); }
  for (const spec of specifications) {
    const bounds = rect(spec.bounds, owner.target.width, owner.target.height);
    const viewport = [bounds.width, bounds.height], asset = assetFor(spec.assetId);
    const region = owner.scene.renderView.createRegion({ id: 'reference:' + (++serial), bounds, visible: false, updateMode: 'demand', clearMode: 'on-update' });
    let player;
    try {
      player = await createHyaPlayer(asset.source, { mode: 'render', scene: owner.scene, region, viewport, dpr: 1,
        host: { capabilities: new Set(asset.source.parts.map(part => part.extension)), resources: resourceHost(), invalidate() {} } });
      const first = { sequence: 1, deltaSeconds: 0, viewport, dpr: 1 };
      const before = now();
      while (!player.advance(first).ready) { check(now() - before < 10_000, 'Reference player first pose timed out'); await turn(); }
      owner.raw.push({ asset, player, viewport, sequence: 1, region });
      region.setVisible(true);
    } catch (error) {
      player?.dispose(); region.dispose(); throw error;
    }
  }
}

async function pixels(owner) {
  const { target } = owner, pitch = Math.ceil(target.width * 4 / 256) * 256;
  const buffer = engine.device.createBuffer({ size: pitch * target.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = engine.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target.colorTexture }, { buffer, bytesPerRow: pitch }, [target.width, target.height]);
    engine.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(buffer.getMappedRange()), bytes = new Uint8Array(target.width * target.height * 4);
    for (let y = 0; y < target.height; y++) bytes.set(raw.subarray(y * pitch, y * pitch + target.width * 4), y * target.width * 4);
    if (target.colorTexture.format.startsWith('bgra')) for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i+2]] = [bytes[i+2], bytes[i]];
    buffer.unmap();
    return bytes;
  } finally { buffer.destroy(); }
}
function maxDiff(a, b) {
  check(a.length === b.length, 'Image sizes differ');
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}
function pixel(owner, image, x, y) {
  const b = rect([x,y,1,1], owner.target.width, owner.target.height);
  const start = (dim(b.y) * owner.target.width + dim(b.x)) * 4;
  return [...image.subarray(start, start + 4)];
}
function dispose(owner) {
  if (!owner || !slots.delete(owner)) return;
  for (const item of owner.raw.splice(0)) { item.player.dispose(); item.region.dispose(); }
  owner.scene.destroy(); // Detaches and disposes the stage through the Scene lifecycle.
  owner.target.destroy();
}

async function gpuSpan(owner, render) {
  if (!engine.timestampQuerySupported) { render(); return null; }
  const device = engine.device;
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
  const out = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    owner.gpuProbe = (execute, [world, time, delta, options]) => {
      const context = createRenderFrameContext(engine, { view: owner.scene.renderView.snapshot(), frameData: options.frameData });
      const encoder = context.encoder;
      try {
        encoder.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex: 0 } }).end();
        execute(world, time, delta, { ...options, context });
        encoder.beginComputePass({ timestampWrites: { querySet, endOfPassWriteIndex: 1 } }).end();
        encoder.resolveQuerySet(querySet, 0, 2, out, 0);
        encoder.copyBufferToBuffer(out, 0, read, 0, 16);
        context.submit();
        return context;
      } catch (error) { context.cancel(); throw error; }
    };
    render();
    await read.mapAsync(GPUMapMode.READ);
    const stamp = new BigUint64Array(read.getMappedRange());
    const elapsed = Number(stamp[1] - stamp[0]) / 1e6;
    read.unmap();
    return elapsed > 0 ? elapsed : null;
  } finally { delete owner.gpuProbe; read.destroy(); out.destroy(); querySet.destroy(); }
}

async function profile(owner, id, strategy, delta) {
  for (let i = 0; i < 6; i++) { await raf(); frame(owner, delta); }
  const samples = [], gpuMs = [], queueWaitMs = [];
  let previous = await raf();
  for (let i = 0; i < 24; i++) {
    const stamp = await raf(), captured = frame(owner, delta);
    samples.push({ intervalMs: stamp - previous, ...captured });
    previous = stamp;
  }
  for (let i = 0; i < 8; i++) {
    gpuMs.push(await gpuSpan(owner, () => frame(owner, delta)));
    frame(owner, delta);
    const started = now();
    await engine.device.queue.onSubmittedWorkDone();
    queueWaitMs.push(now() - started);
  }
  if (id === 'static-dialogue') check(samples.every(item => !item.regions.producerRecords && !item.regions.presentations), 'Static shot did work during steady state');
  else check(samples.some(item => item.regions.producerRecords > 0), 'Animated cohort did no native draw work');
  profiles.push({ id, strategy, warmup: 6, samples, gpuMs, queueWaitMs,
    gpuChannel: engine.timestampQuerySupported ? 'native timestamp span in the same command buffer' : 'timestamp-query unavailable' });
}

async function main() {
  const boot = now();
  engine = new HaiyueEngine({ canvas, msaaSamples: 1, devicePixelRatio: 1, renderProfile: 'simple', timestampQuery: true, clearColor: black, diagnostics: { enabled: true } });
  await engine.init();
  const adapter = engine.adapter.info;
  environment = { userAgent: navigator.userAgent, vendor: adapter.vendor, device: adapter.device, architecture: adapter.architecture,
    description: adapter.description, fallback: adapter.isFallbackAdapter, width, height, dpr: 1, msaa: 1, timestamp: engine.timestampQuerySupported };
  check(!adapter.isFallbackAdapter && !/software|swiftshader/iu.test(adapter.description || adapter.architecture), 'Native WebGPU required');
  engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  engine.device.pushErrorScope('validation');
  scoped = true;
  image = await (await fetch('image.json')).json();
  imageBytes = new Uint8Array(await (await fetch('image.png')).arrayBuffer());
  check(await digest(imageBytes) === image.sha256, 'Fixture texture digest mismatch');
  assets = catalogue(image);
  assetManifest = Object.fromEntries(await Promise.all(Object.entries(assets).map(async ([id, entry]) => {
    const bytes = new TextEncoder().encode(JSON.stringify(entry.source));
    return [id, { bytes: bytes.length, sha256: await digest(bytes), designSize: entry.size, playback: entry.playback }];
  })));
  active = makeScene('stage', true);
  const stage = active.stage;
  let action = 0;
  const run = (cues, reducedMotion = false, signal) => stage.run({ sessionId: 'fixture', actionId: ++action, cues, reducedMotion, signal });
  const start = await settle(active, run([[show(...shot())]]));
  await engine.device.queue.onSubmittedWorkDone();
  const committedAt = now();
  const initial = await pixels(active), firstReadbackMs = now() - committedAt;
  const placement = [pixel(active, initial, 44, 60), pixel(active, initial, 243, 62), pixel(active, initial, 170, 63), pixel(active, initial, 149, 71)];
  const guiQuery = active.scene.guiSystem.entitySet.get(active.scene.world)?.size;
  equal(placement, [[255,0,0,255],[0,0,255,255],[255,255,0,255],[0,255,255,255]], `Layer and overlay order (${JSON.stringify({
    rect: active.badge.rect, root: active.gui.viewport, query: guiQuery, pipeline: active.pipeline.getDebugSnapshot().entries, errors,
  })})`);
  frame(active, 0, false);
  const directPixels = await pixels(active);
  const directDiff = maxDiff(initial, directPixels);
  if (directDiff > 2) {
    const points = [];
    let count = 0;
    for (let i = 0; i < initial.length; i += 4) {
      if (initial.subarray(i, i + 4).some((value, offset) => Math.abs(value - directPixels[i + offset]) > 2)) {
        count++;
        if (points.length < 12) points.push([(i / 4) % width, Math.floor(i / 4 / width), [...initial.subarray(i,i+4)], [...directPixels.subarray(i,i+4)]]);
      }
    }
    throw Error(`Cached and direct rendering differ: max ${directDiff}, ${count} pixels, ${JSON.stringify(points)}`);
  }
  pass('four-slot-native-first-frame-and-gui-overlay', { directDiff, placement, readyWallMs: start.wallMs,
    navigationToFirstGpuCommitMs: committedAt, appToFirstGpuCommitMs: committedAt - boot, firstReadbackMs, sha256: await digest(initial) });

  const beforeSwitch = await pixels(active);
  const blocked = barrier = { entered: Promise.withResolvers(), wait: Promise.withResolvers() };
  // The different source first acquires the same underlying texture. Clear other owners before forcing a miss.
  await settle(active, run([[hide('right')]]));
  const oldWithoutRight = await pixels(active);
  const pending = run([[show(shot('background', 'left', 'right-motion')[2])]]);
  const holdStart = now();
  let entered = false;
  void blocked.entered.promise.then(() => { entered = true; });
  while (!entered && now() - holdStart < 5000) { await turn(); frame(active); }
  check(entered, 'Hidden candidate did not reach async HYA texture');
  check(maxDiff(oldWithoutRight, await pixels(active)) === 0, 'Hidden candidate changed a visible pixel');
  const winner = run([[show(shot()[2])]]);
  const cancelled = pending.then(() => null, dropped);
  barrier = undefined;
  blocked.wait.resolve();
  const switchedAt = await settle(active, winner);
  const switchSubmitted = now();
  await engine.device.queue.onSubmittedWorkDone();
  const switchQueueWaitMs = now() - switchSubmitted;
  check(await cancelled, 'Superseded shot completed');
  check(maxDiff(beforeSwitch, await pixels(active)) <= 2, 'Supersession changed painter order');
  pass('async-first-pose-and-supersession', { firstPoseHidden: true, cancelled: true, finalDiff: maxDiff(beforeSwitch, await pixels(active)),
    switchPrepareWallMs: switchedAt.wallMs, switchQueueWaitMs });

  await settle(active, run([[hide('right')]]));
  const prior = await pixels(active);
  failResource = true;
  const rejected = await settle(active, run([[show(shot()[2])]]).then(() => null, dropped));
  failResource = false;
  check(rejected.outcome && maxDiff(prior, await pixels(active)) === 0, 'Failed HYA resource replaced the committed stage');
  pass('failed-resource-keeps-committed-shot', { error: rejected.outcome, maxPixelDiff: 0 });

  await settle(active, run([[show(...shot('rain','left-motion','right-motion','effect-motion'))]]));
  const runtime = new NarrativeRuntime({ schemaVersion: 1, id: 'native', version: '1', start: 'arrive', variables: {}, nodes: {
    arrive: { type: 'action', name: 'visualNovel.stage', next: 'end' }, end: { type: 'end', ending: 'kept', textKey: 'end' },
  } });
  const connection = connectNarrativeActions(runtime, { 'visualNovel.stage': stageActionHandler(runtime, stage, {
    arrive: [[transition('right', .25, true), waitFor('right', 'actor-ready')]],
  }, () => true) });
  runtime.start('native-events');
  while (stage.waiting?.kind !== 'cues') { await turn(); frame(active); if (connection.error) throw Error(dropped(connection.error)); }
  frame(active, .13);
  check(runtime.view.nodeId === 'arrive' && stage.waiting.events.length === 1, 'Wrong-slot event advanced the story');
  frame(active, .13); await turn();
  equal(runtime.view.ending, 'kept', 'Required event should survive reduced motion');
  const revision = runtime.view.revision;
  frame(active, .05);
  equal(runtime.view.revision, revision, 'Repeated events must be inert');
  connection.dispose(); runtime.dispose();
  pass('actual-hya-event-isolated-by-slot-and-action', { afterWrongSlot: 'arrive', afterTarget: 'kept', completionRevision: revision });

  const accent = shot('background', 'left', 'right', 'effect-motion');
  await settle(active, stage.restore('fixture-restore', accent));
  await settle(active, run([[transition('effect', .2, true)]]), .05);
  const normal = await pixels(active), normalTime = stage.snapshot.at(-1).time;
  await settle(active, stage.restore('fixture-restore', accent));
  await settle(active, run([[transition('effect', .2, true)]], true));
  const reduced = await pixels(active), reducedTime = stage.snapshot.at(-1).time;
  const reducedDiff = maxDiff(normal, reduced);
  check(reducedDiff <= 2 && Math.abs(normalTime - reducedTime) < 1e-6, 'Reduced motion does not land on the authored end pose');
  pass('normal-and-reduced-transition-pixel-parity', { maxPixelDiff: reducedDiff, normalTime, reducedTime,
    normalSha256: await digest(normal), reducedSha256: await digest(reduced) });

  await settle(active, stage.restore('data', shot('background','left','right','effect-data')));
  equal(pixel(active, await pixels(active), 170, 63), [255,255,0,255], 'Default data pose');
  await settle(active, run([[{ op: 'state', slotId: 'effect', stateId: 'hidden' }]]));
  equal(pixel(active, await pixels(active), 170, 63), [0,0,255,255], 'Named state HYA data changed composited opacity');
  pass('named-state-applies-native-hya-data', { stateId: stage.snapshot.at(-1).stateId, binding: 'alpha' });

  const fitted = mode => ({ id: 'fit', assetId: 'wide', order: 1, fit: mode, bounds: [200,16,44,44] });
  await settle(active, stage.restore('fit', [shot()[0], fitted('contain')]));
  const contain = await pixels(active);
  const containTop = pixel(active, contain, 222, 19);
  check(containTop[1] < 200, 'Contain should letterbox its box');
  await settle(active, stage.restore('fit', [shot()[0], fitted('cover')]));
  const cover = await pixels(active);
  equal(pixel(active, cover, 207, 19), [0,255,0,255], 'Cover crops the source stripe at the left');
  equal(pixel(active, cover, 237, 19), [0,255,0,255], 'Cover crops the source stripe at the right');
  await settle(active, stage.restore('fit', [shot()[0], fitted('stretch')]));
  equal(pixel(active, await pixels(active), 206, 19), [255,0,0,255], 'Stretch retains the source stripe');
  active.resize(width + 64, height + 40); frame(active);
  equal(pixel(active, await pixels(active), 206, 19), [255,0,0,255], 'Fit after native target resize');
  active.resize(width, height); frame(active);
  pass('contain-cover-stretch-and-native-resize', { containTop, resized: [width + 64, height + 40] });

  const saved = accent.map((spec, i) => ({ ...spec, ...(i === 3 ? { time: .25, stateId: 'settled' } : {}) }));
  await settle(active, stage.restore('save', saved));
  const savePixels = await pixels(active), measurements = [];
  const peak = { retained: 0, working: 0, retiring: 0, depth: 0 };
  for (let i = 0; i < 12; i++) {
    const prepared = await settle(active, stage.restore('save', saved));
    const submitted = now(); await engine.device.queue.onSubmittedWorkDone();
    const readStarted = now(), restored = await pixels(active);
    const diff = maxDiff(savePixels, restored);
    check(diff <= 2, 'Silent restore changed committed pixels: ' + diff);
    measurements.push({ cycle: i + 1, prepareCpuWallMs: prepared.wallMs, queueWaitMs: readStarted - submitted, verificationReadbackMs: now() - readStarted, diff });
    for (const region of prepared.stats) {
      peak.retained = Math.max(peak.retained, region.retainedColorBytes);
      peak.working = Math.max(peak.working, region.workingColorBytes);
      peak.retiring = Math.max(peak.retiring, region.workingRetiringColorBytes);
      peak.depth = Math.max(peak.depth, region.regionDepthBytes);
    }
  }
  pass('twelve-silent-restores-with-resource-accounting', { measurements, peak, sourceLeases: engine.assetManager.getDebugSnapshot().records.length });

  const profilesToRun = [
    ['static-dialogue', shot(), 0],
    ['continuous-background', shot('rain'), 1 / 60],
    ['two-actors-and-effect', shot('rain', 'left-motion', 'right-motion', 'effect-playing'), 1 / 60],
  ];
  for (const [id, specs, delta] of profilesToRun) {
    await settle(active, stage.restore('cohort', specs));
    await profile(active, id, 'stage', delta);
  }
  dispose(active); active = null;
  await engine.device.queue.onSubmittedWorkDone(); await turn();
  reference = makeScene('reference-bench', false);
  for (const [id, specs, delta] of profilesToRun) {
    await manual(reference, specs);
    if (id === 'static-dialogue') {
      frame(reference);
      const diff = maxDiff(initial, await pixels(reference));
      check(diff <= 2, 'Four-slot pixels differ from manual painter by ' + diff);
      pass('full-image-parity-with-manual-hya-reference', { comparedPixels: width * height, diff });
    }
    await profile(reference, id, 'manual-published-hya', delta);
  }
  pass('same-host-matched-frame-cohorts', { scenarioCount: profiles.length / 2, samplesPerCohort: 24 });
  dispose(reference); reference = null;
  const flow = createSceneFlow({ engine });
  const flowed = makeScene('flow-owned', true);
  await flow.transition({ id: 'stage', create: () => flowed.scene });
  await settle(flowed, flowed.stage.restore('flow', [shot()[0]]));
  const switched = await flow.transition({ id: 'out', create: () => engine.createScene({ render3D: false, render2D: false, gui: false }) });
  check(flowed.scene.state === 'destroyed' && !flowed.stage.snapshot.length && engine.activeScene === switched, 'Scene Flow did not retire the previous stage');
  flow.dispose();
  dispose(flowed);
  pass('scene-flow-retirement', { previousDestroyed: true, currentOwnedByFlow: true });
  await engine.device.queue.onSubmittedWorkDone(); await turn();
  const assetRecords = engine.assetManager.getDebugSnapshot().records.filter(record => record.key.startsWith('visual-novel:'));
  const residuals = getEngineDiagnosticsSnapshot(engine).gpuResources.releasedOwnerResiduals;
  check(!assetRecords.length && residuals === 0, 'Stage teardown left asset or GPU owner residuals');
  const validation = await engine.device.popErrorScope();
  scoped = false;
  if (validation) errors.push(validation.message);
  check(!errors.length, errors.join(' | '));
  pass('scene-exit-releases-assets-and-gpu-owners', { assetRecords: assetRecords.length, residuals, calls });
}

try {
  await main();
  result.textContent = JSON.stringify({ status: 'passed', environment, assetManifest, cases, profiles, errors });
  result.dataset.status = 'passed';
} catch (error) {
  result.textContent = JSON.stringify({ status: 'failed', environment, assetManifest, cases, profiles, errors, error: String(error?.stack ?? error) });
  result.dataset.status = 'failed';
} finally {
  for (const owner of [...slots]) dispose(owner);
  if (scoped) await engine.device.popErrorScope();
  engine?.destroy();
}
