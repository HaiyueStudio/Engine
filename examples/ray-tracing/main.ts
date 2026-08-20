import {
  Camera3D,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  Geometry3D,
  Mesh3D,
  PbrMaterial,
  World,
  createBox3D,
  createSphere3D,
} from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import {
  rayAcceleration,
  rayDenoise,
  rayMaterial,
  rayPathTracing,
  raySampling,
  rayScene,
  rayTraversal,
} from '@haiyue/extensions/ray-tracing';

type SceneId = 'analytic' | 'material';
type Quality = 'low' | 'medium' | 'high';
type View = 'raw' | 'denoised' | 'variance' | 'history-age' | 'feature';

interface CandidateReport {
  readonly sceneId: SceneId;
  readonly fixedSceneId: string;
  readonly fixedCameraReplayId: string;
  readonly sourceSha256: string;
  readonly candidateSha256: string;
  readonly width: number;
  readonly height: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly pixelRatio: number;
  readonly resolutionSource: 'viewport' | 'evidence-fixed';
  readonly buildMs: number;
  readonly gpuTimeNs: number | null;
  readonly peakBytes: number;
  readonly liveResourceCount: number;
  readonly counters: object;
  readonly pixelSummary: PixelSummary;
  readonly stageTimings: Readonly<Record<string, number | null>>;
  readonly diagnostics: readonly Readonly<{ code: string; severity: string; message: string }>[];
  readonly unclassifiedFailureCount: 0;
}

interface PixelSummary {
  readonly maximumChannel: number;
  readonly nonBlackPixelCount: number;
  readonly meanRgb: readonly [number, number, number];
}

interface ActiveCandidate { dispose(): void }

interface RenderResolution {
  readonly width: number;
  readonly height: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly pixelRatio: number;
  readonly source: 'viewport' | 'evidence-fixed';
}

const QUALITY = Object.freeze({
  low: Object.freeze({ samples: 1, bounces: 1 }),
  medium: Object.freeze({ samples: 4, bounces: 2 }),
  high: Object.freeze({ samples: 8, bounces: 3 }),
});
const ANALYTIC_DEFINITION = Object.freeze({ schemaVersion: 1, sphere: { center: [0, 0, 0], radius: 0.78 }, camera: { originZ: 3, extent: [16, 9] } });
const MATERIAL_DEFINITION = Object.freeze({ schemaVersion: 1, layout: 'five-pbr-objects-room', camera: [0, 1.1, 7.2], light: [-0.35, -0.8, -0.45] });

const canvas = query<HTMLCanvasElement>('#candidate');
const sceneControl = query<HTMLSelectElement>('#scene');
const qualityControl = query<HTMLSelectElement>('#quality');
const pixelRatioControl = query<HTMLInputElement>('#pixel-ratio');
const pixelRatioValue = query<HTMLOutputElement>('#pixel-ratio-value');
const viewControl = query<HTMLSelectElement>('#view');
const renderButton = query<HTMLButtonElement>('#render');
const resultNode = query<HTMLElement>('#result');
let active: ActiveCandidate | null = null;
let generation = 0;

renderButton.addEventListener('click', () => { void renderSelected(); });
sceneControl.addEventListener('change', () => { viewControl.disabled = sceneControl.value === 'analytic'; });
pixelRatioControl.addEventListener('input', updatePixelRatioLabel);
window.addEventListener('pagehide', dispose, { once: true });

void runInitial();

async function runInitial(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.get('scene') === 'analytic') sceneControl.value = 'analytic';
  if (params.get('quality') === 'low' || params.get('quality') === 'high') qualityControl.value = params.get('quality')!;
  if (params.get('view') && [...viewControl.options].some(option => option.value === params.get('view'))) viewControl.value = params.get('view')!;
  pixelRatioControl.value = String(parsePixelRatio(params.get('pixelRatio'), window.devicePixelRatio));
  updatePixelRatioLabel();
  viewControl.disabled = sceneControl.value === 'analytic';
  if (params.get('evidence') === '1') {
    const reports: CandidateReport[] = [];
    reports.push(await renderCandidate('analytic', parseQuality(qualityControl.value), 'raw'));
    reports.push(await renderCandidate('material', parseQuality(qualityControl.value), parseView(viewControl.value)));
    const reviewCapture = params.get('review') === '1' ? captureReviewCanvas(parseView(viewControl.value)) : undefined;
    publish('passed', { schemaVersion: 1, suite: 'ray-tracing-example-product-candidates', status: 'passed', cases: reports, reviewCapture, unclassifiedFailureCount: 0 });
    return;
  }
  await renderSelected();
}

