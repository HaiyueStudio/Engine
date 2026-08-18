import {
  BasicMaterial,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  HaiyueEngine,
  Mesh3D,
  OrbitControl,
  PbrMaterial,
  SphericalTransform3D,
  createBox3D,
  createPlane3D,
  createSphere3D,
} from '@haiyue/engine';

interface MovingReference {
  readonly transform: CartesianTransform3D;
  readonly baseX: number;
  readonly baseY: number;
  readonly phase: number;
}

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: { r: 0.004, g: 0.009, b: 0.018, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'PBR glass refraction',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4.1, near: 0.1, far: 80 },
      orbit: { radius: 7.4, theta: 0, phi: Math.PI * 0.43, target: [0, 0.42, 0] },
    },
    render3D: { loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'RefractionGlass.render',
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 4.8,
    maxRadius: 13,
    rotateSpeed: 0.6,
  });

  const queryParams = new URLSearchParams(location.search);
  const initialThickness = finiteQueryNumber(queryParams.get('thickness'), 1.35, 0, 2.4);
  const glassMaterial = new PbrMaterial({
    baseColor: [0.9, 0.97, 1, 1],
    metallic: 0,
    roughness: 0.06,
    ior: 1.52,
    specularFactor: 1,
    transmissionFactor: 1,
    thicknessFactor: initialThickness,
    attenuationDistance: 6.5,
    attenuationColor: [0.72, 0.93, 1],
  });
  addMesh(scene, 'Refractive glass sphere', new Mesh3D(
    createSphere3D({ radius: 1.55, widthSegments: 72, heightSegments: 48 }),
    glassMaterial,
  ), [0, 0.48, 0]);

  const backdropTexture = createRefractionBackdrop();
  addMesh(scene, 'Opaque high-frequency backdrop', new Mesh3D(
    createPlane3D({ width: 11.5, height: 7.2, normal: 'z' }),
    new BasicMaterial({ texture: backdropTexture, color: [1, 1, 1, 1] }),
  ), [0, 0.65, -3.25]);

  const movingReferences = createMovingReferences(scene);
  addMesh(scene, 'Ground', new Mesh3D(
    createPlane3D({ width: 18, height: 14, normal: 'y' }),
    new PbrMaterial({ baseColor: [0.055, 0.085, 0.12, 1], metallic: 0.55, roughness: 0.24 }),
  ), [0, -1.11, 0]);

  const key = new Entity('Glass key light');
  key.addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.45],
    color: [0.82, 0.94, 1],
    intensity: 3.8,
  }));
  scene.add(key);
  const rim = new Entity('Glass rim light');
  rim.addComponent(new DirectionalLight({
    direction: [0.65, -0.25, 0.5],
    color: [0.38, 0.75, 1],
    intensity: 2.2,
  }));
  scene.add(rim);
  const environment = new Entity('Glass studio environment');
  environment.addComponent(new EnvironmentLight({
    diffuseColor: [0.11, 0.17, 0.25],
    specularColor: [0.76, 0.92, 1],
    intensity: 1.25,
  }));
  scene.add(environment);

  const controls = bindControls(glassMaterial, initialThickness);
  let validationFrames = 0;
  let validationFinished = false;
  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);
  engine.on('update', ({ detail: { time } }) => {
    if (!controls.animate.checked) return;
    const seconds = time * 0.001;
    for (const reference of movingReferences) {
      reference.transform.setPosition(
        reference.baseX + Math.sin(seconds * 0.7 + reference.phase) * 0.42,
        reference.baseY + Math.cos(seconds * 0.9 + reference.phase) * 0.16,
        -2.52,
      );
      reference.transform.setRotation(seconds * 0.25, seconds * 0.38 + reference.phase, seconds * 0.16);
    }
  });
  engine.on('after-update', () => {
    if (!validationFinished && ++validationFrames >= 6) {
      validationFinished = true;
      void finishValidation();
    }
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.refractionMode = 'opaque-scene-color';
    document.body.dataset.transmission = glassMaterial.transmissionFactor.toFixed(2);
    document.body.dataset.ior = glassMaterial.ior.toFixed(2);
    document.body.dataset.thickness = glassMaterial.thicknessFactor.toFixed(2);
    document.body.dataset.opaqueBackdrop = 'true';
    query<HTMLElement>('#result').textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      sceneColorCapture: true,
      material: {
        transmission: glassMaterial.transmissionFactor,
        ior: glassMaterial.ior,
        thickness: glassMaterial.thicknessFactor,
        roughness: glassMaterial.roughness,
        attenuationDistance: glassMaterial.attenuationDistance,
      },
      movingOpaqueReferences: movingReferences.length,
    });
  }
}

