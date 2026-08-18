import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera2D } from '@haiyue/engine';
import { Transform2D } from '@haiyue/engine';
import { Spine2DComponent, Spine2DRenderSystem } from '@haiyue/extensions/spine';

interface SpineSource {
  jsonUrl: string;
  atlasUrl: string;
  imageUrl: string;
  imageUrls: Record<string, string>;
  animations: string[];
  durations: Record<string, number>;
  skins: string[];
  skin: string;
  layers: SpineLayer[];
  revoke(): void;
}

interface SpineLayer {
  name: string;
  bone: string;
  attachment: string;
}

function dataUri(type: string, text: string): string {
  return `data:${type};base64,${btoa(unescape(encodeURIComponent(text)))}`;
}

function createSampleImageUrl(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d')!;
  context.clearRect(0, 0, canvas.width, canvas.height);

  const body = context.createLinearGradient(16, 16, 112, 112);
  body.addColorStop(0, '#73b7ff');
  body.addColorStop(1, '#1f6fb8');
  context.fillStyle = body;
  context.beginPath();
  context.roundRect(16, 18, 96, 92, 22);
  context.fill();
  context.fillStyle = 'rgba(255,255,255,0.28)';
  context.beginPath();
  context.ellipse(50, 42, 20, 12, -0.4, 0, Math.PI * 2);
  context.fill();

  const head = context.createLinearGradient(152, 20, 226, 94);
  head.addColorStop(0, '#ffd66b');
  head.addColorStop(1, '#d97922');
  context.fillStyle = head;
  context.beginPath();
  context.arc(192, 64, 42, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#111827';
  context.beginPath();
  context.arc(178, 56, 5, 0, Math.PI * 2);
  context.arc(206, 56, 5, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#111827';
  context.lineWidth = 4;
  context.beginPath();
  context.arc(192, 68, 18, 0.15, Math.PI - 0.15);
  context.stroke();

  return canvas.toDataURL('image/png');
}

function createSampleSource(): SpineSource {
  const json = {
    skeleton: { hash: 'sample', spine: '3.8.0', width: 220, height: 180 },
    bones: [
      { name: 'root' },
      { name: 'body', parent: 'root', y: -25 },
      { name: 'head', parent: 'body', y: 72 },
    ],
    slots: [
      { name: 'body-slot', bone: 'body', attachment: 'body' },
      { name: 'head-slot', bone: 'head', attachment: 'head' },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          'body-slot': {
            body: { type: 'region', name: 'body', width: 96, height: 92 },
          },
          'head-slot': {
            head: { type: 'region', name: 'head', width: 84, height: 84 },
          },
        },
      },
    ],
    animations: {
      idle: {
        bones: {
          body: {
            rotate: [
              { time: 0, angle: -4 },
              { time: 0.45, angle: 4 },
              { time: 0.9, angle: -4 },
            ],
            translate: [
              { time: 0, y: 0 },
              { time: 0.45, y: 10 },
              { time: 0.9, y: 0 },
            ],
          },
          head: {
            rotate: [
              { time: 0, angle: 7 },
              { time: 0.45, angle: -7 },
              { time: 0.9, angle: 7 },
            ],
          },
        },
      },
      nod: {
        bones: {
          head: {
            rotate: [
              { time: 0, angle: -16 },
              { time: 0.2, angle: 18 },
              { time: 0.4, angle: -16 },
              { time: 0.6, angle: 18 },
              { time: 0.8, angle: -16 },
            ],
          },
        },
      },
    },
  };
  const atlas = [
    'sample.png',
    'size: 256,128',
    'format: RGBA8888',
    'filter: Linear,Linear',
    'repeat: none',
    'body',
    '  rotate: false',
    '  xy: 16, 18',
    '  size: 96, 92',
    '  orig: 96, 92',
    '  offset: 0, 0',
    'head',
    '  rotate: false',
    '  xy: 150, 22',
    '  size: 84, 84',
    '  orig: 84, 84',
    '  offset: 0, 0',
  ].join('\n');
  return {
    jsonUrl: dataUri('application/json', JSON.stringify(json)),
    atlasUrl: dataUri('text/plain', atlas),
    imageUrl: createSampleImageUrl(),
    imageUrls: {},
    animations: Object.keys(json.animations),
    durations: getAnimationDurations(json.animations),
    skins: ['default'],
    skin: 'default',
    layers: getLayerList(json),
    revoke() {},
  };
}

