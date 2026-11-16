import type { AnimationDocument } from '@haiyue/animation-spec';
import type { HyaStateMachineV2Document } from '@haiyue/animation-spec/hya-production';
import type { HaiyueEngine } from '@haiyue/engine';
import type { AudioMixerStats, OwnerSafeAudioMixer } from '@haiyue/engine/audio';
import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import { Entity } from '@haiyue/engine/ecs';
import { getSceneRenderPipeline } from '@haiyue/engine/experimental';
import { beginRenderCommandPass } from '@haiyue/engine/extension-authoring';
import type { RenderCommandContext } from '@haiyue/engine/extension-authoring';
import { GuiButton, GuiLabel, GuiRoot } from '@haiyue/engine/gui';
import type { Scene } from '@haiyue/engine/scene';
import { captureGameSaveThumbnail, LocalStorageSaveBackend } from '@haiyue/engine/save';
import type { GameSaveThumbnail } from '@haiyue/engine/save';
import type { I18n } from './i18n';
import type { NarrativeVariables } from './narrative';
import { validateNarrativeDefinition } from './narrative';
import { VisualNovelSaveSession } from './visual-novel/save/VisualNovelSaveSession.js';
import { createSceneSaveHost } from './visual-novel/save/scene-presentation.js';
import { valueRecord } from './visual-novel/save/snapshot.js';
import type { SavedMusic } from './visual-novel/save/snapshot';
import type { VisualNovelStage } from './visual-novel/stage/VisualNovelStage';
import type { StageAsset, StageSlot } from './visual-novel/stage/types';
import type { AuthoredStory, StoryAsset, StoryDefinition } from './visual-novel/story/types';
import type { ReadingEntry, ReadingPreferences, ReadingView } from './visual-novel/ui/ReadingPlayback';
import type { GuiReading } from './visual-novel/ui/GuiReading';

export type { VisualNovelSnapshot } from './visual-novel/save/snapshot';
export type VisualNovelDefinition = StoryDefinition;

export interface VisualNovelOptions {
  readonly engine: HaiyueEngine;
  readonly i18n: I18n;
  readonly mixer: OwnerSafeAudioMixer;
  readonly story: AuthoredStory;
  readonly assetRoot: URL;
  readonly storage: Storage;
  readonly music?: string;
  readonly manualSlots?: readonly string[];
  /** Optional source and transport configuration for variants, named states or host-provided HYA resources. */
  readonly resolveHya?: (input: { readonly assetId: string; readonly url: URL; readonly variantId?: string },
    signal: AbortSignal) => Promise<StageAsset>;
  readonly onError?: (error: unknown) => void;
}

export interface VisualNovelView {
  readonly reading: ReadingView | null;
  readonly history: readonly ReadingEntry[];
  readonly replayId: string | null;
  readonly transitioning: boolean;
  readonly slots: readonly StageSlot[];
  readonly audio: AudioMixerStats;
  readonly resources: {
    readonly cachedRegions: number;
    readonly retainedColorBytes: number;
    readonly workingColorBytes: number;
    readonly workingRetiringColorBytes: number;
  } | null;
}

export interface VisualNovelSession {
  readonly view: VisualNovelView;
  start(id: string, initial?: NarrativeVariables, signal?: AbortSignal): Promise<void>;
  advance(): boolean;
  choose(id: string): boolean;
  setPreferences(patch: Partial<ReadingPreferences>): void;
  replayVoice(key: string): Promise<boolean>;
  save(slot: string, request?: { name?: string; thumbnail?: boolean }): Promise<void>;
  load(slot: string, signal?: AbortSignal): Promise<boolean>;
  continueLatest(signal?: AbortSignal): Promise<boolean>;
  listReplays(): readonly string[];
  startReplay(id: string, signal?: AbortSignal): Promise<void>;
  endReplay(): boolean;
  subscribe(callback: () => void): () => void;
  dispose(): Promise<void>;
}

const invalid = (message: string, cause?: unknown) => new EngineError(EngineErrorCode.GameplayInvalidInput, message, { cause });
const clearColor = { r: .03, g: .065, b: .10, a: 1 };
const assetKinds = new Set(['hya', 'audio', 'image']);
let nextOwner = 0;

