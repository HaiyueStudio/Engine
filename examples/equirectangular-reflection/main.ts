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
  createPlane3D,
  createSphere3D,
} from '@haiyue/engine';
import { createEquirectangularReflectionMap } from '@haiyue/engine/lighting';
import {
  PANORAMA_HEIGHT,
  PANORAMA_WIDTH,
  createReflectionPanorama,
} from './Panorama';

const FACE_SIZE = 256;

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: { r: 0.006, g: 0.009, b: 0.018, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const panorama = createReflectionPanorama();
  const preview = query<HTMLCanvasElement>('#panorama-preview');
  preview.width = PANORAMA_WIDTH;
  preview.height = PANORAMA_HEIGHT;
  preview.getContext('2d')?.drawImage(panorama, 0, 0);
  const reflectionMap = await createEquirectangularReflectionMap(engine.device, panorama, {
    faceSize: FACE_SIZE,
    label: 'EquirectangularReflectionExample',
  });

  const scene = engine.createScene({
    name: 'Equirectangular reflection map',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
      orbit: { radius: 9.4, theta: Math.PI * 0.13, phi: Math.PI * 0.12, target: [0, 0.45, 0] },
    },
    render3D: { loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'EquirectangularReflection.render',
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 4.8,
    maxRadius: 18,
    rotateSpeed: 0.75,
  });

  const environment = new EnvironmentLight({
    specularTexture: reflectionMap,
    diffuseColor: [0.13, 0.16, 0.22],
    specularColor: [1, 1, 1],
    intensity: 1.3,
  });
  const environmentEntity = new Entity('Converted equirectangular reflection');
  environmentEntity.addComponent(environment);
  scene.add(environmentEntity);

  const skyTransform = new CartesianTransform3D();
  const sky = new Entity('Source equirectangular sky');
  sky.addComponent(skyTransform);
  sky.addComponent(new Mesh3D(
    createSphere3D({ radius: 36, widthSegments: 64, heightSegments: 32 }),
    new BasicMaterial({
      texture: panorama,
      color: [0.58, 0.58, 0.58, 1],
      cullMode: 'front',
      depthWrite: false,
    }),
  ));
  scene.add(sky);

  const sphereGeometry = createSphere3D({ radius: 1.05, widthSegments: 56, heightSegments: 32 });
  addMesh(scene, 'Chrome', sphereGeometry, [-2.45, 0.55, 0], [0.93, 0.95, 1, 1], 1, 0.04);
  addMesh(scene, 'Copper', sphereGeometry, [0, 0.55, 0], [0.95, 0.44, 0.17, 1], 1, 0.1);
  addMesh(scene, 'Coated dielectric', sphereGeometry, [2.45, 0.55, 0], [0.08, 0.2, 0.48, 1], 0.08, 0.16);

  const floor = new Entity('Reflection floor');
  floor.addComponent(new CartesianTransform3D({ position: [0, -0.58, 0] }));
  floor.addComponent(new Mesh3D(
    createPlane3D({ width: 18, height: 12, normal: 'y' }),
    new PbrMaterial({ baseColor: [0.12, 0.13, 0.16, 1], metallic: 0.82, roughness: 0.16 }),
  ));
  scene.add(floor);

  const key = new Entity('Soft key light');
  key.addComponent(new DirectionalLight({
    direction: [-0.5, -1, -0.35],
    color: [1, 0.86, 0.72],
    intensity: 0.65,
  }));
  scene.add(key);

  const rotation = query<HTMLInputElement>('#rotation');
  const intensity = query<HTMLInputElement>('#intensity');
  const animate = query<HTMLInputElement>('#animate');
  const rotationValue = query<HTMLOutputElement>('#rotation-value');
  const intensityValue = query<HTMLOutputElement>('#intensity-value');
  const updateRotation = (): void => {
    environment.rotation = Number(rotation.value) * Math.PI / 180;
    skyTransform.setRotation(0, -environment.rotation, 0);
    rotationValue.value = `${Math.round(Number(rotation.value))}°`;
  };
  const updateIntensity = (): void => {
    environment.intensity = Number(intensity.value);
    intensityValue.value = environment.intensity.toFixed(2);
  };
  rotation.addEventListener('input', updateRotation);
  intensity.addEventListener('input', updateIntensity);
  updateRotation();
  updateIntensity();

  let validationFrames = 0;
  let validationFinished = false;
  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    if (!animate.checked) return;
    rotation.value = String((Number(rotation.value) + delta * 0.007 + 180) % 360 - 180);
    updateRotation();
  });
  engine.on('after-update', () => {
    if (!validationFinished && ++validationFrames >= 4) {
      validationFinished = true;
      void finishValidation();
    }
  });
  window.addEventListener('pagehide', () => reflectionMap.destroy(), { once: true });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (reflectionMap.sourceWidth !== PANORAMA_WIDTH || reflectionMap.sourceHeight !== PANORAMA_HEIGHT) {
      validationErrors.push('The converted map did not preserve the source dimensions.');
    }
    if (reflectionMap.faceSize !== FACE_SIZE) validationErrors.push('The converted cubemap face size is incorrect.');
    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.equirectSourceSize = `${reflectionMap.sourceWidth}x${reflectionMap.sourceHeight}`;
    document.body.dataset.equirectFaceSize = String(reflectionMap.faceSize);
    document.body.dataset.equirectLayers = '6';
    query<HTMLElement>('#result').textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      source: [reflectionMap.sourceWidth, reflectionMap.sourceHeight],
      cubemap: [reflectionMap.faceSize, reflectionMap.faceSize, 6],
      mipLevelCount: reflectionMap.mipLevelCount,
    });
  }
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: ReturnType<typeof createSphere3D>,
  position: [number, number, number],
  baseColor: [number, number, number, number],
  metallic: number,
  roughness: number,
): void {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position }));
  entity.addComponent(new Mesh3D(geometry, new PbrMaterial({ baseColor, metallic, roughness })));
  scene.add(entity);
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
