import {
  ANIMATION_MIME_TYPE,
  encodeAnimationBinary,
  parseAnimation,
  type AnimationDocument,
  type AnimationResource,
  type ParsedAnimation,
} from '@haiyue/animation-spec';
import { Animation2DComponent, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import { Particle2DRenderSystem, Particle2DSystem } from '@haiyue/engine/systems';

interface SampleEntry {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly capability: string;
  readonly file: string;
  readonly description: string;
}

interface SampleManifest {
  readonly schemaVersion: 1;
  readonly kind: 'hya-samples';
  readonly entries: readonly SampleEntry[];
}

interface LoadedSource {
  readonly animation: ParsedAnimation;
  readonly bytes: ArrayBuffer;
  readonly label: string;
  readonly sourceUrl?: string;
  readonly warnings: readonly string[];
}

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

async function main(): Promise<void> {
  const sampleRoot = resolveSampleRoot(window.location);
  const manifestUrl = new URL('manifest.json', sampleRoot).href;
  const canvas = query<HTMLCanvasElement>('#canvas');
  const status = query<HTMLElement>('#status');
  const sampleList = query<HTMLElement>('#sample-list');
  const categoryFilter = query<HTMLSelectElement>('#category-filter');
  const search = query<HTMLInputElement>('#sample-search');
  const urlInput = query<HTMLInputElement>('#source-url');
  const fileInput = query<HTMLInputElement>('#source-file');
  const timeline = query<HTMLInputElement>('#timeline');
  const currentTime = query<HTMLOutputElement>('#current-time');
  const duration = query<HTMLOutputElement>('#duration');
  const speed = query<HTMLSelectElement>('#speed');
  const loop = query<HTMLInputElement>('#loop');
  const play = query<HTMLButtonElement>('#play');
  const restart = query<HTMLButtonElement>('#restart');
  const download = query<HTMLButtonElement>('#download');
  const formatPreview = query<HTMLElement>('#format-preview');
  const diagnostics = query<HTMLElement>('#diagnostics');
  const stats = query<HTMLElement>('#stats');
  const detailsTitle = query<HTMLElement>('#details-title');
  const detailsCapability = query<HTMLElement>('#details-capability');
  const detailsDescription = query<HTMLElement>('#details-description');

  setStatus('正在初始化 WebGPU…', 'working');
  const engine = new HaiyueEngine({ canvas, clearColor: { r: 0.012, g: 0.02, b: 0.046, a: 1 } });
  await engine.init();

  const gpuErrors = new Set<string>();
  engine.device.addEventListener('uncapturederror', event => {
    if (gpuErrors.size < 20) gpuErrors.add(event.error.message);
    renderDiagnostics();
  });

  const cameraEntity = new Entity('HYA sample browser camera').addComponent(new Camera2D({
    width: 640, height: 360, designWidth: 640, designHeight: 360, viewportMode: 'fit',
  }));
  const camera = cameraEntity.getComponent(Camera2D)!;
  const scene = engine.createScene({
    name: 'HYA sample browser',
    camera: { type: '2d', entity: cameraEntity },
    render3D: false,
    render2D: false,
    gui: false,
    pipelineLabel: 'HyaSamples.render',
  });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  scene.addSystem(new Particle2DSystem({ priority: -9 }), false);
  const animationRenderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 16 });
  scene.addSystem(animationRenderer);
  scene.addSystem(new Particle2DRenderSystem(engine, cameraEntity, { loadOp: 'load', priority: 10 }));
  engine.switchScene(scene);
  engine.run();

  let manifest: SampleManifest | null = null;
  let activeSampleId = '';
  let playerEntity: Entity | null = null;
  let player: Animation2DComponent | null = null;
  let loaded: LoadedSource | null = null;
  let urlRequest: AbortController | null = null;
  let scrubbing = false;
  let resumeAfterScrub = false;
  let lastDiagnosticSignature = '';

  const install = (source: LoadedSource, sample?: SampleEntry): void => {
    const nextEntity = new Entity(`HYA preview: ${source.label}`).addComponent(new Transform2D());
    const nextPlayer = new Animation2DComponent(source.animation, {
      autoplay: true,
      loop: loop.checked,
      speed: Number(speed.value),
    });
    nextEntity.addComponent(nextPlayer);
    if (playerEntity) scene.remove(playerEntity);
    scene.add(nextEntity);
    playerEntity = nextEntity;
    player = nextPlayer;
    loaded = source;
    activeSampleId = sample?.id ?? '';

    camera.setViewportFit({
      designWidth: source.animation.canvas.width,
      designHeight: source.animation.canvas.height,
      viewportMode: 'fit',
    });
    camera.resize(engine.displayWidth, engine.displayHeight);
    timeline.min = '0';
    timeline.max = String(source.animation.duration);
    timeline.step = String(1 / (source.animation.frameRate ?? 60));
    timeline.value = '0';
    duration.value = formatTime(source.animation.duration);
    play.disabled = false;
    restart.disabled = false;
    timeline.disabled = false;
    download.disabled = false;
    detailsTitle.textContent = sample?.title ?? source.label;
    detailsCapability.textContent = sample?.capability ?? 'external/source';
    detailsDescription.textContent = sample?.description ?? '从 URL 或本地文件载入的 HYA 动画。';
    stats.textContent = [
      `${formatBytes(source.bytes.byteLength)} binary`,
      `${source.animation.nodes.length} nodes`,
      `${source.animation.tracks.length} tracks`,
      `${source.animation.duration.toFixed(2)}s`,
      `${source.animation.frameRate ?? 60}fps`,
    ].join(' · ');
    formatPreview.textContent = stringifyAnimation(source.animation);
    renderSampleList();
    renderDiagnostics(true);
    setStatus(`已载入 ${source.label}`, 'success');
    history.replaceState(null, '', sample ? `?sample=${encodeURIComponent(sample.id)}` : window.location.pathname);
  };

  const loadSample = async (entry: SampleEntry): Promise<void> => {
    setBusy(true, `正在读取 ${entry.title}…`);
    try {
      const source = await fetchSource(new URL(entry.file, sampleRoot).href, entry.title);
      install(source, entry);
    } catch (error) {
      setStatus(errorMessage(error), 'error');
      renderErrorDiagnostic(error);
    } finally {
      setBusy(false);
    }
  };

  const loadUrl = async (): Promise<void> => {
    const value = urlInput.value.trim();
    if (!value) return;
    urlRequest?.abort('replaced');
    const controller = new AbortController();
    urlRequest = controller;
    setBusy(true, '正在读取远程 HYA…');
    try {
      const url = new URL(value, window.location.href);
      const source = await fetchSource(url.href, fileName(url.pathname) || 'Remote HYA', controller.signal);
      if (!controller.signal.aborted) install(source);
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus(`${errorMessage(error)}；跨域地址需要允许 CORS。`, 'error');
        renderErrorDiagnostic(error);
      }
    } finally {
      if (urlRequest === controller) {
        urlRequest = null;
        setBusy(false);
      }
    }
  };

  const loadFile = async (file: File): Promise<void> => {
    setBusy(true, `正在读取 ${file.name}…`);
    try {
      if (file.size > MAX_SOURCE_BYTES) throw new RangeError(`文件超过 ${formatBytes(MAX_SOURCE_BYTES)} 上限。`);
      install(parseLoadedSource(await file.arrayBuffer(), file.name));
    } catch (error) {
      setStatus(errorMessage(error), 'error');
      renderErrorDiagnostic(error);
    } finally {
      fileInput.value = '';
      setBusy(false);
    }
  };

  query<HTMLButtonElement>('#load-url').addEventListener('click', () => void loadUrl());
  urlInput.addEventListener('keydown', event => { if (event.key === 'Enter') void loadUrl(); });
  query<HTMLButtonElement>('#choose-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
  });
  search.addEventListener('input', renderSampleList);
  categoryFilter.addEventListener('change', renderSampleList);
  play.addEventListener('click', () => {
    if (!player) return;
    player.playing ? player.pause() : player.play();
    refreshTransport();
  });
  restart.addEventListener('click', () => player?.seek(0).play());
  speed.addEventListener('change', () => player?.setSpeed(Number(speed.value)));
  loop.addEventListener('change', () => { if (player) player.loop = loop.checked; });
  timeline.addEventListener('pointerdown', () => {
    if (!player) return;
    scrubbing = true;
    resumeAfterScrub = player.playing;
    player.pause();
  });
  timeline.addEventListener('input', () => player?.seek(Number(timeline.value)));
  window.addEventListener('pointerup', () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (resumeAfterScrub) player?.play();
  });
  download.addEventListener('click', () => {
    if (!loaded) return;
    const url = URL.createObjectURL(new Blob([loaded.bytes], { type: ANIMATION_MIME_TYPE }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeStem(loaded.label)}.hya`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  for (const eventName of ['dragenter', 'dragover']) {
    document.addEventListener(eventName, event => {
      event.preventDefault();
      document.body.dataset.dropActive = 'true';
    });
  }
  document.addEventListener('dragleave', event => {
    if (!event.relatedTarget) delete document.body.dataset.dropActive;
  });
  document.addEventListener('drop', event => {
    event.preventDefault();
    delete document.body.dataset.dropActive;
    const file = event.dataTransfer?.files[0];
    if (file) void loadFile(file);
  });

  engine.on('after-update', () => {
    refreshTransport();
    renderDiagnostics();
  });
  window.addEventListener('beforeunload', () => {
    urlRequest?.abort('page-unload');
    engine.destroy();
  }, { once: true });

  try {
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Sample manifest 请求失败：${response.status}`);
    manifest = validateManifest(await response.json());
    populateCategories(manifest.entries);
    renderSampleList();
    const requested = new URLSearchParams(window.location.search).get('sample');
    const initial = manifest.entries.find(entry => entry.id === requested) ?? manifest.entries[0];
    if (!initial) throw new Error('Sample manifest 为空。');
    await loadSample(initial);
  } catch (error) {
    setStatus(errorMessage(error), 'error');
    renderErrorDiagnostic(error);
  }

  function renderSampleList(): void {
    if (!manifest) return;
    const needle = search.value.trim().toLocaleLowerCase();
    const category = categoryFilter.value;
    const entries = manifest.entries.filter(entry => {
      const categoryMatches = !category || entry.category === category;
      const searchMatches = !needle || `${entry.title} ${entry.capability} ${entry.description}`.toLocaleLowerCase().includes(needle);
      return categoryMatches && searchMatches;
    });
    sampleList.replaceChildren(...entries.map(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sample-card';
      button.dataset.active = String(entry.id === activeSampleId);
      const categoryLabel = document.createElement('span');
      categoryLabel.className = 'sample-category';
      categoryLabel.textContent = entry.category;
      const title = document.createElement('strong');
      title.textContent = entry.title;
      const capability = document.createElement('code');
      capability.textContent = entry.capability;
      button.append(categoryLabel, title, capability);
      button.addEventListener('click', () => void loadSample(entry));
      return button;
    }));
    query<HTMLElement>('#sample-empty').hidden = entries.length > 0;
  }

  function renderDiagnostics(force = false): void {
    const runtime = player?.runtimeStats;
    const messages: { kind: string; title: string; detail: string }[] = [];
    if (loaded) messages.push({ kind: 'success', title: 'HYA parse', detail: `格式 ${loaded.animation.version} · ${loaded.animation.source} source` });
    for (const warning of loaded?.warnings ?? []) messages.push({ kind: 'warning', title: 'Resource URL', detail: warning });
    if (runtime?.unsupportedComponentCount) messages.push({ kind: 'warning', title: 'Unsupported component', detail: `${runtime.unsupportedComponentCount} 个组件没有对应运行时。` });
    if (runtime?.pendingResourceCount) messages.push({ kind: 'working', title: 'Loading resources', detail: `${runtime.pendingResourceCount} 个资源仍在加载。` });
    if (runtime?.failedResourceCount) messages.push({ kind: 'error', title: 'Resource failure', detail: `${runtime.failedResourceCount} 个资源加载失败。` });
    for (const message of gpuErrors) messages.push({ kind: 'error', title: 'WebGPU validation', detail: message });
    if (loaded && runtime && runtime.nodeCount === loaded.animation.nodes.length && messages.every(message => message.kind !== 'error')) {
      messages.push({ kind: 'success', title: 'Runtime hierarchy', detail: `${runtime.nodeCount} nodes · ${animationRenderer.stats.visualCount} visuals` });
    }
    const signature = JSON.stringify(messages);
    if (!force && signature === lastDiagnosticSignature) return;
    lastDiagnosticSignature = signature;
    diagnostics.replaceChildren(...messages.map(message => {
      const item = document.createElement('li');
      item.dataset.kind = message.kind;
      const title = document.createElement('strong');
      title.textContent = message.title;
      const detail = document.createElement('span');
      detail.textContent = message.detail;
      item.append(title, detail);
      return item;
    }));
    const failed = messages.some(message => message.kind === 'error');
    document.body.dataset.renderStatus = failed ? 'failed' : loaded ? 'passed' : 'pending';
    query<HTMLElement>('#result').textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      sample: activeSampleId || null,
      source: loaded?.label ?? null,
      runtime,
      gpuErrors: [...gpuErrors],
    });
  }

  function renderErrorDiagnostic(error: unknown): void {
    diagnostics.replaceChildren();
    const item = document.createElement('li');
    item.dataset.kind = 'error';
    const title = document.createElement('strong');
    title.textContent = 'Load failed';
    const detail = document.createElement('span');
    detail.textContent = errorMessage(error);
    item.append(title, detail);
    diagnostics.append(item);
    document.body.dataset.renderStatus = 'failed';
  }

  function refreshTransport(): void {
    if (!player) return;
    if (!scrubbing) timeline.value = String(player.currentTime);
    currentTime.value = formatTime(player.currentTime);
    play.textContent = player.playing ? '暂停' : '播放';
  }

  function setBusy(busy: boolean, message?: string): void {
    query<HTMLButtonElement>('#load-url').disabled = busy;
    query<HTMLButtonElement>('#choose-file').disabled = busy;
    if (busy && message) setStatus(message, 'working');
  }

  function setStatus(message: string, kind: 'working' | 'success' | 'error'): void {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function populateCategories(entries: readonly SampleEntry[]): void {
    for (const category of [...new Set(entries.map(entry => entry.category))]) {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      categoryFilter.append(option);
    }
  }
}

