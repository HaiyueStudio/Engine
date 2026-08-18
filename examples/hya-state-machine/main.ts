import {
  ANIMATION_FORMAT,
  ANIMATION_MIME_TYPE,
  ANIMATION_VERSION,
  HYA_STATE_MACHINE_EXTENSION_ID,
  encodeAnimationBinary,
  parseAnimation,
  type AnimationDocument,
  type AnimationTrack,
} from '@haiyue/animation-spec';
import { Animation2DRenderSystem } from '@haiyue/extensions/animation';
import {
  Animation2DStateMachineComponent,
  Animation2DStateMachineSystem,
} from '@haiyue/extensions/hya-state-machine';
import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';

const WIDTH = 800;
const HEIGHT = 500;
const CLIP_NAMES = Object.freeze({ idle: 'Idle', walk: 'Walk', jump: 'Jump', attack: 'Attack' });

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.018, g: 0.025, b: 0.052, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraEntity = new Entity('HYA state-machine camera').addComponent(new Camera2D({
    width: WIDTH,
    height: HEIGHT,
    designWidth: WIDTH,
    designHeight: HEIGHT,
    viewportMode: 'fit',
  }));
  const scene = engine.createScene({
    name: 'HYA single-asset state machine',
    camera: { type: '2d', entity: cameraEntity },
    render3D: false,
    render2D: false,
    gui: false,
    pipelineLabel: 'HyaStateMachine.render',
  });
  scene.addSystem(new Animation2DStateMachineSystem({
    priority: -10,
    assetManager: engine.assetManager!,
  }), false);
  const animationRenderer = new Animation2DRenderSystem(engine, cameraEntity, {
    loadOp: 'clear',
    maxMaskTargets: 4,
  });
  scene.addSystem(animationRenderer);

  // The player consumes one encoded HYA binary, rather than four runtime assets.
  const binary = encodeAnimationBinary(HYA_DOCUMENT);
  const parsed = parseAnimation(binary);
  const characterEntity = new Entity('One HYA character').addComponent(new Transform2D());
  const player = new Animation2DStateMachineComponent(parsed, { autoplay: true });
  characterEntity.addComponent(player);
  scene.add(characterEntity);

  bindActions(player);
  bindFormatPreview(binary);
  updateAssetStats(binary.byteLength, parsed.nodes.length, parsed.tracks.length);

  engine.switchScene(scene);
  engine.run();

  const autoDemoStartedAt = performance.now();
  let frameCount = 0;
  let lastAutoStep = -1;
  let validationFinished = false;
  engine.on('after-update', () => {
    frameCount++;
    updateRuntimeUi(player);
    const auto = query<HTMLInputElement>('#auto-demo').checked;
    if (auto) {
      const step = Math.floor((performance.now() - autoDemoStartedAt) / 2200) % 4;
      if (step !== lastAutoStep) {
        lastAutoStep = step;
        runAutoStep(player, step);
      }
    } else {
      lastAutoStep = -1;
    }
    if (!validationFinished && frameCount >= 12) {
      validationFinished = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (player.runtimeStats.nodeCount !== parsed.nodes.length) {
      validationErrors.push(
        `Expected one ${parsed.nodes.length}-node HYA hierarchy, received ${player.runtimeStats.nodeCount} nodes.`,
      );
    }
    if (characterEntity.children.length !== 1) {
      validationErrors.push(`Expected one generated hierarchy, received ${characterEntity.children.length}.`);
    }
    if (animationRenderer.stats.visualCount === 0) {
      validationErrors.push('Animation2D renderer did not submit any visuals.');
    }
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    const result = query<HTMLElement>('#result');
    result.dataset.status = validationErrors.length === 0 ? 'passed' : 'failed';
    result.textContent = JSON.stringify({
      status: result.dataset.status,
      errors: validationErrors,
      source: parsed.source,
      hierarchyCount: characterEntity.children.length,
      runtime: player.runtimeStats,
      renderer: animationRenderer.stats,
    });
  }
}

function bindActions(player: Animation2DStateMachineComponent): void {
  const auto = query<HTMLInputElement>('#auto-demo');
  const select = (action: keyof typeof CLIP_NAMES): void => {
    auto.checked = false;
    if (action === 'idle') player.setBoolean('moving', false);
    else if (action === 'walk') player.setBoolean('moving', true);
    else player.setTrigger(action);
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    button.addEventListener('click', () => select(button.dataset.action as keyof typeof CLIP_NAMES));
  }
  query<HTMLButtonElement>('#reset').addEventListener('click', () => {
    auto.checked = false;
    player.reset().play();
  });
  window.addEventListener('keydown', event => {
    if (event.repeat) return;
    if (event.key === '1') select('idle');
    else if (event.key === '2') select('walk');
    else if (event.key === '3' || event.key === ' ') {
      event.preventDefault();
      select('jump');
    } else if (event.key === '4') select('attack');
  });
}

function runAutoStep(player: Animation2DStateMachineComponent, step: number): void {
  if (step === 0) player.setBoolean('moving', false);
  else if (step === 1) player.setBoolean('moving', true);
  else if (step === 2) player.setTrigger('jump');
  else player.setTrigger('attack');
}

function bindFormatPreview(binary: ArrayBuffer): void {
  const preview = query<HTMLElement>('#format-preview');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-preview]')];
  let current: 'extension' | 'document' = 'extension';
  const render = (): void => {
    const source = current === 'extension'
      ? HYA_DOCUMENT.extensions?.[HYA_STATE_MACHINE_EXTENSION_ID]
      : HYA_DOCUMENT;
    preview.textContent = JSON.stringify(source, null, 2);
    for (const tab of tabs) tab.classList.toggle('active', tab.dataset.preview === current);
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      current = tab.dataset.preview as typeof current;
      render();
    });
  }
  query<HTMLButtonElement>('#copy-format').addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(preview.textContent ?? '');
    button.textContent = '已复制';
    window.setTimeout(() => { button.textContent = '复制 JSON'; }, 1000);
  });
  query<HTMLButtonElement>('#download-hya').addEventListener('click', () => {
    const blob = new Blob([binary], { type: ANIMATION_MIME_TYPE });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'hya-state-machine-character.hya';
    anchor.click();
    URL.revokeObjectURL(url);
  });
  render();
}

