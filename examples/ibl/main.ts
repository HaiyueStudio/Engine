import {
  BasicMaterial,
  CartesianTransform3D,
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
import type { EnvironmentCubeTexture } from '@haiyue/engine/lighting';

type Vec3 = readonly [number, number, number];

interface ProceduralEnvironment {
  diffuse: EnvironmentCubeTexture;
  specular: EnvironmentCubeTexture;
  panorama: HTMLCanvasElement;
  destroy(): void;
}

const SPECULAR_SIZE = 128;
const SPECULAR_MIP_COUNT = Math.floor(Math.log2(SPECULAR_SIZE)) + 1;
const DIFFUSE_SIZE = 16;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: { r: 0.008, g: 0.012, b: 0.025, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const generated = createProceduralEnvironment(engine.device);
  const environment = new EnvironmentLight({
    diffuseTexture: generated.diffuse,
    specularTexture: generated.specular,
    diffuseColor: [1, 1, 1],
    specularColor: [1, 1, 1],
    intensity: 1.15,
  });

  const scene = engine.createScene({
    name: 'Image-based lighting',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
      orbit: {
        radius: 12.5,
        theta: Math.PI * 0.12,
        phi: Math.PI * 0.08,
        target: [0, 0.8, 0],
      },
    },
    render3D: { loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'IBL.render',
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 7,
    maxRadius: 24,
    rotateSpeed: 0.75,
  });

  const environmentEntity = new Entity('Texture IBL');
  environmentEntity.addComponent(environment);
  scene.add(environmentEntity);

  const skyTransform = new CartesianTransform3D();
  const skyEntity = new Entity('Environment backdrop');
  skyEntity.addComponent(skyTransform);
  skyEntity.addComponent(new Mesh3D(
    createSphere3D({ radius: 42, widthSegments: 64, heightSegments: 32 }),
    new BasicMaterial({
      color: [0.64, 0.64, 0.64, 1],
      texture: generated.panorama,
      cullMode: 'front',
      depthWrite: false,
    }),
  ));
  scene.add(skyEntity);

  const sphere = createSphere3D({ radius: 0.76, widthSegments: 48, heightSegments: 28 });
  const roughnessValues = [0.06, 0.22, 0.4, 0.62, 0.82, 1];
  for (let column = 0; column < roughnessValues.length; column++) {
    const x = (column - (roughnessValues.length - 1) / 2) * 1.72;
    const roughness = roughnessValues[column]!;
    addSphere(scene, sphere, `Metal · roughness ${roughness.toFixed(2)}`, [x, 1.85, 0], {
      baseColor: [0.92, 0.56, 0.18, 1],
      metallic: 1,
      roughness,
    });
    addSphere(scene, sphere, `Dielectric · roughness ${roughness.toFixed(2)}`, [x, 0.08, 0], {
      baseColor: [0.12, 0.48, 0.84, 1],
      metallic: 0,
      roughness,
    });
  }

  addMesh(scene, 'Ground', new Mesh3D(
    createPlane3D({ width: 28, height: 20, normal: 'y' }),
    new PbrMaterial({ baseColor: [0.16, 0.17, 0.2, 1], metallic: 0.45, roughness: 0.32 }),
  ), [0, -0.82, 0]);

  const toggle = document.querySelector<HTMLInputElement>('#texture-toggle')!;
  const intensity = document.querySelector<HTMLInputElement>('#intensity')!;
  const rotation = document.querySelector<HTMLInputElement>('#rotation')!;
  const animate = document.querySelector<HTMLInputElement>('#animate')!;
  const intensityValue = document.querySelector<HTMLOutputElement>('#intensity-value')!;
  const rotationValue = document.querySelector<HTMLOutputElement>('#rotation-value')!;

  function updateTextureMode(): void {
    environment.diffuseTexture = toggle.checked ? generated.diffuse : null;
    environment.specularTexture = toggle.checked ? generated.specular : null;
    environment.diffuseColor = toggle.checked ? [1, 1, 1] : [0.24, 0.3, 0.4];
    environment.specularColor = toggle.checked ? [1, 1, 1] : [0.58, 0.66, 0.78];
    document.body.dataset.iblMode = toggle.checked ? 'texture' : 'color-fallback';
  }

  function updateIntensity(): void {
    environment.intensity = Number(intensity.value);
    intensityValue.value = environment.intensity.toFixed(2);
  }

  function updateRotation(): void {
    environment.rotation = Number(rotation.value) * Math.PI / 180;
    rotationValue.value = `${Math.round(Number(rotation.value))}°`;
    skyTransform.setRotation(0, -environment.rotation, 0);
  }

  toggle.addEventListener('change', updateTextureMode);
  intensity.addEventListener('input', updateIntensity);
  rotation.addEventListener('input', updateRotation);
  updateTextureMode();
  updateIntensity();
  updateRotation();

  let validationFrames = 0;
  let validationFinished = false;
  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    if (!animate.checked) return;
    const nextDegrees = (Number(rotation.value) + delta * 0.006 + 180) % 360 - 180;
    rotation.value = String(nextDegrees);
    updateRotation();
  });
  engine.on('after-update', () => {
    if (!validationFinished && ++validationFrames >= 3) {
      validationFinished = true;
      void finishValidation();
    }
  });
  window.addEventListener('pagehide', () => generated.destroy(), { once: true });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const error = await engine.device.popErrorScope();
    if (error) validationErrors.push(error.message);
    document.body.dataset.iblDiffuseSize = String(DIFFUSE_SIZE);
    document.body.dataset.iblSpecularMips = String(SPECULAR_MIP_COUNT);
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
  }
}

