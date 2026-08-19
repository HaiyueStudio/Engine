import { encodeAnimationBinary, parseAnimation } from '@haiyue/animation-spec';
import { convertLottie, type LottieConversionDiagnostic } from '@haiyue/animation-spec/lottie';
import { Animation2DComponent, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light.js';

interface SampleEntry { id: string; title: string; file: string; license: string; source: string }
interface Bounds { x: number; y: number; width: number; height: number }

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#hya-canvas');
  const referenceHost = query<HTMLElement>('#reference-player');
  const engine = new HaiyueEngine({ canvas, clearColor: { r: 0.018, g: 0.027, b: 0.063, a: 1 } });
  await engine.init();
  const cameraEntity = new Entity('Lottie comparison camera');
  const camera = new Camera2D({ width: 512, height: 512, designWidth: 512, designHeight: 512, viewportMode: 'fit' });
  cameraEntity.addComponent(camera);
  const scene = engine.createScene({ name: 'Lottie HYA comparison', camera: { type: '2d', entity: cameraEntity }, render3D: false, render2D: false, gui: false, pipelineLabel: 'LottieHyaCompare.render' });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  const renderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 16 });
  scene.addSystem(renderer);
  engine.switchScene(scene);
  engine.run();

  let playerEntity: Entity | null = null;
  let player: Animation2DComponent | null = null;
  let modelTransform: Transform2D | null = null;
  let reference: AnimationItem | null = null;
  let sourceWidth = 1;
  let sourceHeight = 1;
  let duration = 1;
  let frameRate = 60;
  let currentTime = 0;
  let playing = true;
  let lastTick = performance.now();
  let bounds: Bounds = { x: 0, y: 0, width: 1, height: 1 };
  let autoZoom = 1;
  let ready = false;
  let generation = 0;
  let controller: AbortController | null = null;

  const manifest = await fetch('./samples/manifest.json').then(requireOk).then(response => response.json()) as { samples: SampleEntry[] };
  const sampleSelect = query<HTMLSelectElement>('#sample');
  for (const sample of manifest.samples) sampleSelect.add(new Option(sample.title, sample.file));
  sampleSelect.addEventListener('change', () => void loadSample(sampleSelect.value));
  bindControls();
  void loadSample(manifest.samples[0]!.file);

  engine.on('after-update', () => {
    const now = performance.now();
    const delta = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    if (playing && player) currentTime = (currentTime + delta) % duration;
    syncPlayers();
    const result = query<HTMLElement>('#result');
    if (!result.dataset.status && ready && player && reference && renderer.stats.visualCount > 0) {
      result.dataset.status = 'passed';
      result.textContent = JSON.stringify({ status: 'passed', renderer: renderer.stats, officialPlayer: 'lottie-web', bounds, autoZoom });
    }
  });

  async function loadSample(file: string): Promise<void> {
    const token = ++generation;
    controller?.abort('sample-replaced');
    controller = new AbortController();
    ready = false;
    const result = query<HTMLElement>('#result');
    delete result.dataset.status;
    result.textContent = '';
    setStatus('读取并转换 Lottie…', 'working');
    try {
      const source = await fetch(`./samples/${file}`, { signal: controller.signal }).then(requireOk).then(response => response.json()) as Record<string, unknown>;
      const converted = convertLottie(source);
      const binary = encodeAnimationBinary(converted.document);
      const parsed = parseAnimation(binary);
      if (token !== generation) return;
      sourceWidth = parsed.canvas.width;
      sourceHeight = parsed.canvas.height;
      duration = parsed.duration;
      frameRate = parsed.frameRate ?? (Number(source.fr) || 60);
      currentTime = 0;
      camera.setViewportFit({ designWidth: sourceWidth, designHeight: sourceHeight, viewportMode: 'fit' });
      camera.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
      if (playerEntity) scene.remove(playerEntity);
      modelTransform = new Transform2D();
      player = new Animation2DComponent(parsed, { autoplay: false, loop: true });
      playerEntity = new Entity('Converted HYA').addComponent(modelTransform).addComponent(player);
      scene.add(playerEntity);
      reference?.destroy();
      referenceHost.replaceChildren();
      reference = lottie.loadAnimation({ container: referenceHost, renderer: 'svg', loop: true, autoplay: false, animationData: structuredClone(source), rendererSettings: { preserveAspectRatio: 'xMidYMid meet' } });
      await once(reference, 'DOMLoaded');
      if (token !== generation) { reference.destroy(); return; }
      bounds = measureAnimatedBounds(reference, referenceHost, sourceWidth, sourceHeight);
      autoZoom = clamp(0.82 * Math.min(sourceWidth / Math.max(1, bounds.width), sourceHeight / Math.max(1, bounds.height)), 0.1, 12);
      query<HTMLInputElement>('#zoom').value = '1';
      query<HTMLInputElement>('#pan-x').value = '0';
      query<HTMLInputElement>('#pan-y').value = '0';
      query<HTMLInputElement>('#timeline').max = String(duration);
      renderDiagnostics(converted.diagnostics);
      applyView();
      ready = true;
      setStatus(`${file} · HYA ${formatBytes(binary.byteLength)} · 自动适配 ${autoZoom.toFixed(2)}×`, 'success');
    } catch (error) {
      if (controller?.signal.aborted) return;
      setStatus(error instanceof Error ? error.message : String(error), 'error');
      const result = query<HTMLElement>('#result');
      result.dataset.status = 'failed';
      result.textContent = JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  function bindControls(): void {
    query<HTMLButtonElement>('#play').addEventListener('click', () => { playing = !playing; query<HTMLButtonElement>('#play').textContent = playing ? '暂停' : '播放'; });
    const timeline = query<HTMLInputElement>('#timeline');
    timeline.addEventListener('input', () => { currentTime = Number(timeline.value); syncPlayers(); });
    for (const id of ['zoom', 'pan-x', 'pan-y']) query<HTMLInputElement>(`#${id}`).addEventListener('input', applyView);
    query<HTMLButtonElement>('#fit').addEventListener('click', () => {
      query<HTMLInputElement>('#zoom').value = '1'; query<HTMLInputElement>('#pan-x').value = '0'; query<HTMLInputElement>('#pan-y').value = '0'; applyView();
    });
  }

  function syncPlayers(): void {
    if (!player || !reference) return;
    player.seek(currentTime);
    reference.goToAndStop(currentTime * frameRate, true);
    const timeline = query<HTMLInputElement>('#timeline');
    if (document.activeElement !== timeline) timeline.value = String(currentTime);
    query<HTMLOutputElement>('#time').textContent = `${currentTime.toFixed(2)} / ${duration.toFixed(2)}s`;
  }

  function applyView(): void {
    if (!modelTransform) return;
    const zoom = autoZoom * Number(query<HTMLInputElement>('#zoom').value);
    const panX = Number(query<HTMLInputElement>('#pan-x').value);
    const panY = Number(query<HTMLInputElement>('#pan-y').value);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    modelTransform.setScale(zoom).setPosition(zoom * (sourceWidth / 2 - centerX) + panX, zoom * (centerY - sourceHeight / 2) - panY);
    const base = Math.min(referenceHost.clientWidth / sourceWidth, referenceHost.clientHeight / sourceHeight);
    const dx = zoom * (sourceWidth / 2 - centerX) * base + panX * base;
    const dy = zoom * (sourceHeight / 2 - centerY) * base + panY * base;
    const svg = referenceHost.querySelector<SVGSVGElement>('svg');
    if (svg) { svg.style.transformOrigin = '50% 50%'; svg.style.transform = `translate(${dx}px, ${dy}px) scale(${zoom})`; }
    query<HTMLOutputElement>('#view-value').textContent = `${zoom.toFixed(2)}× · ${panX.toFixed(0)}, ${panY.toFixed(0)}`;
  }

  window.addEventListener('beforeunload', () => { controller?.abort(); reference?.destroy(); engine.destroy(); }, { once: true });
}

function measureAnimatedBounds(item: AnimationItem, host: HTMLElement, width: number, height: number): Bounds {
  let result: Bounds | null = null;
  const frames = Math.max(1, item.getDuration(true));
  for (let sample = 0; sample <= 12; sample++) {
    item.goToAndStop(frames * sample / 12, true);
    const svg = host.querySelector<SVGSVGElement>('svg');
    const graphic = svg?.querySelector<SVGGraphicsElement>(':scope > g');
    if (!svg || !graphic) continue;
    const viewport = svg.getBoundingClientRect();
    const rendered = graphic.getBoundingClientRect();
    const scale = Math.min(viewport.width / width, viewport.height / height);
    if (scale <= 0 || rendered.width <= 0 || rendered.height <= 0) continue;
    const insetX = (viewport.width - width * scale) / 2;
    const insetY = (viewport.height - height * scale) / 2;
    const box = {
      x: (rendered.left - viewport.left - insetX) / scale,
      y: (rendered.top - viewport.top - insetY) / scale,
      width: rendered.width / scale,
      height: rendered.height / scale,
    };
    if (isSaneBounds(box, width, height)) result = result ? union(result, box) : box;
  }
  item.goToAndStop(0, true);
  return result ?? { x: 0, y: 0, width, height };
}
function isSaneBounds(bounds: Bounds, width: number, height: number): boolean {
  const limit = Math.max(width, height) * 64;
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0 && bounds.height > 0
    && Math.abs(bounds.x) <= limit && Math.abs(bounds.y) <= limit
    && bounds.width <= limit && bounds.height <= limit;
}
function union(a: Bounds, b: Bounds): Bounds { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), right = Math.max(a.x + a.width, b.x + b.width), bottom = Math.max(a.y + a.height, b.y + b.height); return { x, y, width: right - x, height: bottom - y }; }
function once(item: AnimationItem, event: 'DOMLoaded'): Promise<void> { return new Promise(resolve => item.addEventListener(event, resolve)); }
function renderDiagnostics(items: readonly LottieConversionDiagnostic[]): void { query<HTMLElement>('#diagnostics').textContent = items.length ? items.map(item => `${item.code} · ${item.path}`).join('\n') : '无 fidelity diagnostics'; }
function setStatus(message: string, kind: string): void { const node = query<HTMLElement>('#status'); node.textContent = message; node.dataset.kind = kind; }
function requireOk(response: Response): Response { if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`); return response; }
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function query<T extends Element>(selector: string): T { const element = document.querySelector<T>(selector); if (!element) throw new ReferenceError(`Missing ${selector}`); return element; }

void main().catch(error => { const result = document.querySelector<HTMLElement>('#result'); if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: String(error) }); } console.error(error); });
