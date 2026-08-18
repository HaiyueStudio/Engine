import { BasicMaterial, Camera3D, CartesianTransform3D, DirectionalLight, Entity, EnvironmentLight, Geometry3D, HaiyueEngine, Mesh3D, OrbitControl, PbrMaterial, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D } from '@haiyue/engine';
import { PlanarMirror } from '@haiyue/engine/components';
import { createCone3D } from '@haiyue/engine/geometry';

interface MovingMesh {
  readonly transform: CartesianTransform3D;
  readonly origin: readonly [number, number, number];
  readonly phase: number;
  readonly speed: number;
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.012, g: 0.018, b: 0.035, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraTransform = new SphericalTransform3D({
    radius: 7.7,
    theta: Math.PI * 0.035,
    phi: Math.PI * 0.43,
    target: [0, 0.9, -2.7],
  });
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.08, far: 140 }))
    .addComponent(cameraTransform);

  const scene = engine.createScene({
    name: 'Recursive Mirror Hall',
    camera,
    render3D: { renderProfile: 'simple', loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'MirrorHall.render',
  });
  new OrbitControl(canvas, cameraTransform, { minRadius: 4, maxRadius: 13, rotateSpeed: 0.45 });

  const rearMirror = createMirror('Rear mirror', [0, 1.45, -5], [0, 0, 1]);
  const frontMirror = createMirror('Front mirror', [0, 1.45, 5], [0, 0, -1]);
  scene.add(rearMirror.entity).add(frontMirror.entity);
  addRoom(scene);
  addFrames(scene);

  const moving: MovingMesh[] = [
    addMovingMesh(
      scene,
      'Red sphere',
      createSphere3D({ radius: 0.9, widthSegments: 32, heightSegments: 22 }),
      new PbrMaterial({ baseColor: [0.9, 0.06, 0.12, 1], metallic: 0.34, roughness: 0.18 }),
      [-2.15, -0.25, -0.3],
      0,
      0.6,
    ),
    addMovingMesh(
      scene,
      'Gold cube',
      createBox3D({ width: 1.65, height: 1.65, depth: 1.65 }),
      new PbrMaterial({ baseColor: [0.94, 0.55, 0.07, 1], metallic: 0.86, roughness: 0.2 }),
      [0, -0.3, 0.65],
      2.1,
      -0.75,
    ),
    addMovingMesh(
      scene,
      'Blue cone',
      createCone3D({ radius: 0.95, height: 2.25, radialSegments: 32 }),
      new PbrMaterial({ baseColor: [0.04, 0.5, 0.96, 1], metallic: 0.16, roughness: 0.24 }),
      [2.2, -0.08, -1.15],
      4.2,
      0.5,
    ),
  ];

  scene.add(new Entity('Directional light').addComponent(new DirectionalLight({
    direction: [-0.5, -1, -0.25],
    color: [1, 0.88, 0.72],
    intensity: 3.1,
    castShadow: false,
  })));
  scene.add(new Entity('Environment light').addComponent(new EnvironmentLight({
    intensity: 0.8,
    diffuseColor: [0.1, 0.18, 0.36],
    specularColor: [0.65, 0.83, 1],
  })));

  let animate = true;
  let elapsed = 0;
  bindControls(rearMirror.component, frontMirror.component, () => {
    animate = !animate;
    return animate;
  });

  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    if (animate) elapsed += delta * 0.001;
    for (const item of moving) {
      const bob = Math.sin(elapsed * 1.25 + item.phase) * 0.18;
      item.transform.setPosition(item.origin[0], item.origin[1] + bob, item.origin[2]);
      item.transform.setRotation(
        elapsed * item.speed * 0.45,
        elapsed * item.speed,
        elapsed * item.speed * 0.2,
      );
    }
  });
  engine.on('after-update', () => {
    const render3D = scene.render3DSystem!;
    const stats = render3D.lastMirrorPlanStats;
    document.querySelector<HTMLOutputElement>('#view-count')!.value = `${render3D.lastViewCount}`;
    document.querySelector<HTMLOutputElement>('#mirror-plan')!.value = `${stats.plannedViewCount} / ${stats.executedViewCount} / ${stats.droppedViewCount}`;
    document.querySelector<HTMLOutputElement>('#rtt-pixels')!.value = `${(stats.rttPixels / 1_000_000).toFixed(2)} MP`;
  });

  let validationFrames = 0;
  engine.on('after-update', () => {
    if (++validationFrames === 4) void finishValidation();
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const error = await engine.device.popErrorScope();
    if (error) validationErrors.push(error.message);
    document.body.dataset.mirrorHallValidation = 'two-mirrors,recursive-reflection,deepest-first';
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
  }
}

