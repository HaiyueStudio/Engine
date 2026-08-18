import { BasicMaterial, CartesianTransform3D, DirectionalLight, Entity, EnvironmentLight, Geometry3D, HaiyueEngine, Mesh3D, OrbitControl, PbrMaterial, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D, type RenderProfileName } from '@haiyue/engine';
import { setupPbrShowcaseControls } from './PbrShowcaseControls';

function addMesh(scene: ReturnType<HaiyueEngine['createScene']>, name: string, mesh: Mesh3D, position: [number, number, number]) {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position }));
  entity.addComponent(mesh);
  scene.add(entity);
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const query = new URLSearchParams(location.search);
  const neutralRimProbe = query.get('neutralRim') === 'on';
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'gpu-driven',
    msaaSamples: 4,
    clearColor: neutralRimProbe
      ? { r: 0.04, g: 0.04, b: 0.04, a: 1 }
      : { r: 0.025, g: 0.055, b: 0.1, a: 1 },
  });
  await engine.init();
  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'PBR product baseline',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
      orbit: { radius: 12, theta: Math.PI * 0.17, phi: Math.PI * 0.2, target: [0, 0.8, 0] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, { minRadius: 5, maxRadius: 24 });

  const clearcoatEnabled = query.get('clearcoat') !== 'off';
  const specularEnabled = query.get('specular') === 'on';
  const sheenEnabled = query.get('sheen') === 'on';
  const transmissionEnabled = query.get('transmission') === 'on';
  const shadowBatchEnabled = query.get('shadowBatch') === 'on';
  const showcaseMaterials: PbrMaterial[] = [];
  const mipCompatibilityTexture = createMipCompatibilityTexture();
  const clearcoatCompatibilityTexture = createClearcoatCompatibilityTexture();
  const sphere = createSphere3D({ radius: 0.72, widthSegments: 40, heightSegments: 24 });
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 5; column++) {
      const material = new PbrMaterial({
        baseColor: neutralRimProbe
          ? [0.62, 0.62, 0.62, 1]
          : [0.38 + row * 0.16, 0.55 - row * 0.08, 0.82 - row * 0.16, 1],
        metallic: column / 4,
        roughness: 0.08 + row * 0.4,
        clearcoatFactor: clearcoatEnabled && row > 0 ? (row === 1 ? column / 4 : 1) : 0,
        clearcoatRoughnessFactor: row === 1 ? 0.08 + column * 0.12 : column / 4,
        clearcoatNormalScale: row === 2 ? 0.35 + column * 0.3 : 1,
        ior: specularEnabled ? 1.05 + column * 0.3 : 1.5,
        specularFactor: specularEnabled ? 0.2 + row * 0.3 : 1,
        specularColorFactor: specularEnabled
          ? [1.45 - row * 0.2, 0.55 + column * 0.08, 0.45 + row * 0.22]
          : [1, 1, 1],
        sheenColorFactor: sheenEnabled
          ? [0.95 - row * 0.18, 0.12 + column * 0.1, 0.36 + row * 0.2]
          : [0, 0, 0],
        sheenRoughnessFactor: sheenEnabled ? 0.12 + row * 0.3 : 0,
        transmissionFactor: transmissionEnabled && row < 2 ? 0.35 + column * 0.14 : 0,
        thicknessFactor: transmissionEnabled && row === 1 ? 0.18 + column * 0.08 : 0,
        attenuationDistance: transmissionEnabled ? 1.2 + column * 0.45 : Infinity,
        attenuationColor: transmissionEnabled
          ? [0.98 - row * 0.08, 0.72 + column * 0.04, 0.5 + row * 0.2]
          : [1, 1, 1],
        ...(!neutralRimProbe && row === 0 && column === 0 ? {
          baseColorTexture: mipCompatibilityTexture,
          metallicRoughnessTexture: mipCompatibilityTexture,
        } : {}),
        ...(!neutralRimProbe && clearcoatEnabled && row === 2 && column === 0 ? {
          clearcoatTexture: clearcoatCompatibilityTexture,
          clearcoatRoughnessTexture: clearcoatCompatibilityTexture,
          clearcoatNormalTexture: clearcoatCompatibilityTexture,
        } : {}),
        ...(!neutralRimProbe && specularEnabled && row === 0 && column === 0 ? {
          specularTexture: clearcoatCompatibilityTexture,
          specularColorTexture: clearcoatCompatibilityTexture,
        } : {}),
        ...(!neutralRimProbe && sheenEnabled && row === 0 && column === 0 ? {
          sheenColorTexture: clearcoatCompatibilityTexture,
          sheenRoughnessTexture: clearcoatCompatibilityTexture,
        } : {}),
        ...(!neutralRimProbe && transmissionEnabled && row === 0 && column === 0 ? {
          transmissionTexture: clearcoatCompatibilityTexture,
          thicknessTexture: clearcoatCompatibilityTexture,
        } : {}),
        variants: [
          { name: 'moonlit', state: { baseColor: [0.16, 0.48, 0.82, 1], metallic: 0.65, roughness: 0.24, clearcoatFactor: clearcoatEnabled ? 0.5 : 0 } },
          { name: 'copper', state: { baseColor: [0.92, 0.42, 0.18, 1], metallic: 0.95, roughness: 0.3, clearcoatFactor: clearcoatEnabled ? 1 : 0, clearcoatRoughnessFactor: 0.18 } },
        ],
      });
      showcaseMaterials.push(material);
      addMesh(scene, `PBR ${row}:${column}`, new Mesh3D(sphere, material), [(column - 2) * 1.65, 0.1 + row * 1.5, 0]);
    }
  }

  addMesh(scene, 'Ground', new Mesh3D(
    createPlane3D({ width: 20, height: 14, normal: 'y' }),
    new PbrMaterial({
      baseColor: neutralRimProbe ? [0.2, 0.2, 0.2, 1] : [0.14, 0.18, 0.24, 1],
      metallic: 0.05,
      roughness: 0.76,
    }),
  ), [0, -0.72, 0]);
  addMesh(scene, 'Shadow reference', new Mesh3D(
    createBox3D({ width: 1.2, height: 2.4, depth: 1.2 }),
    new PbrMaterial({
      baseColor: neutralRimProbe ? [0.7, 0.7, 0.7, 1] : [0.72, 0.76, 0.82, 1],
      metallic: 0.7,
      roughness: 0.2,
    }),
  ), [-4.9, 0.48, -2]);
  if (shadowBatchEnabled) {
    const batchGeometry = createBox3D({ width: 0.62, height: 0.9, depth: 0.62 });
    const batchMaterial = new PbrMaterial({
      baseColor: [0.92, 0.28, 0.12, 1],
      metallic: 0.25,
      roughness: 0.36,
    });
    for (let index = 0; index < 7; index++) {
      addMesh(
        scene,
        `Direct-instanced shadow caster ${index}`,
        new Mesh3D(batchGeometry, batchMaterial),
        [(index - 3) * 0.9, -0.27, 1.35],
      );
    }
  }

  // Hidden below the opaque ground: these casters exercise real shadow draw
  // validation without changing the product screenshot.
  const shadowValidationMaterial = new BasicMaterial({ color: [0.2, 0.2, 0.2, 1] });
  addMesh(scene, 'Shadow morph validation', new Mesh3D(
    createShadowValidationGeometry(true, false), shadowValidationMaterial,
  ), [-1, -3, 0]);
  addMesh(scene, 'Shadow skin validation', new Mesh3D(
    createShadowValidationGeometry(false, true), shadowValidationMaterial,
  ), [0, -3, 0]);
  addMesh(scene, 'Shadow skin morph validation', new Mesh3D(
    createShadowValidationGeometry(true, true), shadowValidationMaterial,
  ), [1, -3, 0]);

  const sun = new Entity('Shadow-casting sun');
  const sunLight = new DirectionalLight({
    direction: [-0.7, -1, -0.45],
    color: neutralRimProbe ? [1, 1, 1] : [1, 0.94, 0.82],
    intensity: 3.2,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 14, far: 40, bias: 0.0012 },
  });
  sun.addComponent(sunLight);
  scene.add(sun);

  const environment = new Entity('Neutral analytic IBL fallback');
  const environmentLight = new EnvironmentLight({
    intensity: 0.85,
  });
  environment.addComponent(environmentLight);
  scene.add(environment);

  const report = engine.capabilities!.report;
  document.querySelector('#requested')!.textContent = report.requestedProfile;
  document.querySelector('#enabled')!.textContent = report.enabledProfile;
  document.querySelector('#degrade')!.textContent = report.degraded
    ? report.decisions.filter(item => item.requested && !item.enabled).map(item => `${item.capability}: ${item.reason}`).join(' · ')
    : '全部请求能力已启用';

  document.querySelector<HTMLSelectElement>('#profile')!.addEventListener('change', event => {
    scene.render3DSystem!.setRenderProfile((event.currentTarget as HTMLSelectElement).value as RenderProfileName);
  });
  setupPbrShowcaseControls({
    materials: showcaseMaterials,
    colorTexture: mipCompatibilityTexture,
    dataTexture: clearcoatCompatibilityTexture,
    sun: sunLight,
    environment: environmentLight,
  });

  let validationFrames = 0;
  let validationFinished = false;
  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);
  engine.on('after-update', () => {
    if (!validationFinished && ++validationFrames >= 3) {
      validationFinished = true;
      void finishValidation();
    }
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const error = await engine.device.popErrorScope();
    if (error) validationErrors.push(error.message);
    const pbrCoverage = [
      'base',
      ...(clearcoatEnabled ? ['clearcoat'] : []),
      ...(specularEnabled ? ['ior-specular'] : []),
      ...(sheenEnabled ? ['sheen'] : []),
      ...(transmissionEnabled ? ['transmission-volume'] : []),
      ...(shadowBatchEnabled ? ['shadow-direct-instancing'] : []),
    ].join(',');
    document.body.dataset.pbrShaderValidation = `${pbrCoverage},shadow-static,shadow-morph,shadow-skinned,shadow-skinned-morph`;
    publishValidation();
  }

  function publishValidation(): void {
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
  }
}

