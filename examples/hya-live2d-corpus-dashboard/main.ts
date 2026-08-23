import { parseAnimation } from '@haiyue/animation-spec';
import {
  createDeformableMesh2DFormatRegistry,
  decodeDeformableMesh2DData,
} from '@haiyue/animation-spec/deformable2d';
import type { CubismDrawableCapture } from '@haiyue/animation-spec/live2d';
import {
  Animation2DComponent,
  Animation2DExtensionRegistry,
  Animation2DRenderSystem,
  Animation2DSystem,
} from '@haiyue/extensions/animation';
import {
  createDeformableMesh2DRuntimeExtension,
  type DeformableMesh2DRuntimeStatus,
} from '@haiyue/extensions/deformable-animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';

interface CorpusManifest {
  readonly schemaVersion: number;
  readonly featureStatus: string;
  readonly samples: readonly CorpusManifestSample[];
  readonly externalOfficialSamples: readonly ExternalSample[];
}

interface DashboardFeatureStatus {
  readonly schemaVersion: number;
  readonly kind: 'haiyue-live2d-dashboard-feature-status';
  readonly generatedFrom: { readonly manifestId: string; readonly candidateRevision: string; readonly formalEvidence: boolean };
  readonly features: readonly DashboardFeature[];
  readonly licensedSamples: readonly DashboardLicensedSample[];
  readonly missingLocalAssetMessage: string;
}

interface DashboardFeature {
  readonly id: string;
  readonly title: string;
  readonly implementationStatus: 'supported' | 'degraded' | 'unsupported';
  readonly coverageStatus: 'covered' | 'not-covered' | 'not-applicable';
  readonly detail: string;
}

interface DashboardLicensedSample {
  readonly id: string;
  readonly title: string;
  readonly implementationEvidence: string;
  readonly coverageStatus: 'covered';
  readonly observations: Readonly<Record<string, number>>;
  readonly localOnly: true;
}

interface CorpusManifestSample {
  readonly id: string;
  readonly title: string;
  readonly hya: string;
  readonly data: string;
  readonly texture: string;
  readonly license: string;
  readonly referenceMode: string;
}

interface ExternalSample {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly license: string;
  readonly bundled: false;
}

interface LoadedCorpus {
  readonly manifest: CorpusManifest;
  readonly featureStatus: DashboardFeatureStatus;
  readonly capture: CubismDrawableCapture;
  readonly captureBytes: number;
  readonly hyaBytes: ArrayBuffer;
  readonly dataBytes: ArrayBuffer;
  readonly textureBytes: ArrayBuffer;
}

const SAMPLE_ROOT = './samples';
const VIEW_SIZE = 512;