function assetPath(path: unknown): path is string {
  return typeof path === 'string' && !/[%?#\\:\x00-\x1f]/u.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function validateVisualNovelDefinition(source: unknown): VisualNovelDefinition {
  if (!valueRecord(source) || source.schemaVersion !== 1 || !valueRecord(source.assets) ||
      !valueRecord(source.presets) || !valueRecord(source.cues)) throw invalid('Expected a compiled visual novel definition.');
  try { validateNarrativeDefinition(source.narrative); }
  catch (cause) { throw invalid('Invalid visual novel narrative.', cause); }
  for (const [id, asset] of Object.entries(source.assets)) {
    if (!valueRecord(asset) || typeof asset.kind !== 'string' || !assetKinds.has(asset.kind) || !assetPath(asset.path)) {
      throw invalid(`Invalid project-relative asset "${id}".`);
    }
  }
  const definition = source as unknown as VisualNovelDefinition;
  for (const [id, slots] of Object.entries(definition.presets)) {
    if (!Array.isArray(slots) || slots.some(slot => !valueRecord(slot) || typeof slot.id !== 'string' || typeof slot.assetId !== 'string' ||
      !Object.hasOwn(definition.assets, slot.assetId) || definition.assets[slot.assetId]?.kind !== 'hya' ||
      !Number.isFinite(slot.order) || !Array.isArray(slot.bounds) || slot.bounds.length !== 4 ||
      slot.bounds.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)) ||
      slot.bounds[2] <= 0 || slot.bounds[3] <= 0) || new Set(slots.map(slot => slot.id)).size !== slots.length) {
      throw invalid(`Invalid visual novel preset "${id}".`);
    }
  }
  for (const [id, groups] of Object.entries(definition.cues)) {
    if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group))) throw invalid(`Invalid cue groups "${id}".`);
  }
  if (definition.replays !== undefined && (!valueRecord(definition.replays) || Object.values(definition.replays).some(replay =>
    !valueRecord(replay) || typeof replay.startLineId !== 'string' || typeof replay.endLineId !== 'string'))) {
    throw invalid('Invalid visual novel replay definitions.');
  }
  return definition;
}

function loadPlayerModules() {
  return Promise.all([
    import('./audio.js'), import('./visual-novel/audio/ReadingAudio.js'),
    import('./visual-novel/stage/hya-stage.js'), import('./visual-novel/ui/GuiReading.js'),
  ] as const);
}

