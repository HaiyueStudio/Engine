import { HaiyueEngine } from '@haiyue/engine';
import {
  RenderPipeline,
  World,
  type RenderCommandContext,
} from '@haiyue/engine/experimental';
import { CubemapRenderer, type CubemapCamera } from './CubemapRenderer';
import { createProceduralCubemap } from './ProceduralCubemap';

const FACE_SIZE = 256;

interface CubemapState {
  environmentRotation: number;
  reflectivity: number;
  exposure: number;
  autoRotate: boolean;
}

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.006, g: 0.009, b: 0.017, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cubemap = await createProceduralCubemap(engine.device, FACE_SIZE);
  const renderer = await CubemapRenderer.create(engine, cubemap.view);
  const world = new World('CubemapExample');
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

  const state: CubemapState = {
    environmentRotation: 0,
    reflectivity: 0.94,
    exposure: 1,
    autoRotate: true,
  };
  const camera: CubemapCamera = { yaw: 0.72, pitch: 0.18, radius: 4.6 };
  const controls = bindControls(state);
  bindCamera(canvas, camera);

  let validationFrames = 0;
  let validationFinished = false;
  engine.on('update', ({ detail: { time, delta } }) => {
    if (state.autoRotate) {
      state.environmentRotation = wrapRadians(state.environmentRotation + delta * 0.00012);
      controls.rotation.value = String(state.environmentRotation * 180 / Math.PI);
    }
    renderer.update({
      camera,
      environmentRotation: state.environmentRotation,
      reflectivity: state.reflectivity,
      exposure: state.exposure,
      timeSeconds: time * 0.001,
    });
    renderPipeline.execute(world, time, delta, { label: 'CubemapExample.render' });
    updateOutputs(state, controls);

    if (!validationFinished && ++validationFrames >= 12) {
      validationFinished = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (cubemap.faces.length !== 6) validationErrors.push(`Expected six cubemap faces; received ${cubemap.faces.length}.`);
    if (renderer.sphereIndexCount === 0) validationErrors.push('Reflection sphere has no indices.');
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.cubemapLayers = String(cubemap.faces.length);
    document.body.dataset.cubemapFaceSize = String(cubemap.size);
    document.body.dataset.cubemapFaceOrder = cubemap.faces.map(face => face.axis).join(',');
    query<HTMLElement>('#result').textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      faceSize: cubemap.size,
      layers: cubemap.faces.length,
      faceOrder: cubemap.faces.map(face => face.axis),
      sphereVertices: renderer.sphereVertexCount,
      sphereIndices: renderer.sphereIndexCount,
    });
  }

  window.addEventListener('pagehide', () => {
    renderer.destroy();
    cubemap.destroy();
  }, { once: true });
  engine.run();
}

interface CubemapControls {
  readonly rotation: HTMLInputElement;
  readonly reflectivity: HTMLInputElement;
  readonly exposure: HTMLInputElement;
  readonly rotationValue: HTMLOutputElement;
  readonly reflectivityValue: HTMLOutputElement;
  readonly exposureValue: HTMLOutputElement;
  readonly autoRotate: HTMLButtonElement;
}

function bindControls(state: CubemapState): CubemapControls {
  const controls: CubemapControls = {
    rotation: query<HTMLInputElement>('#rotation'),
    reflectivity: query<HTMLInputElement>('#reflectivity'),
    exposure: query<HTMLInputElement>('#exposure'),
    rotationValue: query<HTMLOutputElement>('#rotation-value'),
    reflectivityValue: query<HTMLOutputElement>('#reflectivity-value'),
    exposureValue: query<HTMLOutputElement>('#exposure-value'),
    autoRotate: query<HTMLButtonElement>('#auto-rotate'),
  };
  controls.rotation.addEventListener('input', () => {
    state.autoRotate = false;
    state.environmentRotation = Number(controls.rotation.value) * Math.PI / 180;
  });
  controls.reflectivity.addEventListener('input', () => {
    state.reflectivity = Number(controls.reflectivity.value);
  });
  controls.exposure.addEventListener('input', () => {
    state.exposure = Number(controls.exposure.value);
  });
  controls.autoRotate.addEventListener('click', () => {
    state.autoRotate = !state.autoRotate;
  });
  return controls;
}

function updateOutputs(state: CubemapState, controls: CubemapControls): void {
  controls.rotationValue.value = `${Math.round(state.environmentRotation * 180 / Math.PI)}°`;
  controls.reflectivityValue.value = `${Math.round(state.reflectivity * 100)}%`;
  controls.exposureValue.value = state.exposure.toFixed(2);
  controls.autoRotate.classList.toggle('active', state.autoRotate);
  controls.autoRotate.setAttribute('aria-pressed', String(state.autoRotate));
}

function bindCamera(canvas: HTMLCanvasElement, camera: CubemapCamera): void {
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
    camera.pitch = Math.min(1.2, Math.max(-1.2, camera.pitch + (event.clientY - lastY) * 0.005));
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const release = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    camera.radius = Math.min(9, Math.max(2.8, camera.radius * Math.exp(event.deltaY * 0.001)));
  }, { passive: false });
}

function wrapRadians(value: number): number {
  return (value + Math.PI) % (Math.PI * 2) - Math.PI;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing cubemap example element: ${selector}`);
  return element;
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