async function main(): Promise<void> {
  const corpus = await loadCorpus();
  const parseStarted = performance.now();
  const animation = parseAnimation(corpus.hyaBytes, { extensions: createDeformableMesh2DFormatRegistry() });
  const parseMs = performance.now() - parseStarted;
  const meshData = decodeDeformableMesh2DData(corpus.dataBytes);
  const sample = corpus.manifest.samples[0];
  if (!sample) throw new Error('Live2D corpus manifest contains no bundled sample.');

  renderCorpusSummary(corpus, meshData.drawables.length, meshData.times.length);
  renderCapabilityMatrix(corpus.featureStatus);
  renderCorpusRows(corpus.manifest, corpus.featureStatus, sample);

  const canvas = required<HTMLCanvasElement>('#preview-canvas');
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.012, g: 0.02, b: 0.052, a: 1 },
    devicePixelRatio: 1,
    timestampQuery: false,
    renderProfile: 'simple',
  });
  await engine.init();
  const errors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const camera = new Entity('Live2D corpus camera').addComponent(new Camera2D({
    width: VIEW_SIZE,
    height: VIEW_SIZE,
    designWidth: VIEW_SIZE,
    designHeight: VIEW_SIZE,
    viewportMode: 'fit',
  }));
  const scene = engine.createScene({
    name: 'HYA Live2D corpus dashboard',
    camera: { type: '2d', entity: camera },
    view: { clearColor: { r: 0.012, g: 0.02, b: 0.052, a: 1 } },
    render3D: false,
    render2D: false,
    gui: false,
    pipelineLabel: 'HyaLive2DCorpus.render',
  });
  const runtimeExtensions = new Animation2DExtensionRegistry();
  let runtimeStatus: DeformableMesh2DRuntimeStatus = { state: 'loading', drawableCount: 0 };
  const unregister = runtimeExtensions.register(createDeformableMesh2DRuntimeExtension({
    onStatus(status) {
      runtimeStatus = status;
      required('#runtime-state').textContent = status.state;
      const sampleState = document.querySelector<HTMLElement>('[data-sample-state]');
      if (sampleState) sampleState.textContent = status.state === 'ready' ? '已验证' : status.state;
      if (status.error) errors.push(status.error);
    },
  }));
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  const renderer = new Animation2DRenderSystem(engine, camera, { loadOp: 'clear', maxMaskTargets: 8 });
  scene.addSystem(renderer);
  const player = new Animation2DComponent(animation, { autoplay: true, loop: true, runtimeExtensions });
  scene.add(new Entity('Bundled MIT Cubism capture').addComponent(new Transform2D()).addComponent(player));
  bindTransport(player, animation.duration);

  engine.switchScene(scene);
  engine.run();
  let frames = 0;
  let finished = false;
  engine.on('after-update', () => {
    frames++;
    required<HTMLInputElement>('#timeline').value = String(player.currentTime);
    required('#current-time').textContent = `${player.currentTime.toFixed(2)} / ${animation.duration.toFixed(2)}s`;
    if (!finished && runtimeStatus.state === 'ready' && frames >= 12) {
      finished = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scoped = await engine.device.popErrorScope();
    if (scoped) errors.push(scoped.message);
    if (renderer.stats.visualCount < 1) errors.push('No deformable visual reached the renderer.');
    if (runtimeStatus.drawableCount !== meshData.drawables.length) {
      errors.push(`Expected ${meshData.drawables.length} drawables, received ${runtimeStatus.drawableCount}.`);
    }
    const status = errors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderStatus = status;
    required('#page-state').textContent = status === 'passed' ? 'WebGPU playback ready' : 'validation failed';
    const result = required<HTMLPreElement>('#result');
    result.dataset.status = status;
    result.textContent = JSON.stringify({
      status,
      corpus: 'hya-live2d-public-v1',
      bundledSamples: corpus.manifest.samples.length,
      licenseGatedCandidates: corpus.manifest.externalOfficialSamples.length,
      licensedEvidenceSamples: corpus.featureStatus.licensedSamples.length,
      featureStatusKind: corpus.featureStatus.kind,
      implementationStates: [...new Set(corpus.featureStatus.features.map(feature => feature.implementationStatus))].sort(),
      coverageStates: [...new Set(corpus.featureStatus.features.map(feature => feature.coverageStatus))].sort(),
      capabilityDetailCount: corpus.featureStatus.features.length,
      missingLocalAssetMessage: corpus.featureStatus.missingLocalAssetMessage,
      runtime: runtimeStatus,
      renderer: renderer.stats,
      metrics: {
        captureBytes: corpus.captureBytes,
        hyaBytes: corpus.hyaBytes.byteLength,
        sidecarBytes: corpus.dataBytes.byteLength,
        textureBytes: corpus.textureBytes.byteLength,
        parseMs,
        frameCount: meshData.times.length,
        drawableCount: meshData.drawables.length,
      },
      cubismRuntimeInBrowser: false,
      errors,
    });
  }

  window.addEventListener('beforeunload', () => {
    unregister();
    engine.destroy();
  }, { once: true });
}

async function loadCorpus(): Promise<LoadedCorpus> {
  const manifest = await fetchJson<CorpusManifest>(`${SAMPLE_ROOT}/manifest.json`);
  if (manifest.schemaVersion !== 1 || typeof manifest.featureStatus !== 'string' || !Array.isArray(manifest.samples) || !Array.isArray(manifest.externalOfficialSamples)) {
    throw new Error('Live2D corpus manifest format is invalid.');
  }
  const [featureStatus, captureResponse, hyaBytes, dataBytes, textureBytes] = await Promise.all([
    fetchJson<DashboardFeatureStatus>(`${SAMPLE_ROOT}/${manifest.featureStatus}`),
    fetch(`${SAMPLE_ROOT}/mascot.capture.json`, { cache: 'no-store' }),
    fetchBytes(`${SAMPLE_ROOT}/mascot.hya`),
    fetchBytes(`${SAMPLE_ROOT}/mascot.hydm`),
    fetchBytes(`${SAMPLE_ROOT}/mascot.png`),
  ]);
  if (featureStatus.schemaVersion !== 1 || featureStatus.kind !== 'haiyue-live2d-dashboard-feature-status' || !Array.isArray(featureStatus.features) || !Array.isArray(featureStatus.licensedSamples)) throw new Error('Live2D feature status format is invalid.');
  if (!captureResponse.ok) throw new Error(`Capture request failed with HTTP ${captureResponse.status}.`);
  const captureText = await captureResponse.text();
  const capture = JSON.parse(captureText) as CubismDrawableCapture;
  return {
    manifest,
    featureStatus,
    capture,
    captureBytes: new TextEncoder().encode(captureText).byteLength,
    hyaBytes,
    dataBytes,
    textureBytes,
  };
}

function renderCorpusSummary(corpus: LoadedCorpus, drawableCount: number, frameCount: number): void {
  const runtimeBytes = corpus.hyaBytes.byteLength + corpus.dataBytes.byteLength;
  const saving = corpus.captureBytes > 0 ? 1 - runtimeBytes / corpus.captureBytes : 0;
  setMetric('metric-samples', String(corpus.manifest.samples.length), `${corpus.featureStatus.licensedSamples.length} 个本地真实 evidence case`);
  setMetric('metric-delivery', formatBytes(runtimeBytes), `HYA + HYDM，比 capture 少 ${formatPercent(saving)}`);
  setMetric('metric-frames', String(frameCount), `${corpus.capture.duration.toFixed(2)}s · ${corpus.capture.frameRate.toFixed(0)} fps`);
  setMetric('metric-drawables', String(drawableCount), `${countVertices(corpus.capture)} vertices / frame`);
  required('#report-meta').textContent = `hya-live2d-public-v1 · ${corpus.featureStatus.generatedFrom.manifestId} · dirty candidate ${corpus.featureStatus.generatedFrom.candidateRevision} · ${formatBytes(corpus.textureBytes.byteLength)} public texture`;
}

function renderCapabilityMatrix(status: DashboardFeatureStatus): void {
  const body = required<HTMLTableSectionElement>('#capability-rows');
  for (const feature of status.features) {
    const row = document.createElement('tr');
    row.dataset.featureId = feature.id;
    row.innerHTML = `<td><strong>${escapeHtml(feature.title)}</strong><code>${escapeHtml(feature.id)}</code></td><td><span class="status status--${feature.implementationStatus}">${escapeHtml(feature.implementationStatus)}</span></td><td><span class="status status--${feature.coverageStatus}">${escapeHtml(feature.coverageStatus)}</span></td><td><details><summary>查看证据</summary><span>${escapeHtml(feature.detail)}</span></details></td>`;
    body.append(row);
  }
}

function renderCorpusRows(manifest: CorpusManifest, status: DashboardFeatureStatus, bundled: CorpusManifestSample): void {
  const body = required<HTMLTableSectionElement>('#sample-rows');
  const bundledRow = document.createElement('tr');
  bundledRow.innerHTML = `<td><div class="sample"><img src="${SAMPLE_ROOT}/${encodeURIComponent(bundled.texture)}" alt="" /><span><strong>${escapeHtml(bundled.title)}</strong><code>${escapeHtml(bundled.id)}</code></span></div></td><td>${escapeHtml(bundled.license)}</td><td>${escapeHtml(bundled.referenceMode)}</td><td><span class="status status--loading" data-sample-state>loading</span></td>`;
  body.append(bundledRow);
  for (const sample of manifest.externalOfficialSamples) {
    const evidence = status.licensedSamples.find(candidate => candidate.id === sample.id);
    const observations = evidence ? Object.entries(evidence.observations).filter(([, count]) => count > 0).map(([feature, count]) => `${feature}=${count}`).join(' · ') : '等待本地验证';
    const row = document.createElement('tr');
    row.innerHTML = `<td><div class="sample"><span><strong><a href="${escapeHtml(sample.model)}" target="_blank" rel="noreferrer">${escapeHtml(sample.title)} ↗</a></strong><code>${escapeHtml(sample.id)}</code></span></div></td><td>${escapeHtml(sample.license)}</td><td><details><summary>本地官方 Core 对照</summary><span>${escapeHtml(observations)}</span><small>${escapeHtml(status.missingLocalAssetMessage)}</small></details></td><td><span class="status status--${evidence ? 'covered' : 'license-gated'}">${evidence ? 'covered · local-only' : 'license-gated'}</span></td>`;
    body.append(row);
  }
}

function bindTransport(player: Animation2DComponent, duration: number): void {
  const button = required<HTMLButtonElement>('#play-pause');
  const timeline = required<HTMLInputElement>('#timeline');
  timeline.max = String(duration);
  button.addEventListener('click', () => {
    if (player.playing) player.pause(); else player.play();
    button.textContent = player.playing ? '暂停' : '播放';
  });
  timeline.addEventListener('input', () => player.seek(Number(timeline.value)));
}

function setMetric(id: string, value: string, note: string): void {
  const card = required(`#${id}`);
  requiredDescendant(card, '.metric-value').textContent = value;
  requiredDescendant(card, '.metric-note').textContent = note;
}

function countVertices(capture: CubismDrawableCapture): number {
  return capture.frames[0]?.drawables.reduce((sum, drawable) => sum + drawable.positions.length / 2, 0) ?? 0;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} request failed with HTTP ${response.status}.`);
  return response.arrayBuffer();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} request failed with HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KiB`;
}

function formatPercent(value: number): string { return `${(value * 100).toFixed(1)}%`; }

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function required<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new ReferenceError(`Missing dashboard element: ${selector}`);
  return element;
}

function requiredDescendant(root: Element, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new ReferenceError(`Missing dashboard descendant: ${selector}`);
  return element;
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  const pageState = document.querySelector('#page-state');
  if (pageState) pageState.textContent = 'failed';
  const pageError = document.querySelector<HTMLElement>('#page-error');
  if (pageError) { pageError.hidden = false; pageError.textContent = message; }
  const result = document.querySelector<HTMLPreElement>('#result');
  if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: message }); }
});
