import {
  BasicMaterial,
  CartesianTransform3D,
  Entity,
  Geometry3D,
  HaiyueEngine,
  Mesh3D,
  OrbitControl,
  SphericalTransform3D,
  createBox3D,
  createPlane3D,
  createSphere3D,
} from '@haiyue/engine';
import { createTorus3D } from '@haiyue/engine/geometry';
import {
  GtaoPass,
  PostProcessRenderFeature,
  SaoPass,
  SsaoPass,
} from '@haiyue/engine/postprocess';

type Vec3 = [number, number, number];
type AmbientOcclusionAlgorithm = 'gtao' | 'sao' | 'ssao';
type AmbientOcclusionQuality = 'low' | 'medium' | 'high';
type AmbientOcclusionCameraView = 'default' | 'nearby' | 'alternate';
type AmbientOcclusionPass = GtaoPass | SaoPass | SsaoPass;

async function main(): Promise<void> {
  const queryParams = new URLSearchParams(location.search);
  const regression = queryParams.get('regression') === '1';
  const requestedAlgorithm = parseAlgorithm(queryParams.get('algorithm'));
  const enabled = queryParams.get('ao') !== 'off';
  const occlusionOnly = queryParams.get('display') === 'occlusion';
  const cameraView = parseCameraView(queryParams.get('view'));
  const isolatedFixture = queryParams.get('fixture') === 'isolated';
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 1,
    clearColor: { r: 0.055, g: 0.072, b: 0.105, a: 1 },
  });
  await engine.init();
  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Ambient Occlusion laboratory',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4.2, near: 0.1, far: 80 },
      orbit: {
        radius: isolatedFixture ? 7.5 : 14.5,
        theta: Math.PI * (isolatedFixture ? 0.12 : cameraView === 'alternate' ? 0.24 : cameraView === 'nearby' ? 0.15 : 0.13),
        phi: Math.PI * (isolatedFixture ? 0.42 : cameraView === 'alternate' ? 0.28 : 0.32),
        target: [0, 1.25, -1.4],
      },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 7,
    maxRadius: 28,
    rotateSpeed: 0.55,
  });

  const aoRadius = isolatedFixture ? 0.85 : 1.5;
  const passes = {
    gtao: new GtaoPass({ radius: aoRadius, intensity: 1.45, bias: 0.018, power: 1.35, distanceFalloff: 3.2, quality: 'high' }),
    sao: new SaoPass({ radius: aoRadius, intensity: 1.3, bias: 0.02, power: 1.25, distanceFalloff: 3.2, quality: 'high' }),
    ssao: new SsaoPass({ radius: aoRadius, intensity: 1.6, bias: 0.018, power: 1.35, distanceFalloff: 3.2, quality: 'high' }),
  } satisfies Record<AmbientOcclusionAlgorithm, AmbientOcclusionPass>;
  query<HTMLInputElement>('#radius').value = String(aoRadius);
  let algorithm = requestedAlgorithm;
  let aoEnabled = enabled;
  query<HTMLSelectElement>('#display').value = occlusionOnly ? 'occlusion' : 'composite';
  for (const pass of Object.values(passes)) pass.displayMode = occlusionOnly ? 'occlusion' : 'composite';
  const postProcess = new PostProcessRenderFeature(scene.render3DSystem!, aoEnabled ? [passes[algorithm]] : []);
  scene.addSystem(postProcess);

  const floor = new BasicMaterial({ color: [0.56, 0.63, 0.73, 1] });
  const wall = new BasicMaterial({ color: [0.27, 0.34, 0.46, 1] });
  const cyan = new BasicMaterial({ color: [0.08, 0.78, 0.82, 1] });
  const orange = new BasicMaterial({ color: [1, 0.34, 0.08, 1] });
  const violet = new BasicMaterial({ color: [0.55, 0.24, 0.92, 1] });
  if (isolatedFixture) {
    addMesh(
      scene,
      'Isolated convex sphere',
      createSphere3D({ radius: 2, widthSegments: 48, heightSegments: 32 }),
      violet,
      [0, 1.25, -1.4],
    );
  } else {
    addMesh(scene, 'Ground', createPlane3D({ width: 24, height: 20, normal: 'y' }), floor, [0, 0, -2]);
    addMesh(scene, 'Back wall', createPlane3D({ width: 24, height: 8, normal: 'z' }), wall, [0, 4, -8]);
    addMesh(scene, 'Left wall', createPlane3D({ width: 16, height: 8, normal: 'x' }), wall, [-7.8, 4, -1.5]);

    const box = createBox3D({ width: 1.65, height: 1.65, depth: 1.65 });
    for (let z = 0; z < 3; z++) for (let x = 0; x < 4; x++) {
      const height = (x + z) % 3;
      addMesh(scene, `Contact box ${x}:${z}`, box, (x + z) % 2 ? cyan : orange, [x * 1.8 - 3, 0.83 + height * 0.82, -z * 2 - 0.2]);
    }
    addMesh(scene, 'Corner sphere', createSphere3D({ radius: 1.35, widthSegments: 32, heightSegments: 20 }), violet, [4.35, 1.35, -5.8]);
    addMesh(scene, 'Contact sphere', createSphere3D({ radius: 1.05, widthSegments: 28, heightSegments: 18 }), cyan, [3.0, 1.05, -1.25]);
    addMesh(scene, 'Torus contact', createTorus3D({ radius: 1.35, tube: 0.32, radialSegments: 20, tubularSegments: 64 }), orange, [3.15, 1.48, -3.55], [Math.PI / 2, 0, 0]);
    const beam = createBox3D({ width: 6.8, height: 0.34, depth: 0.65 });
    addMesh(scene, 'Overhang', beam, violet, [-1.8, 3.15, -5.7], [0, 0, -0.08]);
    const gapPlate = createBox3D({ width: 2.2, height: 0.18, depth: 1.1 });
    addMesh(scene, 'Narrow gap lower plate', gapPlate, cyan, [4.85, 0.09, 0.3]);
    addMesh(scene, 'Narrow gap upper plate', gapPlate, orange, [4.85, 0.47, 0.3]);
  }

  bindControls(passes, postProcess, () => algorithm, value => { algorithm = value; }, () => aoEnabled, value => { aoEnabled = value; });
  const warmupStartedAt = performance.now();
  const warmup = await scene.warmupPipelines();
  const pipelineWarmupMs = performance.now() - warmupStartedAt;
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);
  let frames = 0;
  let finished = false;
  engine.on('after-update', () => {
    updateMetrics(passes[algorithm]);
    if (!finished && ++frames >= (regression ? 14 : 10)) {
      finished = true;
      if (regression) engine.stop();
      void finishValidation();
    }
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (aoEnabled && passes[algorithm].stats.frameCount < 2) validationErrors.push(`${algorithm.toUpperCase()} did not render two frames.`);
    const result = query<HTMLElement>('#result');
    result.dataset.status = validationErrors.length ? 'failed' : 'passed';
    result.textContent = JSON.stringify({
      schemaVersion: 1,
      suite: 'ambient-occlusion-example',
      status: result.dataset.status,
      algorithm: aoEnabled ? algorithm : 'off',
      view: cameraView,
      fixture: isolatedFixture ? 'isolated' : 'contact-scene',
      displayMode: passes[algorithm].displayMode,
      radiusSpace: 'view',
      needsDepthTexture: passes[algorithm].needsDepthTexture,
      needsNormalTexture: passes[algorithm].needsNormalTexture,
      pipelineWarmupMs,
      stats: passes[algorithm].stats,
      errors: validationErrors,
    });
    document.body.dataset.renderStatus = result.dataset.status;
    document.body.dataset.renderError = validationErrors.join('\n');
  }
}

