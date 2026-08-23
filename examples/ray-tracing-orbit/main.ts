import { OrbitControl } from '@haiyue/engine';
import {
  rayAcceleration,
  rayDenoise,
  rayMaterial,
  rayPathTracing,
  raySampling,
  rayScene,
} from '@haiyue/extensions/ray-tracing';
import { ProgressiveCanvasPresenter } from './ProgressiveCanvasPresenter';
import { createOrbitRayScene, type OrbitRayScene } from './scene';

type View = raySampling.RayProgressiveView;
type ProgressiveResult = Awaited<ReturnType<raySampling.RayProgressiveRenderer['render']>>;

interface RenderResolution {
  readonly width: number;
  readonly height: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly pixelRatio: number;
  readonly source: 'viewport' | 'evidence-fixed';
}

interface Runtime {
  readonly device: GPUDevice;
  readonly scene: OrbitRayScene;
  readonly builder: rayAcceleration.RayAccelerationBuilder;
  readonly acceleration: rayAcceleration.RayAccelerationSnapshot;
  readonly materials: rayMaterial.RayPackedMaterialScene;
  readonly baseRenderer: rayPathTracing.RayPathTracingRenderer;
  readonly denoiser: rayDenoise.RaySpatialTemporalDenoiser;
  readonly progressive: raySampling.RayProgressiveRenderer;
  readonly presenter: ProgressiveCanvasPresenter;
  readonly orbit: OrbitControl;
  readonly uncapturedErrors: string[];
  readonly onUncapturedError: (event: GPUUncapturedErrorEvent) => void;
  disposed: boolean;
}

interface InteractionState {
  paused: boolean;
  pointerActive: boolean;
  mutationRevision: number;
  published: boolean;
}

const canvas = query<HTMLCanvasElement>('#candidate');
const pixelRatioControl = query<HTMLInputElement>('#pixel-ratio');
const pixelRatioValue = query<HTMLOutputElement>('#pixel-ratio-value');
const bouncesControl = query<HTMLSelectElement>('#bounces');
const viewControl = query<HTMLSelectElement>('#view');
const maxSamplesControl = query<HTMLSelectElement>('#max-samples');
const pauseButton = query<HTMLButtonElement>('#pause');
const resetButton = query<HTMLButtonElement>('#reset');
const resultNode = query<HTMLElement>('#result');
const interaction: InteractionState = {
  paused: false,
  pointerActive: false,
  mutationRevision: 0,
  published: false,
};
const pageEvents = new AbortController();
let runtime: Runtime | null = null;

installPageControls();
void start();

async function start(): Promise<void> {
  try {
    const params = new URLSearchParams(location.search);
    pixelRatioControl.value = String(parsePixelRatio(params.get('pixelRatio'), window.devicePixelRatio));
    const requestedView = params.get('view');
    if (requestedView && isView(requestedView)) viewControl.value = requestedView;
    const requestedBounces = params.get('bounces');
    if (requestedBounces && ['1', '2', '3'].includes(requestedBounces)) {
      bouncesControl.value = requestedBounces;
    }
    updatePixelRatioLabel();
    setStatus('请求 WebGPU device…');
    runtime = await createRuntime();
    if (params.get('evidence') === '1') {
      await runEvidence(runtime);
      return;
    }
    await runInteractiveLoop(runtime);
  } catch (error) {
    fail(error);
  }
}

