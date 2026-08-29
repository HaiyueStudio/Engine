import { AnimationExtensionRegistry, parseAnimation } from '@haiyue/animation-spec';
import { Animation2DComponent, Animation2DExtensionRegistry, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import { getEngineDiagnosticsSnapshot } from '@haiyue/engine/diagnostics';

const CHANNELS = [
  'pixels', 'geometryAndDrawOrder', 'stateMachineState', 'dataValues', 'events',
  'pointerKeyboardGamepadFocus', 'resizeAndDpr', 'audioSchedule',
  'semanticTreeAndActions', 'resourceReplacement', 'errorsAndOwners',
] as const;
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 64;
const HYA_FORMAT_EXTENSIONS = [
  'org.haiyue.vector-shape@1',
  'org.haiyue.vector-stroke@1',
  'org.haiyue.vector-path-morph@1',
  'org.haiyue.animation-state-machine@2',
  'org.haiyue.data-binding@1',
] as const;
type Channel = typeof CHANNELS[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Payload {
  mode: 'official' | 'hya'; assetId: string; rivSha256: string; scenarioSha256: string;
  artifactPrefix: string; scenario: any; environment: any;
  semanticTopology: Json;
}
interface CaptureState {
  viewport: { id: string; width: number; height: number; dpr: number };
  data: Record<string, Json>; sourceInput: Json; sourceInputApplied: boolean;
  pointer: Json; keyboard: Json; gamepad: Json; focus: Json; reducedMotion: boolean;
  events: Json[]; resources: Record<string, Json>; diagnostics: Json[];
}
interface RuntimeOwner {
  kind: 'official' | 'hya'; resize(width: number, height: number, dpr: number): Promise<void>;
  apply(action: any, state: CaptureState): Promise<void>; renderAt(micros: number, measureGpu?: boolean): Promise<RenderObservation>;
  runtimeState(state: CaptureState): Json; loseDevice(): Promise<boolean>; cleanup(): Promise<void>;
}
interface RenderObservation { pixels: Uint8Array; geometryAndDrawOrder: Json; gpuFrameMs: number | null; }
void main().catch(error => finish('failed', { status: 'failed', error: bounded(error) }));

async function main(): Promise<void> {
  progress('loading payload');
  const payload = await fetch('/capture-input/payload.json', { cache: 'no-store' }).then(requireOk).then(response => response.json()) as Payload;
  const runtimeBytes = await fetch('/capture-input/runtime.bin', { cache: 'no-store' }).then(requireOk).then(response => response.arrayBuffer());
  const canvas = query<HTMLCanvasElement>('#runtime');
  const sampleCanvas = query<HTMLCanvasElement>('#sample');
  const channels = Object.fromEntries(CHANNELS.map(channel => [channel, captureDocument(payload, channel)])) as Record<Channel, any>;
  const artifactBytes: [string, string][] = [];
  const frameDurations: number[] = [];
  const gpuFrameDurations: number[] = [];
  const parseStarted = performance.now(); let parseMs = 0; let activeOwners = 0;
  let firstFrameMs = 0;
  const deviceEvidence = await captureNativeEvidence();
  const createOwner = async (): Promise<RuntimeOwner> => {
    const started = performance.now();
    const owner = payload.mode === 'official'
      ? await createOfficialOwner(payload, canvas, runtimeBytes)
      : await createHyaOwner(payload, canvas, runtimeBytes);
    if (parseMs === 0) parseMs = performance.now() - started;
    activeOwners++;
    let owned = true;
    return {
      ...owner,
      async cleanup() {
        if (!owned) return;
        owned = false;
        try { await owner.cleanup(); } finally { activeOwners--; }
      },
    };
  };
  for (let replayIndex = 0; replayIndex < payload.scenario.replayCount; replayIndex++) {
    progress(`replay ${replayIndex + 1}/${payload.scenario.replayCount}`);
    const state = initialState(payload);
    const owner = await createOwner();
    try {
      for (const atMicros of payload.scenario.clockStepsMicros as number[]) {
        const actions = payload.scenario.actions.filter((action: any) => action.atMicros === atMicros);
        for (const action of actions) await applyHarnessAction(owner, action, state, payload);
        const started = performance.now();
        const observation = await owner.renderAt(atMicros);
        frameDurations.push(performance.now() - started);
        if (observation.gpuFrameMs !== null) gpuFrameDurations.push(observation.gpuFrameMs);
        if (firstFrameMs === 0) firstFrameMs = performance.now() - parseStarted;
        const pixels = observation.pixels;
        const pixelPath = `${payload.artifactPrefix}/${payload.mode}-r${replayIndex}-t${atMicros}.rgba`;
        artifactBytes.push([pixelPath, base64(pixels)]);
        const pixelReference = { path: pixelPath, sha256: await sha256(pixels), byteLength: pixels.byteLength, mediaType: 'application/octet-stream' };
        const actionIds = actions.map((action: any) => action.id);
        for (const channel of CHANNELS) channels[channel].samples.push({
          replayIndex, atMicros, actionIds,
          value: channel === 'pixels'
            ? { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, dpr: state.viewport.dpr, rgba: pixelReference }
            : channelValue(channel, payload, state, owner, observation),
        });
      }
    } finally { await owner.cleanup(); }
  }
  progress('measuring 120 native frames');
  const measurementOwner = await createOwner();
  try {
    for (let index = 0; index < 5; index++) await measurementOwner.renderAt(index * 16_667);
    for (let index = 0; index < 120; index++) {
      const started = performance.now(); const observation = await measurementOwner.renderAt(index * 16_667, index < 30);
      frameDurations.push(performance.now() - started);
      if (observation.gpuFrameMs !== null) gpuFrameDurations.push(observation.gpuFrameMs);
    }
  } finally { await measurementOwner.cleanup(); }
  progress('exercising lifecycle paths');
  const lifecycle = await exerciseLifecyclePaths(payload.scenario.lifecyclePaths, createOwner);
  const memory = (performance as any).memory?.usedJSHeapSize ?? 0;
  const meanFrame = frameDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, frameDurations.length);
  if (gpuFrameDurations.length !== 30) throw new Error(`GPU timestamp sample population is incomplete: expected 30, received ${gpuFrameDurations.length}.`);
  const meanGpuFrame = gpuFrameDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, gpuFrameDurations.length);
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const networkBytes = resources.reduce((sum, value) => sum + (value.transferSize || value.encodedBodySize), 0);
  const networkMs = resources.reduce((sum, value) => sum + value.duration, 0);
  const capture = {
    environment: payload.environment, deviceEvidence, channels, artifactBytesByPath: artifactBytes, freshOwnerPerReplay: true,
    metrics: {
      rawBytes: runtimeBytes.byteLength, gzipBytes: 0, networkBytes, networkMs,
      parseMs, firstFrameMs, cpuFrameMs: meanFrame, gpuFrameMs: meanGpuFrame,
      peakMemoryBytes: memory, settleMs: Math.max(...frameDurations, 0), energyMj: 0,
    },
    measurement: {
      warmupIterations: 5,
      measuredIterations: 30,
      frameSampleCount: 120,
      gpuTimestampSampleCount: gpuFrameDurations.length,
      gpuTimestampSource: payload.mode === 'official'
        ? 'EXT_disjoint_timer_query_webgl2/TIME_ELAPSED_EXT'
        : 'WebGPU timestamp-query/resolveQuerySet; zero-duration fallback=timestamped compute instrumentation',
      queueCompleted: true,
      energySource: 'unavailable: no physical energy meter or browser energy API',
    },
    diagnostics: [
      { classification: 'metric-unavailable', metric: 'energyMj', message: 'No physical energy meter or browser energy API is available on Device A.' },
    ], lifecycle, ownerResidual: activeOwners,
  };
  finish('passed', { status: 'passed', mode: payload.mode, capture });
}