function createMipCompatibilityTexture(): HTMLCanvasElement {
  const texture = document.createElement('canvas');
  texture.width = 64;
  texture.height = 64;
  const context = texture.getContext('2d');
  if (!context) throw new Error('PBR mip compatibility texture requires a 2D canvas context.');
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      context.fillStyle = (x + y) % 2 === 0 ? '#f0a060' : '#4068d0';
      context.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  return texture;
}

function createShadowValidationGeometry(morph: boolean, skinned: boolean): Geometry3D {
  const positions = new Float32Array([-0.25, 0, 0, 0.25, 0, 0, 0, 0.5, 0]);
  return new Geometry3D({
    positions,
    ...(morph ? {
      morphTargets: [{ positions: new Float32Array([0, 0, 0, 0, 0, 0, 0.1, 0, 0]) }],
      morphWeights: [0.5],
    } : {}),
    ...(skinned ? {
      skinning: {
        joints: new Float32Array(12),
        weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        jointMatrices: new Float32Array([
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1,
        ]),
      },
    } : {}),
  });
}

function createClearcoatCompatibilityTexture(): HTMLCanvasElement {
  const texture = document.createElement('canvas');
  texture.width = 32;
  texture.height = 32;
  const context = texture.getContext('2d');
  if (!context) throw new Error('PBR clearcoat compatibility texture requires a 2D canvas context.');
  context.fillStyle = 'rgb(192, 128, 255)';
  context.fillRect(0, 0, 32, 32);
  context.fillStyle = 'rgb(128, 64, 240)';
  context.fillRect(0, 0, 16, 16);
  context.fillRect(16, 16, 16, 16);
  return texture;
}

main().catch(console.error);
