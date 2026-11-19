import { Entity, HaiyueEngine } from '@haiyue/engine';
import { OwnerSafeAudioMixer } from '@haiyue/engine/audio';
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';
import { getSceneRenderPipeline } from '@haiyue/engine/experimental';
import { beginRenderCommandPass } from '@haiyue/engine/extension-authoring';
import { GuiRoot } from '@haiyue/engine/gui';
import { RttEngine } from '@haiyue/engine/rtt';
import { captureGameSaveThumbnail, GameSaveService, LocalStorageSaveBackend } from '@haiyue/engine/save';
import { createGameAudio } from '@haiyue/extensions/audio';
import { I18n } from '@haiyue/extensions/i18n';
import { GuiReading } from 'g05:reading';
import { createSceneSaveHost } from 'g05:scene';
import { VisualNovelSaveSession } from 'g05:session';
import { createHyaStage } from 'g05:stage';
import { catalogue, design } from '../visual-novel-stage/assets.mjs';
import { story } from './story.mjs';

const [width, height] = design;
const check = (ok, message) => { if (!ok) throw Error(message); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const equal = (a, b, label) => check(JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)),
  label + ': ' + JSON.stringify({ expected: a, actual: b }));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const black = { r: 0, g: 0, b: 0, a: 1 };
const gameId = 'g05-browser';
const stageAssets = catalogue();
const changed = (a, b) => {
  check(a.length === b.length, 'Pixel dimensions differ.');
  let max = 0, count = 0;
  for (let i = 0; i < a.length; i += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(a[i + channel] - b[i + channel]));
    if (delta) count++;
    max = Math.max(max, delta);
  }
  return { max, count, pixels: a.length / 4 };
};
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');

function png(bytes) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(bytes, width, height), 0, 0);
  return captureGameSaveThumbnail(canvas, { mimeType: 'image/png' });
}

async function readPixels(device, target) {
  const pitch = Math.ceil(width * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target.colorTexture }, { buffer, bytesPerRow: pitch }, [width,height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange()), pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) pixels.set(mapped.subarray(y * pitch, y * pitch + width * 4), y * width * 4);
    buffer.unmap();
    if (target.format.startsWith('bgra')) for (let i = 0; i < pixels.length; i += 4) [pixels[i],pixels[i + 2]] = [pixels[i + 2],pixels[i]];
    return pixels;
  } finally { buffer.destroy(); }
}

function rawStorage() {
  return Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
}