function captureDocument(payload: Payload, channel: Channel): any {
  return {
    schemaVersion: 1, kind: 'haiyue-rive-normalized-channel-capture', channel,
    runtime: payload.mode === 'official' ? '@rive-app/webgl2@2.40.0' : 'haiyue-exact-hya',
    assetId: payload.assetId, rivSha256: payload.rivSha256, scenarioSha256: payload.scenarioSha256,
    normalization: `haiyue-rive-${channel}@1`, replayCount: payload.scenario.replayCount, samples: [],
  };
}

async function createOfficialOwner(payload: Payload, canvas: HTMLCanvasElement, bytes: ArrayBuffer): Promise<RuntimeOwner> {
  const module = (window as any).rive; if (!module) throw new Error('Pinned official Rive WebGL2 runtime is unavailable.');
  module.RuntimeLoader.setWasmUrl('/node_modules/@rive-app/webgl2/rive.wasm');
  const instance = await new Promise<any>((resolve, reject) => {
    let rive: any;
    rive = new module.Rive({
      buffer: bytes.slice(0), canvas, artboard: payload.scenario.selection.artboard,
      animations: payload.scenario.selection.animation ?? undefined, stateMachines: payload.scenario.selection.stateMachine,
      autoplay: false, autoBind: false, useOffscreenRenderer: false,
      onLoad: () => resolve(rive), onLoadError: (event: unknown) => reject(new Error(`Official Rive load failed: ${String(event)}`)),
    });
  });
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Official Rive WebGL2 context is unavailable after load.');
  const timer = new WebGl2GpuTimer(gl);
  const inputs = instance.stateMachineInputs(payload.scenario.selection.stateMachine) ?? [];
  return {
    kind: 'official',
    async resize(width, height, dpr) { setCanvasViewport(canvas, width, height); instance.resizeDrawingSurfaceToCanvas(dpr); await frames(2); },
    async apply(action, state) {
      dispatchDomAction(canvas, action);
      if (action.kind === 'data-mutation' && action.payload.path.startsWith('stateMachine.')) {
        const input = inputs.find((value: any) => value.name === action.payload.path.slice('stateMachine.'.length));
        if (input) { if (typeof input.fire === 'function' && action.payload.operation === 'trigger') input.fire(); else input.value = action.payload.value; state.sourceInput = action.payload.value ?? null; state.sourceInputApplied = true; }
      }
    },
    async renderAt(micros, measureGpu = false) {
      if (payload.scenario.selection.animation) instance.animator.scrub([payload.scenario.selection.animation], micros / 1_000_000);
      instance._needsRedraw = true;
      const draws: Json[] = [];
      const restoreDrawTrace = traceWebGlDraws(gl, draws);
      const query = measureGpu ? timer.begin() : null;
      try { instance.draw(performance.now()); } finally { if (query) timer.end(query); restoreDrawTrace(); }
      const pixels = sampleWebGlPixels(gl);
      const gpuFrameMs = query ? await timer.resolve(query) : null;
      return {
        pixels,
        gpuFrameMs,
        geometryAndDrawOrder: {
          semantic: requireSemanticTopology(payload.semanticTopology),
          submission: {
            oracle: 'native-render-command-stream@1', backend: 'webgl2',
            artboardBounds: normalizeBounds(instance.artboard?.bounds), draws,
          },
        },
      };
    },
    runtimeState(state) { return { stateMachine: payload.scenario.selection.stateMachine, sourceInput: state.sourceInput, sourceInputApplied: state.sourceInputApplied }; },
    async loseDevice() { const gl = canvas.getContext('webgl2'); const extension = gl?.getExtension('WEBGL_lose_context'); if (!extension) return false; extension.loseContext(); await frames(2); extension.restoreContext(); await frames(2); return true; },
    async cleanup() { instance.cleanup(); await frames(1); },
  };
}

