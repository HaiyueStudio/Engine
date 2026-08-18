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
  createPlane3D,
} from '@haiyue/engine';
import { subdivideGeometryTriangles } from '@haiyue/engine/geometry';

const LEVELS = [0, 2, 4] as const;
const COLORS = [
  [0.18, 0.55, 0.92, 1],
  [0.19, 0.82, 0.63, 1],
  [0.95, 0.48, 0.18, 1],
] as const;

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'gpu-driven',
    msaaSamples: 4,
    clearColor: { r: 0.012, g: 0.02, b: 0.042, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Linear triangle subdivision',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
      orbit: { radius: 13.5, theta: Math.PI * 0.16, phi: Math.PI * 0.24, target: [0, 0, 0] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 7,
    maxRadius: 24,
  });

  const base = createPlane3D({ width: 3.5, height: 3.5, normal: 'y' });
  const patches = LEVELS.map((iterations, index) => {
    const geometry = subdivideGeometryTriangles(base, { iterations });
    displaceSurface(geometry);
    addPatch(scene, `Subdivision level ${iterations}`, geometry, COLORS[index]!, [(index - 1) * 4.3, 0, 0]);
    return geometry;
  });

  const sun = new Entity('Subdivision key light');
  sun.addComponent(new DirectionalLight({
    direction: [-0.65, -1, -0.42],
    color: [1, 0.92, 0.8],
    intensity: 3.1,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 16, far: 35, bias: 0.0012 },
  }));
  scene.add(sun);

  const environment = new Entity('Subdivision environment');
  environment.addComponent(new EnvironmentLight({
    intensity: 0.72,
    diffuseColor: [0.16, 0.26, 0.48],
    specularColor: [0.64, 0.82, 1],
  }));
  scene.add(environment);

  publishStats(patches);
  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') {
    throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  }
  engine.switchScene(scene);

  let validationFrames = 0;
  let validationFinished = false;
  engine.on('after-update', () => {
    if (validationFinished || ++validationFrames < 4) return;
    validationFinished = true;
    void finishValidation();
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);

    const triangleCounts = patches.map(geometry => (geometry.indices?.length ?? geometry.vertexCount) / 3);
    const expectedTriangles = LEVELS.map(level => 2 * 4 ** level);
    if (triangleCounts.some((count, index) => count !== expectedTriangles[index])) {
      validationErrors.push(`Unexpected triangle counts: ${triangleCounts.join(', ')}.`);
    }
    if (base.vertexCount !== 4 || base.indices?.length !== 6) {
      validationErrors.push('Source plane was mutated by subdivision.');
    }

    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.subdivisionLevels = LEVELS.join(',');
    document.body.dataset.subdivisionTriangles = triangleCounts.join(',');
    document.body.dataset.subdivisionVertices = patches.map(geometry => geometry.vertexCount).join(',');
    query<HTMLElement>('#result').textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      levels: LEVELS,
      triangles: triangleCounts,
      vertices: patches.map(geometry => geometry.vertexCount),
      sourceTriangles: 2,
      sourceVertices: base.vertexCount,
    });
  }
}

function displaceSurface(geometry: Geometry3D): void {
  const positions = geometry.positions;
  for (let vertex = 0; vertex < geometry.vertexCount; vertex++) {
    const offset = vertex * 3;
    const x = positions[offset]!;
    const z = positions[offset + 2]!;
    const radial = Math.exp(-(x * x + z * z) * 0.38);
    positions[offset + 1] = Math.sin(x * 1.55 + 0.35) * Math.cos(z * 1.35 - 0.2) * 0.7 + radial * 0.42;
  }
  geometry.normals = calculateSmoothNormals(geometry);
  geometry.markDirty();
}

function calculateSmoothNormals(geometry: Geometry3D): Float32Array {
  const normals = new Float32Array(geometry.positions.length);
  const indices = geometry.indices ?? Uint32Array.from({ length: geometry.vertexCount }, (_, index) => index);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]! * 3;
    const b = indices[offset + 1]! * 3;
    const c = indices[offset + 2]! * 3;
    const abx = geometry.positions[b]! - geometry.positions[a]!;
    const aby = geometry.positions[b + 1]! - geometry.positions[a + 1]!;
    const abz = geometry.positions[b + 2]! - geometry.positions[a + 2]!;
    const acx = geometry.positions[c]! - geometry.positions[a]!;
    const acy = geometry.positions[c + 1]! - geometry.positions[a + 1]!;
    const acz = geometry.positions[c + 2]! - geometry.positions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertexOffset of [a, b, c]) {
      normals[vertexOffset] = normals[vertexOffset]! + nx;
      normals[vertexOffset + 1] = normals[vertexOffset + 1]! + ny;
      normals[vertexOffset + 2] = normals[vertexOffset + 2]! + nz;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset]!, normals[offset + 1]!, normals[offset + 2]!) || 1;
    normals[offset] = normals[offset]! / length;
    normals[offset + 1] = normals[offset + 1]! / length;
    normals[offset + 2] = normals[offset + 2]! / length;
  }
  return normals;
}

function addPatch(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: Geometry3D,
  baseColor: readonly [number, number, number, number],
  position: [number, number, number],
): void {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position }));
  entity.addComponent(new Mesh3D(geometry, new PbrMaterial({
    baseColor,
    metallic: 0.28,
    roughness: 0.3,
  })));
  scene.add(entity);
}

function publishStats(patches: readonly Geometry3D[]): void {
  patches.forEach((geometry, index) => {
    query<HTMLElement>(`#vertices-${index}`).textContent = geometry.vertexCount.toLocaleString();
    query<HTMLElement>(`#triangles-${index}`).textContent = ((geometry.indices?.length ?? geometry.vertexCount) / 3).toLocaleString();
  });
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing geometry-subdivision example element: ${selector}`);
  return element;
}

main().catch(error => {
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
});