async function createRuntime(): Promise<Runtime> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('RAY_ORBIT_WEBGPU_UNAVAILABLE');
  const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  const uncapturedErrors: string[] = [];
  const onUncapturedError = (event: GPUUncapturedErrorEvent) => uncapturedErrors.push(event.error.message);
  device.addEventListener('uncapturederror', onUncapturedError);

  const scene = createOrbitRayScene();
  const builder = new rayAcceleration.RayAccelerationBuilder();
  let baseRenderer: rayPathTracing.RayPathTracingRenderer | null = null;
  let denoiser: rayDenoise.RaySpatialTemporalDenoiser | null = null;
  let progressive: raySampling.RayProgressiveRenderer | null = null;
  let presenter: ProgressiveCanvasPresenter | null = null;
  let orbit: OrbitControl | null = null;
  try {
    setStatus('提取场景并构建 BLAS/TLAS…');
    const extracted = rayScene.extractRayTracingScene(scene.world);
    if (!extracted.valid) throw new Error(formatDiagnostics(extracted.diagnostics));
    const updated = builder.update(extracted.snapshot);
    if (!updated.snapshot) throw new Error(formatDiagnostics(updated.diagnostics));
    const packedMaterials = rayMaterial.packRayPbrMaterialScene(scene.world, updated.snapshot.packed);
    if (!packedMaterials.packed) throw new Error(formatDiagnostics(packedMaterials.diagnostics));
    const facts = rayPathTracing.extractRayPathSceneFacts(scene.world, {
      cameraEntityId: scene.cameraEntity.id,
    });
    if (!facts.facts) throw new Error(formatDiagnostics(facts.diagnostics));

    setStatus('创建 progressive path tracing pipelines…');
    const baseCreated = await rayPathTracing.RayPathTracingRenderer.create(
      device,
      updated.snapshot.packed,
      packedMaterials.packed,
    );
    if (!baseCreated.renderer) throw new Error(formatDiagnostics(baseCreated.diagnostics));
    baseRenderer = baseCreated.renderer;
    const denoiseCreated = await rayDenoise.RaySpatialTemporalDenoiser.create(device);
    if (!denoiseCreated.denoiser) throw new Error(formatDiagnostics(denoiseCreated.diagnostics));
    denoiser = denoiseCreated.denoiser;
    const progressiveCreated = await raySampling.RayProgressiveRenderer.create(
      device,
      baseRenderer,
      denoiser,
    );
    if (!progressiveCreated.renderer) throw new Error(formatDiagnostics(progressiveCreated.diagnostics));
    progressive = progressiveCreated.renderer;
    presenter = await ProgressiveCanvasPresenter.create(device, canvas);
    orbit = new OrbitControl(canvas, scene.cameraTransform, {
      minRadius: 4.5,
      maxRadius: 16,
      minPhi: 0.24,
      maxPhi: Math.PI - 0.18,
      rotateSpeed: 0.7,
      panSpeed: 0.72,
      zoomSpeed: 0.75,
    });
    return {
      device,
      scene,
      builder,
      acceleration: updated.snapshot,
      materials: packedMaterials.packed,
      baseRenderer,
      denoiser,
      progressive,
      presenter,
      orbit,
      uncapturedErrors,
      onUncapturedError,
      disposed: false,
    };
  } catch (error) {
    orbit?.dispose();
    presenter?.destroy();
    progressive?.destroy();
    denoiser?.destroy();
    baseRenderer?.destroy();
    builder.destroy();
    scene.world.destroy();
    device.removeEventListener('uncapturederror', onUncapturedError);
    device.destroy();
    throw error;
  }
}

async function runInteractiveLoop(active: Runtime): Promise<void> {
  setStatus('开始采样 · 拖拽画面可旋转');
  while (!active.disposed) {
    if (interaction.paused || document.hidden) {
      await nextAnimationFrame();
      continue;
    }
    const maxSamples = parseMaxSamples(maxSamplesControl.value);
    if (active.progressive.sampleCount >= maxSamples && interaction.mutationRevision === 0) {
      setStatus('已收敛到 ' + active.progressive.sampleCount + ' spp · 拖拽可重新采样');
      await nextAnimationFrame();
      continue;
    }
    const revisionAtStart = interaction.mutationRevision;
    const startedAt = performance.now();
    const rendered = await renderOne(active, false, 'discard-stale');
    if (!rendered) {
      await nextAnimationFrame();
      continue;
    }
    if (revisionAtStart === interaction.mutationRevision) interaction.mutationRevision = 0;
    updateMetrics(rendered, performance.now() - startedAt);
    if (!interaction.published && rendered.statistics.sampleCount >= 8) {
      interaction.published = true;
      publish('passed', {
        schemaVersion: 1,
        suite: 'ray-tracing-orbit-example',
        status: 'passed',
        interactive: true,
        sampleCount: rendered.statistics.sampleCount,
        resetCount: rendered.statistics.resetCount,
        unclassifiedFailureCount: 0,
      });
    }
    await nextAnimationFrame();
  }
}

