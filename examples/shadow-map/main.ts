import {
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  Geometry3D,
  HaiyueEngine,
  Mesh3D,
  OrbitControl,
  PbrMaterial,
  SphericalTransform3D,
  createBox3D,
  createPlane3D,
  createSphere3D,
} from '@haiyue/engine';

const SHADOW_LIGHTS = [
  { name: 'Coral key', direction: [-0.92, -1, -0.18] as [number, number, number], color: [1, 0.18, 0.12] as [number, number, number] },
  { name: 'Mint key', direction: [0.82, -1, -0.28] as [number, number, number], color: [0.12, 1, 0.42] as [number, number, number] },
  { name: 'Blue key', direction: [0.06, -1, 0.92] as [number, number, number], color: [0.16, 0.36, 1] as [number, number, number] },
] as const;

async function main(): Promise<void> {
  const regression = new URLSearchParams(location.search).get('regression') === '1';
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'gpu-driven',
    msaaSamples: 4,
    clearColor: { r: 0.012, g: 0.016, b: 0.026, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Multiple directional shadow maps',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 },
      orbit: { radius: 13.5, theta: Math.PI * 0.2, phi: Math.PI * 0.22, target: [0, 0.7, 0] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 7,
    maxRadius: 24,
  });

  addMesh(scene, 'Ground receiver', createPlane3D({ width: 18, height: 16, normal: 'y' }), new PbrMaterial({
    baseColor: [0.72, 0.74, 0.78, 1],
    metallic: 0.02,
    roughness: 0.82,
  }), [0, -0.04, 0]);

  const pedestalMaterial = new PbrMaterial({
    baseColor: [0.22, 0.24, 0.28, 1],
    metallic: 0.58,
    roughness: 0.26,
  });
  const accentMaterial = new PbrMaterial({
    baseColor: [0.78, 0.8, 0.84, 1],
    metallic: 0.12,
    roughness: 0.48,
  });
  addMesh(scene, 'Tall caster', createBox3D({ width: 1.15, height: 3.4, depth: 1.15 }), pedestalMaterial, [0, 1.7, 0]);
  addMesh(scene, 'Round caster', createSphere3D({ radius: 0.92, widthSegments: 32, heightSegments: 20 }), accentMaterial, [-2.65, 0.92, 1.5]);
  addMesh(scene, 'Low caster', createBox3D({ width: 1.5, height: 1.5, depth: 1.5 }), accentMaterial, [2.45, 0.75, 1.25], [0.12, 0.42, -0.08]);

  for (const definition of SHADOW_LIGHTS) {
    const lightEntity = new Entity(definition.name);
    lightEntity.addComponent(new DirectionalLight({
      direction: definition.direction,
      color: definition.color,
      intensity: 1.65,
      castShadow: true,
      shadow: {
        mapSize: 1024,
        extent: 13,
        near: 0.1,
        far: 34,
        bias: 0.0012,
        normalBias: 0.018,
      },
    }));
    scene.add(lightEntity);
  }

  const environment = new Entity('Low fill environment');
  environment.addComponent(new EnvironmentLight({
    intensity: 0.12,
    diffuseColor: [0.12, 0.15, 0.22],
    specularColor: [0.34, 0.4, 0.52],
  }));
  scene.add(environment);

  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') {
    throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  }
  engine.switchScene(scene);

  let frameCount = 0;
  let maxShadowPasses = 0;
  let sawCacheHit = false;
  let finished = false;
  engine.on('after-update', () => {
    const render3D = scene.render3DSystem!;
    maxShadowPasses = Math.max(maxShadowPasses, render3D.lastDirectionalShadowPassCount);
    sawCacheHit ||= render3D.lastDirectionalShadowCacheHit;
    if (finished || ++frameCount < 6) return;
    finished = true;
    void finishValidation();
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (maxShadowPasses !== SHADOW_LIGHTS.length) {
      validationErrors.push(`Expected ${SHADOW_LIGHTS.length} directional shadow passes, observed ${maxShadowPasses}.`);
    }
    if (!sawCacheHit) validationErrors.push('Directional shadow cache did not reuse the static three-map result.');

    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.shadowLightCount = String(SHADOW_LIGHTS.length);
    document.body.dataset.shadowPassCount = String(maxShadowPasses);
    document.body.dataset.shadowCacheHit = String(sawCacheHit);
    query<HTMLElement>('#passes').textContent = String(maxShadowPasses);
    query<HTMLElement>('#cache').textContent = sawCacheHit ? 'Hit' : 'Miss';
    query<HTMLElement>('#status').textContent = document.body.dataset.renderStatus;
    const result = query<HTMLElement>('#result');
    result.dataset.status = document.body.dataset.renderStatus;
    result.textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      shadowLights: SHADOW_LIGHTS.length,
      maxShadowPasses,
      cacheHit: sawCacheHit,
    });
    if (regression) engine.stop();
  }
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: Geometry3D,
  material: PbrMaterial,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): void {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position, rotation }));
  entity.addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing shadow-map example element: ${selector}`);
  return element;
}

main().catch(error => {
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  const result = document.querySelector<HTMLElement>('#result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({ status: 'failed', error: document.body.dataset.renderError });
  }
});