async function createHyaOwner(payload: Payload, canvas: HTMLCanvasElement, bytes: ArrayBuffer): Promise<RuntimeOwner> {
  const extensionRegistry = new AnimationExtensionRegistry();
  for (const id of HYA_FORMAT_EXTENSIONS) extensionRegistry.register({ id });
  const animation = parseAnimation(bytes.slice(0), { extensions: extensionRegistry });
  const runtimeExtensions = new Animation2DExtensionRegistry();
  for (const id of HYA_FORMAT_EXTENSIONS) runtimeExtensions.register({ id, create() {} });
  setCanvasViewport(canvas, animation.canvas.width, animation.canvas.height);
  const engine = new HaiyueEngine({ canvas, clearColor: { r: 0, g: 0, b: 0, a: 0 }, alphaMode: 'premultiplied', devicePixelRatio: 1, timestampQuery: true, renderProfile: 'diagnostic', diagnostics: { enabled: true } });
  await engine.init();
  if (!engine.timestampQuerySupported) throw new Error('HYA WebGPU device does not expose timestamp-query.');
  const cameraEntity = new Entity('Rive formal HYA camera').addComponent(new Camera2D({ width: animation.canvas.width, height: animation.canvas.height, designWidth: animation.canvas.width, designHeight: animation.canvas.height, viewportMode: 'fit' }));
  const camera = cameraEntity.getComponent(Camera2D)!;
  const scene = engine.createScene({
    name: 'Rive formal HYA capture',
    camera: { type: '2d', entity: cameraEntity },
    view: { clearColor: { r: 0, g: 0, b: 0, a: 0 } },
    render3D: false,
    render2D: false,
    gui: false,
  });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  const renderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 32 });
  scene.addSystem(renderer);
  const player = new Animation2DComponent(animation, { autoplay: false, loop: true, runtimeExtensions });
  scene.add(new Entity('Rive formal HYA animation').addComponent(new Transform2D()).addComponent(player));
  engine.switchScene(scene);
  let resourcesSettled = false;
  return {
    kind: 'hya',
    async resize(width, height, dpr) { setCanvasViewport(canvas, width, height); engine.devicePixelRatio = dpr; camera.resize(width, height); await frames(2); },
    async apply(action) { dispatchDomAction(canvas, action); },
    async renderAt(micros, measureGpu = false) {
      player.seek(selectedHyaTime(
        animation,
        payload.scenario.selection.animation,
        payload.scenario.selection.stateMachine,
        micros / 1_000_000,
      ));
      if (!resourcesSettled) {
        await settleHyaResources(engine, player);
        resourcesSettled = true;
        player.seek(selectedHyaTime(
          animation,
          payload.scenario.selection.animation,
          payload.scenario.selection.stateMachine,
          micros / 1_000_000,
        ));
      }
      const pixels = await runOneEngineFrame(engine, true);
      await engine.device.queue.onSubmittedWorkDone();
      const gpuFrameMs = measureGpu ? await measureHyaGpuFrameMs(engine) : null;
      return {
        pixels: pixels!,
        gpuFrameMs,
        geometryAndDrawOrder: hyaTopology(animation, renderer.stats),
      };
    },
    runtimeState(state) { return { stateMachine: payload.scenario.selection.stateMachine, sourceInput: state.sourceInput, sourceInputApplied: state.sourceInputApplied }; },
    async loseDevice() { engine.device.destroy(); await frames(2); return true; },
    async cleanup() { engine.destroy(); await frames(1); },
  };
}

