import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { Sky } from '@haiyue/engine/components';
import { BasicMaterial } from '@haiyue/engine';
import { createPlane3D } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import type { Scene } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';

function setCanvasSize(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
}

function setTransform(
  transform: Transform3D,
  position: [number, number, number],
  scale: [number, number, number],
  rotationY = 0,
): void {
  const t = mat4.translation(position);
  const r = mat4.rotationY(rotationY);
  const s = mat4.scaling(scale);
  transform.localMatrix = mat4.multiply(t, mat4.multiply(r, s)) as Float32Array;
}

function addMesh(
  scene: Scene,
  name: string,
  mesh: Mesh3D,
  position: [number, number, number],
  scale: [number, number, number],
  rotationY = 0,
): Transform3D {
  const transform = new Transform3D();
  setTransform(transform, position, scale, rotationY);

  const entity = new Entity(name);
  entity.addComponent(transform);
  entity.addComponent(mesh);
  scene.add(entity);
  return transform;
}

function readRange(id: string): number {
  return Number((document.getElementById(id) as HTMLInputElement).value);
}

function bindRange(id: string, format: (value: number) => string, onChange: () => void): void {
  const input = document.getElementById(id) as HTMLInputElement;
  const output = document.getElementById(`${id}-value`) as HTMLSpanElement;
  const update = () => {
    output.textContent = format(Number(input.value));
    onChange();
  };
  input.addEventListener('input', update);
  update();
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  setCanvasSize(canvas);

  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: { r: 0.04, g: 0.06, b: 0.09, a: 1 },
  });
  await engine.init();

  window.addEventListener('resize', () => {
    setCanvasSize(canvas);
    engine.msaaSamples = engine.msaaSamples === 4 ? 1 : 4;
    engine.msaaSamples = 4;
  });

  const scene = engine.createScene({
    name: 'Sky',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 120 },
      orbit: {
        radius: 18,
        theta: Math.PI * 0.18,
        phi: Math.PI * 0.18,
        target: [0, 1.6, 0],
      },
    },
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'Sky.render',
  });
  const camSph = scene.cameraEntity.getComponent(SphericalTransform3D)!;
  new OrbitControl(canvas, camSph, { minRadius: 5, maxRadius: 46 });

  const sky = new Sky({
    turbidity: 10,
    rayleigh: 3,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.7,
    exposure: 0.65,
  });
  const skyEntity = new Entity('Sky');
  skyEntity.addComponent(sky);
  scene.add(skyEntity);

  const groundMaterial = new BasicMaterial({ color: [0.36, 0.43, 0.33, 1] });
  const whiteMaterial = new BasicMaterial({ color: [0.78, 0.74, 0.68, 1] });
  const warmMaterial = new BasicMaterial({ color: [0.76, 0.48, 0.28, 1] });
  const coolMaterial = new BasicMaterial({ color: [0.34, 0.50, 0.64, 1] });

  addMesh(
    scene,
    'Ground',
    new Mesh3D(createPlane3D({ width: 80, height: 80, normal: 'y' }), groundMaterial),
    [0, 0, 0],
    [1, 1, 1],
  );

  const boxTransform = addMesh(
    scene,
    'Box',
    new Mesh3D(createBox3D({ width: 2.2, height: 2.2, depth: 2.2 }), warmMaterial),
    [-3.2, 1.1, 0],
    [1, 1, 1],
    0.4,
  );
  const sphereTransform = addMesh(
    scene,
    'Sphere',
    new Mesh3D(createSphere3D({ radius: 1.4, widthSegments: 32, heightSegments: 18 }), coolMaterial),
    [2.8, 1.4, 0.8],
    [1, 1, 1],
  );
  addMesh(
    scene,
    'White Slab',
    new Mesh3D(createBox3D({ width: 3, height: 0.45, depth: 2 }), whiteMaterial),
    [0, 0.25, -3],
    [1, 1, 1],
    -0.25,
  );

  function updateSky(): void {
    sky.turbidity = readRange('turbidity');
    sky.rayleigh = readRange('rayleigh');
    sky.mieCoefficient = readRange('mie');
    sky.mieDirectionalG = readRange('mie-g');
    sky.exposure = readRange('exposure');

    const elevation = readRange('elevation') * Math.PI / 180;
    const azimuth = readRange('azimuth') * Math.PI / 180;
    sky.setSunPosition(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );
  }

  bindRange('turbidity', (value) => value.toFixed(1), updateSky);
  bindRange('rayleigh', (value) => value.toFixed(1), updateSky);
  bindRange('mie', (value) => value.toFixed(3), updateSky);
  bindRange('mie-g', (value) => value.toFixed(2), updateSky);
  bindRange('elevation', (value) => value.toFixed(1), updateSky);
  bindRange('azimuth', (value) => value.toFixed(0), updateSky);
  bindRange('exposure', (value) => value.toFixed(2), updateSky);

  let elapsed = 0;
  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    elapsed += delta * 0.001;
    setTransform(boxTransform, [-3.2, 1.1, 0], [1, 1, 1], elapsed * 0.35);
    setTransform(sphereTransform, [2.8, 1.4 + Math.sin(elapsed) * 0.08, 0.8], [1, 1, 1], 0);
  });

  engine.run();
}

main().catch(console.error);