function bindControls(
  passes: Record<AmbientOcclusionAlgorithm, AmbientOcclusionPass>,
  feature: PostProcessRenderFeature,
  getAlgorithm: () => AmbientOcclusionAlgorithm,
  setAlgorithm: (value: AmbientOcclusionAlgorithm) => void,
  getEnabled: () => boolean,
  setEnabled: (value: boolean) => void,
): void {
  const algorithm = query<HTMLSelectElement>('#algorithm');
  const enabled = query<HTMLInputElement>('#enabled');
  const display = query<HTMLSelectElement>('#display');
  const quality = query<HTMLSelectElement>('#quality');
  const radius = query<HTMLInputElement>('#radius');
  const intensity = query<HTMLInputElement>('#intensity');
  algorithm.value = getAlgorithm();
  enabled.checked = getEnabled();
  const active = (): AmbientOcclusionPass => passes[getAlgorithm()];
  const syncPass = (): void => { feature.setPasses(getEnabled() ? [active()] : []); };
  algorithm.addEventListener('change', () => {
    setAlgorithm(parseAlgorithm(algorithm.value));
    applySharedControls(active(), display, quality, radius, intensity);
    syncPass();
  });
  enabled.addEventListener('change', () => { setEnabled(enabled.checked); syncPass(); });
  display.addEventListener('change', () => { active().displayMode = display.value === 'occlusion' ? 'occlusion' : 'composite'; });
  quality.addEventListener('change', () => { active().quality = parseQuality(quality.value); });
  radius.addEventListener('input', () => { active().radius = Number(radius.value); query<HTMLOutputElement>('#radius-value').value = `${Number(radius.value).toFixed(2)}u`; });
  intensity.addEventListener('input', () => { active().intensity = Number(intensity.value); query<HTMLOutputElement>('#intensity-value').value = Number(intensity.value).toFixed(2); });
  applySharedControls(active(), display, quality, radius, intensity);
}