async function renderSelected(): Promise<void> {
  try {
    const report = await renderCandidate(parseScene(sceneControl.value), parseQuality(qualityControl.value), parseView(viewControl.value));
    publish('passed', { schemaVersion: 1, suite: 'ray-tracing-example', status: 'passed', ...report });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    setStatus('渲染失败', 0); query<HTMLElement>('#diagnostics').textContent = message;
    publish('failed', { schemaVersion: 1, suite: 'ray-tracing-example', status: 'failed', error: message, unclassifiedFailureCount: 1 });
    console.error(error);
  }
}

async function renderCandidate(sceneId: SceneId, quality: Quality, view: View): Promise<CandidateReport> {
  const runGeneration = ++generation;
  renderButton.disabled = true;
  active?.dispose(); active = null;
  setStatus('请求 WebGPU device…', 0.03);
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('RAY_EXAMPLE_WEBGPU_UNAVAILABLE');
  const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  const resolution = resolveRenderResolution(device, quality);
  const errors: string[] = [];
  const onError = (event: GPUUncapturedErrorEvent) => errors.push(event.error.message);
  device.addEventListener('uncapturederror', onError);
  let owned: ActiveCandidate | null = null;
  try {
    const output = sceneId === 'analytic'
      ? await renderAnalytic(device, quality, resolution, runGeneration)
      : await renderMaterial(device, quality, view, resolution, runGeneration);
    owned = output.owned;
    if (runGeneration !== generation) throw new DOMException('Superseded ray example render.', 'AbortError');
    if (errors.length > 0) throw new Error(`RAY_EXAMPLE_GPU_VALIDATION:${errors.join('; ')}`);
    active = { dispose() { owned?.dispose(); owned = null; device.removeEventListener('uncapturederror', onError); device.destroy(); } };
    draw(output.pixels, output.report.width, output.report.height);
    updateMetrics(output.report);
    setStatus('完成', 1);
    return output.report;
  } catch (error) {
    owned?.dispose(); device.removeEventListener('uncapturederror', onError); device.destroy();
    throw error;
  } finally {
    if (runGeneration === generation) renderButton.disabled = false;
  }
}