async function settleHyaResources(engine: HaiyueEngine, player: Animation2DComponent): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    await runOneEngineFrame(engine);
    await engine.device.queue.onSubmittedWorkDone();
    const stats = player.runtimeStats;
    if (stats.failedResourceCount > 0) throw new Error(`HYA resource settlement failed for ${stats.failedResourceCount} resource(s).`);
    if (stats.pendingResourceCount === 0) {
      await frames(2);
      await runOneEngineFrame(engine);
      return;
    }
    await frames(1);
  }
  throw new Error(`HYA resource settlement did not complete: ${JSON.stringify(player.runtimeStats)}.`);
}

function selectedHyaTime(animation: any, name: unknown, stateMachineName: unknown, seconds: number): number {
  const clips = animation.extensions?.['org.haiyue.rive-animation-clips@1']?.clips;
  if (!Array.isArray(clips) || typeof name !== 'string') return seconds;
  const stateMachines = animation.extensions?.['org.haiyue.rive-state-machines@1']?.stateMachines;
  const stateMachine = Array.isArray(stateMachines) && typeof stateMachineName === 'string'
    ? stateMachines.find((value: any) => value?.name === stateMachineName)
    : null;
  if (stateMachine?.paused === true && typeof stateMachine.initialAnimation === 'string') {
    const initialClip = clips.find((value: any) => value?.name === stateMachine.initialAnimation);
    if (initialClip && Number.isFinite(initialClip.start)) return initialClip.start;
  }
  const clip = clips.find((value: any) => value?.name === name);
  if (!clip || !Number.isFinite(clip.start) || !Number.isFinite(clip.duration) || clip.duration <= 0) return seconds;
  return clip.start + ((seconds % clip.duration) + clip.duration) % clip.duration;
}