function createMovingReferences(scene: ReturnType<HaiyueEngine['createScene']>): MovingReference[] {
  const colors: Array<readonly [number, number, number, number]> = [
    [1, 0.12, 0.33, 1],
    [1, 0.72, 0.08, 1],
    [0.12, 0.92, 0.88, 1],
    [0.42, 0.2, 1, 1],
    [0.22, 1, 0.38, 1],
  ];
  const geometry = createBox3D({ width: 0.55, height: 2.2, depth: 0.4 });
  return colors.map((color, index) => {
    const baseX = (index - 2) * 1.22;
    const baseY = 0.42 + (index % 2) * 0.42;
    const transform = new CartesianTransform3D({ position: [baseX, baseY, -2.52] });
    const entity = new Entity(`Opaque chromatic reference ${index + 1}`);
    entity.addComponent(transform);
    entity.addComponent(new Mesh3D(geometry, new PbrMaterial({
      baseColor: color,
      metallic: 0.12,
      roughness: 0.28,
      emissiveFactor: [color[0] * 0.1, color[1] * 0.1, color[2] * 0.1],
    })));
    scene.add(entity);
    return { transform, baseX, baseY, phase: index * 1.27 };
  });
}

function createRefractionBackdrop(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Refraction backdrop requires Canvas2D.');
  context.fillStyle = '#06101f';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const colors = ['#00d8ff', '#ff205d', '#ffd21c', '#763bff'];
  const cell = 64;
  for (let row = 0; row < canvas.height / cell; row++) {
    for (let column = 0; column < canvas.width / cell; column++) {
      context.fillStyle = colors[(row + column) % colors.length]!;
      context.globalAlpha = (row + column) % 2 === 0 ? 0.82 : 0.28;
      context.fillRect(column * cell + 5, row * cell + 5, cell - 10, cell - 10);
    }
  }
  context.globalAlpha = 0.74;
  context.strokeStyle = '#ffffff';
  context.lineWidth = 3;
  for (let radius = 52; radius <= 230; radius += 44) {
    context.beginPath();
    context.arc(canvas.width / 2, canvas.height / 2, radius, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = 1;
  context.fillStyle = '#ffffff';
  context.font = '700 24px ui-monospace, monospace';
  context.textAlign = 'center';
  context.fillText('OPAQUE SCENE COLOR', canvas.width / 2, 38);
  return canvas;
}

function bindControls(material: PbrMaterial, initialThickness: number): {
  readonly animate: HTMLInputElement;
} {
  const transmission = query<HTMLInputElement>('#transmission');
  const ior = query<HTMLInputElement>('#ior');
  const thickness = query<HTMLInputElement>('#thickness');
  const roughness = query<HTMLInputElement>('#roughness');
  const animate = query<HTMLInputElement>('#animate');
  thickness.value = String(initialThickness);
  bindRange(transmission, '#transmission-value', value => material.transmissionFactor = value);
  bindRange(ior, '#ior-value', value => material.ior = value);
  bindRange(thickness, '#thickness-value', value => material.thicknessFactor = value);
  bindRange(roughness, '#roughness-value', value => material.roughness = value);
  return { animate };
}

function bindRange(
  input: HTMLInputElement,
  outputSelector: string,
  apply: (value: number) => void,
): void {
  const output = query<HTMLOutputElement>(outputSelector);
  const update = (): void => {
    const value = Number(input.value);
    apply(value);
    output.value = value.toFixed(2);
  };
  input.addEventListener('input', update);
  update();
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  mesh: Mesh3D,
  position: [number, number, number],
): Entity {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position }));
  entity.addComponent(mesh);
  scene.add(entity);
  return entity;
}

function finiteQueryNumber(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing refraction example element: ${selector}`);
  return element;
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