async function child(phase) {
  const errors = [], cases = [];
  const canvas = document.querySelector('#stage');
  canvas.width = width; canvas.height = height;
  const engine = new HaiyueEngine({ canvas, devicePixelRatio: 1, msaaSamples: 1,
    renderProfile: 'simple', clearColor: black, diagnostics: { enabled: true } });
  let mixer, context, session, i18n, scoped = false;
  const owners = new Map();
  const call = error => errors.push(String(error?.message ?? error));
  try {
    await engine.init();
    const adapter = engine.adapter.info;
    check(!adapter.isFallbackAdapter && !/software|swiftshader/iu.test(adapter.description || adapter.architecture), 'Native WebGPU required.');
    const environment = { vendor: adapter.vendor, architecture: adapter.architecture, fallback: adapter.isFallbackAdapter };
    engine.device.addEventListener('uncapturederror', event => call(event.error));
    engine.device.pushErrorScope('validation'); scoped = true;
    context = new AudioContext();
    mixer = new OwnerSafeAudioMixer({ context });
    await mixer.unlock();
    i18n = new I18n({ locale: story.defaultLocale, fallbackLocale: story.defaultLocale });
    i18n.register(story.locales[story.defaultLocale]);
    const backend = new LocalStorageSaveBackend({ namespace: 'g05-native' });
    let sequence = 0, calls = 0, rejectActivation = false;
    const host = createSceneSaveHost(engine, () => {
      const no = ++sequence, scene = engine.createScene({ name: 'g05-' + no, render3D: false, render2D: false, gui: { loadOp: 'load' } });
      const fault = rejectActivation;
      const target = new RttEngine(engine, width, height, black);
      scene.renderView.target = target.renderTarget;
      const pipeline = getSceneRenderPipeline(scene);
      const geometry = { x: 0, y: 0, width, height };
      const region = name => scene.renderView.createRegion({ id: name, bounds: geometry, clearMode: 'on-update', updateMode: 'demand', visible: true });
      const clear = region('clear'), overlay = region('gui');
      pipeline.add({ record(_world, ctx) {
        const { passEncoder, ownsPass } = beginRenderCommandPass(ctx); if (ownsPass) passEncoder.end();
      } }, { sort: -100, pass: 'isolated', loadOp: 'clear', depth: false, region: clear });
      pipeline.add(scene.guiSystem, { sort: 10000, pass: 'shared', loadOp: 'load', region: overlay });
      const root = new GuiRoot();
      scene.add(new Entity('Reading interface').addComponent(root));
      const stage = createHyaStage({ scene, designViewport: design, onError: call, resolve(assetId) {
        const value = stageAssets[assetId];
        return { key: assetId, async load(signal) {
          signal.throwIfAborted();
          return { source: value.source, bytes: new TextEncoder().encode(JSON.stringify(value.source)).length,
            designSize: value.size, playback: value.playback };
        } };
      } });
      const audio = createGameAudio({ mixer });
      const bufferId = 'g05-buffer:' + no;
      let gui, track, voice = null;
      const object = { scene, stage, target, pipeline,
        mount(reading) { gui = new GuiReading({ root, gui: scene.guiSystem, playback: reading }); },
        music: {
          snapshot: () => track,
          async prepare(saved) {
            track = saved ?? { assetId: 'music', playing: true, position: .125 };
            const sampleRate = context.sampleRate, sound = context.createBuffer(1, sampleRate, sampleRate);
            const wave = sound.getChannelData(0);
            for (let sample = 0; sample < wave.length; sample++) {
              wave[sample] = Math.sin((sample / sampleRate + (track.position ?? 0)) * 2 * Math.PI * 310) * .125;
            }
            mixer.installBuffer(bufferId, sound);
          },
        },
        active(enabled) {
          if (enabled && fault) throw Error('Fixture activation rejected');
          if (enabled && track.playing) {
            voice = audio.play({ eventId: bufferId, bufferId, owner: bufferId, channel: 'music', bus: 'music', loop: true, startTick: 1 });
            check(voice !== null, 'Music did not start on presentation commit.');
          }
          if (!enabled && voice) { mixer.stopVoice(voice); voice = null; }
        },
        async thumbnail() { return png(await readPixels(engine.device, target)); },
        dispose() {
          gui?.dispose(); stage.dispose(); audio.dispose(); mixer.removeBuffer(bufferId);
          scene.destroy(); target.destroy(); owners.delete(scene);
        },
      };
      owners.set(scene, object);
      return object;
    });
    session = new VisualNovelSaveSession({ story, gameId, backend, manualSlots: ['manual','alternate','legacy'],
      profileStorage: localStorage, i18n, host, onError: call,
      migrations: { 0: old => old.position },
      actions: { award(request) {
        calls++;
        const ledger = JSON.parse(localStorage.getItem('g05:effects') ?? '{}');
        if (!Object.hasOwn(ledger, request.token)) {
          ledger[request.token] = { coins: 1 };
          localStorage.setItem('g05:effects', JSON.stringify(ledger));
        }
        return ledger[request.token];
      } },
    });
    let timestamp = 0;
    const draw = (delta = 0) => engine.updateActiveScene(timestamp += 16, delta);
    const wait = async fn => {
      for (let i = 0; i < 120; i++) { if (fn()) return; await frame(); draw(); }
      throw Error('Native story did not reach the expected boundary.');
    };
    const active = () => owners.get(engine.activeScene);
    const finishFrame = async () => {
      for (let i = 0; i < 3; i++) { draw(); await frame(); }
      await engine.device.queue.onSubmittedWorkDone();
      return readPixels(engine.device, active().target);
    };
    const view = () => ({ text: session.view.text, options: session.view.choices, history: session.history.map(row => row.lineId),
      slots: active().stage.snapshot, music: active().music.snapshot(), voices: mixer.stats.voices });
    let state, pixels;
    if (phase === 'write') {
      await session.start('native-run');
      session.setPreferences({ textSpeed: 0, highContrast: true });
      await wait(() => session.view?.lineId === 'intro');
      await session.save('alternate');
      draw(120);
      check(session.advance(), 'Choice did not open.');
      pixels = await finishFrame();
      state = view();
      check(state.slots.length === 4 && state.slots.some(slot => slot.time > 0) && state.voices === 1, 'Missing animated HYA or Web Audio.');
      await session.save('manual', { thumbnail: true, name: '港湾选择' });
      const record = await backend.read(gameId, 'manual');
      check(record?.thumbnail?.width === width && record.thumbnail.height === height, 'Committed frame thumbnail missing.');
      const legacy = new GameSaveService({ backend, gameId, dataVersion: 0 });
      await legacy.save({ saveId: 'legacy', name: 'Legacy', data: { position: record.data },
        metadata: record.metadata });
      await legacy.dispose();
      localStorage.setItem('g05-native:game-save:' + gameId + ':legacy', '{');
      cases.push({ id: 'persistent-multi-slot-and-real-thumbnail', thumbnailChars: record.thumbnail.dataUrl.length,
        slots: (await session.listSlots()).map(row => [row.id, row.status]) });
    } else {
      check((await session.listSlots()).some(row => row.status === 'unreadable'), 'Corrupt slot was not carried through reload.');
      check(await session.continueLatest(), 'Fresh application could not continue.');
      pixels = await finishFrame();
      state = view();
      check(state.text === '请选择航线。' && state.music.position === .125 && state.voices === 1 && session.view.preferences.highContrast,
        'Continue did not restore the full read/audio state.');
      cases.push({ id: 'fresh-document-local-storage-continue', timeOrigin: performance.timeOrigin, ...state });
      const first = engine.activeScene;
      for (let i = 0; i < 3; i++) {
        check(await session.load('manual'), 'Repeated load failed.');
        const diff = changed(pixels, await finishFrame());
        check(diff.max <= 2, 'Repeated restore changed the frame: ' + JSON.stringify(diff));
      }
      check(first.state === 'destroyed' && owners.size === 1, 'Repeated restore retained old scenes.');
      cases.push({ id: 'repeated-silent-restore-and-retirement', rounds: 3, logicalSlots: state.slots.length, liveScenes: owners.size });
      const prior = engine.activeScene;
      rejectActivation = true;
      let failure;
      try { await session.load('manual'); } catch (error) { failure = error; }
      rejectActivation = false;
      check(failure?.message === 'Fixture activation rejected' && engine.activeScene === prior &&
        prior.state === 'active' && owners.size === 1 && mixer.stats.voices === 1, 'Failed native activation did not restore the previous scene and audio.');
      const rolledBack = changed(pixels, await finishFrame());
      check(rolledBack.max <= 2, 'The failed native load changed the previous frame.');
      cases.push({ id: 'activation-failure-rolls-back-picture-and-audio', ...rolledBack, liveScenes: owners.size, voices: mixer.stats.voices });
      for (const [id, choice, expected] of [['chapter','left','leftEnd'],['cg','right','rightEnd']]) {
        check(await session.load('manual') && session.choose(choice), 'Could not replay authored route from the saved choice.');
        await wait(() => session.view.lineId === expected);
        await session.flush();
        check(session.listReplays().includes(id), 'Unlock did not survive the slot restore.');
      }
      const ledger = JSON.parse(localStorage.getItem('g05:effects'));
      check(Object.keys(ledger).length === 1 && calls === 2, 'Durable token did not deduplicate branch rewards.');
      await finishFrame();
      const before = rawStorage(), original = engine.activeScene, held = view();
      const beforeReplay = await readPixels(engine.device, active().target);
      await session.startReplay('chapter');
      check(session.advance() && !session.choose('right') && session.choose('left'), 'Isolated chapter navigation failed.');
      await wait(() => session.view.lineId === 'leftEnd');
      check(!session.advance() && calls === 2, 'Replay advanced past its end or called the live action handler.');
      check(session.endReplay(), 'Could not return from completed chapter replay.');
      await session.startReplay('cg');
      check(session.advance() && session.endReplay(), 'Could not return midway through CG replay.');
      check(engine.activeScene === original, 'Replay replaced the original session.');
      equal(before, rawStorage(), 'Replay wrote profile, original slots, or rewards');
      equal(held, view(), 'Replay changed the original stage, story or music');
      const returned = changed(beforeReplay, await finishFrame());
      check(returned.max <= 2, 'Return from replay changed visible pixels.');
      cases.push({ id: 'chapter-and-cg-replay-isolation', unlocks: session.listReplays(), rewardCommits: 1, handlerCalls: calls, returned });
    }
    const image = png(pixels);
    await session.dispose();
    await engine.device.queue.onSubmittedWorkDone();
    const diagnostics = getEngineDiagnosticsSnapshot(engine).gpuResources;
    const sources = engine.assetManager.getDebugSnapshot().records.filter(record => record.key.startsWith('visual-novel:')).length;
    check(!owners.size && !sources && !mixer.stats.voices && diagnostics.releasedOwnerResiduals === 0, 'Scene, asset, audio or GPU owner remained after teardown.');
    const validation = await engine.device.popErrorScope(); scoped = false;
    if (validation) call(validation);
    check(!errors.length, errors.join(' | '));
    cases.push({ id: phase + '-resource-cleanup', scenes: owners.size, sources, voices: mixer.stats.voices, gpuResiduals: diagnostics.releasedOwnerResiduals });
    return { environment, cases, state, pixels, image: image.dataUrl.split(',')[1], imageSha256: await digest(pixels),
      timeOrigin: performance.timeOrigin, errors };
  } finally {
    await session?.dispose();
    i18n?.dispose(); mixer?.dispose();
    await context?.close();
    if (scoped) await engine.device.popErrorScope();
    engine.destroy();
  }
}

