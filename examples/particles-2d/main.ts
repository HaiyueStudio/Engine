import { Camera2D, Entity, HaiyueEngine, Transform2D } from '@haiyue/engine';
import { Particle2DRenderSystem, Particle2DSystem } from '@haiyue/engine/systems';
import { ParticleEmitter2D } from '@haiyue/engine/components';

interface DemoEmitter {
  readonly id: string;
  readonly entity: Entity;
  readonly emitter: ParticleEmitter2D;
  readonly baseEmissionRate: number;
  readonly baseGravity: readonly [number, number];
  readonly burstAmount: number;
}

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.012, g: 0.018, b: 0.04, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraEntity = new Entity('Particle camera').addComponent(new Camera2D({
    width: 960,
    height: 600,
    designWidth: 960,
    designHeight: 600,
    viewportMode: 'fit',
  }));
  const scene = engine.createScene({
    name: 'Native 2D particles',
    camera: { type: '2d', entity: cameraEntity },
    render3D: false,
    render2D: false,
    gui: false,
    pipelineLabel: 'Particles2D.render',
  });
  const simulation = new Particle2DSystem({ maxDeltaSeconds: 0.1, priority: -10 });
  const renderer = new Particle2DRenderSystem(engine, cameraEntity, { loadOp: 'clear', priority: 0 });
  scene.addSystem(simulation, false);
  scene.addSystem(renderer);

  const emitters: DemoEmitter[] = [
    createEmitter('fire', 'Fire', -70, -170, {
      maxParticles: 900,
      emissionRate: 145,
      burst: 30,
      seed: 11,
      lifetime: [0.65, 1.35],
      speed: [55, 135],
      angle: [1.22, 1.92],
      gravity: [0, -28],
      startSize: [13, 25],
      endSize: [1, 6],
      startColor: [1, 0.94, 0.28, 0.92],
      endColor: [1, 0.08, 0.01, 0],
      shape: 'circle',
      shapeRadius: 22,
      blendMode: 'additive',
      radial: true,
    }, 55),
    createEmitter('fountain', 'Fountain', 120, -185, {
      maxParticles: 900,
      emissionRate: 105,
      burst: 18,
      seed: 23,
      lifetime: [1.4, 2.35],
      speed: [145, 240],
      angle: [1.18, 1.96],
      gravity: [0, -150],
      startSize: [5, 10],
      endSize: [2, 5],
      startColor: [0.25, 0.9, 1, 0.95],
      endColor: [0.08, 0.28, 1, 0],
      shape: 'box',
      shapeSize: [24, 5],
      blendMode: 'additive',
      radial: true,
    }, 45),
    createEmitter('confetti', 'Confetti', 320, -175, {
      maxParticles: 800,
      emissionRate: 42,
      burst: 70,
      seed: 37,
      lifetime: [1.8, 3.4],
      speed: [95, 190],
      angle: [0.86, 2.28],
      gravity: [0, -92],
      startSize: [7, 13],
      endSize: [4, 8],
      startColor: [1, 0.32, 0.78, 1],
      endColor: [0.18, 0.9, 0.7, 0],
      shape: 'box',
      shapeSize: [75, 8],
      blendMode: 'normal',
      radial: false,
    }, 80),
    createEmitter('snow', 'Snow', 360, 240, {
      maxParticles: 1200,
      emissionRate: 72,
      burst: 75,
      seed: 51,
      lifetime: [4.8, 7.2],
      speed: [30, 68],
      angle: [-1.92, -1.23],
      gravity: [0, -8],
      startSize: [5, 11],
      endSize: [3, 8],
      startColor: [0.92, 0.98, 1, 0.92],
      endColor: [0.55, 0.76, 1, 0],
      shape: 'box',
      shapeSize: [220, 12],
      blendMode: 'normal',
      radial: true,
    }, 60),
  ];
  for (const item of emitters) scene.add(item.entity);

  bindControls(emitters);
  engine.switchScene(scene);
  engine.run();

  let frameCount = 0;
  let validationFinished = false;
  engine.on('after-update', () => {
    frameCount++;
    updateStats(renderer, emitters);
    if (!validationFinished && frameCount >= 12) {
      validationFinished = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    const totalParticles = emitters.reduce((sum, item) => sum + item.emitter.activeParticles, 0);
    if (renderer.stats.emitterCount !== emitters.length) {
      validationErrors.push(`Expected ${emitters.length} visible emitters, got ${renderer.stats.emitterCount}.`);
    }
    if (renderer.stats.particleCount === 0 || totalParticles === 0) {
      validationErrors.push('Particle simulation did not produce visible instances.');
    }
    for (const item of emitters) {
      const data = item.emitter.instanceData.subarray(0, item.emitter.activeParticles * 8);
      if (!data.every(Number.isFinite)) validationErrors.push(`${item.id} generated non-finite instance data.`);
    }
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.particleCount = String(renderer.stats.particleCount);
    const result = query<HTMLElement>('#result');
    result.dataset.status = validationErrors.length === 0 ? 'passed' : 'failed';
    result.textContent = JSON.stringify({
      status: result.dataset.status,
      errors: validationErrors,
      renderer: renderer.stats,
      emitters: emitters.map(item => ({ id: item.id, count: item.emitter.activeParticles })),
    });
  }
}

function createEmitter(
  id: string,
  name: string,
  x: number,
  y: number,
  options: ConstructorParameters<typeof ParticleEmitter2D>[0],
  burstAmount: number,
): DemoEmitter {
  const emitter = new ParticleEmitter2D(options);
  const entity = new Entity(name)
    .addComponent(new Transform2D({ x, y }))
    .addComponent(emitter);
  return {
    id,
    entity,
    emitter,
    baseEmissionRate: emitter.emissionRate,
    baseGravity: [...emitter.gravity],
    burstAmount,
  };
}

function bindControls(emitters: readonly DemoEmitter[]): void {
  const pauseButton = query<HTMLButtonElement>('#pause');
  const restartButton = query<HTMLButtonElement>('#restart');
  const burstButton = query<HTMLButtonElement>('#burst');
  const emission = query<HTMLInputElement>('#emission');
  const emissionValue = query<HTMLOutputElement>('#emission-value');
  const gravity = query<HTMLInputElement>('#gravity');
  const gravityValue = query<HTMLOutputElement>('#gravity-value');
  let playing = true;

  const setPlaying = (value: boolean): void => {
    playing = value;
    for (const item of emitters) item.emitter.playing = value;
    pauseButton.textContent = value ? '暂停' : '继续';
    pauseButton.classList.toggle('active', !value);
  };
  pauseButton.addEventListener('click', () => setPlaying(!playing));
  restartButton.addEventListener('click', () => {
    for (const item of emitters) item.emitter.restart(true);
    setPlaying(true);
  });
  burstButton.addEventListener('click', () => {
    for (const item of emitters) if (!item.entity.disabled) item.emitter.emit(item.burstAmount);
  });
  emission.addEventListener('input', () => {
    const scale = Number(emission.value);
    emissionValue.value = `${scale.toFixed(2)}×`;
    for (const item of emitters) item.emitter.emissionRate = item.baseEmissionRate * scale;
  });
  gravity.addEventListener('input', () => {
    const scale = Number(gravity.value);
    gravityValue.value = `${scale.toFixed(2)}×`;
    for (const item of emitters) {
      item.emitter.gravity[0] = item.baseGravity[0] * scale;
      item.emitter.gravity[1] = item.baseGravity[1] * scale;
    }
  });
  for (const item of emitters) {
    query<HTMLInputElement>(`#toggle-${item.id}`).addEventListener('change', event => {
      item.entity.disabled = !(event.currentTarget as HTMLInputElement).checked;
    });
  }
  window.addEventListener('keydown', event => {
    if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
    if (event.key.toLowerCase() === 'r') restartButton.click();
    if (event.key.toLowerCase() === 'b') burstButton.click();
  });
}

function updateStats(renderer: Particle2DRenderSystem, emitters: readonly DemoEmitter[]): void {
  query<HTMLElement>('#particle-count').textContent = renderer.stats.particleCount.toLocaleString();
  query<HTMLElement>('#emitter-count').textContent = String(renderer.stats.emitterCount);
  query<HTMLElement>('#upload-bytes').textContent = formatBytes(renderer.stats.uploadedBytes);
  for (const item of emitters) {
    query<HTMLElement>(`#count-${item.id}`).textContent = item.emitter.activeParticles.toLocaleString();
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required particle example element: ${selector}`);
  return element;
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = message;
  const result = document.querySelector<HTMLElement>('#result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({ status: 'failed', errors: [message] });
  }
  console.error(error);
});