function resolveSampleRoot(location: Pick<Location, 'origin' | 'pathname'>): URL {
  const marker = '/animation-spec/';
  const markerIndex = location.pathname.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Viewer URL 必须位于 ${marker} 路径下，当前为 ${location.pathname}。`);
  }
  const animationSpecRoot = location.pathname.slice(0, markerIndex + marker.length);
  return new URL(`${animationSpecRoot}samples/`, location.origin);
}

async function fetchSource(url: string, label: string, signal?: AbortSignal): Promise<LoadedSource> {
  const response = await fetch(url, { cache: 'no-store', ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`请求失败：${response.status} ${response.statusText}`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_SOURCE_BYTES) throw new RangeError(`远程文件超过 ${formatBytes(MAX_SOURCE_BYTES)} 上限。`);
  const input = await response.arrayBuffer();
  if (input.byteLength > MAX_SOURCE_BYTES) throw new RangeError(`远程文件超过 ${formatBytes(MAX_SOURCE_BYTES)} 上限。`);
  return parseLoadedSource(input, label, response.url || url);
}

function parseLoadedSource(input: ArrayBuffer, label: string, sourceUrl?: string): LoadedSource {
  const text = maybeJson(input);
  const original = parseAnimation(text ?? input);
  const warnings: string[] = [];
  const animation = sourceUrl ? resolveResources(original, sourceUrl) : warnRelativeResources(original, warnings);
  const bytes = text === null ? input.slice(0) : encodeAnimationBinary(toDocument(animation));
  return { animation, bytes, label, ...(sourceUrl ? { sourceUrl } : {}), warnings };
}

function resolveResources(animation: ParsedAnimation, sourceUrl: string): ParsedAnimation {
  if (animation.resources.length === 0) return animation;
  const resources = animation.resources.map(resource => ({
    ...resource,
    uri: new URL(resource.uri, sourceUrl).href,
  })) as readonly AnimationResource[];
  return Object.freeze({ ...animation, resources: Object.freeze(resources) });
}

function warnRelativeResources(animation: ParsedAnimation, warnings: string[]): ParsedAnimation {
  for (const resource of animation.resources) {
    try {
      const url = new URL(resource.uri);
      if (url.protocol) continue;
    } catch {
      warnings.push(`本地文件中的相对资源 “${resource.uri}” 没有可解析的 base URL。请使用绝对 URL、data URI 或从 URL 载入 HYA。`);
    }
  }
  return animation;
}

function toDocument(animation: ParsedAnimation): AnimationDocument {
  return {
    format: animation.format,
    version: animation.version,
    ...(animation.name ? { name: animation.name } : {}),
    canvas: animation.canvas,
    duration: animation.duration,
    ...(animation.frameRate ? { frameRate: animation.frameRate } : {}),
    endBehavior: animation.endBehavior,
    resources: animation.resources,
    nodes: animation.nodes,
    tracks: animation.tracks,
    extensionsUsed: animation.extensionsUsed,
    extensionsRequired: animation.extensionsRequired,
    extensions: animation.extensions,
  };
}

function validateManifest(value: unknown): SampleManifest {
  if (!value || typeof value !== 'object') throw new TypeError('Sample manifest 必须是对象。');
  const candidate = value as Partial<SampleManifest>;
  if (candidate.schemaVersion !== 1 || candidate.kind !== 'hya-samples' || !Array.isArray(candidate.entries)) {
    throw new TypeError('Sample manifest schema 不受支持。');
  }
  const ids = new Set<string>();
  for (const entry of candidate.entries) {
    if (!entry.id || !entry.file || !entry.title || !entry.category || !entry.capability || ids.has(entry.id)) {
      throw new TypeError(`Sample manifest entry 无效：${entry.id ?? '(unknown)'}`);
    }
    ids.add(entry.id);
  }
  return candidate as SampleManifest;
}

function maybeJson(input: ArrayBuffer): string | null {
  const prefix = new TextDecoder().decode(input.slice(0, Math.min(64, input.byteLength))).trimStart();
  return prefix.startsWith('{') ? new TextDecoder().decode(input) : null;
}

function stringifyAnimation(animation: ParsedAnimation): string {
  return JSON.stringify(toDocument(animation), (_key, value) => ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value, 2);
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new ReferenceError(`Missing HYA sample browser element: ${selector}`);
  return element;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function formatTime(value: number): string { return `${value.toFixed(3)}s`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fileName(pathname: string): string { return decodeURIComponent(pathname.split('/').pop() ?? ''); }
function safeStem(value: string): string {
  return value.replace(/\.hya$/i, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'animation';
}

void main().catch(error => {
  const status = document.querySelector<HTMLElement>('#status');
  if (status) {
    status.textContent = errorMessage(error);
    status.dataset.kind = 'error';
  }
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = errorMessage(error);
  console.error(error);
});