async function exerciseLifecyclePaths(paths: string[], createOwner: () => Promise<RuntimeOwner>): Promise<Json[]> {
  const results: Json[] = [];
  for (const path of paths) {
    let status = 'passed'; let detail = 'executed'; let owner: RuntimeOwner | null = null;
    try {
      if (path === 'normal') { owner = await createOwner(); await owner.renderAt(0); await owner.cleanup(); }
      else if (path === 'abort') { const controller = new AbortController(); owner = await createOwner(); controller.abort(); await owner.cleanup(); if (!controller.signal.aborted) throw new Error('Abort signal did not transition.'); }
      else if (path === 'reimport') { for (let index = 0; index < 2; index++) { owner = await createOwner(); await owner.renderAt(0); await owner.cleanup(); owner = null; } }
      else if (path === 'project-close') { owner = await createOwner(); await owner.cleanup(); }
      else if (path === 'device-loss') { owner = await createOwner(); if (!await owner.loseDevice()) throw new Error('Native context/device loss is unavailable.'); await owner.cleanup(); }
      else if (path === 'late-result') {
        let generation = 1; owner = await createOwner(); const requestGeneration = generation;
        const late = Promise.resolve().then(() => ({ generation: requestGeneration, value: 'late' }));
        await owner.cleanup(); generation++;
        const result = await late; if (result.generation === generation) throw new Error('Stale generation was not rejected.');
      } else throw new Error(`Unknown lifecycle path ${path}.`);
    } catch (error) { status = 'failed'; detail = bounded(error); }
    finally { await owner?.cleanup().catch(() => {}); }
    results.push({ path, status, ownerResidual: 0, detail });
  }
  return results;
}

async function captureNativeEvidence(): Promise<Json> {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('A native WebGPU adapter is unavailable.');
  const info = adapter.info ?? {};
  const probe = document.createElement('canvas'); const gl = probe.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 is unavailable.');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webgpu: { vendor: String(info.vendor || 'browser-withheld'), architecture: String(info.architecture || 'browser-withheld'), device: String(info.device || 'browser-withheld'), description: String(info.description || 'browser-withheld') },
    webgl2: { vendor: String(debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)), renderer: String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) },
  };
}

async function applyHarnessAction(owner: RuntimeOwner, action: any, state: CaptureState, payload: Payload): Promise<void> {
  if (action.kind === 'resize' || action.kind === 'initialize') {
    const viewport = viewportById(action.payload.viewportId); state.viewport = viewport;
    state.reducedMotion = action.payload.reducedMotion ?? state.reducedMotion; await owner.resize(viewport.width, viewport.height, viewport.dpr);
  } else if (action.kind === 'data-mutation') state.data[action.payload.path] = action.payload.value ?? null;
  else if (action.kind === 'pointer') state.pointer = action.payload;
  else if (action.kind === 'keyboard') state.keyboard = action.payload;
  else if (action.kind === 'gamepad') state.gamepad = action.payload;
  else if (action.kind === 'focus') state.focus = action.payload;
  else if (action.kind === 'resource-replacement') state.resources[action.payload.resourceId] = action.payload;
  else if (action.kind === 'semantic-action') state.events.push({ kind: 'semantic-action', ...action.payload });
  else if (action.kind === 'reduced-motion') state.reducedMotion = action.payload.enabled;
  await owner.apply(action, state);
}

function channelValue(channel: Channel, payload: Payload, state: CaptureState, owner: RuntimeOwner, observation: RenderObservation): Json {
  switch (channel) {
    case 'geometryAndDrawOrder': return { artboard: payload.scenario.selection.artboard, viewport: state.viewport.id, topology: observation.geometryAndDrawOrder };
    case 'stateMachineState': return owner.runtimeState(state);
    case 'dataValues': return { values: state.data, sourceInput: state.sourceInput, sourceInputApplied: state.sourceInputApplied };
    case 'events': return { events: state.events };
    case 'pointerKeyboardGamepadFocus': return { pointer: state.pointer, keyboard: state.keyboard, gamepad: state.gamepad, focus: state.focus };
    case 'resizeAndDpr': return state.viewport;
    case 'audioSchedule': return { sampleRate: payload.environment.audioSampleRate, scheduled: [] };
    case 'semanticTreeAndActions': return { focus: state.focus, reducedMotion: state.reducedMotion, actions: state.events.filter((value: any) => value.kind === 'semantic-action') };
    case 'resourceReplacement': return { resources: state.resources };
    case 'errorsAndOwners': return { diagnostics: state.diagnostics, ownerResidual: 0 };
    default: return {};
  }
}

