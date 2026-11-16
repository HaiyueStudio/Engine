import { Entity } from '@haiyue/engine';
import { getSceneRenderPipeline } from '@haiyue/engine/experimental';
import { beginRenderCommandPass } from '@haiyue/engine/extension-authoring';
import { GuiButton, GuiLabel, GuiRoot } from '@haiyue/engine/gui';
import { LocalStorageSaveBackend } from '@haiyue/engine/save';
import { validateNarrativeDefinition } from '@haiyue/extensions/narrative';
import { createGameAudio } from 'g06:audio';
import { ReadingAudio } from 'g06:reader-audio';
import { VisualNovelSaveSession } from 'g06:save';
import { createSceneSaveHost } from 'g06:scene';
import { createHyaStage } from 'g06:stage';
import { GuiReading } from 'g06:reading';

const clearColor = { r: .03, g: .065, b: .10, a: 1 };
const assetKinds = new Set(['hya', 'audio', 'image']);
let nextOwner = 0;

export function validateVisualNovelDefinition(definition) {
  if (definition?.schemaVersion !== 1 || !definition.assets || !definition.presets || !definition.cues) {
    throw new TypeError('Expected a compiled visual novel definition.');
  }
  validateNarrativeDefinition(definition.narrative);
  for (const asset of Object.values(definition.assets)) {
    if (!assetKinds.has(asset.kind) || typeof asset.path !== 'string' || !asset.path || /[\\:]/u.test(asset.path) ||
        asset.path.startsWith('/') || asset.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new TypeError('Expected a project-relative asset path.');
    }
  }
  return definition;
}