function filePath(file: File): string {
  return ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(/\\/g, '/');
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

function resolvePath(baseDir: string, path: string): string {
  const out: string[] = [];
  for (const part of `${baseDir}/${path}`.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function parseSpineMeta(text: string): { animations: string[]; durations: Record<string, number>; skins: string[]; layers: SpineLayer[] } {
  try {
    const json = JSON.parse(text);
    const animations = json.animations ?? {};
    const skins = getSkinNames(json.skins);
    return {
      animations: Object.keys(animations),
      durations: getAnimationDurations(animations),
      skins,
      layers: getLayerList(json),
    };
  } catch {
    return { animations: [], durations: {}, skins: ['default'], layers: [] };
  }
}

function getLayerList(json: unknown): SpineLayer[] {
  if (!json || typeof json !== 'object') return [];
  const slots = (json as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return [];
  return slots.map((slot): SpineLayer => {
    const value = slot && typeof slot === 'object' ? slot as Record<string, unknown> : {};
    return {
      name: typeof value.name === 'string' ? value.name : '',
      bone: typeof value.bone === 'string' ? value.bone : '',
      attachment: typeof value.attachment === 'string' ? value.attachment : '',
    };
  }).filter(slot => slot.name.length > 0);
}

function getSkinNames(skins: unknown): string[] {
  if (Array.isArray(skins)) {
    const names = skins
      .map((skin: unknown) => skin && typeof skin === 'object' ? (skin as { name?: unknown }).name : null)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    return names.length ? names : ['default'];
  }
  if (skins && typeof skins === 'object') {
    const names = Object.keys(skins);
    return names.length ? names : ['default'];
  }
  return ['default'];
}

function getAnimationDurations(animations: Record<string, unknown>): Record<string, number> {
  const durations: Record<string, number> = {};
  for (const [name, animation] of Object.entries(animations)) durations[name] = getTimelineDuration(animation);
  return durations;
}

function getAtlasPages(text: string): string[] {
  const pages: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (!line || line.includes(':')) continue;
    const next = lines[i + 1]?.trim() ?? '';
    if (next.startsWith('size:') || next.startsWith('format:') || next.startsWith('filter:') || next.startsWith('repeat:') || next.startsWith('pma:')) {
      pages.push(line);
    }
  }
  return pages;
}

function getTimelineDuration(value: unknown): number {
  let duration = 0;
  const scan = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const frame of node) {
        if (frame && typeof frame === 'object' && typeof (frame as { time?: unknown }).time === 'number') {
          duration = Math.max(duration, (frame as { time: number }).time);
        }
      }
    } else if (node && typeof node === 'object') {
      for (const child of Object.values(node)) scan(child);
    }
  };
  scan(value);
  return duration;
}

async function createLocalSource(files: FileList | File[]): Promise<SpineSource> {
  const list = Array.from(files);
  const jsonFile = list.find(file => /\.json$/i.test(file.name));
  if (!jsonFile) throw new Error('Select a folder that contains a Spine .json file.');
  const atlasFiles = list.filter(file => /\.atlas$/i.test(file.name));
  const atlasFile = atlasFiles.find(file => !/-pma\.atlas$/i.test(file.name)) ?? atlasFiles[0] ?? null;
  const urls: string[] = [];
  const makeUrl = (file: File): string => {
    const url = URL.createObjectURL(file);
    urls.push(url);
    return url;
  };

  const jsonText = await jsonFile.text();
  const meta = parseSpineMeta(jsonText);
  const jsonBase = dirname(filePath(jsonFile));
  let imageFile = list.find(file => /\.(png|jpg|jpeg|webp)$/i.test(file.name)) ?? null;
  const imageUrls: Record<string, string> = {};
  let atlasUrl = '';
  if (atlasFile) {
    const atlasText = await atlasFile.text();
    const atlasBase = dirname(filePath(atlasFile));
    const pages = getAtlasPages(atlasText);
    for (const page of pages) {
      const pageMatch = list.find(file => filePath(file) === resolvePath(atlasBase, page) || file.name === page.split('/').pop());
      if (!pageMatch) continue;
      imageUrls[page] = makeUrl(pageMatch);
      imageFile ??= pageMatch;
    }
    const firstPage = pages[0] ?? '';
    const pageMatch = firstPage
      ? list.find(file => filePath(file) === resolvePath(atlasBase, firstPage) || file.name === firstPage.split('/').pop())
      : null;
    imageFile = pageMatch ?? imageFile;
    atlasUrl = makeUrl(atlasFile);
  } else {
    const attachmentNames = Object.keys(JSON.parse(jsonText).skins?.[0]?.attachments ?? {});
    const atlasText = [
      imageFile?.name ?? 'spine.png',
      'size: 1,1',
      'format: RGBA8888',
      'filter: Linear,Linear',
      'repeat: none',
      ...attachmentNames.flatMap(name => [name, '  rotate: false', '  xy: 0, 0', '  size: 1, 1', '  orig: 1, 1', '  offset: 0, 0']),
    ].join('\n');
    atlasUrl = dataUri('text/plain', atlasText);
  }
  if (!imageFile) throw new Error('Select a folder that contains the atlas image.');

  return {
    jsonUrl: makeUrl(jsonFile),
    atlasUrl,
    imageUrl: makeUrl(imageFile),
    imageUrls,
    animations: meta.animations,
    durations: meta.durations,
    skins: meta.skins,
    skin: 'default',
    layers: meta.layers,
    revoke: () => urls.forEach(url => URL.revokeObjectURL(url)),
  };
}

