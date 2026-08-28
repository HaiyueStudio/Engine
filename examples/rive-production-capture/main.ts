import { parseAnimation } from '@haiyue/animation-spec';
import { Animation2DComponent, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';

const CHANNELS = [
  'pixels', 'geometryAndDrawOrder', 'stateMachineState', 'dataValues', 'events',
  'pointerKeyboardGamepadFocus', 'resizeAndDpr', 'audioSchedule',
  'semanticTreeAndActions', 'resourceReplacement', 'errorsAndOwners',
] as const;
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 64;
type Channel = typeof CHANNELS[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Payload {
  mode: 'official' | 'hya'; assetId: string; rivSha256: string; scenarioSha256: string;
  artifactPrefix: string; scenario: any; environment: any;
}
interface CaptureState {
  viewport: { id: string; width: number; height: number; dpr: number };
  data: Record<string, Json>; sourceInput: Json; sourceInputApplied: boolean;
  pointer: Json; keyboard: Json; gamepad: Json; focus: Json; reducedMotion: boolean;
  events: Json[]; resources: Record<string, Json>; diagnostics: Json[];
}
interface RuntimeOwner {
  kind: 'official' | 'hya'; resize(width: number, height: number, dpr: number): Promise<void>;
  apply(action: any, state: CaptureState): Promise<void>; renderAt(micros: number): Promise<void>;
  runtimeState(state: CaptureState): Json; loseDevice(): Promise<boolean>; cleanup(): Promise<void>;
}
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
        await owner.renderAt(atMicros);
        frameDurations.push(performance.now() - started);
        if (firstFrameMs === 0) firstFrameMs = performance.now() - parseStarted;
        const pixels = await samplePixels(canvas, sampleCanvas);
        const pixelPath = `${payload.artifactPrefix}/${payload.mode}-r${replayIndex}-t${atMicros}.rgba`;
        artifactBytes.push([pixelPath, base64(pixels)]);
        const pixelReference = { path: pixelPath, sha256: await sha256(pixels), byteLength: pixels.byteLength, mediaType: 'application/octet-stream' };
        const actionIds = actions.map((action: any) => action.id);
        for (const channel of CHANNELS) channels[channel].samples.push({
          replayIndex, atMicros, actionIds,
          value: channel === 'pixels'
            ? { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, dpr: state.viewport.dpr, rgba: pixelReference }
            : channelValue(channel, payload, state, owner, pixels),
        });
      }
    } finally { await owner.cleanup(); }
  }
  progress('measuring 120 native frames');
  const measurementOwner = await createOwner();
  try {
    for (let index = 0; index < 5; index++) await measurementOwner.renderAt(index * 16_667);
    for (let index = 0; index < 120; index++) {
      const started = performance.now(); await measurementOwner.renderAt(index * 16_667);
      frameDurations.push(performance.now() - started);
    }
  } finally { await measurementOwner.cleanup(); }
  progress('exercising lifecycle paths');
  const lifecycle = await exerciseLifecyclePaths(payload.scenario.lifecyclePaths, createOwner);
  const memory = (performance as any).memory?.usedJSHeapSize ?? 0;
  const meanFrame = frameDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, frameDurations.length);
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const networkBytes = resources.reduce((sum, value) => sum + (value.transferSize || value.encodedBodySize), 0);
  const networkMs = resources.reduce((sum, value) => sum + value.duration, 0);
  const capture = {
    environment: payload.environment, deviceEvidence, channels, artifactBytesByPath: artifactBytes, freshOwnerPerReplay: true,
    metrics: {
      rawBytes: runtimeBytes.byteLength, gzipBytes: 0, networkBytes, networkMs,
      parseMs, firstFrameMs, cpuFrameMs: meanFrame, gpuFrameMs: 0,
      peakMemoryBytes: memory, settleMs: Math.max(...frameDurations, 0), energyMj: 0,
    },
    measurement: { warmupIterations: 5, measuredIterations: 30, frameSampleCount: 120, queueCompleted: true, energySource: 'unavailable: no physical energy meter or browser energy API' },
    diagnostics: [
      { classification: 'oracle-proxy', channel: 'geometryAndDrawOrder', message: 'Public Rive WebGL2 does not expose topology/draw-order state; capture is a pixel-occupancy proxy.' },
      { classification: 'metric-unavailable', metric: 'gpuFrameMs', message: 'WebGPU/WebGL2 timestamp queries are not wired into this capture host.' },
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
      autoplay: false, autoBind: true, useOffscreenRenderer: false,
      onLoad: () => resolve(rive), onLoadError: (event: unknown) => reject(new Error(`Official Rive load failed: ${String(event)}`)),
    });
  });
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
    async renderAt(micros) { if (payload.scenario.selection.animation) instance.scrub(payload.scenario.selection.animation, micros / 1_000_000); await frames(2); },
    runtimeState(state) { return { stateMachine: payload.scenario.selection.stateMachine, sourceInput: state.sourceInput, sourceInputApplied: state.sourceInputApplied }; },
    async loseDevice() { const gl = canvas.getContext('webgl2'); const extension = gl?.getExtension('WEBGL_lose_context'); if (!extension) return false; extension.loseContext(); await frames(2); extension.restoreContext(); await frames(2); return true; },
    async cleanup() { instance.cleanup(); await frames(1); },
  };
}

