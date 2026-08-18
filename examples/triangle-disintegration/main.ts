import { HaiyueEngine } from '@haiyue/engine';
import { separateGeometryTriangles } from '@haiyue/engine/geometry';
import {
  RenderPipeline,
  World,
  type RenderCommandContext,
} from '@haiyue/engine/experimental';
import { createSegmentedBoxGeometry } from './SegmentedBoxGeometry';
import {
  TriangleDisintegrationRenderer,
  type DisintegrationCamera,
} from './TriangleDisintegrationRenderer';

const SEGMENTS = 10;
const DURATION_MS = 4_200;
const AUTO_START_DELAY_MS = 900;
const AUTO_RESET_DELAY_MS = 1_650;

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.004, g: 0.007, b: 0.014, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  // The indexed 10×10-per-face box is deliberately converted before the
  // effect. With no shared vertices, vertex_index / 3 is a stable triangle id.
  const indexedGeometry = createSegmentedBoxGeometry({
    width: 3.4,
    height: 3.4,
    depth: 3.4,
    segments: SEGMENTS,
  });
  const separatedGeometry = separateGeometryTriangles(indexedGeometry);
  const renderer = await TriangleDisintegrationRenderer.create(engine, separatedGeometry);
  const world = new World('TriangleDisintegration');
  const renderPipeline = new RenderPipeline(engine);
  renderPipeline.add({
    record(_world: World, context: RenderCommandContext): void {
      renderer.record(context);
    },
  }, {
    passType: 'render',
    pass: 'shared',
    loadOp: 'clear',
    depth: true,
  });

  const state = {
    progress: 0,
    playing: false,
    autoReplay: true,
    holdMs: 0,
    scrubbing: false,
  };
  const camera: DisintegrationCamera = { yaw: 0.62, pitch: 0.24, radius: 8.8 };
  bindCamera(canvas, camera);
  bindControls(state);
  updateGeometryStats(indexedGeometry.vertexCount, separatedGeometry.vertexCount, renderer.triangleCount);

  let validationFrames = 0;
  let validationFinished = false;
  engine.on('update', ({ detail: { time, delta } }) => {
    updatePlayback(state, delta);
    renderer.update(state.progress, time * 0.001, camera);
    renderPipeline.execute(world, time, delta, { label: 'TriangleDisintegration.render' });
    updateUi(state);

    if (!validationFinished && ++validationFrames >= 12) {
      validationFinished = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (indexedGeometry.indices === null) validationErrors.push('Source segmented box was not indexed.');
    if (separatedGeometry.indices !== null) validationErrors.push('Separated geometry unexpectedly retained indices.');
    if (renderer.triangleCount !== 1_200) validationErrors.push(`Expected 1200 triangles, got ${renderer.triangleCount}.`);
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.sourceVertexCount = String(indexedGeometry.vertexCount);
    document.body.dataset.separatedVertexCount = String(separatedGeometry.vertexCount);
    document.body.dataset.triangleCount = String(renderer.triangleCount);
    const result = query<HTMLElement>('#result');
    result.textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      segments: SEGMENTS,
      sourceVertices: indexedGeometry.vertexCount,
      separatedVertices: separatedGeometry.vertexCount,
      triangles: renderer.triangleCount,
      particles: renderer.particleCount,
    });
  }

  window.addEventListener('beforeunload', () => renderer.destroy(), { once: true });
  engine.run();
}

interface PlaybackState {
  progress: number;
  playing: boolean;
  autoReplay: boolean;
  holdMs: number;
  scrubbing: boolean;
}

function updatePlayback(state: PlaybackState, deltaMs: number): void {
  if (state.playing) {
    state.progress = Math.min(1, state.progress + deltaMs / DURATION_MS);
    if (state.progress >= 1) {
      state.playing = false;
      state.holdMs = 0;
    }
    return;
  }
  if (!state.autoReplay || state.scrubbing) return;
  state.holdMs += deltaMs;
  const wait = state.progress >= 1 ? AUTO_RESET_DELAY_MS : AUTO_START_DELAY_MS;
  if (state.holdMs < wait) return;
  state.holdMs = 0;
  if (state.progress >= 1) state.progress = 0;
  else state.playing = true;
}

function bindControls(state: PlaybackState): void {
  const snap = query<HTMLButtonElement>('#snap');
  const reset = query<HTMLButtonElement>('#reset');
  const auto = query<HTMLButtonElement>('#auto');
  const progress = query<HTMLInputElement>('#progress');

  const trigger = (): void => {
    state.autoReplay = false;
    state.holdMs = 0;
    if (state.progress >= 0.999) state.progress = 0;
    state.playing = true;
  };
  const resetEffect = (): void => {
    state.autoReplay = false;
    state.playing = false;
    state.progress = 0;
    state.holdMs = 0;
  };
  snap.addEventListener('click', trigger);
  reset.addEventListener('click', resetEffect);
  auto.addEventListener('click', () => {
    state.autoReplay = !state.autoReplay;
    state.holdMs = 0;
  });
  progress.addEventListener('pointerdown', () => { state.scrubbing = true; });
  progress.addEventListener('pointerup', () => { state.scrubbing = false; });
  progress.addEventListener('input', () => {
    state.autoReplay = false;
    state.playing = false;
    state.progress = Number(progress.value);
    state.holdMs = 0;
  });
  window.addEventListener('keydown', event => {
    if (event.code === 'Space') {
      event.preventDefault();
      trigger();
    } else if (event.key.toLowerCase() === 'r') {
      resetEffect();
    }
  });
}

function bindCamera(canvas: HTMLCanvasElement, camera: DisintegrationCamera): void {
  let pointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', event => {
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId) return;
    camera.yaw -= (event.clientX - lastX) * 0.006;
    camera.pitch = Math.min(1.15, Math.max(-0.75, camera.pitch + (event.clientY - lastY) * 0.005));
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const release = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    camera.radius = Math.min(14, Math.max(5.8, camera.radius * Math.exp(event.deltaY * 0.001)));
  }, { passive: false });
}

function updateUi(state: PlaybackState): void {
  const progress = query<HTMLInputElement>('#progress');
  const progressValue = query<HTMLOutputElement>('#progress-value');
  const snap = query<HTMLButtonElement>('#snap');
  const auto = query<HTMLButtonElement>('#auto');
  if (!state.scrubbing) progress.value = state.progress.toFixed(4);
  progressValue.value = `${Math.round(state.progress * 100)}%`;
  snap.textContent = state.playing ? '灰飞烟灭中…' : state.progress >= 0.999 ? '再次弹响' : '弹响';
  snap.classList.toggle('active', state.playing);
  auto.classList.toggle('active', state.autoReplay);
  auto.setAttribute('aria-pressed', String(state.autoReplay));
}

function updateGeometryStats(sourceVertices: number, separatedVertices: number, triangles: number): void {
  query<HTMLElement>('#source-vertices').textContent = sourceVertices.toLocaleString();
  query<HTMLElement>('#separated-vertices').textContent = separatedVertices.toLocaleString();
  query<HTMLElement>('#triangle-count').textContent = triangles.toLocaleString();
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing triangle-disintegration element: ${selector}`);
  return element;
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
