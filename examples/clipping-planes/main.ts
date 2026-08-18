import {
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  HaiyueEngine,
  Mesh3D,
  OrbitControl,
  PbrMaterial,
  SphericalTransform3D,
  createPlane3D,
  createSphere3D,
} from '@haiyue/engine';
import { ClippingPlanes, MAX_CLIPPING_PLANES } from '@haiyue/engine/components';

const CLIPPED_CENTER_X = -1.65;

type RegressionCase = 'animated' | 'off' | 'three-planes' | 'moved-plane';

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'gpu-driven',
    msaaSamples: 4,
    clearColor: { r: 0.008, g: 0.014, b: 0.03, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Multiple clipping planes',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 },
      orbit: { radius: 9.3, theta: Math.PI * 0.09, phi: Math.PI * 0.36, target: [0, 0.1, 0] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
    pipelineLabel: 'ClippingPlanes.render',
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 5.2,
    maxRadius: 16,
    rotateSpeed: 0.62,
  });

  const sharedGeometry = createSphere3D({ radius: 1.38, widthSegments: 72, heightSegments: 48 });
  const sharedMaterial = new PbrMaterial({
    baseColor: [0.14, 0.64, 1, 1],
    metallic: 0.38,
    roughness: 0.22,
    doubleSided: true,
  });
  const clipping = new ClippingPlanes({
    planes: createPlaneSet(-0.42, -0.38, -0.42),
  });
  const regressionCase = resolveRegressionCase();

  const clipped = addSphere(scene, 'Three-plane clipped sphere', CLIPPED_CENTER_X, sharedGeometry, sharedMaterial);
  clipped.addComponent(clipping);
  addSphere(scene, 'Unclipped shared-resource reference', 1.65, sharedGeometry, sharedMaterial);

  const ground = new Entity('Clipping shadow receiver');
  ground.addComponent(new CartesianTransform3D({ position: [0, -1.58, 0] }));
  ground.addComponent(new Mesh3D(
    createPlane3D({ width: 12, height: 9, normal: 'y' }),
    new PbrMaterial({ baseColor: [0.045, 0.07, 0.13, 1], metallic: 0.16, roughness: 0.52 }),
  ));
  scene.add(ground);

  const key = new Entity('Clipping key light');
  key.addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.38],
    color: [0.83, 0.93, 1],
    intensity: 3.5,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 12, far: 30, bias: 0.0012 },
  }));
  scene.add(key);

  const fill = new Entity('Clipping fill light');
  fill.addComponent(new DirectionalLight({
    direction: [0.7, -0.35, 0.45],
    color: [1, 0.33, 0.18],
    intensity: 1.45,
  }));
  scene.add(fill);

  const environment = new Entity('Clipping environment');
  environment.addComponent(new EnvironmentLight({
    diffuseColor: [0.12, 0.2, 0.38],
    specularColor: [0.72, 0.88, 1],
    intensity: 0.9,
  }));
  scene.add(environment);

  const controls = bindControls(clipping);
  applyRegressionCase(regressionCase, clipping, controls);
  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);

  engine.on('update', ({ detail: { time } }) => {
    if (regressionCase !== 'animated' || !controls.animate.checked) return;
    const z = -0.42 + Math.sin(time * 0.0011) * 0.48;
    controls.z.value = z.toFixed(3);
    controls.apply();
  });

  let validationFrames = 0;
  let validationFinished = false;
  engine.on('after-update', () => {
    if (validationFinished || ++validationFrames < 8) return;
    validationFinished = true;
    void finishValidation();
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (clipping.count !== 3) validationErrors.push(`Expected 3 clipping planes, received ${clipping.count}.`);
    if (clipped.getComponent(ClippingPlanes) !== clipping) validationErrors.push('Clipping component was not retained by the entity.');

    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.clippingPlaneCount = String(clipping.count);
    document.body.dataset.clippingPlaneLimit = String(MAX_CLIPPING_PLANES);
    document.body.dataset.entityScoped = 'true';
    document.body.dataset.sharedResources = 'true';
    const result = query<HTMLElement>('#result');
    result.dataset.status = document.body.dataset.renderStatus;
    result.textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      regressionCase,
      clippingPlaneCount: clipping.count,
      clippingPlaneLimit: MAX_CLIPPING_PLANES,
      space: 'world',
      retainedHalfSpace: 'dot(normal, worldPosition) + constant >= 0',
      entityScoped: true,
      sharedGeometryAndMaterial: true,
      capsGenerated: false,
    });
  }
}

function resolveRegressionCase(): RegressionCase {
  const parameters = new URLSearchParams(globalThis.location.search);
  if (parameters.get('regression') !== '1') return 'animated';
  const requested = parameters.get('clip');
  if (requested === 'off' || requested === 'moved-plane') return requested;
  return 'three-planes';
}

function applyRegressionCase(
  regressionCase: RegressionCase,
  clipping: ClippingPlanes,
  controls: ReturnType<typeof bindControls>,
): void {
  if (regressionCase === 'animated') return;
  document.body.dataset.regression = 'true';
  for (const selector of ['.panel', '.badge', '.hint']) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) element.hidden = true;
  }
  controls.animate.checked = false;
  if (regressionCase === 'off') {
    clipping.disabled = true;
    return;
  }
  if (regressionCase === 'moved-plane') {
    controls.z.value = '0.55';
    controls.apply();
  }
}

function addSphere(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  x: number,
  geometry: ReturnType<typeof createSphere3D>,
  material: PbrMaterial,
): Entity {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position: [x, 0, 0] }));
  entity.addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
  return entity;
}

function createPlaneSet(x: number, y: number, z: number) {
  return [
    { normal: [1, 0, 0] as const, constant: -(CLIPPED_CENTER_X + x) },
    { normal: [0, 1, 0] as const, constant: -y },
    { normal: [0, 0, 1] as const, constant: -z },
  ];
}

function bindControls(clipping: ClippingPlanes): {
  readonly animate: HTMLInputElement;
  readonly z: HTMLInputElement;
  readonly apply: () => void;
} {
  const x = query<HTMLInputElement>('#plane-x');
  const y = query<HTMLInputElement>('#plane-y');
  const z = query<HTMLInputElement>('#plane-z');
  const animate = query<HTMLInputElement>('#animate');
  const apply = (): void => {
    const values = [Number(x.value), Number(y.value), Number(z.value)] as const;
    clipping.setPlanes(createPlaneSet(...values));
    query<HTMLOutputElement>('#plane-x-value').value = values[0].toFixed(2);
    query<HTMLOutputElement>('#plane-y-value').value = values[1].toFixed(2);
    query<HTMLOutputElement>('#plane-z-value').value = values[2].toFixed(2);
  };
  for (const input of [x, y, z]) input.addEventListener('input', () => {
    animate.checked = false;
    apply();
  });
  apply();
  return { animate, z, apply };
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing clipping-planes example element: ${selector}`);
  return element;
}

main().catch(error => {
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  const result = document.querySelector<HTMLElement>('#result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({
      status: 'failed',
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
});