function updateRuntimeUi(player: Animation2DStateMachineComponent): void {
  const snapshot = player.layerSnapshots[0];
  if (!snapshot) return;
  const state = snapshot.transitionId
    ? snapshot.destinationStateId ?? snapshot.currentStateId
    : snapshot.currentStateId;
  query<HTMLElement>('#current-state').textContent = CLIP_NAMES[state as keyof typeof CLIP_NAMES] ?? state;
  query<HTMLElement>('#state-time').textContent = `${snapshot.currentTime.toFixed(2)}s`;
  const transition = query<HTMLElement>('#transition');
  transition.textContent = snapshot.transitionId
    ? `${CLIP_NAMES[snapshot.sourceStateId as keyof typeof CLIP_NAMES] ?? snapshot.sourceStateId} → ${CLIP_NAMES[snapshot.destinationStateId as keyof typeof CLIP_NAMES] ?? snapshot.destinationStateId} · ${Math.round(snapshot.transitionProgress * 100)}%`
    : '稳定状态';
  document.body.dataset.animationState = state;
  document.body.dataset.transition = snapshot.transitionId ?? '';
  for (const node of document.querySelectorAll<HTMLElement>('[data-state]')) {
    node.classList.toggle('active', node.dataset.state === state);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    button.classList.toggle('active', button.dataset.action === state);
  }
}

function updateAssetStats(bytes: number, nodes: number, tracks: number): void {
  query<HTMLElement>('#binary-size').textContent = formatBytes(bytes);
  query<HTMLElement>('#node-count').textContent = String(nodes);
  query<HTMLElement>('#track-count').textContent = String(tracks);
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new ReferenceError(`Missing example element: ${selector}`);
  return element;
}

const ROOT_POSITION_TIMES = [0, 0.5, 1.2, 1.45, 1.7, 1.95, 2.2, 2.4, 2.72, 3.05, 3.4, 4.2, 5.2];