function applySharedControls(pass: AmbientOcclusionPass, display: HTMLSelectElement, quality: HTMLSelectElement, radius: HTMLInputElement, intensity: HTMLInputElement): void {
  pass.displayMode = display.value === 'occlusion' ? 'occlusion' : 'composite';
  pass.quality = parseQuality(quality.value);
  pass.radius = Number(radius.value);
  pass.intensity = Number(intensity.value);
  query<HTMLOutputElement>('#radius-value').value = `${Number(radius.value).toFixed(2)}u`;
  query<HTMLOutputElement>('#intensity-value').value = Number(intensity.value).toFixed(2);
}

function updateMetrics(pass: AmbientOcclusionPass): void {
  query<HTMLElement>('#active-algorithm').textContent = pass.algorithm.toUpperCase();
  query<HTMLElement>('#sample-count').textContent = String(pass.stats.sampleCount);
  query<HTMLElement>('#frame-count').textContent = pass.stats.frameCount.toLocaleString();
}

function addMesh(scene: ReturnType<HaiyueEngine['createScene']>, name: string, geometry: Geometry3D, material: BasicMaterial, position: Vec3, rotation: Vec3 = [0, 0, 0]): Entity {
  const entity = new Entity(name)
    .addComponent(new CartesianTransform3D({ position, rotation }))
    .addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
  return entity;
}

function parseAlgorithm(value: string | null): AmbientOcclusionAlgorithm {
  return value === 'sao' || value === 'ssao' ? value : 'gtao';
}

function parseCameraView(value: string | null): AmbientOcclusionCameraView {
  return value === 'alternate' || value === 'nearby' ? value : 'default';
}

function parseQuality(value: string): AmbientOcclusionQuality {
  return value === 'low' || value === 'medium' ? value : 'high';
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Ambient occlusion example is missing ${selector}.`);
  return element;
}

void main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = message;
  const result = document.querySelector<HTMLElement>('#result');
  if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ schemaVersion: 1, suite: 'ambient-occlusion-example', status: 'failed', errors: [message] }); }
  console.error(error);
});
