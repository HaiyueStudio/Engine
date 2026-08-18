import {
  ANIMATION_MIME_TYPE,
  encodeAnimationBinary,
  parseAnimation,
  type AnimationDocument,
} from '@haiyue/animation-spec';
import {
  convertLottie,
  type LottieConversionResult,
} from '@haiyue/animation-spec/lottie';
import { Animation2DComponent, Animation2DRenderSystem, Animation2DSystem } from '@haiyue/extensions/animation';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import { Particle2DRenderSystem, Particle2DSystem } from '@haiyue/engine/systems';

const WIDTH = 800;
const HEIGHT = 450;
const MAX_LOTTIE_JSON_CHARACTERS = 16 * 1024 * 1024;
const MAX_JSON_PREVIEW_CHARACTERS = 512 * 1024;

interface PlaygroundState {
  player: Animation2DComponent | null;
  playerEntity: Entity | null;
  binary: ArrayBuffer | null;
  document: AnimationDocument | null;
  conversion: LottieConversionResult | null;
  sourceLabel: string;
  sourceBaseUrl: string | undefined;
}

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const sourceInput = query<HTMLTextAreaElement>('#lottie-json');
  const urlInput = query<HTMLInputElement>('#lottie-url');
  const loadUrlButton = query<HTMLButtonElement>('#load-url');
  const convertButton = query<HTMLButtonElement>('#convert');
  const resetButton = query<HTMLButtonElement>('#reset-source');
  const downloadButton = query<HTMLButtonElement>('#download-hya');
  const copyButton = query<HTMLButtonElement>('#copy-json');
  const particleDemo = query<HTMLInputElement>('#particle-demo');
  const status = query<HTMLElement>('#conversion-status');
  const diagnostics = query<HTMLElement>('#diagnostics');
  const outputJson = query<HTMLElement>('#hya-json');
  const stats = query<HTMLElement>('#stats');
  const playButton = query<HTMLButtonElement>('#play');
  const restartButton = query<HTMLButtonElement>('#restart');
  const previousFrameButton = query<HTMLButtonElement>('#previous-frame');
  const nextFrameButton = query<HTMLButtonElement>('#next-frame');
  const timeline = query<HTMLInputElement>('#timeline');
  const currentTime = query<HTMLOutputElement>('#current-time');
  const duration = query<HTMLOutputElement>('#duration');
  const speed = query<HTMLInputElement>('#speed');
  const speedValue = query<HTMLOutputElement>('#speed-value');
  const loop = query<HTMLInputElement>('#loop');

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.018, g: 0.025, b: 0.055, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraEntity = new Entity('Animation camera');
  const camera = new Camera2D({
    width: WIDTH,
    height: HEIGHT,
    designWidth: WIDTH,
    designHeight: HEIGHT,
    viewportMode: 'fit',
  });
  cameraEntity.addComponent(camera);
  const scene = engine.createScene({
    name: 'Haiyue animation converter',
    camera: { type: '2d', entity: cameraEntity },
    render3D: false,
    render2D: false,
    gui: false,
    pipelineLabel: 'AnimationSpec.render',
  });
  scene.addSystem(new Animation2DSystem({ priority: -10, assetManager: engine.assetManager! }), false);
  scene.addSystem(new Particle2DSystem({ priority: -9 }), false);
  const animationRenderer = new Animation2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', maxMaskTargets: 16 });
  const particleRenderer = new Particle2DRenderSystem(engine, cameraEntity, { loadOp: 'load', priority: 10 });
  scene.addSystem(animationRenderer);
  scene.addSystem(particleRenderer);

  const state: PlaygroundState = {
    player: null,
    playerEntity: null,
    binary: null,
    document: null,
    conversion: null,
    sourceLabel: 'lottie-animation',
    sourceBaseUrl: undefined,
  };
  let urlLoad: AbortController | null = null;
  let scrubbing = false;
  let resumeAfterScrub = false;

  const setBusy = (busy: boolean): void => {
    loadUrlButton.disabled = busy;
    convertButton.disabled = busy;
    resetButton.disabled = busy;
    status.dataset.kind = busy ? 'working' : status.dataset.kind;
    if (busy) status.textContent = '正在读取并转换…';
  };

  const setStatus = (message: string, kind: 'idle' | 'working' | 'success' | 'error'): void => {
    status.textContent = message;
    status.dataset.kind = kind;
  };

  const renderDiagnostics = (conversion: LottieConversionResult): void => {
    diagnostics.replaceChildren();
    if (conversion.diagnostics.length === 0 && conversion.fonts.length === 0) {
      const item = document.createElement('li');
      item.className = 'diagnostic diagnostic--success';
      item.textContent = '无转换诊断，当前输入完整落入已支持能力。';
      diagnostics.append(item);
    }
    const fragment = document.createDocumentFragment();
    for (const diagnostic of conversion.diagnostics) {
      const item = document.createElement('li');
      item.className = `diagnostic diagnostic--${diagnostic.severity}`;
      const code = document.createElement('code');
      code.textContent = diagnostic.code;
      const message = document.createElement('span');
      message.textContent = `${diagnostic.message} · ${diagnostic.path}`;
      item.append(code, message);
      fragment.append(item);
    }
    for (const font of conversion.fonts) {
      const item = document.createElement('li');
      item.className = `diagnostic diagnostic--${font.mapped ? 'success' : 'warning'}`;
      const code = document.createElement('code');
      code.textContent = font.mapped ? 'FONT_MAPPED' : 'FONT_MAPPING_REQUIRED';
      const message = document.createElement('span');
      const delivery = font.mapped
        ? `${font.uri}${font.integrity ? ` · ${font.integrity}` : ' · 未记录内容哈希'}`
        : '请在 LottieConversionOptions.fonts 中映射 WOFF2 资源';
      message.textContent = `${font.name} → ${font.resolvedFamily} · ${font.usageCount} 处使用 · ${delivery}`;
      item.append(code, message);
      fragment.append(item);
    }
    diagnostics.append(fragment);
  };

  const refreshPlaybackUi = (): void => {
    const player = state.player;
    const enabled = player !== null;
    playButton.disabled = !enabled;
    restartButton.disabled = !enabled;
    previousFrameButton.disabled = !enabled;
    nextFrameButton.disabled = !enabled;
    timeline.disabled = !enabled;
    playButton.textContent = player?.playing ? '暂停' : '播放';
    if (!player) return;
    if (!scrubbing) timeline.value = String(player.currentTime);
    currentTime.value = formatTime(player.currentTime);
    duration.value = formatTime(player.animation.duration);
  };

  const installPlayer = (
    conversion: LottieConversionResult,
    sourceLabel: string,
    sourceBaseUrl?: string,
  ): void => {
    const animationDocument = particleDemo.checked
      ? withParticleDemo(conversion.document)
      : conversion.document;
    const binary = encodeAnimationBinary(animationDocument);
    const parsed = parseAnimation(binary);
    const nextEntity = new Entity(`Converted player: ${sourceLabel}`).addComponent(new Transform2D());
    const nextPlayer = new Animation2DComponent(parsed, {
      autoplay: true,
      loop: loop.checked,
      speed: Number(speed.value),
    });
    nextEntity.addComponent(nextPlayer);

    if (state.playerEntity) scene.remove(state.playerEntity);
    scene.add(nextEntity);
    state.playerEntity = nextEntity;
    state.player = nextPlayer;
    state.binary = binary;
    state.document = animationDocument;
    state.conversion = conversion;
    state.sourceLabel = sourceLabel;
    state.sourceBaseUrl = sourceBaseUrl;

    camera.setViewportFit({
      designWidth: parsed.canvas.width,
      designHeight: parsed.canvas.height,
      viewportMode: 'fit',
    });
    camera.resize(engine.displayWidth, engine.displayHeight);
    timeline.min = '0';
    timeline.max = String(parsed.duration);
    timeline.step = String(1 / (parsed.frameRate ?? 60));
    timeline.value = '0';
    outputJson.textContent = documentPreview(animationDocument);
    downloadButton.disabled = false;
    copyButton.disabled = false;
    stats.textContent = [
      `${binary.byteLength.toLocaleString()} B HYA`,
      `${parsed.nodes.length} nodes`,
      `${parsed.tracks.length} tracks`,
      `${conversion.convertedLayerCount} converted`,
      `${conversion.skippedLayerCount} skipped`,
      `${conversion.fonts.filter(font => !font.mapped).length} unresolved fonts`,
    ].join(' · ');
    renderDiagnostics(conversion);
    setStatus(`已生成 ${binary.byteLength.toLocaleString()} 字节 HYA，并载入 WebGPU 预览。`, 'success');
    refreshPlaybackUi();
  };

  const convertSource = (
    source: Readonly<Record<string, unknown>>,
    sourceLabel: string,
    sourceBaseUrl?: string,
  ): void => {
    const conversion = convertLottie(source, {
      strict: false,
      ...(sourceBaseUrl ? { imageBaseUrl: sourceBaseUrl } : {}),
    });
    installPlayer(conversion, sourceLabel, sourceBaseUrl);
  };

  const convertTextInput = (): void => {
    setBusy(true);
    try {
      const source = parseJsonObject(sourceInput.value);
      convertSource(source, sourceName(source, 'pasted-lottie'), deriveBaseUrl(urlInput.value));
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const loadFromUrl = async (): Promise<void> => {
    urlLoad?.abort('replaced');
    const controller = new AbortController();
    urlLoad = controller;
    setBusy(true);
    try {
      const url = new URL(urlInput.value.trim(), window.location.href);
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`请求失败：${response.status} ${response.statusText}`);
      const source = parseJsonObject(await response.text());
      if (controller.signal.aborted) return;
      sourceInput.value = JSON.stringify(source, null, 2);
      const responseUrl = response.url || url.href;
      convertSource(source, sourceName(source, fileStem(responseUrl)), deriveBaseUrl(responseUrl));
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus(`${errorMessage(error)}。远程地址还需要允许浏览器 CORS 访问。`, 'error');
      }
    } finally {
      if (urlLoad === controller) {
        urlLoad = null;
        setBusy(false);
      }
    }
  };

  const seekByFrame = (direction: -1 | 1): void => {
    const player = state.player;
    if (!player) return;
    player.pause();
    const frame = 1 / (player.animation.frameRate ?? 60);
    player.seek(player.currentTime + frame * direction);
    refreshPlaybackUi();
  };

  loadUrlButton.addEventListener('click', () => void loadFromUrl());
  urlInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') void loadFromUrl();
  });
  convertButton.addEventListener('click', convertTextInput);
  resetButton.addEventListener('click', () => {
    urlLoad?.abort('reset');
    urlInput.value = '';
    sourceInput.value = JSON.stringify(createLottieSource(), null, 2);
    state.sourceBaseUrl = undefined;
    convertTextInput();
  });
  particleDemo.addEventListener('change', convertTextInput);
  downloadButton.addEventListener('click', () => {
    if (!state.binary) return;
    const url = URL.createObjectURL(new Blob([state.binary], { type: ANIMATION_MIME_TYPE }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFilename(state.sourceLabel)}.hya`;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setStatus(`已生成下载文件 ${anchor.download}。`, 'success');
  });
  copyButton.addEventListener('click', () => {
    if (!state.document) return;
    void navigator.clipboard.writeText(JSON.stringify(state.document, null, 2))
      .then(() => setStatus('已复制 HYA JSON 表示。', 'success'))
      .catch(error => setStatus(`复制失败：${errorMessage(error)}`, 'error'));
  });
  playButton.addEventListener('click', () => {
    const player = state.player;
    if (!player) return;
    if (player.playing) player.pause();
    else player.play();
    refreshPlaybackUi();
  });
  restartButton.addEventListener('click', () => {
    state.player?.seek(0).play();
    refreshPlaybackUi();
  });
  previousFrameButton.addEventListener('click', () => seekByFrame(-1));
  nextFrameButton.addEventListener('click', () => seekByFrame(1));
  timeline.addEventListener('pointerdown', () => {
    scrubbing = true;
    resumeAfterScrub = state.player?.playing ?? false;
    state.player?.pause();
  });
  timeline.addEventListener('input', () => {
    state.player?.seek(Number(timeline.value));
    refreshPlaybackUi();
  });
  const finishScrub = (): void => {
    if (!scrubbing) return;
    scrubbing = false;
    if (resumeAfterScrub) state.player?.play();
    resumeAfterScrub = false;
    refreshPlaybackUi();
  };
  timeline.addEventListener('change', finishScrub);
  timeline.addEventListener('pointerup', finishScrub);
  timeline.addEventListener('pointercancel', finishScrub);
  speed.addEventListener('input', () => {
    const value = Number(speed.value);
    state.player?.setSpeed(value);
    speedValue.value = `${value.toFixed(2)}×`;
  });
  loop.addEventListener('change', () => {
    if (state.player) state.player.loop = loop.checked;
  });
  window.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.code === 'Space') {
      event.preventDefault();
      playButton.click();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekByFrame(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekByFrame(1);
    }
  });

  sourceInput.value = JSON.stringify(createLottieSource(), null, 2);
  engine.switchScene(scene);
  engine.run();
  if (new URLSearchParams(window.location.search).get('verify') === 'url-input') {
    const source = createUrlVerificationSource();
    urlInput.value = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(source))}`;
    await loadFromUrl();
  } else {
    convertTextInput();
  }

  let frames = 0;
  let validationStarted = false;
  engine.on('after-update', () => {
    frames++;
    refreshPlaybackUi();
    const player = state.player;
    if (!validationStarted && player && frames >= 10 && (player.runtimeStats.pendingResourceCount === 0 || frames >= 180)) {
      validationStarted = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    const player = state.player;
    if (!state.binary || !player) validationErrors.push('Initial conversion did not create a player and HYA binary.');
    else {
      const parsed = parseAnimation(state.binary);
      if (parsed.source !== 'binary' || parsed.backingBuffer !== state.binary) {
        validationErrors.push('HYA binary was not parsed with its backing buffer.');
      }
      if (player.runtimeStats.visualCount === 0) validationErrors.push('Initial runtime has no visuals.');
      if (player.runtimeStats.pendingResourceCount !== 0 || player.runtimeStats.failedResourceCount !== 0) {
        validationErrors.push(`Resources pending=${player.runtimeStats.pendingResourceCount}, failed=${player.runtimeStats.failedResourceCount}.`);
      }
      if (Number(timeline.max) !== parsed.duration || downloadButton.disabled) {
        validationErrors.push('Timeline or HYA download controls were not initialized.');
      }
      const wasPlaying = player.playing;
      const previousTime = player.currentTime;
      const scrubTarget = parsed.duration * 0.5;
      timeline.value = String(scrubTarget);
      timeline.dispatchEvent(new Event('input'));
      if (Math.abs(player.currentTime - scrubTarget) > 1e-6) {
        validationErrors.push('Timeline input did not seek the active animation player.');
      }
      player.seek(previousTime);
      if (wasPlaying) player.play();
    }
    if (animationRenderer.stats.droppedCompositeCount !== 0) {
      validationErrors.push(`Composite budget dropped ${animationRenderer.stats.droppedCompositeCount} source(s).`);
    }
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.animationBytes = String(state.binary?.byteLength ?? 0);
    document.body.dataset.animationVisuals = String(player?.runtimeStats.visualCount ?? 0);
    const result = query<HTMLElement>('#result');
    result.dataset.status = validationErrors.length === 0 ? 'passed' : 'failed';
    result.textContent = JSON.stringify({
      status: result.dataset.status,
      errors: validationErrors,
      bytes: state.binary?.byteLength ?? 0,
      runtime: player?.runtimeStats ?? null,
      particles: particleRenderer.stats,
      composites: animationRenderer.stats,
      timeline: { max: Number(timeline.max), step: Number(timeline.step) },
    });
  }
}

function withParticleDemo(document: AnimationDocument): AnimationDocument {
  const resourceIds = new Set((document.resources ?? []).map(resource => resource.id));
  const nodeIds = new Set(document.nodes.map(node => node.id));
  const resourceId = uniqueId('haiyue:particle-dot', resourceIds);
  const nodeId = uniqueId('haiyue:native-particles', nodeIds);
  return {
    ...document,
    resources: [
      ...(document.resources ?? []),
      {
        id: resourceId,
        type: 'image',
        uri: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="white"/></svg>')}`,
        width: 32,
        height: 32,
      },
    ],
    nodes: [
      ...document.nodes,
      {
        id: nodeId,
        name: 'Optional native particle emitter',
        transform: { position: [document.canvas.width / 2, document.canvas.height * 0.78] },
        components: [{
          type: 'particle2d',
          resource: resourceId,
          maxParticles: 384,
          emissionRate: 90,
          burst: 24,
          seed: 42,
          lifetime: [0.7, 1.4],
          speed: [45, 125],
          angle: [-2.35, -0.8],
          gravity: [0, 85],
          startSize: [5, 11],
          endSize: [0, 3],
          startColor: [0.45, 0.95, 1, 0.95],
          endColor: [0.55, 0.25, 1, 0],
          shape: 'box',
          shapeSize: [Math.min(130, document.canvas.width * 0.3), 8],
          blendMode: 'additive',
        }],
      },
    ],
  };
}

function parseJsonObject(source: string): Readonly<Record<string, unknown>> {
  if (source.length > MAX_LOTTIE_JSON_CHARACTERS) {
    throw new Error(`JSON 超过页面允许的 ${(MAX_LOTTIE_JSON_CHARACTERS / 1024 / 1024).toFixed(0)} MiB 上限。`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`JSON 解析失败：${errorMessage(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Lottie 根数据必须是 JSON object。');
  return value as Readonly<Record<string, unknown>>;
}

function deriveBaseUrl(source: string): string | undefined {
  const value = source.trim();
  if (!value) return undefined;
  try { return new URL('.', new URL(value, window.location.href)).href; } catch { return undefined; }
}

function sourceName(source: Readonly<Record<string, unknown>>, fallback: string): string {
  return typeof source.nm === 'string' && source.nm.trim() ? source.nm.trim() : fallback;
}

function fileStem(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return 'lottie-animation';
    const name = parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'lottie-animation';
    return name.replace(/\.json$/i, '') || 'lottie-animation';
  } catch {
    return 'lottie-animation';
  }
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'animation';
}

function uniqueId(preferred: string, used: ReadonlySet<string>): string {
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) suffix++;
  return `${preferred}-${suffix}`;
}

function documentPreview(document: AnimationDocument): string {
  const json = JSON.stringify(document, null, 2);
  if (json.length <= MAX_JSON_PREVIEW_CHARACTERS) return json;
  return `${json.slice(0, MAX_JSON_PREVIEW_CHARACTERS)}\n\n…预览已截断；“复制 HYA JSON”和“.hya 下载”仍包含完整数据。`;
}

function formatTime(value: number): string { return `${Math.max(0, value).toFixed(3)}s`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function query<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing required example element: ${selector}`);
  return value;
}

function createLottieSource(): Readonly<Record<string, unknown>> {
  const staticValue = (value: number | number[]) => ({ a: 0, k: value });
  const animated = (start: number[], end: number[], startFrame = 0, endFrame = 120) => ({
    a: 1,
    k: [
      { t: startFrame, s: start, e: end, o: { x: 0.42, y: 0 }, i: { x: 0.58, y: 1 } },
      { t: endFrame, s: end },
    ],
  });
  const transform = (position: unknown, anchor: number[], rotation: unknown = staticValue(0), opacity: unknown = staticValue(100)) => ({
    p: position,
    a: staticValue(anchor),
    s: staticValue([100, 100]),
    r: rotation,
    o: opacity,
  });
  const path = (vertices: number[][], incoming: number[][], outgoing: number[][]) => ({
    a: 0, k: { v: vertices, i: incoming, o: outgoing, c: true },
  });
  const zeroTangents = (count: number) => Array.from({ length: count }, () => [0, 0]);
  const spriteUri = `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="180" height="120" viewBox="0 0 180 120">
      <rect width="180" height="120" rx="20" fill="#8b5cf6"/>
      <path d="M20 88 Q55 28 90 82 T160 38" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/>
    </svg>
  `)}`;
  const diamond = [[90, -12], [162, 60], [90, 132], [18, 60]];
  const curvedBadge = [[-90, 0], [0, -65], [90, 0], [0, 65]];

  return {
    v: '5.12.0',
    nm: 'Haiyue motion card',
    fr: 60,
    ip: 0,
    op: 120,
    w: WIDTH,
    h: HEIGHT,
    assets: [
      { id: 'badge-image', w: 180, h: 120, p: spriteUri, u: '' },
      { id: 'demo-audio', p: createToneWavUri(), u: '' },
    ],
    layers: [
      {
        ind: 9, ty: 5, nm: 'Runtime text', ip: 0, op: 120,
        ks: transform(staticValue([400, 62]), [0, 0]),
        t: { d: { k: [{ s: { t: 'HAIYUE MOTION', s: 26, f: 'sans-serif', lh: 32, j: 2, fc: [0.45, 0.95, 0.82], sz: [320, 48] } }] } },
      },
      {
        ind: 8, ty: 6, nm: 'Timeline audio', refId: 'demo-audio', ip: 0, op: 120,
        ks: transform(staticValue([0, 0]), [0, 0]),
      },
      {
        ind: 7, ty: 4, nm: 'Bezier badge', ip: 0, op: 120,
        ks: transform(staticValue([650, 110]), [0, 0], animated([-10], [10])),
        shapes: [
          { ty: 'sh', nm: 'Curved diamond', ks: path(curvedBadge, [[-34, -34], [-34, 34], [34, 34], [34, -34]], [[34, -34], [34, 34], [-34, 34], [-34, -34]]) },
          { ty: 'fl', c: staticValue([0.98, 0.75, 0.2, 1]), o: staticValue(90) },
        ],
      },
      {
        ind: 6, ty: 2, nm: 'Masked sprite', refId: 'badge-image', ip: 0, op: 120,
        ks: transform(staticValue([150, 105]), [90, 60]),
        masksProperties: [{ mode: 'a', inv: false, pt: path(diamond, zeroTangents(4), zeroTangents(4)), o: staticValue(100) }],
      },
      {
        ind: 5, ty: 4, nm: 'Orbit', ip: 0, op: 120,
        ks: transform(staticValue([400, 225]), [0, 0], animated([0], [360])),
        shapes: [
          { ty: 'el', nm: 'Orbit disc', p: staticValue([0, 0]), s: staticValue([210, 210]) },
          { ty: 'fl', c: staticValue([0.12, 0.78, 1, 1]), o: staticValue(20) },
        ],
      },
      {
        ind: 4, ty: 1, nm: 'Moving accent', sw: 128, sh: 18, sc: '#ff5470', ip: 0, op: 120,
        ks: transform(animated([145, 328], [655, 328]), [64, 9], animated([-8], [8]), animated([35], [100])),
      },
      {
        ind: 3, ty: 1, nm: 'Center bar', sw: 270, sh: 22, sc: '#74f2ce', ip: 0, op: 120,
        tt: 1, tp: 5,
        ks: transform(staticValue([400, 225]), [135, 11], animated([-4], [4])),
      },
      {
        ind: 2, ty: 1, nm: 'Small bar', sw: 160, sh: 12, sc: '#f9c74f', ip: 0, op: 120,
        ks: transform(animated([585, 145], [215, 145]), [80, 6]),
      },
      {
        ind: 1, ty: 1, nm: 'Card', sw: 680, sh: 300, sc: '#17264b', ip: 0, op: 120,
        ks: transform(staticValue([400, 225]), [340, 150]),
      },
    ],
  };
}

function createUrlVerificationSource(): Readonly<Record<string, unknown>> {
  return {
    v: '5.12.0', nm: 'URL import verification', fr: 30, ip: 0, op: 30, w: 320, h: 180,
    layers: [{
      ind: 1, ty: 1, nm: 'URL solid', sw: 120, sh: 60, sc: '#74f2ce', ip: 0, op: 30,
      ks: {
        a: { a: 0, k: [60, 30] }, p: { a: 0, k: [160, 90] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
      },
    }],
  };
}

function createToneWavUri(): string {
  const sampleRate = 8_000;
  const sampleCount = 800;
  const bytes = new Uint8Array(44 + sampleCount);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + sampleCount, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  write(36, 'data'); view.setUint32(40, sampleCount, true);
  for (let index = 0; index < sampleCount; index++) {
    const envelope = 1 - index / sampleCount;
    bytes[44 + index] = 128 + Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 440) * 28 * envelope);
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

void main();
