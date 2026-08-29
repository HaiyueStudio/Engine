import { AnimationExtensionRegistry, parseAnimation, type ParsedAnimation } from '@haiyue/animation-spec';
import { Animation2DComponent, Animation2DExtensionRegistry, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';

const WASM_URL = 'https://unpkg.com/@rive-app/webgl2@2.40.0/rive.wasm';
const EXPECTED_WASM_SHA256 = '87d864c0efa264f287c3e6bf769b6ddf71d359bb0b3cef446aa0bc13ce4ffe32';
const MAX_HYA_BYTES = 256 * 1024 * 1024;
const HYA_FORMAT_EXTENSIONS = [
  'org.haiyue.vector-shape@1',
  'org.haiyue.vector-stroke@1',
  'org.haiyue.vector-path-morph@1',
  'org.haiyue.animation-state-machine@2',
  'org.haiyue.data-binding@1',
] as const;

interface Sample {
  id: string; title: string; sourceUrl: string; sha256: string; byteLength: number;
  selection: { artboard: string; animation: string | null; stateMachine: string };
  featureFamilies: string[]; evidenceRoles: string[];
}
interface SampleManifest { oracle: { package: string; riveJsSha256: string; riveWasmSha256: string }; samples: Sample[] }
interface ConversionReport { input?: { rivSha256?: string }; output?: { hyaSha256?: string }; featureLedger?: unknown[]; diagnostics?: unknown[] }
interface AutomaticConversionResponse { status: 'passed' | 'failed'; assetId?: string; hyaBase64?: string; report?: ConversionReport; error?: string }
interface OfficialRiveInstance {
  cleanup(): void; play(): void; pause(): void;
  reset(options?: Record<string, unknown>): void; resizeDrawingSurfaceToCanvas(): void;
  readonly contents?: { artboards?: unknown[] };
}
interface OfficialRiveModule {
  RuntimeLoader: { setWasmUrl(url: string): void };
  Rive: new(options: Record<string, unknown>) => OfficialRiveInstance;
}

declare global { interface Window { rive?: OfficialRiveModule } }

async function main(): Promise<void> {
  const manifest = await fetch('./samples.json', { cache: 'no-store' }).then(requireOk).then(response => response.json()) as SampleManifest;
  const module = window.rive;
  if (!module) throw new Error('固定的官方 Rive WebGL2 脚本未加载；请检查网络或 SRI。');
  if (manifest.oracle.package !== '@rive-app/webgl2@2.40.0') throw new Error('示例清单的 oracle 版本不匹配。');
  setStatus('校验官方 WASM…', 'working');
  await verifyUrlIdentity(WASM_URL, manifest.oracle.riveWasmSha256 || EXPECTED_WASM_SHA256);
  module.RuntimeLoader.setWasmUrl(WASM_URL);

  const hyaCanvas = query<HTMLCanvasElement>('#hya-canvas');
  const officialCanvas = query<HTMLCanvasElement>('#official-canvas');
  const engine = new HaiyueEngine({ canvas: hyaCanvas, clearColor: { r: 0.02, g: 0.03, b: 0.07, a: 1 } });
  await engine.init();
  const cameraEntity = new Entity('Rive HYA comparison camera').addComponent(new Camera2D({
    width: 800, height: 640, designWidth: 800, designHeight: 640, viewportMode: 'fit',
  }));
  const camera = cameraEntity.getComponent(Camera2D)!;
  const scene = engine.createScene({
    name: 'Rive HYA comparison', camera: { type: '2d', entity: cameraEntity },
    render3D: false, render2D: false, gui: false, pipelineLabel: 'RiveHyaCompare.render',
  });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  const renderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 32 });
  scene.addSystem(renderer);
  engine.switchScene(scene);
  engine.run();

  const sampleSelect = query<HTMLSelectElement>('#sample');
  for (const sample of manifest.samples) sampleSelect.add(new Option(sample.title, sample.id));
  let activeSample = manifest.samples[0]!;
  let official: OfficialRiveInstance | null = null;
  let hyaEntity: Entity | null = null;
  let hyaPlayer: Animation2DComponent | null = null;
  let activeRivBytes: ArrayBuffer | null = null;
  let conversionAbort: AbortController | null = null;
  let playing = true;
  let generation = 0;

  const loadOfficial = async (sample: Sample): Promise<void> => {
    const token = ++generation;
    conversionAbort?.abort();
    conversionAbort = new AbortController();
    const conversionSignal = conversionAbort.signal;
    activeSample = sample;
    activeRivBytes = null;
    official?.cleanup();
    official = null;
    clearHya();
    setPaneState('official', '校验 RIV…', 'working');
    setPaneState('hya', '等待 RIV 校验', 'working');
    setStatus(`下载 ${sample.title}…`, 'working');
    const response = await fetch(sample.sourceUrl, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    requireOk(response);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== sample.byteLength) throw new Error(`RIV byte length 不匹配：${bytes.byteLength} / ${sample.byteLength}`);
    const rivHash = await sha256(bytes);
    if (rivHash !== sample.sha256) throw new Error(`RIV SHA-256 不匹配：${rivHash}`);
    if (token !== generation) return;
    activeRivBytes = bytes.slice(0);
    query('#source-identity').textContent = `${sample.id} · ${(bytes.byteLength / 1024).toFixed(1)} KiB · ${rivHash.slice(0, 12)}…`;
    query('#selection').textContent = `${sample.selection.artboard} · ${sample.selection.animation ?? 'no animation'} · ${sample.selection.stateMachine}`;
    const link = query<HTMLAnchorElement>('#source-link'); link.href = sample.sourceUrl;
    query('#diagnostics').textContent = `roles: ${sample.evidenceRoles.join(', ')}\nfeatures: ${sample.featureFamilies.join(', ') || 'property-boundary witness'}`;
    const automaticConversion = convertAndInstall(sample, bytes, token, conversionSignal).catch(error => {
      if (token !== generation || conversionSignal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setPaneState('hya', '自动转换不可用', 'error');
      setStatus('官方端已加载；自动转换不可用，可手工载入 HYA', 'working');
      query('#diagnostics').textContent += `\nauto conversion: ${message}`;
      updateResult();
    });
    official = await createOfficialPlayer(module, officialCanvas, bytes, sample, playing);
    if (token !== generation) { official.cleanup(); return; }
    setPaneState('official', 'hash-pinned · ready', 'ready');
    setStatus(hyaPlayer ? '两端均已加载，可视觉对照' : '官方端已加载；正在自动转换 HYA', hyaPlayer ? 'success' : 'working');
    updateResult();
    await automaticConversion;
  };

  const installHya = async (
    hyaBytes: ArrayBuffer, report: ConversionReport, label: string,
    expected?: { generation: number; assetId: string; signal: AbortSignal },
  ): Promise<void> => {
    if (expected && (expected.generation !== generation || expected.assetId !== activeSample.id || expected.signal.aborted)) return;
    if (hyaBytes.byteLength > MAX_HYA_BYTES) throw new RangeError('HYA 超过 256 MiB 示例上限。');
    if (report.input?.rivSha256 !== activeSample.sha256) throw new Error('conversion report 的 RIV SHA-256 与当前官方素材不一致。');
    const hyaHash = await sha256(hyaBytes);
    if (expected && (expected.generation !== generation || expected.assetId !== activeSample.id || expected.signal.aborted)) return;
    if (report.output?.hyaSha256 !== hyaHash) throw new Error('conversion report 的 HYA SHA-256 与输入文件不一致。');
    const extensionRegistry = new AnimationExtensionRegistry();
    const runtimeExtensions = new Animation2DExtensionRegistry();
    for (const id of HYA_FORMAT_EXTENSIONS) {
      extensionRegistry.register({ id });
      runtimeExtensions.register({ id, create() {} });
    }
    const animation = parseAnimation(hyaBytes, { extensions: extensionRegistry });
    if (hyaEntity) scene.remove(hyaEntity);
    hyaPlayer = new Animation2DComponent(animation, { autoplay: playing, loop: true, runtimeExtensions });
    hyaEntity = new Entity(`Rive HYA: ${label}`).addComponent(new Transform2D()).addComponent(hyaPlayer);
    scene.add(hyaEntity);
    camera.setViewportFit({ designWidth: animation.canvas.width, designHeight: animation.canvas.height, viewportMode: 'fit' });
    camera.resize(engine.displayWidth, engine.displayHeight);
    query('#hya-empty').setAttribute('hidden', '');
    setPaneState('hya', `${formatBytes(hyaBytes.byteLength)} · ${hyaHash.slice(0, 10)}…`, 'ready');
    query('#diagnostics').textContent += `\nHYA: ${label} · feature ledger ${(report.featureLedger ?? []).length} · diagnostics ${(report.diagnostics ?? []).length}`;
    setStatus('两端均已加载，可视觉对照', 'success');
    updateResult();
  };

  const convertAndInstall = async (sample: Sample, rivBytes: ArrayBuffer, token: number, signal: AbortSignal): Promise<void> => {
    setPaneState('hya', 'production pipeline 转换中…', 'working');
    setStatus(`正在把 ${sample.title} 转换为 HYA…`, 'working');
    const response = await requestAutomaticConversion(sample.id, rivBytes, signal);
    let result: AutomaticConversionResponse;
    try { result = await response.json() as AutomaticConversionResponse; }
    catch { throw new Error(`自动转换服务返回 HTTP ${response.status}，且响应不是 JSON。`); }
    if (!response.ok || result.status !== 'passed' || !result.hyaBase64 || !result.report) {
      throw new Error(result.error ?? `自动转换服务返回 HTTP ${response.status}。`);
    }
    if (result.assetId !== sample.id) throw new Error('自动转换响应的素材身份不匹配。');
    if (token !== generation || signal.aborted) return;
    const hya = decodeBase64(result.hyaBase64);
    await installHya(hya.buffer, result.report, `${sample.id} · automatic`, { generation: token, assetId: sample.id, signal });
  };

  function clearHya(): void {
    if (hyaEntity) scene.remove(hyaEntity);
    hyaEntity = null; hyaPlayer = null;
    query('#hya-empty').removeAttribute('hidden');
    setPaneState('hya', '等待转换产物', 'missing');
  }

  sampleSelect.addEventListener('change', () => {
    const sample = manifest.samples.find(value => value.id === sampleSelect.value);
    if (sample) void loadOfficial(sample).catch(showError);
  });
  query<HTMLButtonElement>('#reload').addEventListener('click', () => void loadOfficial(activeSample).catch(showError));
  query<HTMLButtonElement>('#auto-convert').addEventListener('click', () => {
    if (!activeRivBytes) { showError(new Error('当前 RIV 尚未下载并通过 hash 校验。')); return; }
    conversionAbort?.abort(); conversionAbort = new AbortController();
    const token = generation;
    void convertAndInstall(activeSample, activeRivBytes, token, conversionAbort.signal).catch(showError);
  });
  query<HTMLButtonElement>('#play').addEventListener('click', () => {
    playing = !playing;
    if (playing) { official?.play(); hyaPlayer?.play(); } else { official?.pause(); hyaPlayer?.pause(); }
    query<HTMLButtonElement>('#play').textContent = playing ? '暂停两端' : '播放两端';
  });
  query<HTMLButtonElement>('#restart').addEventListener('click', () => {
    official?.reset({ artboard: activeSample.selection.artboard, animations: activeSample.selection.animation ?? undefined, stateMachines: activeSample.selection.stateMachine, autoplay: playing, autoBind: true });
    hyaPlayer?.seek(0); if (playing) hyaPlayer?.play();
  });
  query<HTMLInputElement>('#hya-files').addEventListener('change', event => {
    const files = [...(event.currentTarget as HTMLInputElement).files ?? []];
    const hya = files.find(file => file.name.toLowerCase().endsWith('.hya'));
    const report = files.find(file => file.name.toLowerCase().endsWith('.json'));
    if (!hya || !report) { showError(new Error('请同时选择 animation.hya 与 conversion-report.json。')); return; }
    void Promise.all([hya.arrayBuffer(), report.text().then(JSON.parse)]).then(([bytes, value]) => installHya(bytes, value, hya.name)).catch(showError);
  });
  query<HTMLButtonElement>('#load-hya-url').addEventListener('click', () => {
    const value = query<HTMLInputElement>('#hya-url').value.trim();
    if (!value) return;
    const hyaUrl = new URL(value, location.href);
    const reportUrl = new URL('conversion-report.json', hyaUrl);
    void Promise.all([
      fetch(hyaUrl, { cache: 'no-store' }).then(requireOk).then(response => response.arrayBuffer()),
      fetch(reportUrl, { cache: 'no-store' }).then(requireOk).then(response => response.json()),
    ]).then(([bytes, report]) => installHya(bytes, report as ConversionReport, hyaUrl.pathname.split('/').pop() ?? 'animation.hya')).catch(showError);
  });

  const resize = new ResizeObserver(() => { official?.resizeDrawingSurfaceToCanvas(); camera.resize(engine.displayWidth, engine.displayHeight); });
  resize.observe(officialCanvas); resize.observe(hyaCanvas);
  window.addEventListener('beforeunload', () => { conversionAbort?.abort(); resize.disconnect(); official?.cleanup(); engine.destroy(); }, { once: true });
  await loadOfficial(activeSample);

  function updateResult(): void {
    const result = query<HTMLElement>('#result');
    result.dataset.status = hyaPlayer && official ? 'comparison-ready' : 'official-only';
    result.textContent = JSON.stringify({
      status: result.dataset.status,
      assetId: activeSample.id,
      oracle: manifest.oracle.package,
      rivSha256: activeSample.sha256,
      hyaLoaded: Boolean(hyaPlayer),
      renderer: hyaPlayer ? renderer.stats : null,
    });
  }
}

