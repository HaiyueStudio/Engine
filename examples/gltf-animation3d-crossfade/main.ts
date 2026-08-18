import {
  Camera3D,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  HaiyueEngine,
  OrbitControl,
  SphericalTransform3D,
} from '@haiyue/engine';
import { AmbientLight } from '@haiyue/engine/lighting';
import {
  disposeGltfModel,
  loadGltfModel,
  type LoadedGltfModel,
} from '@haiyue/extensions/gltf';
import {
  createGltfAnimation3DRuntime,
  type GltfAnimation3DRuntime,
} from '@haiyue/extensions/gltf-animation3d';

type PlaybackPhase = 'idle' | 'blend' | 'run';

const CROSS_FADE_SECONDS = 1;
const IDLE_HOLD_SECONDS = 0.7;

async function main(): Promise<void> {
  const regression = new URLSearchParams(location.search).get('regression') === '1';
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const status = document.getElementById('status') as HTMLElement;
  const progress = document.getElementById('blend-progress') as HTMLProgressElement;
  const pauseButton = document.getElementById('pause') as HTMLButtonElement;
  const restartButton = document.getElementById('restart') as HTMLButtonElement;
  const phaseNodes = {
    idle: document.getElementById('phase-idle') as HTMLElement,
    blend: document.getElementById('phase-blend') as HTMLElement,
    run: document.getElementById('phase-run') as HTMLElement,
  };

  resizeCanvas(canvas);
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.025, g: 0.055, b: 0.1, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const cameraTransform = new SphericalTransform3D({
    radius: 7,
    theta: Math.PI * 0.28,
    phi: Math.PI * 0.32,
    target: [0, 1, 0],
  });
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({
    type: 'perspective',
    fov: Math.PI / 4,
    near: 0.05,
    far: 100,
  }));
  camera.addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'glTF Animation3D Cross-fade',
    camera,
    render3D: true,
    render2D: false,
    gui: false,
  });
  const orbit = new OrbitControl(canvas, cameraTransform, {
    minRadius: 2,
    maxRadius: 20,
  });

  const ambient = new Entity('Ambient');
  ambient.addComponent(new AmbientLight({ color: [0.72, 0.82, 1], intensity: 0.7 }));
  scene.add(ambient);
  const sun = new Entity('Sun');
  sun.addComponent(new DirectionalLight({
    color: [1, 0.94, 0.84],
    intensity: 2.4,
    direction: [-0.45, -1, -0.35],
  }));
  scene.add(sun);

  const actor = new Entity('Character');
  actor.addComponent(new CartesianTransform3D({
    position: [0, 0, 0],
    scale: [1.4, 1.4, 1.4],
  }));
  scene.add(actor);
  engine.switchScene(scene);
  engine.run();

  let model: LoadedGltfModel | null = null;
  let runtime: GltfAnimation3DRuntime | null = null;
  let phase: PlaybackPhase = 'idle';
  let phaseStartedAt = 0;
  let paused = false;

  const setPhase = (next: PlaybackPhase): void => {
    phase = next;
    for (const [name, node] of Object.entries(phaseNodes)) {
      node.classList.toggle('active', name === next);
    }
  };

  const fixtureUrl = new URL(
    '../../extensions/test/fixtures/gltf/animation-characterization.gltf',
    window.location.href,
  ).href;
  model = await loadGltfModel(fixtureUrl);
  actor.addChild(model.root);
  runtime = createGltfAnimation3DRuntime(model, {
    clipIdPrefix: 'gltf-crossfade-example',
  });
  if (runtime.clips.length < 2) {
    throw new Error(`Expected Idle and Run clips; received ${runtime.clips.length}.`);
  }

  const idle = runtime.mixer.createAction(runtime.clips[1]!, {
    id: 'Idle',
    loop: 'repeat',
  });
  const run = runtime.mixer.createAction(runtime.clips[0]!, {
    id: 'Run',
    loop: 'once',
    clampWhenFinished: true,
  });
  const interpolation = [...new Set(
    runtime.clips.flatMap(clip => clip.tracks.map(track => track.interpolation)),
  )].sort();

  const restart = (): void => {
    if (!runtime) return;
    runtime.mixer.stopAllActions();
    runtime.setTime(0);
    idle.reset().play();
    run.reset().stop();
    runtime.evaluate();
    phaseStartedAt = runtime.mixer.time;
    progress.value = 0;
    setPhase('idle');
  };
  restart();

  if (regression) {
    run.reset().crossFadeFrom(idle, CROSS_FADE_SECONDS);
    runtime.update(CROSS_FADE_SECONDS * 0.5);
    progress.value = 0.5;
    paused = true;
    setPhase('blend');
    status.textContent = 'Regression pose: Idle → Run 50% · root TRS + skinning + GPU morph';
  }

  restartButton.addEventListener('click', restart);
  pauseButton.addEventListener('click', () => {
    paused = !paused;
    pauseButton.textContent = paused ? '继续' : '暂停';
  });

  engine.on('update', ({ detail: { delta } }) => {
    if (!runtime || paused || regression) return;
    runtime.update(Math.min(delta / 1000, 0.1));
    const phaseTime = runtime.mixer.time - phaseStartedAt;
    if (phase === 'idle' && phaseTime >= IDLE_HOLD_SECONDS) {
      run.reset().crossFadeFrom(idle, CROSS_FADE_SECONDS);
      phaseStartedAt = runtime.mixer.time;
      setPhase('blend');
    } else if (phase === 'blend') {
      progress.value = Math.min(1, phaseTime / CROSS_FADE_SECONDS);
      if (phaseTime >= CROSS_FADE_SECONDS) {
        progress.value = 1;
        phaseStartedAt = runtime.mixer.time;
        setPhase('run');
      }
    }
    status.textContent = [
      `fixture: animation-characterization.gltf`,
      `phase: ${phase}  mixer: ${runtime.mixer.constructor.name}`,
      `pose: ${runtime.pose.constructor.name}  sequence: ${runtime.pose.sequence}`,
      `Idle weight: ${idle.effectiveWeight.toFixed(3)}  Run weight: ${run.effectiveWeight.toFixed(3)}`,
      `interpolation: ${interpolation.join(', ')}`,
      `bindings: ${runtime.bindingCount}  GPU morph + skinning: active`,
    ].join('\n');
  });
  if (regression) {
    let frames = 0;
    engine.on('after-update', () => {
      if (++frames < 4) return;
      engine.stop();
      const result = document.getElementById('result')!;
      result.dataset.status = 'passed';
      result.textContent = JSON.stringify({
        schemaVersion: 1,
        suite: 'gltf-animation3d-crossfade-screenshot',
        status: 'passed',
        phase: 'blend',
        progress: 0.5,
        bindings: runtime?.bindingCount ?? 0,
      });
    });
  }

  window.addEventListener('resize', () => {
    resizeCanvas(canvas);
    engine.resizeToDisplaySize();
  });
  window.addEventListener('beforeunload', () => {
    orbit.destroy();
    runtime?.destroy();
    if (model && !model.root.destroyed) disposeGltfModel(model);
  }, { once: true });
}

function resizeCanvas(canvas: HTMLCanvasElement): void {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(window.innerWidth * ratio));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * ratio));
}

void main().catch(error => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = error instanceof Error ? error.message : String(error);
  const result = document.getElementById('result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
});
