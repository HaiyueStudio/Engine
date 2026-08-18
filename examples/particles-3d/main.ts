import { BasicMaterial, Camera3D, CartesianTransform3D, Entity, HaiyueEngine, Mesh3D, OrbitControl, SphericalTransform3D, createBox3D, createPlane3D } from '@haiyue/engine';
import { Particle3DRenderSystem, Particle3DSystem } from '@haiyue/engine/systems';
import { ParticleEmitter3D } from '@haiyue/engine/components';

interface DemoEmitter {
  readonly id: string;
  readonly entity: Entity;
  readonly emitter: ParticleEmitter3D;
  readonly baseEmissionRate: number;
  readonly baseGravity: readonly [number, number, number];
  readonly burstAmount: number;
}

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.008, g: 0.012, b: 0.026, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraTransform = new SphericalTransform3D({
    target: [0, 2.2, 0],
    radius: 15,
    theta: Math.PI * 0.16,
    phi: Math.PI * 0.36,
  });
  const cameraEntity = new Entity('Particle camera')
    .addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 3, near: 0.1, far: 80 }))
    .addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'Native 3D particles',
    camera: cameraEntity,
    defaults: { clearColor: { r: 0.008, g: 0.012, b: 0.026, a: 1 } },
    render3D: { loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'Particles3D.render',
  });
  new OrbitControl(canvas, cameraTransform, { minRadius: 6, maxRadius: 28, rotateSpeed: 0.65 });

  const simulation = new Particle3DSystem({ maxDeltaSeconds: 0.1, priority: -10 });
  const renderer = new Particle3DRenderSystem(engine, cameraEntity, { loadOp: 'load', priority: 20 });
  scene.addSystem(simulation, false);
  scene.addSystem(renderer);

  addStage(scene.world);
  const emitters: DemoEmitter[] = [
    createEmitter('fire', 'Fire volume', [-3.8, 0.15, 0], {
      maxParticles: 1200,
      emissionRate: 190,
      burst: 45,
      seed: 11,
      lifetime: [0.7, 1.5],
      speed: [1.2, 3.2],
      direction: [0, 1, 0],
      spread: 0.48,
      gravity: [0, -0.4, 0],
      startSize: [0.22, 0.48],
      endSize: [0.04, 0.13],
      startColor: [1, 0.9, 0.18, 0.94],
      endColor: [1, 0.035, 0.005, 0],
      shape: 'sphere',
      shapeRadius: 0.42,
      blendMode: 'additive',
      sortMode: 'none',
    }, 90),
    createEmitter('fountain', 'Fountain', [0, 0.2, 0], {
      maxParticles: 1500,
      emissionRate: 135,
      burst: 30,
      seed: 23,
      lifetime: [1.6, 2.8],
      speed: [5.8, 8.2],
      direction: [0, 1, 0],
      spread: 0.32,
      gravity: [0, -5.6, 0],
      startSize: [0.08, 0.16],
      endSize: [0.03, 0.08],
      startColor: [0.18, 0.88, 1, 0.96],
      endColor: [0.03, 0.18, 1, 0],
      shape: 'box',
      shapeSize: [0.42, 0.08, 0.42],
      blendMode: 'additive',
      sortMode: 'none',
    }, 80),
    createEmitter('sparks', 'Orbital sparks', [3.8, 1.25, 0], {
      maxParticles: 1000,
      emissionRate: 52,
      burst: 100,
      seed: 37,
      lifetime: [1.3, 2.4],
      speed: [1.8, 4.8],
      direction: [0, 1, 0],
      spread: Math.PI,
      gravity: [0, -1.3, 0],
      startSize: [0.08, 0.18],
      endSize: [0.01, 0.05],
      startColor: [1, 0.38, 0.82, 1],
      endColor: [0.15, 0.75, 1, 0],
      shape: 'sphere',
      shapeRadius: 0.65,
      blendMode: 'additive',
      sortMode: 'none',
    }, 130),
    createEmitter('snow', 'Sorted snow volume', [0, 5.5, -0.5], {
      maxParticles: 2200,
      emissionRate: 120,
      burst: 240,
      seed: 51,
      lifetime: [5.2, 8.4],
      speed: [0.35, 0.85],
      direction: [0, -1, 0],
      spread: 0.42,
      gravity: [0.08, -0.08, 0.03],
      startSize: [0.07, 0.18],
      endSize: [0.04, 0.12],
      rotation: [0, Math.PI * 2],
      angularVelocity: [-1.4, 1.4],
      startColor: [0.9, 0.97, 1, 0.78],
      endColor: [0.48, 0.72, 1, 0],
      shape: 'box',
      shapeSize: [11, 0.5, 7],
      blendMode: 'normal',
      sortMode: 'back-to-front',
      depthTest: true,
      depthWrite: false,
    }, 180),
  ];
  for (const item of emitters) scene.add(item.entity);

  bindControls(emitters);
  engine.switchScene(scene);
  engine.run();

  let frameCount = 0;
  let validationFinished = false;
  engine.on('after-update', () => {
    updateStats(renderer, emitters);
    if (!validationFinished && ++frameCount >= 12) {
      validationFinished = true;
      void finishValidation();
    }
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (renderer.stats.emitterCount !== emitters.length) validationErrors.push(`Expected ${emitters.length} emitters, got ${renderer.stats.emitterCount}.`);
    if (renderer.stats.particleCount === 0) validationErrors.push('Particle simulation produced no visible instances.');
    if (renderer.stats.sortedParticleCount === 0) validationErrors.push('View-local transparent sorting did not run.');
    for (const item of emitters) {
      const data = item.emitter.instanceData.subarray(0, item.emitter.activeParticles * 12);
      if (!data.every(Number.isFinite)) validationErrors.push(`${item.id} generated non-finite instance data.`);
    }
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.particleCount = String(renderer.stats.particleCount);
    const result = query<HTMLElement>('#result');
    result.dataset.status = validationErrors.length === 0 ? 'passed' : 'failed';
    result.textContent = JSON.stringify({ status: result.dataset.status, errors: validationErrors, renderer: renderer.stats });
  }
}