async function renderAnalytic(device: GPUDevice, quality: Quality, resolution: RenderResolution, runGeneration: number) {
  const config = QUALITY[quality];
  const { width, height } = resolution;
  const sourceSha256 = await sha256Text(JSON.stringify(ANALYTIC_DEFINITION));
  const identity = Object.freeze({ instanceId: 'analytic:sphere:instance', entityId: 'analytic:sphere', geometryId: 'analytic:sphere', geometryRevision: 1, primitiveIndex: 0 });
  const snapshot: rayScene.RaySceneSnapshot = Object.freeze({
    schemaVersion: 1,
    sourceRevision: Object.freeze({ worldId: 0, structureVersion: 1, componentChangeRevision: 0 }),
    revision: 'ray-example:analytic:v1', fingerprint: `sha256:${sourceSha256}`,
    geometries: Object.freeze([]), instances: Object.freeze([]),
    analyticPrimitives: Object.freeze([{ kind: 'sphere' as const, identity, center: [0, 0, 0] as const, radius: 0.78, transform: identityMatrix() }]),
    provenance: Object.freeze([]), diagnostics: Object.freeze([]),
  });
  setStatus('构建 analytic acceleration…', 0.15);
  const builder = new rayAcceleration.RayAccelerationBuilder(); const buildStart = performance.now();
  const update = builder.update(snapshot); const buildMs = performance.now() - buildStart;
  if (!update.snapshot) throw new Error(formatDiagnostics(update.diagnostics));
  const created = await rayTraversal.RayTraversalRuntime.create(device, update.snapshot.packed);
  if (!created.runtime) throw new Error(formatDiagnostics(created.diagnostics));
  const runtime = created.runtime;
  setStatus('GPU traversal…', 0.55);
  const rays: rayReferenceInput[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = ((x + 0.5) / width * 2 - 1) * 1.6;
    const py = (1 - (y + 0.5) / height * 2) * 0.9;
    rays.push({ origin: [px, py, 3], direction: [0, 0, -1], tMin: 0.01, tMax: 10 });
  }
  const traversal = await runtime.execute(rays, { mode: 'closest-hit' });
  if (traversal.status !== 'ok') throw new Error(formatDiagnostics(traversal.diagnostics));
  if (runGeneration !== generation) throw new DOMException('Superseded ray example render.', 'AbortError');
  const pixels = new Uint8Array(width * height * 4);
  traversal.hits.forEach((hit, index) => {
    const offset = index * 4;
    if (hit) {
      const normal = hit.facingNormal; pixels[offset] = Math.round((normal[0] * 0.5 + 0.5) * 255); pixels[offset + 1] = Math.round((normal[1] * 0.5 + 0.5) * 255); pixels[offset + 2] = Math.round((normal[2] * 0.5 + 0.5) * 255);
    } else { pixels[offset] = 4; pixels[offset + 1] = 10; pixels[offset + 2] = 24; }
    pixels[offset + 3] = 255;
  });
  const report: CandidateReport = Object.freeze({ sceneId: 'analytic', fixedSceneId: 'ray-analytic-sphere-v1', fixedCameraReplayId: 'ray-analytic-orthographic-v1', sourceSha256: `sha256:${sourceSha256}`, candidateSha256: `sha256:${await sha256Bytes(pixels)}`, width, height, displayWidth: resolution.displayWidth, displayHeight: resolution.displayHeight, pixelRatio: resolution.pixelRatio, resolutionSource: resolution.source, buildMs, gpuTimeNs: traversal.gpuTimeNs, peakBytes: traversal.memory.peakBytes, liveResourceCount: traversal.memory.liveResourceCount, counters: traversal.counters, pixelSummary: summarizePixels(pixels), stageTimings: Object.freeze({ build: buildMs, traversal: traversal.gpuTimeNs === null ? null : traversal.gpuTimeNs / 1e6, shading: 0, denoise: 0, composite: 0 }), diagnostics: freezeDiagnostics([...created.diagnostics, ...traversal.diagnostics]), unclassifiedFailureCount: 0 });
  return { pixels, report, owned: { dispose() { runtime.destroy(); builder.destroy(); } } };
}

type rayReferenceInput = { readonly origin: readonly [number, number, number]; readonly direction: readonly [number, number, number]; readonly tMin: number; readonly tMax: number };