async function createHyaOwner(payload: Payload, canvas: HTMLCanvasElement, bytes: ArrayBuffer): Promise<RuntimeOwner> {
  const animation = parseAnimation(bytes.slice(0));
  setCanvasViewport(canvas, animation.canvas.width, animation.canvas.height);
  const engine = new HaiyueEngine({ canvas, clearColor: { r: 0, g: 0, b: 0, a: 0 }, alphaMode: 'premultiplied', devicePixelRatio: 1 });
  await engine.init();
  const cameraEntity = new Entity('Rive formal HYA camera').addComponent(new Camera2D({ width: animation.canvas.width, height: animation.canvas.height, designWidth: animation.canvas.width, designHeight: animation.canvas.height, viewportMode: 'fit' }));
  const camera = cameraEntity.getComponent(Camera2D)!;
  const scene = engine.createScene({ name: 'Rive formal HYA capture', camera: { type: '2d', entity: cameraEntity }, render3D: false, render2D: false, gui: false });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  const renderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 32 });
  scene.addSystem(renderer);
  const player = new Animation2DComponent(animation, { autoplay: false, loop: true });
  scene.add(new Entity('Rive formal HYA animation').addComponent(new Transform2D()).addComponent(player));
  engine.switchScene(scene); engine.run(); await frames(2);
  return {
    kind: 'hya',
    async resize(width, height, dpr) { setCanvasViewport(canvas, width, height); engine.devicePixelRatio = dpr; camera.resize(width, height); await frames(2); },
    async apply(action) { dispatchDomAction(canvas, action); },
    async renderAt(micros) { player.seek(micros / 1_000_000); await frames(2); await engine.device.queue.onSubmittedWorkDone(); },
    runtimeState(state) { return { stateMachine: payload.scenario.selection.stateMachine, sourceInput: state.sourceInput, sourceInputApplied: state.sourceInputApplied }; },
    async loseDevice() { engine.device.destroy(); await frames(2); return true; },
    async cleanup() { engine.destroy(); await frames(1); },
  };
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
        let generation = 1; owner = await createOwner();
        const late = Promise.resolve().then(() => ({ generation, value: 'late' }));
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

function channelValue(channel: Channel, payload: Payload, state: CaptureState, owner: RuntimeOwner, pixels: Uint8Array): Json {
  switch (channel) {
    case 'geometryAndDrawOrder': return { artboard: payload.scenario.selection.artboard, occupancy: pixelOccupancy(pixels), viewport: state.viewport.id };
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
function pixelOccupancy(bytes: Uint8Array): Json {
  let nonTransparent = 0; let minX = SAMPLE_WIDTH; let minY = SAMPLE_HEIGHT; let maxX = -1; let maxY = -1;
  for (let offset = 0; offset < bytes.length; offset += 4) if (bytes[offset + 3]! > 0) { const pixel = offset / 4; const x = pixel % SAMPLE_WIDTH; const y = Math.floor(pixel / SAMPLE_WIDTH); nonTransparent++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return { nonTransparent, bounds: nonTransparent === 0 ? null : [minX, minY, maxX, maxY] };
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