function addStage(world: ReturnType<HaiyueEngine['createScene']>['world']): void {
  world.addEntity(new Entity('Ground')
    .addComponent(new CartesianTransform3D({ position: [0, -0.05, 0] }))
    .addComponent(new Mesh3D(
      createPlane3D({ width: 16, height: 11, normal: 'y' }),
      new BasicMaterial({ color: [0.035, 0.055, 0.09, 1] }),
    )));
  const pedestal = createBox3D({ width: 1.7, height: 0.35, depth: 1.7 });
  const colors: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.18, 0.07, 0.035, 1], [0.025, 0.11, 0.16, 1], [0.13, 0.04, 0.13, 1],
  ];
  for (let index = 0; index < 3; index++) {
    world.addEntity(new Entity(`Pedestal ${index}`)
      .addComponent(new CartesianTransform3D({ position: [(index - 1) * 3.8, 0.12, 0] }))
      .addComponent(new Mesh3D(pedestal, new BasicMaterial({ color: colors[index]! }))));
  }
  world.addEntity(new Entity('Depth occluder')
    .addComponent(new CartesianTransform3D({ position: [1.8, 1.15, 1.1] }))
    .addComponent(new Mesh3D(
      createBox3D({ width: 0.75, height: 2.3, depth: 0.75 }),
      new BasicMaterial({ color: [0.09, 0.14, 0.2, 1] }),
    )));
}

function createEmitter(
  id: string,
  name: string,
  position: readonly [number, number, number],
  options: ConstructorParameters<typeof ParticleEmitter3D>[0],
  burstAmount: number,
): DemoEmitter {
  const emitter = new ParticleEmitter3D(options);
  return {
    id,
    entity: new Entity(name).addComponent(new CartesianTransform3D({ position: [...position] })).addComponent(emitter),
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
  restartButton.addEventListener('click', () => { for (const item of emitters) item.emitter.restart(true); setPlaying(true); });
  burstButton.addEventListener('click', () => { for (const item of emitters) if (!item.entity.disabled) item.emitter.emit(item.burstAmount); });
  emission.addEventListener('input', () => {
    const scale = Number(emission.value);
    emissionValue.value = `${scale.toFixed(2)}×`;
    for (const item of emitters) item.emitter.emissionRate = item.baseEmissionRate * scale;
  });
  gravity.addEventListener('input', () => {
    const scale = Number(gravity.value);
    gravityValue.value = `${scale.toFixed(2)}×`;
    for (const item of emitters) for (let axis = 0; axis < 3; axis++) item.emitter.gravity[axis] = item.baseGravity[axis]! * scale;
  });
  for (const item of emitters) query<HTMLInputElement>(`#toggle-${item.id}`).addEventListener('change', event => {
    item.entity.disabled = !(event.currentTarget as HTMLInputElement).checked;
  });
  window.addEventListener('keydown', event => {
    if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
    if (event.key.toLowerCase() === 'r') restartButton.click();
    if (event.key.toLowerCase() === 'b') burstButton.click();
  });
}

function updateStats(renderer: Particle3DRenderSystem, emitters: readonly DemoEmitter[]): void {
  query<HTMLElement>('#particle-count').textContent = renderer.stats.particleCount.toLocaleString();
  query<HTMLElement>('#sorted-count').textContent = renderer.stats.sortedParticleCount.toLocaleString();
  query<HTMLElement>('#upload-bytes').textContent = formatBytes(renderer.stats.uploadedBytes);
  for (const item of emitters) query<HTMLElement>(`#count-${item.id}`).textContent = item.emitter.activeParticles.toLocaleString();
}

function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`; }
function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required 3D particle example element: ${selector}`);
  return element;
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = message;
  const result = document.querySelector<HTMLElement>('#result');
  if (result) result.textContent = JSON.stringify({ status: 'failed', errors: [message] });
  console.error(error);
});
