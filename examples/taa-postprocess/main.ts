import { BasicMaterial, CartesianTransform3D, Entity, Geometry3D, HaiyueEngine, Mesh3D, OrbitControl, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D } from '@haiyue/engine';
import { createTorus3D } from '@haiyue/engine/geometry';
import { PostProcessRenderFeature, TaaPass } from '@haiyue/engine/postprocess';

type Vec3 = [number, number, number];

interface DemoParams {
  enabled: boolean;
  animate: boolean;
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 1,
    clearColor: { r: 0.025, g: 0.035, b: 0.06, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Temporal anti-aliasing',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4.2, near: 0.1, far: 120 },
      orbit: { radius: 16, theta: Math.PI * 0.12, phi: Math.PI * 0.28, target: [0, 1.1, -1.5] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 7,
    maxRadius: 30,
    rotateSpeed: 0.55,
  });

  const taa = new TaaPass({ feedback: 0.9, depthThreshold: 0.002, sharpness: 0.12 });
  const postProcess = new PostProcessRenderFeature(scene.render3DSystem!, [taa]);
  scene.addSystem(postProcess);

  const dark = new BasicMaterial({ color: [0.035, 0.055, 0.1] });
  const pale = new BasicMaterial({ color: [0.48, 0.72, 1] });
  const cyan = new BasicMaterial({ color: [0.08, 0.92, 0.86] });
  const orange = new BasicMaterial({ color: [1, 0.34, 0.11] });
  const white = new BasicMaterial({ color: [0.94, 0.98, 1] });

  addMesh(scene, 'Ground', createPlane3D({ width: 30, height: 30, normal: 'y' }), dark, [0, -0.08, -4]);

  const tileGeometry = createBox3D({ width: 0.82, height: 0.05, depth: 0.82 });
  for (let z = 0; z < 11; z++) {
    for (let x = -6; x <= 6; x++) {
      if ((x + z) % 2 !== 0) continue;
      addMesh(scene, `Grid ${x}:${z}`, tileGeometry, pale, [x * 0.88, 0, -z * 0.88]);
    }
  }

  const poleGeometry = createBox3D({ width: 0.055, height: 4.2, depth: 0.055 });
  for (let i = -9; i <= 9; i++) {
    addMesh(scene, `Thin pole ${i}`, poleGeometry, i % 2 === 0 ? cyan : white, [i * 0.48, 2.05, -7.8]);
  }

  addMesh(scene, 'Reference sphere', createSphere3D({ radius: 1.15, widthSegments: 24, heightSegments: 16 }), orange, [-2.8, 1.1, -2.7]);
  addMesh(scene, 'Reference torus', createTorus3D({ radius: 1.25, tube: 0.18, radialSegments: 16, tubularSegments: 48 }), cyan, [2.8, 1.4, -3.2], [Math.PI / 2, 0, 0]);

  const movingTransforms: CartesianTransform3D[] = [];
  const bladeGeometry = createBox3D({ width: 3.8, height: 0.075, depth: 0.14 });
  for (let i = 0; i < 3; i++) {
    const transform = addMesh(
      scene,
      `Moving blade ${i}`,
      bladeGeometry,
      i === 0 ? orange : white,
      [0, 2.6, 0.7],
      [0, 0, i * Math.PI / 3],
    ).getComponent(CartesianTransform3D)!;
    movingTransforms.push(transform);
  }
  addMesh(scene, 'Blade hub', createSphere3D({ radius: 0.28, widthSegments: 20, heightSegments: 12 }), orange, [0, 2.6, 0.7]);

  const params: DemoParams = { enabled: true, animate: true };
  bindControls(taa, postProcess, params);

  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);

  engine.on('update', ({ detail: { time } }) => {
    if (!params.animate) return;
    const angle = time * 0.00042;
    for (let i = 0; i < movingTransforms.length; i++) {
      movingTransforms[i]!.setRotation(0, Math.sin(angle * 0.31) * 0.18, angle + i * Math.PI / 3);
    }
  });

  let frames = 0;
  engine.on('after-update', () => {
    if (++frames === 12) void finishValidation();
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    const stats = taa.stats;
    if (stats.historyCount < 1 || stats.validHistoryCount < 1) {
      validationErrors.push('TAA did not produce a valid per-view history.');
    }
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.taaHistories = String(stats.historyCount);
  }
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: Geometry3D,
  material: BasicMaterial,
  position: Vec3,
  rotation: Vec3 = [0, 0, 0],
): Entity {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position, rotation }));
  entity.addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
  return entity;
}

function bindControls(
  taa: TaaPass,
  postProcess: PostProcessRenderFeature,
  params: DemoParams,
): void {
  const enabled = document.querySelector<HTMLInputElement>('#taa-enabled')!;
  const animate = document.querySelector<HTMLInputElement>('#scene-animate')!;
  const feedback = document.querySelector<HTMLInputElement>('#taa-feedback')!;
  const feedbackValue = document.querySelector<HTMLOutputElement>('#taa-feedback-value')!;
  const sharpness = document.querySelector<HTMLInputElement>('#taa-sharpness')!;
  const sharpnessValue = document.querySelector<HTMLOutputElement>('#taa-sharpness-value')!;
  const jitter = document.querySelector<HTMLInputElement>('#taa-jitter')!;
  const jitterValue = document.querySelector<HTMLOutputElement>('#taa-jitter-value')!;

  enabled.addEventListener('change', () => {
    params.enabled = enabled.checked;
    taa.resetHistory();
    postProcess.setPasses(params.enabled ? [taa] : []);
    document.body.classList.toggle('taa-off', !params.enabled);
  });
  animate.addEventListener('change', () => { params.animate = animate.checked; });
  feedback.addEventListener('input', () => {
    taa.feedback = Number(feedback.value);
    feedbackValue.value = taa.feedback.toFixed(2);
  });
  sharpness.addEventListener('input', () => {
    taa.sharpness = Number(sharpness.value);
    sharpnessValue.value = taa.sharpness.toFixed(2);
  });
  jitter.addEventListener('input', () => {
    taa.jitterScale = Number(jitter.value);
    jitterValue.value = taa.jitterScale.toFixed(2);
    taa.resetHistory();
  });
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
});