export function createVisualNovel(options) {
  const { engine, i18n, story, mixer, assetRoot, onError } = options;
  const definition = validateVisualNovelDefinition(story.definition);
  const owner = 'visual-novel:' + ++nextOwner;
  const resolveAsset = (id, kind) => {
    const asset = Object.hasOwn(definition.assets, id) && definition.assets[id];
    if (!asset || asset.kind !== kind) throw new Error('Missing ' + kind + ' asset: ' + id);
    return new URL(asset.path, assetRoot);
  };
  async function bytes(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Asset request failed: ' + url.pathname + ' (' + response.status + ')');
    return response.arrayBuffer();
  }
  async function loadAudio(id, signal) {
    const url = resolveAsset(id, 'audio'), bufferId = owner + ':' + id;
    const lease = await engine.assetManager.load(bufferId, async request => {
      const source = await bytes(url, request);
      request.throwIfAborted();
      await mixer.decodeAndInstall(bufferId, source);
      if (request.aborted) { mixer.removeBuffer(bufferId); request.throwIfAborted(); }
      return bufferId;
    }, id => mixer.removeBuffer(id), { signal });
    return { bufferId: lease.value, release: lease.release };
  }
  const surfaces = new WeakMap();
  let serial = 0;
  const host = createSceneSaveHost(engine, () => {
    const scene = engine.createScene({ render3D: false, render2D: false, clearColor, gui: { loadOp: 'load' } });
    const surfaceId = owner + ':scene:' + ++serial;
    const pipeline = getSceneRenderPipeline(scene);
    const bounds = scene.renderView.snapshot();
    const box = { x: 0, y: 0, width: bounds.displayWidth, height: bounds.displayHeight };
    const clear = scene.renderView.createRegion({ id: 'background-clear', bounds: box, updateMode: 'demand', clearMode: 'on-update', visible: true });
    const overlay = scene.renderView.createRegion({ id: 'dialogue-overlay', bounds: box, updateMode: 'demand', clearMode: 'on-update', visible: true });
    pipeline.add({ record(_world, ctx) {
      const { passEncoder, ownsPass } = beginRenderCommandPass(ctx);
      if (ownsPass) passEncoder.end();
    } }, { sort: -100, pass: 'isolated', loadOp: 'clear', depth: false, region: clear });
    pipeline.add(scene.guiSystem, { sort: 10_000, pass: 'shared', loadOp: 'load', region: overlay });
    const root = new GuiRoot();
    scene.add(new Entity('Visual novel dialogue').addComponent(root));
    const stage = createHyaStage({
      scene, onError,
      resolve(id) {
        const key = resolveAsset(id, 'hya');
        return { key: key.href, async load(signal) {
          const input = await bytes(key, signal);
          const source = JSON.parse(new TextDecoder().decode(input));
          const core = source.parts.find(part => part.extension === 'org.haiyue.animation-core@1').document;
          const motion = source.parts.find(part => part.extension === 'org.haiyue.animation-state-machine@2');
          const playback = motion?.document.stateMachines[0]?.layers[0]?.states[0]?.motion?.playback;
          return { source, designSize: [core.canvas.width, core.canvas.height], bytes: input.byteLength,
            playback: playback ? { mode: playback === 'loop' ? 'loop' : 'once', duration: core.duration } : { mode: 'hold' } };
        } };
      },
    });
    const gameAudio = createGameAudio({ mixer });
    const audio = new ReadingAudio({ gameAudio, resolve: loadAudio, duckFactor: .36, onError });
    let gui, track, music, voice = null, trackEvent = 0;
    const resize = () => {
      const size = scene.renderView.snapshot();
      const next = { x: 0, y: 0, width: size.displayWidth, height: size.displayHeight };
      clear.setBounds(next); overlay.setBounds(next);
      gui?.setInsets({ left: 12, right: 12, top: Math.floor(size.displayHeight * .40), bottom: 12 });
    };
    engine.on('resize', resize);
    surfaces.set(scene, { stage, pipeline });
    return {
      scene, stage, audio,
      mount(reading) {
        gui = new GuiReading({ root, gui: scene.guiSystem, playback: reading,
          document: globalThis.document,
          theme: { panel: '#152632f2', text: '#ecf0db', accent: '#ffd692', button: '#294550', border: '#547175' } });
        // The wrapped choice labels already render the captions.
        const layout = gui.panel.layout.bind(gui.panel);
        gui.panel.layout = bounds => {
          layout(bounds);
          if (reading.view.kind !== 'choice') return;
          for (const child of gui.panel.children) for (const option of child.children) {
            if (option instanceof GuiButton && option.text && option.children.some(label => label instanceof GuiLabel)) option.setText('');
          }
        };
        resize();
      },
      music: {
        snapshot: () => track,
        async prepare(saved, signal) {
          track = saved ?? (options.music ? { assetId: options.music, playing: true } : undefined);
          if (track?.playing) music = await loadAudio(track.assetId, signal);
        },
      },
      active(enabled) {
        if (!enabled && voice) { audio.setMusicVoice(null); mixer.stopVoice(voice); voice = null; }
        if (enabled && music && !voice) {
          voice = gameAudio.play({ eventId: surfaceId + ':' + ++trackEvent, bufferId: music.bufferId, owner: surfaceId,
            channel: 'music', bus: 'music', volume: .58, loop: true, startTick: trackEvent });
          audio.setMusicVoice(voice);
        }
      },
      dispose() {
        engine.off('resize', resize);
        gui?.dispose(); audio.dispose(); gameAudio.dispose(); music?.release(); stage.dispose(); scene.destroy();
      },
    };
  });
  const session = new VisualNovelSaveSession({ story, i18n, host,
    gameId: definition.narrative.id, manualSlots: options.manualSlots ?? ['slot-1', 'slot-2'],
    profileStorage: options.storage, backend: new LocalStorageSaveBackend({ storage: options.storage, namespace: 'haiyue-visual-novel' }),
    onError });
  const tick = event => session.tick(event.detail.delta);
  engine.on('update', tick);
  return Object.freeze({
    get view() {
      const current = surfaces.get(engine.activeScene);
      return { reading: session.view, history: session.history, replayId: session.replayId, transitioning: session.transitioning,
        slots: current?.stage.snapshot ?? [], audio: mixer.stats, resources: current?.pipeline.getDebugSnapshot().regions ?? null };
    },
    start: (id, initial) => session.start(id, initial),
    advance: () => session.advance(),
    choose: id => session.choose(id),
    setPreferences: patch => session.setPreferences(patch),
    replayVoice: key => {
      const entry = session.history.find(row => row.key === key);
      return entry ? session.replayVoice(entry) : Promise.resolve(false);
    },
    save: (slot, request) => session.save(slot, request),
    load: slot => session.load(slot),
    continueLatest: () => session.continueLatest(),
    listReplays: () => session.listReplays(),
    startReplay: id => session.startReplay(id),
    endReplay: () => session.endReplay(),
    subscribe: callback => session.subscribe(callback),
    dispose() { engine.off('update', tick); return session.dispose(); },
  });
}