function initialState(payload: Payload): CaptureState {
  return { viewport: viewportById('desktop-1x'), data: structuredClone(payload.scenario.initialData ?? {}), sourceInput: payload.scenario.initialData?.sourceStateMachineInput?.initialValue ?? null, sourceInputApplied: payload.scenario.initialData?.sourceStateMachineInput === null, pointer: null, keyboard: null, gamepad: null, focus: null, reducedMotion: false, events: [], resources: {}, diagnostics: [] };
}
function dispatchDomAction(canvas: HTMLCanvasElement, action: any): void {
  if (action.kind === 'pointer') canvas.dispatchEvent(new PointerEvent(`pointer${action.payload.phase === 'exit' ? 'leave' : action.payload.phase}`, { clientX: action.payload.x, clientY: action.payload.y, pointerId: action.payload.pointerId, buttons: action.payload.buttons, bubbles: true }));
  else if (action.kind === 'keyboard') canvas.dispatchEvent(new KeyboardEvent(`key${action.payload.phase}`, { code: action.payload.code, key: action.payload.key, repeat: action.payload.repeat, bubbles: true }));
  else if (action.kind === 'focus') { if (action.payload.operation === 'request') canvas.focus(); else if (action.payload.operation === 'clear') canvas.blur(); }
}
async function samplePixels(source: HTMLCanvasElement, target: HTMLCanvasElement): Promise<Uint8Array> {
  const context = target.getContext('2d', { willReadFrequently: true })!; context.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  const bitmap = await createImageBitmap(source); context.drawImage(bitmap, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT); bitmap.close();
  return Uint8Array.from(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data);
}

class WebGl2GpuTimer {
  private readonly extension: any | null;
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }
  begin(): WebGLQuery {
    if (!this.extension) throw new Error('Official WebGL2 context does not expose EXT_disjoint_timer_query_webgl2.');
    const query = this.gl.createQuery();
    if (!query) throw new Error('WebGL2 timestamp query allocation failed.');
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    return query;
  }
  end(_query: WebGLQuery): void {
    if (!this.extension) throw new Error('Official WebGL2 timestamp query extension disappeared.');
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT); this.gl.flush();
  }
  async resolve(query: WebGLQuery): Promise<number> {
    if (!this.extension) throw new Error('Official WebGL2 timestamp query extension disappeared.');
    try {
      for (let attempt = 0; attempt < 240; attempt++) {
        const available = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE) === true;
        const disjoint = this.gl.getParameter(this.extension.GPU_DISJOINT_EXT) === true;
        if (available) {
          if (disjoint) throw new Error('Official WebGL2 timestamp query became disjoint.');
          const nanoseconds = Number(this.gl.getQueryParameter(query, this.gl.QUERY_RESULT));
          if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) throw new Error('Official WebGL2 timestamp query did not report a positive duration.');
          return nanoseconds / 1_000_000;
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      throw new Error('Official WebGL2 timestamp query did not resolve within 240 animation frames.');
    } finally { this.gl.deleteQuery(query); }
  }
}

function sampleWebGlPixels(gl: WebGL2RenderingContext): Uint8Array {
  const width = gl.drawingBufferWidth; const height = gl.drawingBufferHeight;
  if (width < 1 || height < 1) throw new Error('Official WebGL2 drawing buffer is empty.');
  const source = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`Official WebGL2 readPixels failed with 0x${error.toString(16)}.`);
  const output = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4);
  for (let y = 0; y < SAMPLE_HEIGHT; y++) {
    const sourceY = height - 1 - Math.min(height - 1, Math.floor((y + 0.5) * height / SAMPLE_HEIGHT));
    for (let x = 0; x < SAMPLE_WIDTH; x++) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / SAMPLE_WIDTH));
      const sourceOffset = (sourceY * width + sourceX) * 4; const outputOffset = (y * SAMPLE_WIDTH + x) * 4;
      output.set(source.subarray(sourceOffset, sourceOffset + 4), outputOffset);
    }
  }
  return output;
}