function addSphere(
  scene: ReturnType<HaiyueEngine['createScene']>,
  geometry: ReturnType<typeof createSphere3D>,
  name: string,
  position: [number, number, number],
  material: ConstructorParameters<typeof PbrMaterial>[0],
): void {
  addMesh(scene, name, new Mesh3D(geometry, new PbrMaterial(material)), position);
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  mesh: Mesh3D,
  position: [number, number, number],
): void {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position }));
  entity.addComponent(mesh);
  scene.add(entity);
}

function createProceduralEnvironment(device: GPUDevice): ProceduralEnvironment {
  const diffuseTexture = device.createTexture({
    label: 'IBL diffuse irradiance cube',
    size: { width: DIFFUSE_SIZE, height: DIFFUSE_SIZE, depthOrArrayLayers: 6 },
    dimension: '2d',
    format: 'rgba8unorm',
    mipLevelCount: 1,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  writeCubeLevel(device, diffuseTexture, 0, DIFFUSE_SIZE, direction => diffuseIrradiance(direction));

  const specularTexture = device.createTexture({
    label: 'IBL prefiltered specular cube',
    size: { width: SPECULAR_SIZE, height: SPECULAR_SIZE, depthOrArrayLayers: 6 },
    dimension: '2d',
    format: 'rgba8unorm',
    mipLevelCount: SPECULAR_MIP_COUNT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  for (let level = 0; level < SPECULAR_MIP_COUNT; level++) {
    const size = Math.max(1, SPECULAR_SIZE >> level);
    const roughness = level / (SPECULAR_MIP_COUNT - 1);
    writeCubeLevel(device, specularTexture, level, size, direction => (
      level === 0 ? environmentRadiance(direction) : prefilterSpecular(direction, roughness)
    ));
  }

  return {
    diffuse: { texture: diffuseTexture, mipLevelCount: 1 },
    specular: { texture: specularTexture, mipLevelCount: SPECULAR_MIP_COUNT },
    panorama: createEnvironmentPanorama(1024, 512),
    destroy: () => {
      diffuseTexture.destroy();
      specularTexture.destroy();
    },
  };
}

function writeCubeLevel(
  device: GPUDevice,
  texture: GPUTexture,
  mipLevel: number,
  size: number,
  sample: (direction: Vec3) => Vec3,
): void {
  const bytesPerRow = Math.ceil(size * 4 / 256) * 256;
  for (let face = 0; face < 6; face++) {
    const pixels = new Uint8Array(bytesPerRow * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const direction = cubeDirection(face, (x + 0.5) / size, (y + 0.5) / size);
        const color = sample(direction);
        const offset = y * bytesPerRow + x * 4;
        pixels[offset] = linearByte(color[0]);
        pixels[offset + 1] = linearByte(color[1]);
        pixels[offset + 2] = linearByte(color[2]);
        pixels[offset + 3] = 255;
      }
    }
    device.queue.writeTexture(
      { texture, mipLevel, origin: { x: 0, y: 0, z: face } },
      pixels,
      { offset: 0, bytesPerRow, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: 1 },
    );
  }
}

function createEnvironmentPanorama(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('IBL panorama requires a 2D canvas context.');
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const phi = (y + 0.5) / height * Math.PI;
    for (let x = 0; x < width; x++) {
      const theta = (x + 0.5) / width * Math.PI * 2;
      const direction: Vec3 = [
        Math.cos(theta) * Math.sin(phi),
        Math.cos(phi),
        Math.sin(theta) * Math.sin(phi),
      ];
      const color = environmentRadiance(direction);
      const offset = (y * width + x) * 4;
      image.data[offset] = srgbByte(color[0]);
      image.data[offset + 1] = srgbByte(color[1]);
      image.data[offset + 2] = srgbByte(color[2]);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function environmentRadiance(direction: Vec3): Vec3 {
  const skyAmount = smoothstep(-0.08, 0.22, direction[1]);
  const zenith = Math.max(direction[1], 0);
  const horizon = Math.exp(-Math.abs(direction[1]) * 9);
  const ground: Vec3 = [0.035, 0.028, 0.038];
  const sky: Vec3 = [
    0.025 + zenith * 0.035,
    0.11 + zenith * 0.12,
    0.28 + zenith * 0.3,
  ];
  const color = mix3(ground, sky, skyAmount);

  const sun = Math.pow(Math.max(dot(direction, normalize([-0.58, 0.62, 0.53])), 0), 420);
  const warmBank = Math.pow(Math.max(dot(direction, normalize([-0.72, 0.08, 0.68])), 0), 9);
  const coolBank = Math.pow(Math.max(dot(direction, normalize([0.82, 0.15, -0.55])), 0), 8);
  return [
    clamp01(color[0] + horizon * 0.18 + warmBank * 0.52 + coolBank * 0.02 + sun),
    clamp01(color[1] + horizon * 0.075 + warmBank * 0.13 + coolBank * 0.34 + sun * 0.8),
    clamp01(color[2] + horizon * 0.035 + warmBank * 0.025 + coolBank * 0.62 + sun * 0.44),
  ];
}

function diffuseIrradiance(normal: Vec3): Vec3 {
  const sampleCount = 48;
  const [tangent, bitangent] = tangentFrame(normal);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let index = 0; index < sampleCount; index++) {
    const radius = Math.sqrt((index + 0.5) / sampleCount);
    const angle = index * GOLDEN_ANGLE;
    const z = Math.sqrt(Math.max(0, 1 - radius * radius));
    const direction = normalize([
      tangent[0] * Math.cos(angle) * radius + bitangent[0] * Math.sin(angle) * radius + normal[0] * z,
      tangent[1] * Math.cos(angle) * radius + bitangent[1] * Math.sin(angle) * radius + normal[1] * z,
      tangent[2] * Math.cos(angle) * radius + bitangent[2] * Math.sin(angle) * radius + normal[2] * z,
    ]);
    const color = environmentRadiance(direction);
    r += color[0];
    g += color[1];
    b += color[2];
  }
  const scale = 1.65 / sampleCount;
  return [clamp01(r * scale), clamp01(g * scale), clamp01(b * scale)];
}

function prefilterSpecular(normal: Vec3, roughness: number): Vec3 {
  const sampleCount = 12 + Math.round(roughness * 28);
  const cone = roughness * roughness * 1.8;
  const [tangent, bitangent] = tangentFrame(normal);
  let r = 0;
  let g = 0;
  let b = 0;
  let weightSum = 0;
  for (let index = 0; index < sampleCount; index++) {
    const radius = cone * Math.sqrt((index + 0.5) / sampleCount);
    const angle = index * GOLDEN_ANGLE;
    const direction = normalize([
      normal[0] + tangent[0] * Math.cos(angle) * radius + bitangent[0] * Math.sin(angle) * radius,
      normal[1] + tangent[1] * Math.cos(angle) * radius + bitangent[1] * Math.sin(angle) * radius,
      normal[2] + tangent[2] * Math.cos(angle) * radius + bitangent[2] * Math.sin(angle) * radius,
    ]);
    const weight = Math.max(dot(normal, direction), 0.001);
    const color = environmentRadiance(direction);
    r += color[0] * weight;
    g += color[1] * weight;
    b += color[2] * weight;
    weightSum += weight;
  }
  return [r / weightSum, g / weightSum, b / weightSum];
}

function cubeDirection(face: number, u01: number, v01: number): Vec3 {
  const u = u01 * 2 - 1;
  const v = v01 * 2 - 1;
  const directions: Vec3[] = [
    [1, -v, -u],
    [-1, -v, u],
    [u, 1, v],
    [u, -1, -v],
    [u, -v, 1],
    [-u, -v, -1],
  ];
  return normalize(directions[face]!);
}

function tangentFrame(normal: Vec3): readonly [Vec3, Vec3] {
  const up: Vec3 = Math.abs(normal[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  const tangent = normalize(cross(up, normal));
  return [tangent, cross(normal, tangent)];
}

function normalize(value: Vec3): Vec3 {
  const inverseLength = 1 / Math.hypot(value[0], value[1], value[2]);
  return [value[0] * inverseLength, value[1] * inverseLength, value[2] * inverseLength];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mix3(a: Vec3, b: Vec3, amount: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ];
}

function smoothstep(min: number, max: number, value: number): number {
  const amount = clamp01((value - min) / (max - min));
  return amount * amount * (3 - 2 * amount);
}

function linearByte(value: number): number {
  return Math.round(clamp01(value) * 255);
}

function srgbByte(value: number): number {
  return Math.round(Math.pow(clamp01(value), 1 / 2.2) * 255);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