async function requestAutomaticConversion(assetId: string, rivBytes: ArrayBuffer, signal: AbortSignal): Promise<Response> {
  const endpoints = automaticConversionEndpoints(assetId);
  const failures: string[] = [];
  for (let index = 0; index < endpoints.length; index++) {
    const endpoint = endpoints[index]!;
    try {
      const response = await fetch(endpoint, {
        method: 'POST', body: rivBytes.slice(0), signal, cache: 'no-store',
        headers: { 'content-type': 'application/octet-stream' },
      });
      if ((response.status === 404 || response.status === 405) && index + 1 < endpoints.length) {
        failures.push(`${endpoint.origin}: HTTP ${response.status}`);
        continue;
      }
      if (response.status === 404 || response.status === 405) {
        throw new Error(`该地址是纯静态服务器，未提供 production converter（HTTP ${response.status}）。`);
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${endpoint.origin}: ${error instanceof Error ? error.message : String(error)}`);
      if (index + 1 < endpoints.length) continue;
    }
  }
  throw new Error(
    `无法连接 Rive production converter。请在 Engine 目录运行 `
    + '`npm run preview:target -- example:rive-hya-compare`，'
    + `服务地址应为 http://127.0.0.1:8080。${failures.length > 0 ? ` (${failures.join('; ')})` : ''}`,
  );
}

function automaticConversionEndpoints(assetId: string): URL[] {
  const path = `/api/rive-hya-compare/convert/${encodeURIComponent(assetId)}`;
  const configured = new URLSearchParams(location.search).get('converter');
  if (configured) return [new URL(path, new URL(configured, location.href))];
  const sameOrigin = new URL(path, location.origin);
  if (!isLoopback(location.hostname)) return [sameOrigin];
  const converterOrigin = new URL(`${location.protocol}//${location.hostname}:8080`);
  const converter = new URL(path, converterOrigin);
  if (location.port === '5500' || location.port === '5501') return [converter];
  return converter.href === sameOrigin.href ? [sameOrigin] : [sameOrigin, converter];
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function createOfficialPlayer(module: OfficialRiveModule, canvas: HTMLCanvasElement, bytes: ArrayBuffer, sample: Sample, autoplay: boolean): Promise<OfficialRiveInstance> {
  return new Promise((resolve, reject) => {
    let instance: OfficialRiveInstance;
    instance = new module.Rive({
      buffer: bytes, canvas, artboard: sample.selection.artboard,
      animations: sample.selection.animation ?? undefined,
      stateMachines: sample.selection.stateMachine,
      autoplay, autoBind: true, useOffscreenRenderer: true,
      onLoad: () => { instance.resizeDrawingSurfaceToCanvas(); resolve(instance); },
      onLoadError: (event: unknown) => reject(new Error(`官方 Rive 加载失败：${String(event)}`)),
    });
  });
}
async function verifyUrlIdentity(url: string, expected: string): Promise<void> {
  const bytes = await fetch(url, { cache: 'force-cache' }).then(requireOk).then(response => response.arrayBuffer());
  const actual = await sha256(bytes); if (actual !== expected) throw new Error(`官方 WASM SHA-256 不匹配：${actual}`);
}
async function sha256(bytes: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function setPaneState(id: 'hya' | 'official', text: string, status: string): void { const node = query(`#${id}-state`); node.textContent = text; node.setAttribute('data-status', status); }
function setStatus(text: string, kind: string): void { const node = query('#status'); node.textContent = text; node.setAttribute('data-kind', kind); }
function showError(error: unknown): void { const message = error instanceof Error ? error.message : String(error); setStatus(message, 'error'); query('#diagnostics').textContent += `\nERROR: ${message}`; const result = query<HTMLElement>('#result'); result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', error: message }); }
function requireOk(response: Response): Response { if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.url}`); return response; }
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
function query<T extends Element = HTMLElement>(selector: string): T { const value = document.querySelector<T>(selector); if (!value) throw new ReferenceError(`Missing ${selector}`); return value; }

void main().catch(showError);