function createMirror(
  name: string,
  position: [number, number, number],
  localNormal: [number, number, number],
): { entity: Entity; component: PlanarMirror } {
  const component = new PlanarMirror({
    localNormal,
    maxBounces: 5,
    resolutionScale: 0.72,
    bounceResolutionScale: 0.85,
    reflectivity: 0.95,
    tint: [0.9, 0.95, 1],
    clipBias: 0.008,
  });
  const entity = new Entity(name)
    .addComponent(new CartesianTransform3D({ position }))
    .addComponent(new Mesh3D(
      createPlane3D({ width: 9.6, height: 5.7, normal: 'z' }),
      new BasicMaterial({ color: [0.055, 0.07, 0.1, 1] }),
    ))
    .addComponent(component);
  return { entity, component };
}

function addRoom(scene: ReturnType<HaiyueEngine['createScene']>): void {
  const floor = new PbrMaterial({ baseColor: [0.075, 0.095, 0.145, 1], metallic: 0.2, roughness: 0.63 });
  const wall = new PbrMaterial({ baseColor: [0.105, 0.13, 0.2, 1], metallic: 0.08, roughness: 0.74 });
  const parts: Array<[string, [number, number, number], [number, number, number], PbrMaterial]> = [
    ['Floor', [0, -1.45, 0], [10.4, 0.2, 10.4], floor],
    ['Ceiling', [0, 4.35, 0], [10.4, 0.16, 10.4], wall],
    ['Left wall', [-5.05, 1.45, 0], [0.18, 5.8, 10.4], wall],
    ['Right wall', [5.05, 1.45, 0], [0.18, 5.8, 10.4], wall],
  ];
  for (const [name, position, size, material] of parts) {
    scene.add(new Entity(name)
      .addComponent(new CartesianTransform3D({ position }))
      .addComponent(new Mesh3D(
        createBox3D({ width: size[0], height: size[1], depth: size[2] }),
        material,
      )));
  }
}

function addFrames(scene: ReturnType<HaiyueEngine['createScene']>): void {
  const material = new PbrMaterial({ baseColor: [0.28, 0.31, 0.38, 1], metallic: 0.92, roughness: 0.16 });
  for (const z of [-5.04, 5.04]) {
    const parts: Array<[[number, number, number], [number, number, number]]> = [
      [[0, 4.38, z], [10.1, 0.22, 0.26]],
      [[0, -1.48, z], [10.1, 0.22, 0.26]],
      [[-4.93, 1.45, z], [0.22, 5.75, 0.26]],
      [[4.93, 1.45, z], [0.22, 5.75, 0.26]],
    ];
    for (let index = 0; index < parts.length; index++) {
      const [position, size] = parts[index]!;
      scene.add(new Entity(`Mirror frame ${z}:${index}`)
        .addComponent(new CartesianTransform3D({ position }))
        .addComponent(new Mesh3D(
          createBox3D({ width: size[0], height: size[1], depth: size[2] }),
          material,
        )));
    }
  }
}

function addMovingMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: Geometry3D,
  material: PbrMaterial,
  origin: readonly [number, number, number],
  phase: number,
  speed: number,
): MovingMesh {
  const transform = new CartesianTransform3D({ position: [origin[0], origin[1], origin[2]] });
  scene.add(new Entity(name)
    .addComponent(transform)
    .addComponent(new Mesh3D(geometry, material)));
  return { transform, origin, phase, speed };
}

function bindControls(
  rear: PlanarMirror,
  front: PlanarMirror,
  toggleAnimation: () => boolean,
): void {
  const mirrors = [rear, front];
  const bounceInput = document.querySelector<HTMLInputElement>('#bounces')!;
  const bounceValue = document.querySelector<HTMLOutputElement>('#bounces-value')!;
  const resolutionInput = document.querySelector<HTMLInputElement>('#resolution')!;
  const resolutionValue = document.querySelector<HTMLOutputElement>('#resolution-value')!;
  const animationButton = document.querySelector<HTMLButtonElement>('#toggle-animation')!;

  bounceInput.addEventListener('input', () => {
    const value = Number(bounceInput.value);
    for (const mirror of mirrors) mirror.maxBounces = value;
    bounceValue.value = `${value}`;
  });
  resolutionInput.addEventListener('input', () => {
    const value = Number(resolutionInput.value);
    for (const mirror of mirrors) mirror.resolutionScale = value;
    resolutionValue.value = `${Math.round(value * 100)}%`;
  });
  animationButton.addEventListener('click', () => {
    const enabled = toggleAnimation();
    animationButton.classList.toggle('active', enabled);
    animationButton.textContent = enabled ? 'Animation enabled' : 'Animation paused';
  });
  document.addEventListener('keydown', event => {
    if (/^[1-6]$/.test(event.key)) {
      bounceInput.value = event.key;
      bounceInput.dispatchEvent(new Event('input'));
    }
    if (event.code === 'Space') {
      event.preventDefault();
      animationButton.click();
    }
  });
  bounceInput.dispatchEvent(new Event('input'));
  resolutionInput.dispatchEvent(new Event('input'));
}

main().catch(error => {
  document.body.dataset.renderStatus = 'error';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