async function main(): Promise<void> {
  const regression = new URLSearchParams(location.search).get('regression') === '1';
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const sampleButton = document.getElementById('sample-button') as HTMLButtonElement;
  const folderButton = document.getElementById('folder-button') as HTMLButtonElement;
  const folderInput = document.getElementById('folder-input') as HTMLInputElement;
  const animationSelect = document.getElementById('animation-select') as HTMLSelectElement;
  const skinSelect = document.getElementById('skin-select') as HTMLSelectElement;
  const scaleInput = document.getElementById('scale-input') as HTMLInputElement;
  const speedInput = document.getElementById('speed-input') as HTMLInputElement;
  const mixInput = document.getElementById('mix-input') as HTMLInputElement;
  const meshToggle = document.getElementById('mesh-toggle') as HTMLInputElement;
  const bonesToggle = document.getElementById('bones-toggle') as HTMLInputElement;
  const playButton = document.getElementById('play-button') as HTMLButtonElement;
  const timelineInput = document.getElementById('timeline-input') as HTMLInputElement;
  const timeLabel = document.getElementById('time-label') as HTMLElement;
  const layerTree = document.getElementById('layer-tree') as HTMLElement;
  const status = document.getElementById('status') as HTMLElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.06, g: 0.08, b: 0.12, a: 1 },
    alphaMode: 'premultiplied',
    msaaSamples: 4,
  });
  await engine.init();
  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraEntity = new Entity('Camera2D');
  cameraEntity.addComponent(new Camera2D({ width: 960, height: 640, zoom: 1 }));
  const scene = engine.createScene({
    name: 'Spine Viewer',
    camera: cameraEntity,
    render3D: false,
    render2D: false,
    gui: false,
    pipelineLabel: 'SpineViewer.render',
  });
  const { world } = scene;

  const spine = new Spine2DComponent({ loop: true, scale: 1, timeScale: 1, mixDuration: Number(mixInput.value) });
  const spineEntity = new Entity('Spine Model');
  spineEntity.addComponent(new Transform2D({ x: 0, y: -70 }));
  spineEntity.addComponent(spine);
  world.addEntity(spineEntity);
  scene.addSystem(new Spine2DRenderSystem(engine, cameraEntity, { loadOp: 'clear' }));

  let currentSource: SpineSource | null = null;
  let isPlaying = true;
  let playbackSpeed = Number(speedInput.value);
  let isScrubbing = false;

  function getCurrentDuration(): number {
    return currentSource?.durations[spine.animation] ?? 0;
  }

  function getCurrentAnimationTime(): number {
    const duration = getCurrentDuration();
    const seconds = spine.elapsed / 1000;
    if (duration <= 0) return seconds;
    return spine.loop ? seconds % duration : Math.min(seconds, duration);
  }

  function setPlaybackState(playing: boolean): void {
    isPlaying = playing;
    spine.timeScale = isPlaying ? playbackSpeed : 0;
    playButton.textContent = isPlaying ? 'Pause' : 'Play';
  }

  function setAnimationTime(seconds: number): void {
    spine.elapsed = Math.max(0, seconds) * 1000;
  }

  function changeAnimation(nextAnimation: string): void {
    if (nextAnimation === spine.animation) return;
    spine.previousAnimation = spine.animation;
    spine.previousElapsed = spine.elapsed;
    spine.mixElapsed = 0;
    spine.animation = nextAnimation;
    spine.elapsed = 0;
    if (spine.mixDuration <= 0) spine.previousAnimation = '';
  }

  function renderLayerTree(source: SpineSource): void {
    const byBone = new Map<string, SpineLayer[]>();
    for (const layer of source.layers) {
      const list = byBone.get(layer.bone) ?? [];
      list.push(layer);
      byBone.set(layer.bone, list);
    }
    const fragment = document.createDocumentFragment();
    for (const [bone, layers] of byBone) {
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = bone || 'root';
      details.append(summary);
      for (const layer of layers) {
        const row = document.createElement('div');
        row.className = 'slot';
        const name = document.createElement('span');
        name.textContent = layer.name;
        const attachment = document.createElement('span');
        attachment.className = 'attachment';
        attachment.textContent = layer.attachment || '-';
        row.append(name, attachment);
        details.append(row);
      }
      fragment.append(details);
    }
    layerTree.replaceChildren(fragment);
  }

  function updateTimelineControls(): void {
    const duration = getCurrentDuration();
    const current = duration > 0 ? getCurrentAnimationTime() : 0;
    timelineInput.disabled = duration <= 0;
    timelineInput.max = String(Math.max(duration, 0.001));
    if (!isScrubbing) timelineInput.value = String(current);
    timeLabel.textContent = `${current.toFixed(3)} / ${duration.toFixed(3)}s`;
  }

  function applySource(source: SpineSource): void {
    currentSource?.revoke();
    currentSource = source;
    spine.jsonUrl = source.jsonUrl;
    spine.atlasUrl = source.atlasUrl;
    spine.imageUrl = source.imageUrl;
    spine.imageUrls = source.imageUrls;
    spine.skin = source.skins.includes(source.skin) ? source.skin : source.skins[0] ?? 'default';
    spine.animation = source.animations.includes('idle') ? 'idle' : source.animations[0] ?? '';
    spine.elapsed = 0;
    spine.previousAnimation = '';
    spine.mixElapsed = 0;
    spine.runtimeKey = '';
    spine.loadingKey = '';
    spine.status = 'idle';
    animationSelect.replaceChildren(...(source.animations.length ? source.animations : ['']).map(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name || 'setup pose';
      return option;
    }));
    animationSelect.value = spine.animation;
    skinSelect.replaceChildren(...source.skins.map(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      return option;
    }));
    skinSelect.value = spine.skin;
    renderLayerTree(source);
    setPlaybackState(true);
    updateTimelineControls();
    status.textContent = 'Loading...';
  }

  sampleButton.addEventListener('click', () => applySource(createSampleSource()));
  folderButton.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    const files = folderInput.files;
    if (!files?.length) return;
    void createLocalSource(files)
      .then(applySource)
      .catch(error => {
        status.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        folderInput.value = '';
      });
  });
  animationSelect.addEventListener('change', () => {
    changeAnimation(animationSelect.value);
    updateTimelineControls();
  });
  skinSelect.addEventListener('change', () => {
    spine.skin = skinSelect.value || 'default';
    spine.runtimeKey = '';
  });
  scaleInput.addEventListener('input', () => {
    spine.scale = Number(scaleInput.value);
  });
  speedInput.addEventListener('input', () => {
    playbackSpeed = Number(speedInput.value);
    if (isPlaying) spine.timeScale = playbackSpeed;
  });
  mixInput.addEventListener('input', () => {
    spine.mixDuration = Number(mixInput.value);
  });
  meshToggle.addEventListener('change', () => {
    spine.debugMesh = meshToggle.checked;
  });
  bonesToggle.addEventListener('change', () => {
    spine.debugBones = bonesToggle.checked;
  });
  playButton.addEventListener('click', () => {
    setPlaybackState(!isPlaying);
  });
  timelineInput.addEventListener('pointerdown', () => {
    isScrubbing = true;
  });
  timelineInput.addEventListener('pointerup', () => {
    isScrubbing = false;
  });
  timelineInput.addEventListener('input', () => {
    setPlaybackState(false);
    setAnimationTime(Number(timelineInput.value));
    updateTimelineControls();
  });

  applySource(createSampleSource());

  let regressionFrames = 0;
  let regressionFinished = false;
  engine.on('update', () => {
    updateTimelineControls();
    status.textContent = spine.status === 'error'
      ? spine.error ?? 'Spine load error.'
      : `${spine.status} · animation: ${spine.animation || 'setup pose'}`;
    if (regression && !regressionFinished && spine.status === 'loaded' && ++regressionFrames >= 6) {
      regressionFinished = true;
      setPlaybackState(false);
      void finishRegression();
    }
  });
  engine.switchScene(scene);
  engine.run();

  async function finishRegression(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    const result = document.getElementById('result')!;
    const resultStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    result.dataset.status = resultStatus;
    result.textContent = JSON.stringify({
      schemaVersion: 1,
      suite: 'spine-viewer-screenshot',
      status: resultStatus,
      animation: spine.animation,
      runtimeStatus: spine.status,
      errors: validationErrors,
    });
    engine.stop();
  }
}

main().catch(error => {
  const status = document.getElementById('status');
  if (status) status.textContent = error instanceof Error ? error.message : String(error);
  const result = document.getElementById('result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
  console.error(error);
});
