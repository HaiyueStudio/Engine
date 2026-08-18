import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { NormalMaterial } from '@haiyue/engine/material';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { createCone3D } from '@haiyue/engine/geometry';
import { OrbitControl } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';
import type { Geometry3D } from '@haiyue/engine';
import type { Scene } from '@haiyue/engine';

interface ObjectRecord {
  transform: Transform3D;
  material: NormalMaterial;
  position: [number, number, number];
  scale: [number, number, number];
  spin: number;
}

function composeMatrix(
  position: [number, number, number],
  scale: [number, number, number],
  rotationY: number,
): Float32Array {
  const t = mat4.translation(position);
  const r = mat4.rotationY(rotationY);
  const s = mat4.scaling(scale);
  return mat4.multiply(t, mat4.multiply(r, s)) as Float32Array;
}

function createObject(
  scene: Scene,
  geometry: Geometry3D,
  material: NormalMaterial,
  position: [number, number, number],
  scale: [number, number, number],
  spin: number,
): ObjectRecord {
  const transform = new Transform3D();
  transform.localMatrix = composeMatrix(position, scale, 0);

  const entity = new Entity('NormalObject');
  entity.addComponent(transform);
  entity.addComponent(new Mesh3D(geometry, material));
  scene.add(entity);

  return { transform, material, position, scale, spin };
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.03, g: 0.035, b: 0.05, a: 1 },
  });
  await engine.init();

  const scene = engine.createScene({
    name: 'NormalMaterial',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 },
      orbit: {
        radius: 14,
        theta: Math.PI * 0.18,
        phi: Math.PI * 0.28,
        target: [0, 0, 0],
      },
    },
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'NormalMaterial.render',
  });
  const camSph = scene.cameraEntity.getComponent(SphericalTransform3D)!;

  new OrbitControl(canvas, camSph, { minRadius: 4, maxRadius: 40 });

  const material = new NormalMaterial({ space: 'view' });
  const box = createBox3D({ width: 2.2, height: 2.2, depth: 2.2 });
  const sphere = createSphere3D({ radius: 1.35, widthSegments: 32, heightSegments: 18 });
  const cone = createCone3D({ radius: 1.25, height: 2.7, radialSegments: 32 });

  const objects = [
    createObject(scene, box, material, [-4.2, 0, 0], [1.0, 1.9, 0.72], 0.85),
    createObject(scene, sphere, material, [0, 0, 0], [1.55, 0.78, 1.0], -0.55),
    createObject(scene, cone, material, [4.2, 0, 0], [1.0, 1.2, 1.85], 0.72),
  ];

  let animate = true;
  const normalSpaces: Array<'view' | 'world' | 'local'> = ['view', 'world', 'local'];
  let normalSpace: 'view' | 'world' | 'local' = 'view';

  const btnSpace = document.getElementById('btn-space') as HTMLButtonElement;
  const btnSpin = document.getElementById('btn-spin') as HTMLButtonElement;

  function updateUI() {
    btnSpace.textContent = `Normal Space: ${normalSpace.charAt(0).toUpperCase()}${normalSpace.slice(1)}`;
    btnSpace.className = normalSpace === 'view' ? 'active' : '';
    btnSpin.textContent = `Animation: ${animate ? 'On' : 'Off'}`;
    btnSpin.className = animate ? 'active' : '';
  }

  function toggleSpace() {
    normalSpace = normalSpaces[(normalSpaces.indexOf(normalSpace) + 1) % normalSpaces.length] ?? 'view';
    material.space = normalSpace;
    updateUI();
  }

  function toggleAnimation() {
    animate = !animate;
    updateUI();
  }

  btnSpace.addEventListener('click', toggleSpace);
  btnSpin.addEventListener('click', toggleAnimation);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'n' || event.key === 'N') toggleSpace();
    if (event.code === 'Space') {
      event.preventDefault();
      toggleAnimation();
    }
  });

  updateUI();

  let elapsed = 0;
  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    if (animate) elapsed += delta * 0.001;
    for (const obj of objects) {
      obj.transform.localMatrix = composeMatrix(obj.position, obj.scale, elapsed * obj.spin);
    }
  });

  engine.run();
}

main().catch(console.error);
