import { BasicMaterial, Camera3D, CartesianTransform3D, DirectionalLight, Entity, EnvironmentLight, HaiyueEngine, Mesh3D, OrbitControl, PbrMaterial, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D } from '@haiyue/engine';
import { PlanarMirror } from '@haiyue/engine/components';
import { createCone3D } from '@haiyue/engine/geometry';

interface AnimatedObject {
  readonly transform: CartesianTransform3D;
  readonly basePosition: readonly [number, number, number];
  readonly spin: readonly [number, number, number];
  readonly phase: number;
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.018, g: 0.025, b: 0.045, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraTransform = new SphericalTransform3D({
    radius: 11.5,
    theta: Math.PI * 0.07,
    phi: Math.PI * 0.39,
    target: [0, 1.1, -1.2],
  });
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 }))
    .addComponent(cameraTransform);

  const scene = engine.createScene({
    name: 'Planar Mirror',
    camera,
    render3D: { renderProfile: 'simple', loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'PlanarMirror.render',
  });
  new OrbitControl(canvas, cameraTransform, {
    minRadius: 6,
    maxRadius: 22,
    rotateSpeed: 0.65,
  });

  // A regular Mesh3D becomes a mirror by adding one component. The plane is
  // local +Z, so it faces the camera and the objects in this scene.
  const mirrorComponent = new PlanarMirror({
    resolutionScale: 0.65,
    clipBias: 0.008,
    tint: [0.93, 0.97, 1],
    reflectivity: 0.96,
  });
  const mirror = new Entity('Planar mirror')
    .addComponent(new CartesianTransform3D({ position: [0, 1.55, -4] }))
    .addComponent(new Mesh3D(
      createPlane3D({ width: 8.4, height: 5.1, normal: 'z' }),
      // This material becomes visible again while PlanarMirror is disabled.
      new BasicMaterial({ color: [0.08, 0.1, 0.14, 1] }),
    ))
    .addComponent(mirrorComponent);
  scene.add(mirror);

  addMirrorFrame(scene);
  scene.add(new Entity('Floor')
    .addComponent(new CartesianTransform3D({ position: [0, -1.2, 0.6] }))
    .addComponent(new Mesh3D(
      createPlane3D({ width: 16, height: 16, normal: 'y' }),
      new PbrMaterial({ baseColor: [0.095, 0.12, 0.17, 1], metallic: 0.18, roughness: 0.7 }),
    )));

  const animated: AnimatedObject[] = [];
  animated.push(addAnimatedMesh(
    scene,
    'Ruby sphere',
    createSphere3D({ radius: 1.05, widthSegments: 36, heightSegments: 24 }),
    new PbrMaterial({ baseColor: [0.88, 0.08, 0.14, 1], metallic: 0.3, roughness: 0.19 }),
    [-2.35, -0.05, 0.25],
    [0.12, 0.55, 0.08],
    0,
  ));
  animated.push(addAnimatedMesh(
    scene,
    'Golden cube',
    createBox3D({ width: 1.8, height: 1.8, depth: 1.8 }),
    new PbrMaterial({ baseColor: [0.94, 0.54, 0.08, 1], metallic: 0.82, roughness: 0.22 }),
    [0, -0.1, -0.25],
    [0.42, 0.68, 0.18],
    1.8,
  ));
  animated.push(addAnimatedMesh(
    scene,
    'Cyan cone',
    createCone3D({ radius: 1.05, height: 2.5, radialSegments: 36 }),
    new PbrMaterial({ baseColor: [0.04, 0.66, 0.86, 1], metallic: 0.12, roughness: 0.27 }),
    [2.4, 0.08, 0.5],
    [0.08, -0.62, 0.16],
    3.6,
  ));

  scene.add(new Entity('Sun').addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.35],
    color: [1, 0.89, 0.72],
    intensity: 3,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 12, far: 35, bias: 0.0012 },
  })));
  scene.add(new Entity('Environment').addComponent(new EnvironmentLight({
    intensity: 0.75,
    diffuseColor: [0.12, 0.2, 0.38],
    specularColor: [0.65, 0.82, 1],
  })));

  let animationEnabled = true;
  let elapsed = 0;
  bindControls(mirrorComponent, () => {
    animationEnabled = !animationEnabled;
    return animationEnabled;
  });

  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    if (animationEnabled) elapsed += delta * 0.001;
    for (const object of animated) {
      const bob = Math.sin(elapsed * 1.35 + object.phase) * 0.16;
      object.transform.setPosition(
        object.basePosition[0],
        object.basePosition[1] + bob,
        object.basePosition[2],
      );
      object.transform.setRotation(
        elapsed * object.spin[0],
        elapsed * object.spin[1],
        elapsed * object.spin[2],
      );
    }
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
    document.body.dataset.planarMirrorValidation = 'reflection-view,oblique-clip,projective-sample';
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
  }
}

function addAnimatedMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: ReturnType<typeof createBox3D>,
  material: PbrMaterial,
  position: readonly [number, number, number],
  spin: readonly [number, number, number],
  phase: number,
): AnimatedObject {
  const transform = new CartesianTransform3D({ position: [...position] });
  scene.add(new Entity(name)
    .addComponent(transform)
    .addComponent(new Mesh3D(geometry, material)));
  return { transform, basePosition: position, spin, phase };
}

function addMirrorFrame(scene: ReturnType<HaiyueEngine['createScene']>): void {
  const material = new PbrMaterial({
    baseColor: [0.22, 0.25, 0.32, 1],
    metallic: 0.9,
    roughness: 0.18,
  });
  const parts: Array<[string, [number, number, number], [number, number, number]]> = [
    ['Top', [0, 4.25, -4.06], [9, 0.28, 0.3]],
    ['Bottom', [0, -1.15, -4.06], [9, 0.28, 0.3]],
    ['Left', [-4.36, 1.55, -4.06], [0.28, 5.15, 0.3]],
    ['Right', [4.36, 1.55, -4.06], [0.28, 5.15, 0.3]],
  ];
  for (const [name, position, size] of parts) {
    scene.add(new Entity(`Mirror frame ${name}`)
      .addComponent(new CartesianTransform3D({ position }))
      .addComponent(new Mesh3D(
        createBox3D({ width: size[0], height: size[1], depth: size[2] }),
        material,
      )));
  }
}

function bindControls(mirror: PlanarMirror, toggleAnimation: () => boolean): void {
  const mirrorButton = document.querySelector<HTMLButtonElement>('#toggle-mirror')!;
  const animationButton = document.querySelector<HTMLButtonElement>('#toggle-animation')!;
  const reflectivity = document.querySelector<HTMLInputElement>('#reflectivity')!;
  const reflectivityValue = document.querySelector<HTMLOutputElement>('#reflectivity-value')!;
  const resolution = document.querySelector<HTMLInputElement>('#resolution')!;
  const resolutionValue = document.querySelector<HTMLOutputElement>('#resolution-value')!;

  const toggleMirror = () => {
    mirror.disabled = !mirror.disabled;
    mirrorButton.classList.toggle('active', !mirror.disabled);
    mirrorButton.textContent = mirror.disabled ? 'Mirror disabled' : 'Mirror enabled';
  };
  mirrorButton.addEventListener('click', toggleMirror);
  animationButton.addEventListener('click', () => {
    const enabled = toggleAnimation();
    animationButton.classList.toggle('active', enabled);
    animationButton.textContent = enabled ? 'Animation enabled' : 'Animation paused';
  });
  reflectivity.addEventListener('input', () => {
    mirror.material.reflectivity = Number(reflectivity.value);
    reflectivityValue.value = mirror.material.reflectivity.toFixed(2);
  });
  resolution.addEventListener('input', () => {
    mirror.resolutionScale = Number(resolution.value);
    resolutionValue.value = `${Math.round(mirror.resolutionScale * 100)}%`;
  });
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() === 'm') toggleMirror();
    if (event.code === 'Space') {
      event.preventDefault();
      animationButton.click();
    }
  });
  reflectivity.dispatchEvent(new Event('input'));
  resolution.dispatchEvent(new Event('input'));
}

main().catch(error => {
  document.body.dataset.renderStatus = 'error';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