async function renderMaterial(device: GPUDevice, quality: Quality, view: View, resolution: RenderResolution, runGeneration: number) {
  const config = QUALITY[quality]; const world = createMaterialWorld();
  const sourceSha256 = await sha256Text(JSON.stringify(MATERIAL_DEFINITION));
  const builder = new rayAcceleration.RayAccelerationBuilder();
  setStatus('提取场景并构建 BLAS/TLAS…', 0.12); const buildStart = performance.now();
  const extracted = rayScene.extractRayTracingScene(world); if (!extracted.valid) throw new Error(formatDiagnostics(extracted.diagnostics));
  const update = builder.update(extracted.snapshot); if (!update.snapshot) throw new Error(formatDiagnostics(update.diagnostics));
  const materials = rayMaterial.packRayPbrMaterialScene(world, update.snapshot.packed); if (!materials.packed) throw new Error(formatDiagnostics(materials.diagnostics));
  const facts = rayPathTracing.extractRayPathSceneFacts(world); if (!facts.facts) throw new Error(formatDiagnostics(facts.diagnostics));
  const buildMs = performance.now() - buildStart;
  setStatus('创建 path tracing pipelines…', 0.28);
  const baseCreated = await rayPathTracing.RayPathTracingRenderer.create(device, update.snapshot.packed, materials.packed); if (!baseCreated.renderer) throw new Error(formatDiagnostics(baseCreated.diagnostics));
  const denoiseCreated = await rayDenoise.RaySpatialTemporalDenoiser.create(device); if (!denoiseCreated.denoiser) { baseCreated.renderer.destroy(); throw new Error(formatDiagnostics(denoiseCreated.diagnostics)); }
  const progressiveCreated = await raySampling.RayProgressiveRenderer.create(device, baseCreated.renderer, denoiseCreated.denoiser); if (!progressiveCreated.renderer) { denoiseCreated.denoiser.destroy(); baseCreated.renderer.destroy(); throw new Error(formatDiagnostics(progressiveCreated.diagnostics)); }
  const progressive = progressiveCreated.renderer; const denoiser = denoiseCreated.denoiser; const base = baseCreated.renderer;
  const frame = Object.freeze({ facts: facts.facts, revision: raySampling.createRayProgressiveFrameRevision(update.snapshot, materials.packed, facts.facts) });
  const probe = await base.render(facts.facts, { width: resolution.width, height: resolution.height, maxBounces: config.bounces, seed: 0x39f10a7d, exposure: 1, toneMapping: 'aces', readback: true });
  if (probe.status !== 'ok' || !probe.pixels) throw new Error(formatDiagnostics(probe.diagnostics));
  const probeSummary = summarizePixels(probe.pixels);
  if (probe.counters.hits < 1 || probeSummary.nonBlackPixelCount < 1) throw new Error(`RAY_EXAMPLE_PATH_OUTPUT_DEGENERATE:${JSON.stringify({ counters: probe.counters, pixelSummary: probeSummary })}`);
  let rendered: Awaited<ReturnType<typeof progressive.render>> | null = null;
  for (let sample = 1; sample <= config.samples; sample++) {
    setStatus(`Progressive sample ${sample}/${config.samples}…`, 0.3 + sample / config.samples * 0.62);
    rendered = await progressive.render(frame, { width: resolution.width, height: resolution.height, maxBounces: config.bounces, baseSeed: 0x39f10a7d, qualityRevision: `example:${quality}:pixel-ratio:${resolution.pixelRatio}`, view, readback: sample === config.samples });
    if (rendered.status !== 'ok') throw new Error(formatDiagnostics(rendered.diagnostics));
    if (runGeneration !== generation) throw new DOMException('Superseded ray example render.', 'AbortError');
  }
  if (!rendered?.pixels) throw new Error('RAY_EXAMPLE_READBACK_MISSING');
  const pixels = rendered.pixels;
  const pixelSummary = summarizePixels(pixels);
  if (pixelSummary.nonBlackPixelCount < 1) throw new Error(`RAY_EXAMPLE_PROGRESSIVE_OUTPUT_DEGENERATE:${JSON.stringify(pixelSummary)}`);
  const diagnostics = [...extracted.diagnostics, ...update.diagnostics, ...materials.diagnostics, ...facts.diagnostics, ...baseCreated.diagnostics, ...denoiseCreated.diagnostics, ...progressiveCreated.diagnostics, ...rendered.diagnostics];
  const timed = (...values: readonly (number | null)[]): number | null => values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const gpuTimeNs = timed(rendered.timing.samplingNs, rendered.timing.accumulationNs, rendered.timing.denoiseTemporalNs, rendered.timing.denoiseSpatialNs, rendered.timing.presentNs);
  const report: CandidateReport = Object.freeze({ sceneId: 'material', fixedSceneId: 'ray-pbr-material-room-v1', fixedCameraReplayId: 'ray-pbr-material-room-camera-v1', sourceSha256: `sha256:${sourceSha256}`, candidateSha256: `sha256:${await sha256Bytes(pixels)}`, width: resolution.width, height: resolution.height, displayWidth: resolution.displayWidth, displayHeight: resolution.displayHeight, pixelRatio: resolution.pixelRatio, resolutionSource: resolution.source, buildMs, gpuTimeNs, peakBytes: rendered.memory.peakBytes, liveResourceCount: rendered.memory.liveResourceCount, counters: Object.freeze({ samples: rendered.statistics.sampleCount, resets: rendered.statistics.resetCount, pixels: resolution.width * resolution.height, path: probe.counters }), pixelSummary, stageTimings: Object.freeze({ build: buildMs, pathTracing: rendered.timing.samplingNs === null ? null : rendered.timing.samplingNs / 1e6, accumulation: rendered.timing.accumulationNs === null ? null : rendered.timing.accumulationNs / 1e6, denoise: timed(rendered.timing.denoiseTemporalNs, rendered.timing.denoiseSpatialNs) === null ? null : timed(rendered.timing.denoiseTemporalNs, rendered.timing.denoiseSpatialNs)! / 1e6, composite: rendered.timing.presentNs === null ? null : rendered.timing.presentNs / 1e6 }), diagnostics: freezeDiagnostics([...diagnostics, ...probe.diagnostics]), unclassifiedFailureCount: 0 });
  return { pixels, report, owned: { dispose() { progressive.destroy(); denoiser.destroy(); base.destroy(); builder.destroy(); world.destroy(); } } };
}