/** Copy the submitted frame while the swap-chain texture is still current. */
function captureThumbnail(engine: HaiyueEngine, signal: AbortSignal): Promise<GameSaveThumbnail> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer); engine.off('after-update', capture); signal.removeEventListener('abort', cancel);
    };
    const fail = (error: unknown) => { clean(); reject(error); };
    const cancel = () => fail(signal.reason);
    const capture = () => {
      clean();
      try {
        const source = engine.canvas;
        if (!source?.width || !source.height) throw invalid('A submitted browser canvas is required for a thumbnail.');
        const canvas = source.ownerDocument.createElement('canvas');
        const scale = Math.min(1, 320 / source.width, 180 / source.height);
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw invalid('A 2D canvas is required for a thumbnail.');
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        resolve(captureGameSaveThumbnail(canvas));
      } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => fail(invalid('Timed out waiting for a submitted thumbnail frame.')), 1_000);
    engine.once('after-update', capture);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export function createVisualNovel(options: VisualNovelOptions): VisualNovelSession {
  const { engine, i18n, story, mixer, storage, onError } = options;
  const definition = validateVisualNovelDefinition(story.definition);
  const assets = engine.assetManager;
  if (!assets) throw invalid('Initialize the engine before creating a visual novel.');
  const assetRoot = new URL('./', options.assetRoot);
  const owner = 'visual-novel:' + ++nextOwner;
  const lifetime = new AbortController();
  const resolveAsset = (id: string, kind: StoryAsset['kind']) => {
    const asset = Object.hasOwn(definition.assets, id) ? definition.assets[id] : undefined;
    if (!asset || asset.kind !== kind) throw invalid(`Missing ${kind} asset "${id}".`);
    return new URL(asset.path, assetRoot);
  };
  const manager = assets;
  async function bytes(url: URL, signal?: AbortSignal) {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) throw invalid(`Asset request failed: ${url.pathname} (${response.status}).`);
    return response.arrayBuffer();
  }
  async function loadAudio(id: string, signal: AbortSignal) {
    const url = resolveAsset(id, 'audio'), bufferId = owner + ':' + id;
    const lease = await manager.load(bufferId, async request => {
      const source = await bytes(url, request);
      request?.throwIfAborted();
      await mixer.decodeAndInstall(bufferId, source);
      if (request?.aborted) { mixer.removeBuffer(bufferId); request.throwIfAborted(); }
      return bufferId;
    }, id => { mixer.removeBuffer(id); }, { signal });
    return { bufferId: lease.value, release: () => lease.release() };
  }

  let modules: Awaited<ReturnType<typeof loadPlayerModules>> | undefined;
  let pendingModules: ReturnType<typeof loadPlayerModules> | undefined;
  async function prepare<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    const request = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    request.throwIfAborted();
    pendingModules ??= loadPlayerModules();
    modules = await pendingModules;
    request.throwIfAborted();
    return operation();
  }

  const surfaces = new WeakMap<Scene, { stage: VisualNovelStage; pipeline: ReturnType<typeof getSceneRenderPipeline> }>();
  let serial = 0;
  const host = createSceneSaveHost(engine, () => {
    if (!modules) throw invalid('The visual novel player has not been initialized.');
    const [{ createGameAudio }, { ReadingAudio }, { createHyaStage }, { GuiReading }] = modules;
    const scene = engine.createScene({ render3D: false, render2D: false, gui: { loadOp: 'load' } });
    scene.renderView.clearColor = clearColor;
    const surfaceId = owner + ':scene:' + ++serial;
    const pipeline = getSceneRenderPipeline(scene);
    const bounds = () => {
      const { displayWidth, displayHeight } = scene.renderView.snapshot();
      return { x: 0, y: 0, width: displayWidth, height: displayHeight };
    };
    try {
      const guiSystem = scene.guiSystem;
      if (!guiSystem) throw invalid('The visual novel requires a GUI scene.');
      const region = (id: string) => scene.renderView.createRegion({ id, bounds: bounds(),
        updateMode: 'demand', clearMode: 'on-update', visible: true });
      const clear = region('background-clear'), overlay = region('dialogue-overlay');
      pipeline.add({ record(_world: unknown, context: RenderCommandContext) {
        const { passEncoder, ownsPass } = beginRenderCommandPass(context);
        if (ownsPass) passEncoder.end();
      } }, { sort: -100, pass: 'isolated', loadOp: 'clear', depth: false, region: clear });
      pipeline.add(guiSystem, { sort: 10_000, pass: 'shared', loadOp: 'load', region: overlay });
      const root = new GuiRoot();
      scene.add(new Entity('Visual novel dialogue').addComponent(root));
      const stage = createHyaStage({
        scene, ...(onError ? { onError } : {}),
        resolve(id, variantId) {
          const url = resolveAsset(id, 'hya');
          const custom = options.resolveHya;
          if (variantId !== undefined && !custom) throw invalid(`HYA variant "${variantId}" requires a project resolver.`);
          const key = custom ? JSON.stringify([owner, url.href, variantId ?? null]) : url.href;
          return { key, async load(signal) {
            if (custom) return custom({ assetId: id, url, ...(variantId !== undefined ? { variantId } : {}) }, signal);
            const input = await bytes(url, signal);
            const source = JSON.parse(new TextDecoder().decode(input)) as {
              parts?: readonly { extension: string; document: unknown }[];
            };
            const core = source.parts?.find(part => part.extension === 'org.haiyue.animation-core@1')?.document as AnimationDocument | undefined;
            if (!core?.canvas) throw invalid(`Missing HYA animation core for "${id}".`);
            const motion = source.parts?.find(part => part.extension === 'org.haiyue.animation-state-machine@2')?.document as HyaStateMachineV2Document | undefined;
            const authoredPlayback = motion?.stateMachines[0]?.layers[0]?.states[0]?.motion;
            const playback = authoredPlayback?.kind === 'clip' ? authoredPlayback.playback : undefined;
            return { source, designSize: [core.canvas.width, core.canvas.height], bytes: input.byteLength,
              playback: playback ? { mode: playback === 'loop' ? 'loop' : 'once', duration: core.duration } : { mode: 'hold' } };
          } };
        },
      });
      const gameAudio = createGameAudio({ mixer });
      const audio = new ReadingAudio({ gameAudio, resolve: loadAudio, duckFactor: .36, ...(onError ? { onError } : {}) });
      let gui: GuiReading | undefined, track: SavedMusic | undefined, music: Awaited<ReturnType<typeof loadAudio>> | undefined;
      let voice: string | null = null, trackEvent = 0;
      const resize = () => {
        const next = bounds();
        clear.setBounds(next); overlay.setBounds(next);
        gui?.setInsets({ left: 12, right: 12, top: Math.floor(next.height * .40), bottom: 12 });
      };
      engine.on('resize', resize);
      surfaces.set(scene, { stage, pipeline });
      return {
        scene, stage, audio,
        mount(reading) {
          const document = engine.canvas?.ownerDocument;
          const reader = gui = new GuiReading({ root, gui: guiSystem, playback: reading,
            ...(document ? { document } : {}),
            theme: { panel: '#152632f2', text: '#ecf0db', accent: '#ffd692', button: '#294550', border: '#547175' } });
          const layout = reader.panel.layout.bind(reader.panel);
          reader.panel.layout = parent => {
            layout(parent);
            if (reading.view.kind !== 'choice') return;
            // The wrapped choice labels already render the captions.
            for (const child of reader.panel.children) for (const option of child.children) {
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
        thumbnail: () => {
          overlay.invalidate('Save thumbnail');
          return captureThumbnail(engine, lifetime.signal);
        },
        dispose() {
          engine.off('resize', resize);
          try { gui?.dispose(); audio.dispose(); gameAudio.dispose(); music?.release(); stage.dispose(); }
          finally { scene.destroy(); }
        },
      };
    } catch (error) { scene.destroy(); throw error; }
  });
  const session = new VisualNovelSaveSession({ story, i18n, host,
    gameId: definition.narrative.id, manualSlots: options.manualSlots ?? ['slot-1', 'slot-2'],
    profileStorage: storage, backend: new LocalStorageSaveBackend({ storage, namespace: 'haiyue-visual-novel' }),
    ...(onError ? { onError } : {}) });
  const tick = (event: { readonly detail: { readonly delta: number } }) => session.tick(event.detail.delta);
  engine.on('update', tick);
  let disposal: Promise<void> | undefined;
  return Object.freeze<VisualNovelSession>({
    get view() {
      const current = engine.activeScene && surfaces.get(engine.activeScene);
      return { reading: session.view, history: session.history, replayId: session.replayId, transitioning: session.transitioning,
        slots: current?.stage.snapshot ?? [], audio: mixer.stats, resources: current?.pipeline.getDebugSnapshot().regions ?? null };
    },
    start: (id, initial, signal) => prepare(() => session.start(id, initial, signal), signal),
    advance: () => session.advance(), choose: id => session.choose(id),
    setPreferences: patch => session.setPreferences(patch),
    replayVoice: key => {
      const entry = session.history.find(row => row.key === key);
      return entry ? session.replayVoice(entry) : Promise.resolve(false);
    },
    save: (slot, request) => session.save(slot, request),
    load: (slot, signal) => prepare(() => session.load(slot, signal), signal),
    continueLatest: signal => prepare(() => session.continueLatest(signal), signal),
    listReplays: () => session.listReplays(),
    startReplay: (id, signal) => prepare(() => session.startReplay(id, signal), signal),
    endReplay: () => session.endReplay(),
    subscribe: callback => session.subscribe(callback),
    dispose() {
      return disposal ??= (async () => {
        lifetime.abort(new EngineError(EngineErrorCode.SceneFlowAborted, 'The visual novel session was disposed.'));
        engine.off('update', tick);
        await session.dispose();
      })();
    },
  });
}