async function runEvidence(active: Runtime): Promise<void> {
  const initialCounts: number[] = [];
  const initialDeltas: number[] = [];
  let previous: Uint8Array | null = null;
  let finalInitial: ProgressiveResult | null = null;
  for (let index = 0; index < 12; index++) {
    const startedAt = performance.now();
    const rendered = await renderOne(active, true);
    updateMetrics(rendered, performance.now() - startedAt);
    if (!rendered.pixels) throw new Error('RAY_ORBIT_EVIDENCE_READBACK_MISSING');
    initialCounts.push(rendered.statistics.sampleCount);
    if (previous) initialDeltas.push(meanAbsoluteDelta(previous, rendered.pixels));
    previous = rendered.pixels;
    finalInitial = rendered;
  }
  const earlyMeanDelta = mean(initialDeltas.slice(0, 3));
  const lateMeanDelta = mean(initialDeltas.slice(-3));
  if (!(lateMeanDelta < earlyMeanDelta)) {
    throw new Error('RAY_ORBIT_CONVERGENCE_FAILED:' + JSON.stringify({ earlyMeanDelta, lateMeanDelta }));
  }

  active.scene.cameraTransform.set(
    active.scene.cameraTransform.radius,
    active.scene.cameraTransform.theta + 0.34,
    active.scene.cameraTransform.phi - 0.08,
  );
  interaction.mutationRevision++;
  const postOrbitCounts: number[] = [];
  let cameraReset: raySampling.RayProgressiveResetEvent | null = null;
  for (let index = 0; index < 6; index++) {
    const startedAt = performance.now();
    const rendered = await renderOne(active, true);
    updateMetrics(rendered, performance.now() - startedAt);
    postOrbitCounts.push(rendered.statistics.sampleCount);
    if (index === 0) cameraReset = rendered.statistics.lastReset;
  }
  if (
    postOrbitCounts[0] !== 1
    || !cameraReset?.reasons.includes('camera')
    || active.uncapturedErrors.length > 0
  ) {
    throw new Error('RAY_ORBIT_CAMERA_RESET_FAILED:' + JSON.stringify({
      postOrbitCounts,
      cameraReset,
      uncapturedErrors: active.uncapturedErrors,
    }));
  }
  const pendingBeforeManualReset = renderOne(active, false, 'discard-stale');
  active.progressive.reset('explicit');
  const discardedBeforeManualReset = await pendingBeforeManualReset;
  if (discardedBeforeManualReset !== null) {
    throw new Error('RAY_ORBIT_MANUAL_RESET_DID_NOT_DISCARD_STALE_SAMPLE');
  }
  const afterManualReset = await renderOne(active, false);
  if (
    afterManualReset.statistics.sampleCount !== 1
    || !afterManualReset.statistics.lastReset?.reasons.includes('explicit')
  ) {
    throw new Error('RAY_ORBIT_MANUAL_RESET_FAILED:' + JSON.stringify({
      sampleCount: afterManualReset.statistics.sampleCount,
      lastReset: afterManualReset.statistics.lastReset,
    }));
  }
  publish('passed', {
    schemaVersion: 1,
    suite: 'ray-tracing-orbit-example',
    status: 'passed',
    resolution: {
      width: finalInitial?.width ?? 0,
      height: finalInitial?.height ?? 0,
      source: 'evidence-fixed',
    },
    initialSampleCounts: initialCounts,
    postOrbitSampleCounts: postOrbitCounts,
    cameraResetReasons: cameraReset.reasons,
    manualResetRace: {
      staleSampleDiscarded: true,
      nextSampleCount: afterManualReset.statistics.sampleCount,
      resetReasons: afterManualReset.statistics.lastReset?.reasons ?? [],
    },
    convergence: {
      earlyMeanDelta,
      lateMeanDelta,
      improved: lateMeanDelta < earlyMeanDelta,
    },
    liveResourceCount: finalInitial?.memory.liveResourceCount ?? 0,
    unclassifiedFailureCount: 0,
  });
  setStatus('证据通过 · 相机重置后重新收敛');
}