function createMaterialWorld(): World {
  const world = new World('Ray material room');
  const floor = new PbrMaterial({ baseColor: [0.18, 0.22, 0.3, 1], metallic: 0.05, roughness: 0.82 });
  const red = new PbrMaterial({ baseColor: [0.86, 0.08, 0.04, 1], metallic: 0.08, roughness: 0.45 });
  const metal = new PbrMaterial({ baseColor: [0.72, 0.78, 0.9, 1], metallic: 0.92, roughness: 0.16 });
  const emissive = new PbrMaterial({ baseColor: [0.08, 0.22, 0.32, 1], metallic: 0, roughness: 0.58, emissiveFactor: [0.18, 0.42, 0.8] });
  addMesh(world, 'Floor', createBox3D({ width: 9, height: 0.22, depth: 7 }), floor, [0, -1.65, -1]);
  addMesh(world, 'Back', createBox3D({ width: 9, height: 5.2, depth: 0.2 }), floor, [0, 0.8, -4.4]);
  addMesh(world, 'Red sphere', withoutDegenerateTriangles(createSphere3D({ radius: 1.15, widthSegments: 32, heightSegments: 20 })), red, [-1.9, -0.4, -1.2]);
  addMesh(world, 'Metal sphere', withoutDegenerateTriangles(createSphere3D({ radius: 1.05, widthSegments: 32, heightSegments: 20 })), metal, [1.45, -0.55, -1.8]);
  addMesh(world, 'Emissive cube', createBox3D({ width: 1.1, height: 1.1, depth: 1.1 }), emissive, [0.2, 1.05, -2.8], [0.2, 0.45, 0]);
  world.addEntity(new Entity('Camera').add(new Transform3D().setTranslation(0, 1.1, 7.2)).add(new Camera3D({ fov: Math.PI / 3, near: 0.05, far: 80 })));
  world.addEntity(new Entity('Sun').add(new DirectionalLight({ direction: [-0.35, -0.8, -0.45], color: [1, 0.92, 0.8], intensity: 2.4 })));
  world.addEntity(new Entity('Environment').add(new EnvironmentLight({ intensity: 0.26, diffuseColor: [0.08, 0.13, 0.24], specularColor: [0.25, 0.38, 0.62] })));
  return world;
}

function addMesh(world: World, name: string, geometry: Geometry3D, material: PbrMaterial, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]): void {
  world.addEntity(new Entity(name).add(new CartesianTransform3D({ position, rotation })).add(new Mesh3D(geometry, material)));
}

