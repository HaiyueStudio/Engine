import { Camera3D, Entity, OrbitControl, SphericalTransform3D, HaiyueEngine, createSphere3D } from '@haiyue/engine';
import { InstancedMaterial } from '@haiyue/engine/material';
import { InstancedMesh3D } from '@haiyue/engine/components';
import { InstancedMesh3DRenderSystem } from '@haiyue/engine/systems';
import { Ray } from '@haiyue/engine/math';
import { mat4 } from 'wgpu-matrix';
import { requiredNumberAt } from '../arrayAccess';

const GRID = 10;
const INSTANCE_COUNT = GRID * GRID * GRID;
const SPACING = 1.25;
const RADIUS = 0.42;

function randomColor(): [number, number, number] {
  const h = Math.random();
  const s = 0.72;
  const v = 0.96;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const info = document.getElementById('info')!;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.025, g: 0.035, b: 0.055, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const cameraTransform = new SphericalTransform3D({
    radius: 24,
    theta: Math.PI * 0.22,
    phi: Math.PI * 0.34,
    target: [0, 0, 0],
  });
  const camera = new Entity('Camera');
  const cameraComponent = new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 });
  camera.addComponent(cameraComponent);
  camera.addComponent(cameraTransform);

  const scene = engine.createScene({
    name: 'InstancingRaycast',
    camera,
    render3D: false,
    pipelineLabel: 'InstancingRaycast.render',
  });
  const world = scene.world;

  new OrbitControl(canvas, cameraTransform, { minRadius: 8, maxRadius: 60 });

  const geometry = createSphere3D({ radius: RADIUS, widthSegments: 18, heightSegments: 10 });
  const material = new InstancedMaterial(INSTANCE_COUNT);
  const centers = new Float32Array(INSTANCE_COUNT * 3);
  const offset = ((GRID - 1) * SPACING) / 2;

  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const xIndex = i % GRID;
    const yIndex = Math.floor(i / GRID) % GRID;
    const zIndex = Math.floor(i / (GRID * GRID));
    const x = xIndex * SPACING - offset;
    const y = yIndex * SPACING - offset;
    const z = zIndex * SPACING - offset;
    centers.set([x, y, z], i * 3);
    material.setTransform(i, mat4.translation([x, y, z]) as Float32Array);
    const [r, g, b] = randomColor();
    material.setColor(i, r * 0.55, g * 0.55, b * 0.55);
  }

  const mesh = new Entity('InstancedSpheres');
  mesh.addComponent(new InstancedMesh3D(geometry, material));
  world.addEntity(mesh);
  scene.addSystem(new InstancedMesh3DRenderSystem(engine, camera, { msaaSamples: 4 }), { pass: 'shared' });

  const ray = new Ray();
  const invViewProj = mat4.identity() as Float32Array;
  const viewMatrix = mat4.identity() as Float32Array;
  const viewProj = mat4.identity() as Float32Array;
  let lastHit = -1;

  function updateRayFromPointer(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;

    cameraComponent.updateAspect(engine.width / engine.height);
    cameraTransform.updateWorldMatrix();
    mat4.inverse(cameraTransform.worldMatrix, viewMatrix);
    mat4.multiply(cameraComponent.projectionMatrix, viewMatrix, viewProj);
    mat4.inverse(viewProj, invViewProj);
    ray.setFromCamera(ndcX, ndcY, cameraTransform.eyePosition, invViewProj);

    const hit = raycastInstances(ray, centers);
    if (hit === -1) {
      lastHit = -1;
      info.textContent = '1000 instanced spheres · hover to recolor · drag = orbit';
      return;
    }
    if (hit !== lastHit) {
      const [r, g, b] = randomColor();
      material.setColor(hit, r, g, b);
      lastHit = hit;
    }
    info.textContent = `Hit instance ${hit} · 1000 instanced spheres`;
  }

  canvas.addEventListener('pointermove', updateRayFromPointer);
  canvas.addEventListener('pointerleave', () => {
    lastHit = -1;
    info.textContent = '1000 instanced spheres · hover to recolor · drag = orbit';
  });

  engine.switchScene(scene);
  engine.run();
}

function raycastInstances(ray: Ray, centers: Float32Array): number {
  const ox = requiredNumberAt(ray.origin, 0, 'ray origin');
  const oy = requiredNumberAt(ray.origin, 1, 'ray origin');
  const oz = requiredNumberAt(ray.origin, 2, 'ray origin');
  const dx = requiredNumberAt(ray.direction, 0, 'ray direction');
  const dy = requiredNumberAt(ray.direction, 1, 'ray direction');
  const dz = requiredNumberAt(ray.direction, 2, 'ray direction');
  const radiusSq = RADIUS * RADIUS;
  let bestIndex = -1;
  let bestT = Infinity;

  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const base = i * 3;
    const cx = requiredNumberAt(centers, base, 'instance centers');
    const cy = requiredNumberAt(centers, base + 1, 'instance centers');
    const cz = requiredNumberAt(centers, base + 2, 'instance centers');
    const ocx = ox - cx;
    const ocy = oy - cy;
    const ocz = oz - cz;
    const b = ocx * dx + ocy * dy + ocz * dz;
    const c = ocx * ocx + ocy * ocy + ocz * ocz - radiusSq;
    const h = b * b - c;
    if (h < 0) continue;
    const t = -b - Math.sqrt(h);
    if (t > 0 && t < bestT) {
      bestT = t;
      bestIndex = i;
    }
  }

  return bestIndex;
}

main().catch(console.error);
