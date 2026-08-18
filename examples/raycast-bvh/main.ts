import { mat4 } from 'wgpu-matrix';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { Ray } from '@haiyue/engine/math';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const trianglesEl = document.getElementById('triangles') as HTMLElement;
const raysEl = document.getElementById('rays') as HTMLElement;
const bvhOnEl = document.getElementById('bvh-on') as HTMLElement;
const bvhOffEl = document.getElementById('bvh-off') as HTMLElement;
const speedupEl = document.getElementById('speedup') as HTMLElement;

const geometry = createSphere3D({ radius: 1.6, widthSegments: 192, heightSegments: 96 });
const worldMatrix = mat4.identity() as Float32Array;
const rayCount = 6000;

function makeRays(): Ray[] {
  const rays: Ray[] = [];
  const originZ = 5;
  const spread = 2.7;
  for (let i = 0; i < rayCount; i++) {
    const u = (i % 100) / 99;
    const v = Math.floor(i / 100) / Math.ceil(rayCount / 100);
    const x = (u - 0.5) * spread;
    const y = (v - 0.5) * spread;
    const ray = new Ray();
    ray.origin.set([x, y, originZ]);
    const len = Math.hypot(-x * 0.14, -y * 0.14, -originZ);
    ray.direction.set([-x * 0.14 / len, -y * 0.14 / len, -originZ / len]);
    rays.push(ray);
  }
  return rays;
}

function benchmark(rays: Ray[], useBVH: boolean): { ms: number; hits: number } {
  let hits = 0;
  const t0 = performance.now();
  for (const ray of rays) {
    if (ray.intersectMesh(geometry, worldMatrix, { useBVH })) hits++;
  }
  return { ms: performance.now() - t0, hits };
}

function runBenchmark(): void {
  const rays = makeRays();
  runButton.disabled = true;
  runButton.textContent = 'Running...';

  requestAnimationFrame(() => {
    // Warm BVH construction outside the measured path.
    rays[0]?.intersectMesh(geometry, worldMatrix, { useBVH: true });

    const withBVH = benchmark(rays, true);
    const withoutBVH = benchmark(rays, false);
    const speedup = withoutBVH.ms / Math.max(0.0001, withBVH.ms);

    bvhOnEl.textContent = `${withBVH.ms.toFixed(2)} ms (${withBVH.hits} hits)`;
    bvhOffEl.textContent = `${withoutBVH.ms.toFixed(2)} ms (${withoutBVH.hits} hits)`;
    speedupEl.textContent = `${speedup.toFixed(2)}x`;
    runButton.disabled = false;
    runButton.textContent = 'Run benchmark';
  });
}

async function main(): Promise<void> {
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.04, g: 0.05, b: 0.08, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 7] }));
  const scene = engine.createScene({
    name: 'RaycastBVH',
    camera,
    render3D: true,
    pipelineLabel: 'RaycastBVH.render',
  });

  const mesh = new Entity('HighPolySphere');
  mesh.addComponent(new CartesianTransform3D());
  mesh.addComponent(new Mesh3D(geometry, new BasicMaterial({ color: new ColorSRGB(0.34, 0.64, 0.96, 1) })));
  scene.add(mesh);

  engine.switchScene(scene);
  engine.run();

  trianglesEl.textContent = String((geometry.indices?.length ?? geometry.positions.length / 3) / 3);
  raysEl.textContent = String(rayCount);
  runButton.addEventListener('click', runBenchmark);
  runBenchmark();
}

main().catch(console.error);