const HYA_DOCUMENT: AnimationDocument = {
  format: ANIMATION_FORMAT,
  version: ANIMATION_VERSION,
  name: 'Single Asset Action Character',
  canvas: { width: WIDTH, height: HEIGHT, coordinateSystem: 'screen-y-down' },
  duration: 5.2,
  frameRate: 60,
  endBehavior: 'loop',
  nodes: [
    {
      id: 'ground', name: 'Ground', transform: { position: [400, 415], opacity: 0.42 },
      components: [{ type: 'shape2d', shape: 'ellipse', size: [250, 26], fill: [0.08, 0.16, 0.28, 0.78] }],
    },
    { id: 'character', name: 'Character root', transform: { position: [400, 330] } },
    {
      id: 'cape', name: 'Cape', parent: 'character', transform: { position: [0, -38], rotation: 0.05 },
      components: [{ type: 'shape2d', shape: 'rect', size: [68, 94], position: [0, 38], fill: [0.28, 0.12, 0.56, 1] }],
    },
    {
      id: 'left-leg', name: 'Left leg', parent: 'character', transform: { position: [-20, 35] },
      components: [{ type: 'shape2d', shape: 'rect', size: [20, 70], position: [0, 34], fill: [0.16, 0.48, 0.92, 1] }],
    },
    {
      id: 'right-leg', name: 'Right leg', parent: 'character', transform: { position: [20, 35] },
      components: [{ type: 'shape2d', shape: 'rect', size: [20, 70], position: [0, 34], fill: [0.12, 0.38, 0.82, 1] }],
    },
    {
      id: 'torso', name: 'Torso', parent: 'character', transform: { position: [0, -35] },
      components: [{ type: 'shape2d', shape: 'rect', size: [82, 92], fill: [0.12, 0.62, 0.96, 1] }],
    },
    {
      id: 'badge', name: 'Chest badge', parent: 'torso', transform: { position: [0, -4] },
      components: [{ type: 'shape2d', shape: 'ellipse', size: [26, 26], fill: [0.98, 0.77, 0.18, 1] }],
    },
    {
      id: 'head', name: 'Head', parent: 'character', transform: { position: [0, -112] },
      components: [
        { type: 'shape2d', shape: 'ellipse', size: [72, 70], fill: [0.98, 0.72, 0.48, 1] },
        { type: 'shape2d', shape: 'rect', size: [68, 18], position: [0, -22], fill: [0.18, 0.12, 0.3, 1] },
        { type: 'shape2d', shape: 'ellipse', size: [9, 12], position: [-14, -2], fill: [0.05, 0.09, 0.18, 1] },
        { type: 'shape2d', shape: 'ellipse', size: [9, 12], position: [14, -2], fill: [0.05, 0.09, 0.18, 1] },
      ],
    },
    {
      id: 'left-arm', name: 'Left arm', parent: 'character', transform: { position: [-50, -68] },
      components: [{ type: 'shape2d', shape: 'rect', size: [18, 76], position: [0, 35], fill: [0.16, 0.5, 0.94, 1] }],
    },
    {
      id: 'right-arm', name: 'Right arm', parent: 'character', transform: { position: [50, -68] },
      components: [{ type: 'shape2d', shape: 'rect', size: [18, 76], position: [0, 35], fill: [0.12, 0.42, 0.88, 1] }],
    },
    {
      id: 'sword', name: 'Energy blade', parent: 'right-arm', transform: { position: [0, 77], opacity: 0 },
      components: [
        { type: 'shape2d', shape: 'rect', size: [30, 12], fill: [0.98, 0.77, 0.18, 1] },
        { type: 'shape2d', shape: 'rect', size: [10, 92], position: [0, 48], fill: [0.3, 0.95, 1, 0.95] },
      ],
    },
  ],
  tracks: [
    track('character', 'position', ROOT_POSITION_TIMES, [
      400, 330, 400, 324, 400, 330,
      400, 323, 400, 330, 400, 323, 400, 330,
      400, 300, 400, 218, 400, 268, 400, 330,
      400, 330, 400, 330,
    ], 'cubic-bezier'),
    track('torso', 'scale', [0, 0.5, 1.2, 1.45, 1.7, 1.95, 2.2, 2.72, 3.4, 3.72, 4.2, 5.2], [
      1, 1, 1.03, 0.97, 1, 1,
      1.02, 0.98, 1, 1, 1.02, 0.98, 1, 1,
      0.96, 1.06, 1, 1, 1.05, 0.95, 1, 1, 1, 1,
    ], 'cubic-bezier'),
    track('head', 'rotation', [0, 0.5, 1.2, 1.7, 2.2, 2.72, 3.4, 3.72, 4.2, 4.62, 5.2], [
      -0.05, 0.05, -0.05, 0.06, -0.04, 0.02, 0, -0.12, 0, 0.1, 0,
    ], 'cubic-bezier'),
    track('left-arm', 'rotation', [0, 0.6, 1.2, 1.45, 1.7, 1.95, 2.2, 2.4, 2.72, 3.05, 3.4, 3.72, 4.02, 4.2, 5.2], [
      0.12, -0.1, 0.12, 0.72, -0.72, 0.72, 0.12, -1.8, -2.2, -1.8, 0.12, 0.55, -0.3, 0.12, 0.12,
    ], 'cubic-bezier'),
    track('right-arm', 'rotation', [0, 0.6, 1.2, 1.45, 1.7, 1.95, 2.2, 2.4, 2.72, 3.05, 3.4, 3.62, 3.82, 4.02, 4.2, 5.2], [
      -0.12, 0.1, -0.12, -0.72, 0.72, -0.72, -0.12, 1.8, 2.2, 1.8, -0.12, -1.5, 1.35, -0.6, -0.12, -0.12,
    ], 'cubic-bezier'),
    track('left-leg', 'rotation', [0, 1.2, 1.45, 1.7, 1.95, 2.2, 2.4, 2.72, 3.05, 3.4, 4.2, 5.2], [
      0, 0, -0.58, 0.58, -0.58, 0, -0.22, 0.32, -0.18, 0, 0, 0,
    ], 'cubic-bezier'),
    track('right-leg', 'rotation', [0, 1.2, 1.45, 1.7, 1.95, 2.2, 2.4, 2.72, 3.05, 3.4, 4.2, 5.2], [
      0, 0, 0.58, -0.58, 0.58, 0, 0.22, -0.32, 0.18, 0, 0, 0,
    ], 'cubic-bezier'),
    track('cape', 'rotation', [0, 0.6, 1.2, 1.45, 1.7, 1.95, 2.2, 2.4, 2.72, 3.05, 3.4, 3.72, 4.2, 5.2], [
      0.05, -0.05, 0.05, -0.28, 0.18, -0.28, 0.05, 0.3, -0.15, 0.22, 0.05, 0.18, 0.05, 0.05,
    ], 'cubic-bezier'),
    track('sword', 'opacity', [0, 3.4, 3.52, 4.08, 4.2, 5.2], [0, 0, 1, 1, 0, 0], 'linear'),
    track('ground', 'scale', [0, 2.2, 2.72, 3.4, 5.2], [
      1, 1, 1, 1, 0.55, 0.55, 1, 1, 1, 1,
    ], 'cubic-bezier'),
  ],
  extensionsUsed: [HYA_STATE_MACHINE_EXTENSION_ID],
  extensionsRequired: [HYA_STATE_MACHINE_EXTENSION_ID],
  extensions: {
    [HYA_STATE_MACHINE_EXTENSION_ID]: {
      clips: [
        { id: 'idle', name: 'Idle', start: 0, duration: 1.2 },
        { id: 'walk', name: 'Walk', start: 1.2, duration: 1 },
        { id: 'jump', name: 'Jump', start: 2.2, duration: 1.2 },
        { id: 'attack', name: 'Attack', start: 3.4, duration: 0.8 },
      ],
      stateMachine: {
        format: 'haiyue-animation-state-machine@1',
        id: 'hero-controller',
        name: 'Hero Controller',
        parameters: [
          { name: 'moving', type: 'boolean', defaultValue: false },
          { name: 'jump', type: 'trigger' },
          { name: 'attack', type: 'trigger' },
        ],
        layers: [{
          id: 'base', name: 'Base', initialStateId: 'idle',
          states: [
            { id: 'idle', name: 'Idle', motion: { kind: 'clip', clipId: 'idle' }, loop: 'repeat' },
            { id: 'walk', name: 'Walk', motion: { kind: 'clip', clipId: 'walk' }, loop: 'repeat' },
            { id: 'jump', name: 'Jump', motion: { kind: 'clip', clipId: 'jump' }, loop: 'once' },
            { id: 'attack', name: 'Attack', motion: { kind: 'clip', clipId: 'attack' }, loop: 'once' },
          ],
          transitions: [
            { id: 'any-jump', from: '*', to: 'jump', conditions: [{ parameter: 'jump', operator: 'triggered' }], duration: 0.12, interruption: 'source-then-destination' },
            { id: 'any-attack', from: '*', to: 'attack', conditions: [{ parameter: 'attack', operator: 'triggered' }], duration: 0.08, interruption: 'source-then-destination' },
            { id: 'start-walk', from: 'idle', to: 'walk', conditions: [{ parameter: 'moving', operator: 'is-true' }], duration: 0.18 },
            { id: 'stop-walk', from: 'walk', to: 'idle', conditions: [{ parameter: 'moving', operator: 'is-false' }], duration: 0.18 },
            { id: 'land', from: 'jump', to: 'idle', conditions: [], duration: 0.12, hasExitTime: true, exitTime: 0.94 },
            { id: 'finish-attack', from: 'attack', to: 'idle', conditions: [], duration: 0.1, hasExitTime: true, exitTime: 0.96 },
          ],
        }],
      },
    },
  },
};

function track(
  node: string,
  property: AnimationTrack['property'],
  times: readonly number[],
  values: readonly number[],
  interpolation: AnimationTrack['interpolation'],
): AnimationTrack {
  const result: AnimationTrack = { node, property, times, values, interpolation };
  if (interpolation === 'cubic-bezier') {
    return {
      ...result,
      easings: Array.from({ length: Math.max(0, times.length - 1) }, () => [0.42, 0, 0.58, 1]).flat(),
    };
  }
  return result;
}

void main().catch(error => {
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  const result = document.querySelector<HTMLElement>('#result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({ status: 'failed', error: document.body.dataset.renderError });
  }
});