function withoutDegenerateTriangles(source: Geometry3D): Geometry3D {
  if (!source.indices) return source;
  const kept: number[] = []; const positions = source.positions;
  for (let offset = 0; offset < source.indices.length; offset += 3) {
    const a = (source.indices[offset] ?? 0) * 3; const b = (source.indices[offset + 1] ?? 0) * 3; const c = (source.indices[offset + 2] ?? 0) * 3;
    const abx = (positions[b] ?? 0) - (positions[a] ?? 0); const aby = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0); const abz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0);
    const acx = (positions[c] ?? 0) - (positions[a] ?? 0); const acy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0); const acz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
    const crossX = aby * acz - abz * acy; const crossY = abz * acx - abx * acz; const crossZ = abx * acy - aby * acx;
    const areaSquared = crossX * crossX + crossY * crossY + crossZ * crossZ;
    const edgeScale = Math.max((abx * abx + aby * aby + abz * abz) * (acx * acx + acy * acy + acz * acz), 1);
    if (areaSquared > 1e-24 * edgeScale) kept.push(source.indices[offset]!, source.indices[offset + 1]!, source.indices[offset + 2]!);
  }
  const indices = source.indices instanceof Uint32Array ? Uint32Array.from(kept) : Uint16Array.from(kept);
  return new Geometry3D({
    positions: source.positions,
    ...(source.normals ? { normals: source.normals } : {}),
    textureCoordinates: [...source.textureCoordinates].map(([set, data]) => ({ set, data })),
    textureCoordinateLayout: source.textureCoordinateLayout,
    indices,
    ...(source.topology ? { topology: source.topology } : {}),
    ...(source.cullMode ? { cullMode: source.cullMode } : {}),
    ...(source.frontFace ? { frontFace: source.frontFace } : {}),
  });
}

function draw(pixels: Uint8Array, width: number, height: number): void {
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('RAY_EXAMPLE_2D_CONTEXT_UNAVAILABLE');
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
}

function summarizePixels(pixels: Uint8Array): PixelSummary {
  let maximumChannel = 0; let nonBlackPixelCount = 0; const sums = [0, 0, 0];
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] ?? 0; const green = pixels[offset + 1] ?? 0; const blue = pixels[offset + 2] ?? 0;
    maximumChannel = Math.max(maximumChannel, red, green, blue);
    if (red > 2 || green > 2 || blue > 2) nonBlackPixelCount++;
    sums[0]! += red; sums[1]! += green; sums[2]! += blue;
  }
  const count = pixels.length / 4;
  const meanRgb: readonly [number, number, number] = Object.freeze([
    Math.round(sums[0]! / count * 1000) / 1000,
    Math.round(sums[1]! / count * 1000) / 1000,
    Math.round(sums[2]! / count * 1000) / 1000,
  ]);
  return Object.freeze({ maximumChannel, nonBlackPixelCount, meanRgb });
}

function captureReviewCanvas(view: View): Readonly<{ view: View; nativeWidth: number; nativeHeight: number; width: number; height: number; pngBase64: string }> {
  const scale = 6; const review = document.createElement('canvas');
  review.width = canvas.width * scale; review.height = canvas.height * scale;
  const context = review.getContext('2d'); if (!context) throw new Error('RAY_EXAMPLE_REVIEW_CONTEXT_UNAVAILABLE');
  context.imageSmoothingEnabled = false; context.drawImage(canvas, 0, 0, review.width, review.height);
  return Object.freeze({ view, nativeWidth: canvas.width, nativeHeight: canvas.height, width: review.width, height: review.height, pngBase64: review.toDataURL('image/png').split(',', 2)[1] ?? '' });
}

function updateMetrics(report: CandidateReport): void {
  query<HTMLElement>('#resolution').textContent = `${report.width} × ${report.height} (${report.pixelRatio.toFixed(2)}×)`;
  query<HTMLElement>('#source').textContent = report.sourceSha256.slice(7, 19);
  query<HTMLElement>('#build').textContent = `${report.buildMs.toFixed(1)} ms`;
  query<HTMLElement>('#gpu').textContent = report.gpuTimeNs === null ? 'unavailable' : `${(report.gpuTimeNs / 1e6).toFixed(2)} ms`;
  query<HTMLElement>('#memory').textContent = `${(report.peakBytes / 1048576).toFixed(2)} MiB`;
  query<HTMLElement>('#resources').textContent = String(report.liveResourceCount);
  query<HTMLElement>('#diagnostics').textContent = report.diagnostics.map(value => `${value.severity} ${value.code}`).join('\n') || 'No diagnostics';
}