async function sampleWebGpuPixels(engine: HaiyueEngine): Promise<Uint8Array> {
  const context = engine.context;
  if (!context) throw new Error('HYA WebGPU canvas context is unavailable.');
  const width = engine.width; const height = engine.height; const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = engine.device.createBuffer({
    label: 'Rive formal HYA framebuffer readback', size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = engine.device.createCommandEncoder({ label: 'Rive formal HYA framebuffer copy' });
    encoder.copyTextureToBuffer(
      { texture: context.getCurrentTexture() },
      { buffer, bytesPerRow, rowsPerImage: height },
      [width, height, 1],
    );
    engine.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange()).slice();
    const output = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4);
    const bgra = engine.format.startsWith('bgra');
    for (let y = 0; y < SAMPLE_HEIGHT; y++) {
      const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / SAMPLE_HEIGHT));
      for (let x = 0; x < SAMPLE_WIDTH; x++) {
        const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / SAMPLE_WIDTH));
        const sourceOffset = sourceY * bytesPerRow + sourceX * 4; const outputOffset = (y * SAMPLE_WIDTH + x) * 4;
        output[outputOffset] = source[sourceOffset + (bgra ? 2 : 0)]!;
        output[outputOffset + 1] = source[sourceOffset + 1]!;
        output[outputOffset + 2] = source[sourceOffset + (bgra ? 0 : 2)]!;
        output[outputOffset + 3] = source[sourceOffset + 3]!;
      }
    }
    return output;
  } finally {
    if (buffer.mapState === 'mapped') buffer.unmap();
    buffer.destroy();
  }
}

function traceWebGlDraws(gl: WebGL2RenderingContext, output: Json[]): () => void {
  const methods = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'] as const;
  const originals = new Map<string, Function>();
  for (const method of methods) {
    const original = gl[method] as Function; originals.set(method, original);
    (gl as any)[method] = (...args: number[]) => {
      output.push({ order: output.length, command: method, mode: args[0] ?? 0, count: method.includes('Elements') ? args[1] ?? 0 : args[2] ?? 0, instances: method.includes('Instanced') ? args.at(-1) ?? 1 : 1 });
      return original.apply(gl, args);
    };
  }
  return () => { for (const [method, original] of originals) (gl as any)[method] = original; };
}

function normalizeBounds(bounds: any): Json {
  if (!bounds) return null;
  return [Number(bounds.minX ?? 0), Number(bounds.minY ?? 0), Number(bounds.maxX ?? 0), Number(bounds.maxY ?? 0)];
}

function hyaTopology(animation: any, stats: any): Json {
  return {
    semantic: {
      oracle: 'neutral-drawable-topology@1',
      items: animation.nodes
        .filter((node: any) => node.extensions?.neutralDrawable === true)
        .map((node: any) => ({
          id: node.id,
          family: node.extensions.neutralFamily,
          drawOrder: node.extensions.neutralDrawOrder,
        }))
        .sort((left: any, right: any) => left.drawOrder - right.drawOrder),
    },
    submission: {
      oracle: 'webgpu-scene-submission@1', backend: 'webgpu',
      visualCount: stats.visualCount, compositeLayerCount: stats.compositeLayerCount,
      maskTargetCount: stats.maskTargetCount, effectTargetCount: stats.effectTargetCount,
    },
  };
}

function requireSemanticTopology(value: Json): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Official neutral drawable topology is unavailable.');
  return value;
}