function renderOne(active: Runtime, readback: boolean): Promise<ProgressiveResult>;
function renderOne(
  active: Runtime,
  readback: boolean,
  stalePolicy: 'discard-stale',
): Promise<ProgressiveResult | null>;
async function renderOne(
  active: Runtime,
  readback: boolean,
  stalePolicy: 'fail' | 'discard-stale' = 'fail',
): Promise<ProgressiveResult | null> {
  if (active.disposed) throw new DOMException('Ray orbit example disposed.', 'AbortError');
  const resolution = resolveResolution(active.device);
  active.presenter.resize(resolution.width, resolution.height);
  const extracted = rayPathTracing.extractRayPathSceneFacts(active.scene.world, {
    cameraEntityId: active.scene.cameraEntity.id,
  });
  if (!extracted.facts) throw new Error(formatDiagnostics(extracted.diagnostics));
  const frame = Object.freeze({
    facts: extracted.facts,
    revision: raySampling.createRayProgressiveFrameRevision(
      active.acceleration,
      active.materials,
      extracted.facts,
    ),
  });
  const rendered = await active.progressive.render(frame, {
    width: resolution.width,
    height: resolution.height,
    baseSeed: 0x51ca7e31,
    maxBounces: Number(bouncesControl.value),
    qualityRevision: 'ray-orbit-interactive-v1',
    exposure: 1,
    toneMapping: 'aces',
    view: parseView(viewControl.value),
    readback,
  });
  if (rendered.status !== 'ok' || !rendered.outputTexture) {
    if (stalePolicy === 'discard-stale' && isExpectedStaleSample(rendered)) return null;
    throw new Error(formatDiagnostics(rendered.diagnostics));
  }
  if (active.uncapturedErrors.length > 0) {
    throw new Error('RAY_ORBIT_GPU_VALIDATION:' + active.uncapturedErrors.join('; '));
  }
  active.presenter.present(rendered.outputTexture);
  query<HTMLElement>('#resolution').textContent =
    resolution.width + ' × ' + resolution.height + ' · ' + resolution.pixelRatio.toFixed(2) + '×';
  return rendered;
}

function isExpectedStaleSample(rendered: ProgressiveResult): boolean {
  const errors = rendered.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  return errors.length > 0
    && errors.every(diagnostic => diagnostic.code === 'RAY_PROGRESSIVE_STALE_SAMPLE');
}

function installPageControls(): void {
  const signal = pageEvents.signal;
  pixelRatioControl.addEventListener('input', () => {
    updatePixelRatioLabel();
    markChanged();
  }, { signal });
  bouncesControl.addEventListener('change', markChanged, { signal });
  viewControl.addEventListener('change', markChanged, { signal });
  maxSamplesControl.addEventListener('change', markChanged, { signal });
  pauseButton.addEventListener('click', () => {
    interaction.paused = !interaction.paused;
    pauseButton.textContent = interaction.paused ? '继续' : '暂停';
    setStatus(interaction.paused ? '已暂停' : '继续采样');
  }, { signal });
  resetButton.addEventListener('click', () => {
    runtime?.progressive.reset('explicit');
    interaction.mutationRevision++;
    interaction.paused = false;
    pauseButton.textContent = '暂停';
    setStatus('手动重置 · 重新从 1 spp 开始');
  }, { signal });
  canvas.addEventListener('pointerdown', () => {
    interaction.pointerActive = true;
    setStatus('拖拽相机 · 下一帧重置 history');
  }, { signal });
  canvas.addEventListener('pointermove', () => {
    if (interaction.pointerActive) markChanged();
  }, { signal });
  window.addEventListener('pointerup', () => {
    if (!interaction.pointerActive) return;
    interaction.pointerActive = false;
    markChanged();
  }, { signal });
  canvas.addEventListener('wheel', markChanged, { signal, passive: true });
  const resizeObserver = new ResizeObserver(markChanged);
  resizeObserver.observe(canvas);
  signal.addEventListener('abort', () => resizeObserver.disconnect(), { once: true });
  window.addEventListener('pagehide', dispose, { signal, once: true });
}

function updateMetrics(rendered: ProgressiveResult, wallTimeMs: number): void {
  const resetReasons = rendered.statistics.lastReset?.reasons.join(', ') ?? '—';
  query<HTMLElement>('#samples').textContent = rendered.statistics.sampleCount + ' spp';
  query<HTMLElement>('#resets').textContent =
    rendered.statistics.resetCount + ' · ' + resetReasons;
  query<HTMLElement>('#variance').textContent =
    rendered.statistics.varianceMean.toFixed(5) + ' / ' + rendered.statistics.varianceMax.toFixed(5);
  query<HTMLElement>('#frame-time').textContent = wallTimeMs.toFixed(1) + ' ms';
  query<HTMLElement>('#memory').textContent =
    (rendered.memory.peakBytes / 1048576).toFixed(1) + ' MiB';
  const maxSamples = parseMaxSamples(maxSamplesControl.value);
  query<HTMLProgressElement>('#progress').value =
    Math.min(1, rendered.statistics.sampleCount / maxSamples);
  document.body.dataset.convergence =
    rendered.statistics.sampleCount < 12 ? 'noisy' : 'refining';
  if (
    rendered.statistics.lastReset?.resetIndex === rendered.statistics.resetCount
    && rendered.statistics.sampleCount <= 2
  ) {
    setStatus('History reset: ' + resetReasons + ' · ' + rendered.statistics.sampleCount + ' spp');
  } else {
    setStatus(
      (interaction.pointerActive ? '拖拽中' : 'Progressive sampling')
      + ' · ' + rendered.statistics.sampleCount + ' spp',
    );
  }
}

