import { AnimationExtensionRegistry, parseAnimation, type ParsedAnimation } from '@haiyue/animation-spec';
import {
  Animation2DComponent, Animation2DExtensionRegistry, Animation2DRenderSystem, Animation2DSystem, InteractionRuntime,
  type RuntimeInteractionAction, type RuntimeInteractionDocument,
} from '@haiyue/extensions/animation';
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
  'org.haiyue.interaction@1',
] as const;
const RIVE_COMPONENT_LIST_PROTOCOL = 'org.haiyue.rive-component-list@1';

interface Sample {
  id: string; title: string; sourceUrl: string; sha256: string; byteLength: number;
  selection: { artboard: string; animation: string | null; stateMachine: string };
  featureFamilies: string[]; evidenceRoles: string[];
}
interface SampleManifest { oracle: { package: string; riveJsSha256: string; riveWasmSha256: string }; samples: Sample[] }
interface ConversionReport { input?: { rivSha256?: string }; output?: { hyaSha256?: string }; featureLedger?: unknown[]; diagnostics?: unknown[] }
interface AutomaticConversionAsset { path: string; mimeType: string; sha256: string; byteLength: number; base64: string }
interface AutomaticConversionResponse { status: 'passed' | 'failed'; assetId?: string; hyaBase64?: string; assets?: AutomaticConversionAsset[]; report?: ConversionReport; error?: string }
interface RiveListActionArguments {
  row: number; sourceRow: number; list: string;
  idleNode: string; hoverNode: string; openNode: string; openHoverNode: string;
  expandedNode: string; expandedHoverNode: string;
  baseX: number; baseY: number; collapsedHeight: number; openHeight: number; expandedHeight: number;
  hoverAudio?: string; hoverGain?: number; clickAudio?: string; clickGain?: number;
  openAudio?: string; openGain?: number; closeAudio?: string; closeGain?: number; active?: boolean;
}
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
  const requestedSampleId = new URLSearchParams(location.search).get('sample');
  let activeSample = manifest.samples.find(sample => sample.id === requestedSampleId) ?? manifest.samples[0]!;
  sampleSelect.value = activeSample.id;
  let official: OfficialRiveInstance | null = null;
  let hyaEntity: Entity | null = null;
  let hyaPlayer: Animation2DComponent | null = null;
  let hyaAssetUrls: string[] = [];
  let activeRivBytes: ArrayBuffer | null = null;
  let conversionAbort: AbortController | null = null;
  let hyaInteraction: InteractionRuntime | null = null;
  let hyaAudioContext: AudioContext | null = null;
  let hyaAudioResources = new Map<string, string>();
  let hyaAudioGains = new Map<string, number>();
  let hyaAudioBuffers = new Map<string, Promise<AudioBuffer>>();
  const listRows = new Map<number, { descriptor: RiveListActionArguments; hover: boolean; open: boolean; expanded: boolean }>();
  const listTargetRows = new Map<string, number>();
  const interactionTargetShift = new Map<string, number>();
  let playing = true;
  let generation = 0;

  const playHyaAudio = (resourceId: string): void => {
    const uri = hyaAudioResources.get(resourceId); if (!uri) return;
    const context = hyaAudioContext ??= new AudioContext();
    let buffer = hyaAudioBuffers.get(resourceId);
    if (!buffer) {
      buffer = fetch(uri).then(requireOk).then(response => response.arrayBuffer()).then(bytes => context.decodeAudioData(bytes));
      hyaAudioBuffers.set(resourceId, buffer);
    }
    void Promise.all([context.resume(), buffer]).then(([, decoded]) => {
      const source = context.createBufferSource(); const gain = context.createGain();
      source.buffer = decoded;
      gain.gain.setValueAtTime(hyaAudioGains.get(resourceId) ?? 1, context.currentTime);
      source.connect(gain); gain.connect(context.destination); source.start();
      hyaCanvas.dataset.lastAudioEvent = resourceId;
    }).catch(() => { /* Browser autoplay policy may defer audio until the first pointer press. */ });
  };

  const applyListRows = (): void => {
    if (!hyaPlayer) return;
    interactionTargetShift.clear();
    const groups = new Map<string, Array<{ descriptor: RiveListActionArguments; hover: boolean; open: boolean; expanded: boolean }>>();
    for (const state of listRows.values()) {
      const values = groups.get(state.descriptor.list) ?? []; values.push(state); groups.set(state.descriptor.list, values);
    }
    for (const values of groups.values()) {
      let shift = 0;
      for (const state of values.sort((left, right) => left.descriptor.sourceRow - right.descriptor.sourceRow)) {
        const descriptor = state.descriptor;
        const selected = state.expanded
          ? (state.hover ? descriptor.expandedHoverNode : descriptor.expandedNode)
          : state.open ? (state.hover ? descriptor.openHoverNode : descriptor.openNode)
            : (state.hover ? descriptor.hoverNode : descriptor.idleNode);
        for (const nodeId of [
          descriptor.idleNode, descriptor.hoverNode, descriptor.openNode, descriptor.openHoverNode,
          descriptor.expandedNode, descriptor.expandedHoverNode,
        ]) {
          hyaPlayer.setNodeOverride(nodeId, { position: [descriptor.baseX, descriptor.baseY + shift], opacity: nodeId === selected ? 1 : 0 });
        }
        interactionTargetShift.set(`rive-list-row-${String(descriptor.row).padStart(6, '0')}`, shift);
        if (state.open) {
          const activeHeight = state.expanded ? descriptor.expandedHeight : descriptor.openHeight;
          shift += Math.max(0, activeHeight - descriptor.collapsedHeight);
        }
      }
    }
    hyaCanvas.dataset.interactionState = JSON.stringify([...listRows.values()]
      .sort((left, right) => left.descriptor.row - right.descriptor.row)
      .map(state => ({ row: state.descriptor.row, hover: state.hover, open: state.open, expanded: state.expanded })));
  };

  const resetHyaInteraction = (): void => {
    hyaInteraction?.dispose(); hyaInteraction = null;
    listRows.clear(); listTargetRows.clear(); interactionTargetShift.clear(); hyaAudioResources.clear(); hyaAudioGains.clear(); hyaAudioBuffers.clear();
    delete hyaCanvas.dataset.interactionState;
    delete hyaCanvas.dataset.lastAudioEvent;
  };

  const setupHyaInteraction = (animation: ParsedAnimation): void => {
    resetHyaInteraction();
    const document = animation.extensions['org.haiyue.interaction@1'] as RuntimeInteractionDocument | undefined;
    if (!document) return;
    hyaAudioResources = new Map(animation.resources.filter(resource => resource.type === 'audio').map(resource => [resource.id, resource.uri]));
    for (const listener of document.listeners) {
      for (const action of listener.actions) {
        const descriptor = riveListActionArguments(action);
        if (descriptor) {
          registerAudioGain(descriptor.hoverAudio, descriptor.hoverGain);
          registerAudioGain(descriptor.clickAudio, descriptor.clickGain);
          registerAudioGain(descriptor.openAudio, descriptor.openGain);
          registerAudioGain(descriptor.closeAudio, descriptor.closeGain);
          if (!listRows.has(descriptor.row)) listRows.set(descriptor.row, { descriptor, hover: false, open: false, expanded: false });
          listTargetRows.set(listener.target, descriptor.row);
        }
      }
    }
    const listTargetRects = new Map<string, readonly [number, number, number, number]>();
    const runtimeDocument: RuntimeInteractionDocument = {
      ...document,
      targets: document.targets.map(target => {
        if (!listTargetRows.has(target.id) || target.hitArea.kind !== 'rect' || !Array.isArray(target.hitArea.rect)) return target;
        const rect = target.hitArea.rect.map(Number);
        if (rect.length !== 4 || rect.some(value => !Number.isFinite(value))) return target;
        listTargetRects.set(target.id, [rect[0]!, rect[1]!, rect[2]!, rect[3]!]);
        return { ...target, hitArea: { kind: 'geometry', port: 'rive-list-row-stage' } };
      }),
    };
    hyaInteraction = new InteractionRuntime(runtimeDocument, {
      geometryPort: {
        matrix: target => [1, 0, 0, 1, 0, interactionTargetShift.get(target) ?? 0],
        containsGeometry(port, target, point) {
          if (port !== 'rive-list-row-stage') return false;
          const row = listTargetRows.get(target); const state = row === undefined ? undefined : listRows.get(row);
          const rect = listTargetRects.get(target);
          if (!state || !rect) return false;
          const height = state.expanded ? state.descriptor.expandedHeight
            : state.open ? state.descriptor.openHeight : state.descriptor.collapsedHeight;
          return point[0] >= rect[0] && point[1] >= rect[1]
            && point[0] <= rect[0] + rect[2] && point[1] <= rect[1] + height;
        },
      },
      actionPort: {
        begin() {}, commit() {}, rollback() {},
        invoke(action) {
          if (action.kind === 'audio' && action.operation === 'play' && typeof action.target === 'string') {
            playHyaAudio(action.target); return;
          }
          const descriptor = riveListActionArguments(action); if (!descriptor) return;
          const state = listRows.get(descriptor.row); if (!state) return;
          if (action.port === 'set-hover') state.hover = descriptor.active === true;
          else if (action.port === 'advance-open') {
            let resource: string | undefined;
            if (!state.open) {
              state.open = true; state.expanded = false; resource = descriptor.clickAudio;
            } else if (!state.expanded) {
              state.expanded = true; resource = descriptor.openAudio;
            } else {
              state.open = false; state.expanded = false; resource = descriptor.closeAudio;
            }
            if (resource) playHyaAudio(resource);
          } else if (action.port === 'toggle-open') {
            state.open = !state.open;
            state.expanded = state.open;
            const resource = state.open ? descriptor.openAudio : descriptor.closeAudio;
            if (resource) playHyaAudio(resource);
          }
          applyListRows();
        },
      },
    });
    applyListRows();

    function registerAudioGain(resourceId: string | undefined, gain: number | undefined): void {
      if (resourceId && Number.isFinite(gain)) hyaAudioGains.set(resourceId, gain!);
    }
  };

  const hyaPoint = (event: PointerEvent): readonly [number, number] => {
    const rect = hyaCanvas.getBoundingClientRect();
    const width = hyaPlayer?.animation.canvas.width ?? 1; const height = hyaPlayer?.animation.canvas.height ?? 1;
    const scale = Math.min(rect.width / width, rect.height / height);
    const offsetX = (rect.width - width * scale) / 2; const offsetY = (rect.height - height * scale) / 2;
    return [(event.clientX - rect.left - offsetX) / scale, (event.clientY - rect.top - offsetY) / scale];
  };
  hyaCanvas.addEventListener('pointermove', event => hyaInteraction?.dispatchPointer({ kind: 'move', pointerId: event.pointerId, point: hyaPoint(event) }));
  hyaCanvas.addEventListener('pointerdown', event => {
    void (hyaAudioContext ??= new AudioContext()).resume();
    hyaInteraction?.dispatchPointer({ kind: 'down', pointerId: event.pointerId, point: hyaPoint(event), button: event.button });
  });
  hyaCanvas.addEventListener('pointerup', event => hyaInteraction?.dispatchPointer({ kind: 'up', pointerId: event.pointerId, point: hyaPoint(event), button: event.button }));
  hyaCanvas.addEventListener('pointerleave', event => hyaInteraction?.dispatchPointer({ kind: 'move', pointerId: event.pointerId, point: [-1e9, -1e9] }));

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
    hyaBytes: ArrayBuffer, report: ConversionReport, label: string, packagedAssets?: readonly AutomaticConversionAsset[],
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
    const parsed = parseAnimation(hyaBytes, { extensions: extensionRegistry });
    const materialized = await materializePackageResources(parsed, packagedAssets, expected?.signal);
    if (expected && (expected.generation !== generation || expected.assetId !== activeSample.id || expected.signal.aborted)) {
      materialized.urls.forEach(url => URL.revokeObjectURL(url));
      return;
    }
    const animation = materialized.animation;
    if (hyaEntity) scene.remove(hyaEntity);
    hyaAssetUrls.forEach(url => URL.revokeObjectURL(url));
    hyaAssetUrls = materialized.urls;
    hyaPlayer = new Animation2DComponent(animation, { autoplay: playing, loop: true, runtimeExtensions });
    hyaEntity = new Entity(`Rive HYA: ${label}`).addComponent(new Transform2D()).addComponent(hyaPlayer);
    scene.add(hyaEntity);
    setupHyaInteraction(animation);
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
    await installHya(hya.buffer, result.report, `${sample.id} · automatic`, result.assets ?? [], { generation: token, assetId: sample.id, signal });
  };

  function clearHya(): void {
    resetHyaInteraction();
    if (hyaEntity) scene.remove(hyaEntity);
    hyaEntity = null; hyaPlayer = null;
    hyaAssetUrls.forEach(url => URL.revokeObjectURL(url));
    hyaAssetUrls = [];
    query('#hya-empty').removeAttribute('hidden');
    setPaneState('hya', '等待转换产物', 'missing');
  }

  sampleSelect.addEventListener('change', () => {
    const sample = manifest.samples.find(value => value.id === sampleSelect.value);
    if (sample) {
      const url = new URL(location.href); url.searchParams.set('sample', sample.id); history.replaceState(null, '', url);
      void loadOfficial(sample).catch(showError);
    }
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
    for (const state of listRows.values()) { state.hover = false; state.open = false; }
    applyListRows();
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
  window.addEventListener('beforeunload', () => { conversionAbort?.abort(); resetHyaInteraction(); void hyaAudioContext?.close(); resize.disconnect(); official?.cleanup(); engine.destroy(); }, { once: true });
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

function riveListActionArguments(action: RuntimeInteractionAction): RiveListActionArguments | null {
  if (action.kind !== 'custom' || action.protocol !== RIVE_COMPONENT_LIST_PROTOCOL || !action.arguments || typeof action.arguments !== 'object') return null;
  const value = action.arguments as Record<string, unknown>;
  const numbers = ['row', 'sourceRow', 'baseX', 'baseY', 'collapsedHeight', 'expandedHeight'] as const;
  const strings = ['list', 'idleNode', 'hoverNode', 'openNode', 'openHoverNode'] as const;
  if (numbers.some(key => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null;
  if (strings.some(key => typeof value[key] !== 'string' || value[key].length === 0)) return null;
  const expandedNode = typeof value.expandedNode === 'string' && value.expandedNode.length > 0 ? value.expandedNode : value.openNode;
  const expandedHoverNode = typeof value.expandedHoverNode === 'string' && value.expandedHoverNode.length > 0
    ? value.expandedHoverNode : value.openHoverNode;
  const openHeight = typeof value.openHeight === 'number' && Number.isFinite(value.openHeight)
    ? value.openHeight : value.collapsedHeight;
  return { ...value, expandedNode, expandedHoverNode, openHeight } as unknown as RiveListActionArguments;
}

async function materializePackageResources(
  animation: ParsedAnimation,
  assets: readonly AutomaticConversionAsset[] | undefined,
  signal?: AbortSignal,
): Promise<{ animation: ParsedAnimation; urls: string[] }> {
  const urls: string[] = [];
  try {
    const uriByPath = new Map<string, string>();
    for (const asset of assets ?? []) {
      if (signal?.aborted) throw signal.reason;
      if (!/^assets\/[0-9a-f]{64}$/u.test(asset.path) || asset.path !== `assets/${asset.sha256}`) {
        throw new Error(`转换资源路径不符合 content-addressed 约束：${asset.path}`);
      }
      const bytes = decodeBase64(asset.base64);
      if (bytes.byteLength !== asset.byteLength) throw new Error(`转换资源长度不匹配：${asset.path}`);
      const actual = await sha256(bytes.buffer);
      if (actual !== asset.sha256) throw new Error(`转换资源 SHA-256 不匹配：${asset.path}`);
      if (uriByPath.has(asset.path)) throw new Error(`转换响应包含重复资源：${asset.path}`);
      const url = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
      urls.push(url); uriByPath.set(asset.path, url);
    }
    const resources = animation.resources.map(resource => {
      const uri = uriByPath.get(resource.uri);
      if (!uri && assets !== undefined && resource.uri.startsWith('assets/')) throw new Error(`转换响应缺少 HYA 包内资源：${resource.uri}`);
      return uri ? Object.freeze({ ...resource, uri }) : resource;
    });
    return { animation: Object.freeze({ ...animation, resources: Object.freeze(resources) }), urls };
  } catch (error) {
    urls.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }
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