function resolveRenderResolution(device: GPUDevice, quality: Quality): RenderResolution {
  const params = new URLSearchParams(location.search);
  const fixed = params.get('evidence') === '1' ? parseFixedResolution(params.get('resolution')) : null;
  const rect = canvas.getBoundingClientRect();
  const displayWidth = Math.max(1, Math.round(rect.width));
  const displayHeight = Math.max(1, Math.round(rect.height));
  const pixelRatio = fixed ? 1 : parsePixelRatio(pixelRatioControl.value, window.devicePixelRatio);
  const legacyEvidence = quality === 'low' ? [96, 54] as const : quality === 'high' ? [160, 90] as const : [128, 72] as const;
  const width = fixed?.width ?? (params.get('evidence') === '1' ? legacyEvidence[0] : Math.max(1, Math.round(displayWidth * pixelRatio)));
  const height = fixed?.height ?? (params.get('evidence') === '1' ? legacyEvidence[1] : Math.max(1, Math.round(displayHeight * pixelRatio)));
  if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D) {
    throw new Error(`RAY_EXAMPLE_RESOLUTION_UNSUPPORTED:${JSON.stringify({ width, height, maxTextureDimension2D: device.limits.maxTextureDimension2D })}`);
  }
  return Object.freeze({ width, height, displayWidth, displayHeight, pixelRatio, source: params.get('evidence') === '1' ? 'evidence-fixed' : 'viewport' });
}

function parseFixedResolution(value: string | null): Readonly<{ width: number; height: number }> | null {
  const match = /^(\d+)x(\d+)$/u.exec(value ?? '');
  if (!match) return null;
  const width = Number(match[1]); const height = Number(match[2]);
  return width > 0 && height > 0 ? Object.freeze({ width, height }) : null;
}

function parsePixelRatio(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Math.min(2, Math.max(0.25, Number.isFinite(parsed) ? parsed : 1));
}

function updatePixelRatioLabel(): void { pixelRatioValue.value = `${parsePixelRatio(pixelRatioControl.value, 1).toFixed(2)}×`; }

function setStatus(message: string, progress: number): void { query<HTMLElement>('#status').textContent = message; query<HTMLProgressElement>('#progress').value = progress; }
function dispose(): void { generation++; active?.dispose(); active = null; }
function identityMatrix(): readonly number[] { return Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
function freezeDiagnostics(values: readonly { readonly code: string; readonly severity: string; readonly message: string }[]): readonly Readonly<{ code: string; severity: string; message: string }>[] { return Object.freeze(values.map(value => Object.freeze({ code: value.code, severity: value.severity, message: value.message }))); }
function formatDiagnostics(values: readonly { readonly code: string; readonly message: string }[]): string { return JSON.stringify(values.map(value => ({ code: value.code, message: value.message }))); }
function parseScene(value: string): SceneId { return value === 'analytic' ? 'analytic' : 'material'; }
function parseQuality(value: string): Quality { return value === 'low' || value === 'high' ? value : 'medium'; }
function parseView(value: string): View { return value === 'raw' || value === 'variance' || value === 'history-age' || value === 'feature' ? value : 'denoised'; }
async function sha256Text(value: string): Promise<string> { return sha256Bytes(new TextEncoder().encode(value)); }
async function sha256Bytes(value: Uint8Array): Promise<string> { const copy = Uint8Array.from(value); return [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function publish(status: 'passed' | 'failed', value: unknown): void { resultNode.dataset.status = status; resultNode.textContent = JSON.stringify(value); document.body.dataset.renderStatus = status; }
function query<T extends Element>(selector: string): T { const value = document.querySelector<T>(selector); if (!value) throw new Error(`Ray tracing example is missing ${selector}.`); return value; }