function resolveResolution(device: GPUDevice): RenderResolution {
  const params = new URLSearchParams(location.search);
  const fixed = params.get('evidence') === '1'
    ? parseFixedResolution(params.get('resolution'))
    : null;
  const rect = canvas.getBoundingClientRect();
  const displayWidth = Math.max(1, Math.round(rect.width));
  const displayHeight = Math.max(1, Math.round(rect.height));
  const pixelRatio = fixed ? 1 : parsePixelRatio(pixelRatioControl.value, window.devicePixelRatio);
  const width = fixed?.width ?? Math.max(1, Math.round(displayWidth * pixelRatio));
  const height = fixed?.height ?? Math.max(1, Math.round(displayHeight * pixelRatio));
  if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D) {
    throw new Error('RAY_ORBIT_RESOLUTION_UNSUPPORTED:' + JSON.stringify({
      width,
      height,
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
    }));
  }
  return Object.freeze({
    width,
    height,
    displayWidth,
    displayHeight,
    pixelRatio,
    source: fixed ? 'evidence-fixed' : 'viewport',
  });
}

function dispose(): void {
  pageEvents.abort();
  const active = runtime;
  runtime = null;
  if (!active || active.disposed) return;
  active.disposed = true;
  active.orbit.dispose();
  active.presenter.destroy();
  active.progressive.destroy();
  active.denoiser.destroy();
  active.baseRenderer.destroy();
  active.builder.destroy();
  active.scene.world.destroy();
  active.device.removeEventListener('uncapturederror', active.onUncapturedError);
  active.device.destroy();
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  setStatus('渲染失败');
  query<HTMLElement>('#diagnostics').textContent = message;
  publish('failed', {
    schemaVersion: 1,
    suite: 'ray-tracing-orbit-example',
    status: 'failed',
    error: message,
    unclassifiedFailureCount: 1,
  });
  console.error(error);
  dispose();
}

function markChanged(): void {
  interaction.mutationRevision++;
}

function parseFixedResolution(value: string | null): Readonly<{ width: number; height: number }> | null {
  const match = /^(\d+)x(\d+)$/u.exec(value ?? '');
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? Object.freeze({ width, height }) : null;
}

function parsePixelRatio(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Math.min(2, Math.max(0.25, Number.isFinite(parsed) ? parsed : 1));
}

function parseMaxSamples(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1024;
}

function parseView(value: string): View {
  return isView(value) ? value : 'raw';
}

function isView(value: string): value is View {
  return ['raw', 'denoised', 'variance', 'history-age', 'feature'].includes(value);
}

function meanAbsoluteDelta(left: Uint8Array, right: Uint8Array): number {
  let total = 0;
  let channels = 0;
  for (let offset = 0; offset < Math.min(left.length, right.length); offset += 4) {
    total += Math.abs((left[offset] ?? 0) - (right[offset] ?? 0));
    total += Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0));
    total += Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0));
    channels += 3;
  }
  return channels > 0 ? total / channels : 0;
}

function mean(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function updatePixelRatioLabel(): void {
  pixelRatioValue.value = parsePixelRatio(pixelRatioControl.value, 1).toFixed(2) + '×';
}

function setStatus(message: string): void {
  query<HTMLElement>('#status').textContent = message;
}

function formatDiagnostics(values: readonly { readonly code: string; readonly message: string }[]): string {
  return JSON.stringify(values.map(value => ({ code: value.code, message: value.message })));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function publish(status: 'passed' | 'failed', value: unknown): void {
  resultNode.dataset.status = status;
  resultNode.textContent = JSON.stringify(value);
  document.body.dataset.renderStatus = status;
}

function query<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error('Ray orbit example is missing ' + selector + '.');
  return value;
}