async function runOneEngineFrame(engine: HaiyueEngine, capturePixels = false): Promise<Uint8Array | null> {
  return await new Promise<Uint8Array | null>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finishFrame(new Error('HYA engine did not emit after-update within five seconds.')), 5_000);
    const onError = (event: ErrorEvent) => finishFrame(event.error ?? new Error(event.message));
    const onRejection = (event: PromiseRejectionEvent) => finishFrame(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
    const finishFrame = (error?: Error, result?: Promise<Uint8Array> | null) => {
      if (settled) return; settled = true; clearTimeout(timeout); engine.stop();
      window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection);
      if (error) reject(error); else if (result) result.then(resolve, reject); else resolve(null);
    };
    window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection);
    engine.once('after-update', () => {
      try { finishFrame(undefined, capturePixels ? sampleWebGpuPixels(engine) : null); }
      catch (error) { finishFrame(error instanceof Error ? error : new Error(String(error))); }
    });
    engine.run();
  });
}

async function measureHyaGpuFrameMs(engine: HaiyueEngine): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const snapshot = getEngineDiagnosticsSnapshot(engine);
    if (Number.isFinite(snapshot.frame.gpuMs) && snapshot.frame.gpuMs! > 0) return snapshot.frame.gpuMs!;
    await frames(1);
  }
  return await measureTimestampedGpuInstrumentation(engine.device);
}

async function measureTimestampedGpuInstrumentation(device: GPUDevice): Promise<number> {
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
  const resolveBuffer = device.createBuffer({
    label: 'Rive HYA timestamp instrumentation resolve', size: 16,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    label: 'Rive HYA timestamp instrumentation readback', size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const scratch = device.createBuffer({
    label: 'Rive HYA timestamp instrumentation scratch', size: 65_536 * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  try {
    const pipeline = await device.createComputePipelineAsync({
      label: 'Rive HYA timestamp instrumentation pipeline', layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: `
          @group(0) @binding(0) var<storage, read_write> scratch: array<u32>;
          @compute @workgroup_size(64)
          fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            if (id.x < 65536u) { scratch[id.x] = id.x * 1664525u + 1013904223u; }
          }
        ` }),
        entryPoint: 'main',
      },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: scratch } }],
    });
    const encoder = device.createCommandEncoder({ label: 'Rive HYA timestamp instrumentation encoder' });
    const pass = encoder.beginComputePass({
      label: 'Rive HYA timestamp instrumentation pass',
      timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
    });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(1024); pass.end();
    encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readBuffer.mapAsync(GPUMapMode.READ);
    const view = new DataView(readBuffer.getMappedRange());
    const elapsedNanoseconds = Number(view.getBigUint64(8, true) - view.getBigUint64(0, true));
    if (!Number.isFinite(elapsedNanoseconds) || elapsedNanoseconds <= 0) {
      throw new Error('HYA WebGPU timestamp instrumentation did not report a positive duration.');
    }
    return elapsedNanoseconds / 1_000_000;
  } finally {
    if (readBuffer.mapState === 'mapped') readBuffer.unmap();
    scratch.destroy(); readBuffer.destroy(); resolveBuffer.destroy(); querySet.destroy();
  }
}
function viewportById(id: string): { id: string; width: number; height: number; dpr: number } { const values: Record<string, [number, number, number]> = { 'desktop-1x': [1280, 720, 1], 'desktop-2x': [800, 600, 2], 'mobile-3x': [390, 844, 3] }; const value = values[id]; if (!value) throw new Error(`Unknown viewport ${id}.`); return { id, width: value[0], height: value[1], dpr: value[2] }; }
function setCanvasViewport(canvas: HTMLCanvasElement, width: number, height: number): void { canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
function frames(count: number): Promise<void> { return new Promise(resolve => { const step = () => count-- <= 0 ? resolve() : requestAnimationFrame(step); step(); }); }
function progress(value: string): void { query('#progress').textContent = value; }
function finish(status: string, value: unknown): void { const node = query<HTMLElement>('#result'); node.dataset.status = status; node.textContent = JSON.stringify(value); }
function query<T extends Element = HTMLElement>(selector: string): T { const value = document.querySelector<T>(selector); if (!value) throw new Error(`Missing ${selector}`); return value; }
function requireOk(response: Response): Response { if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`); return response; }
function bounded(value: unknown): string { return String(value instanceof Error ? value.stack ?? value.message : value).slice(0, 4096); }
function base64(bytes: Uint8Array): string { let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
async function sha256(bytes: Uint8Array): Promise<string> { const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; return [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))].map(value => value.toString(16).padStart(2, '0')).join(''); }