async function outer() {
  const result = document.querySelector('#result'), childPage = document.querySelector('iframe');
  const phases = [];
  addEventListener('message', event => {
    if (event.source !== childPage.contentWindow || event.origin !== location.origin || !event.data?.g05) return;
    try {
      if (event.data.error) throw Error(event.data.error);
      phases.push(event.data.receipt);
      if (phases.length === 1) {
        childPage.src = 'child.html?phase=read';
        return;
      }
      const [before, after] = phases;
      check(before.timeOrigin !== after.timeOrigin, 'The same document was reused.');
      equal(before.state, after.state, 'Saved and restored state differ');
      const difference = changed(before.pixels, after.pixels);
      check(difference.max <= 2, 'Fresh document pixels differ: ' + JSON.stringify(difference));
      result.textContent = JSON.stringify({ status: 'passed', environment: after.environment,
        cases: [...before.cases, ...after.cases, { id: 'full-image-restart-comparison', ...difference }],
        images: { 'saved-choice': before.image, 'restored-choice': after.image },
        hashes: { saved: before.imageSha256, restored: after.imageSha256 }, errors: [...before.errors, ...after.errors] });
      result.dataset.status = 'passed';
    } catch (error) {
      result.textContent = JSON.stringify({ status: 'failed', cases: phases.flatMap(item => item.cases), error: String(error?.stack ?? error) });
      result.dataset.status = 'failed';
    }
  });
  childPage.src = 'child.html?phase=write';
}

if (window.parent === window) await outer();
else {
  try { window.parent.postMessage({ g05: true, receipt: await child(new URL(location.href).searchParams.get('phase')) }, location.origin); }
  catch (error) { window.parent.postMessage({ g05: true, error: String(error?.stack ?? error) }, location.origin); }
}
