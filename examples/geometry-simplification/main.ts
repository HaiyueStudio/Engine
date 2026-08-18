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
} from '@haiyue/engine';
import { Line3D } from '@haiyue/engine/components';
import { LineGeometry, createIcosahedron3D, simplifyGeometryTriangles } from '@haiyue/engine/geometry';
import { LineMaterial } from '@haiyue/engine/material';
import { Line3DRenderSystem } from '@haiyue/engine/systems';

const TARGETS = [1, 0.5, 0.15] as const;
const COLORS = [
  [0.24, 0.52, 0.95, 1],
  [0.22, 0.82, 0.59, 1],
  [0.96, 0.44, 0.18, 1],
] as const;

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'gpu-driven',
    msaaSamples: 4,
    clearColor: { r: 0.009, g: 0.016, b: 0.034, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');
  const scene = engine.createScene({
    name: 'QEM geometry simplification',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
      orbit: { radius: 13.8, theta: Math.PI * 0.14, phi: Math.PI * 0.22, target: [0, 0, 0] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 7,
    maxRadius: 24,
  });
  scene.addSystem(new Line3DRenderSystem(engine, scene.cameraEntity, {
    msaaSamples: 4,
    loadOp: 'load',
  }));

  const source = createAsteroidGeometry();
  const geometries: Geometry3D[] = [];
  const simplifyTimes: number[] = [];
  for (let index = 0; index < TARGETS.length; index++) {
    const startedAt = performance.now();
    const geometry = simplifyGeometryTriangles(source, { targetRatio: TARGETS[index]! });
    simplifyTimes.push(performance.now() - startedAt);
    geometries.push(geometry);
    addComparisonMesh(scene, geometry, COLORS[index]!, [(index - 1) * 4.25, 0, 0], index);
  }

  const sun = new Entity('Simplification key light');
  sun.addComponent(new DirectionalLight({
    direction: [-0.7, -1, -0.4],
    color: [1, 0.92, 0.8],
    intensity: 3.15,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 16, far: 35, bias: 0.0012 },
  }));
  scene.add(sun);
  const environment = new Entity('Simplification environment');
  environment.addComponent(new EnvironmentLight({
    intensity: 0.78,
    diffuseColor: [0.13, 0.24, 0.46],
    specularColor: [0.65, 0.84, 1],
  }));
  scene.add(environment);

  publishStats(geometries, simplifyTimes);
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
    const triangleCounts = geometries.map(triangleCount);
    const expected = TARGETS.map(ratio => Math.floor(1280 * ratio));
    if (triangleCounts.some((count, index) => count !== expected[index])) {
      validationErrors.push(`Unexpected triangle counts: ${triangleCounts.join(', ')}.`);
    }
    if (source.vertexCount !== 642 || triangleCount(source) !== 1280) {
      validationErrors.push('Source asteroid was mutated by simplification.');
    }

    document.body.dataset.renderStatus = validationErrors.length === 0 ? 'passed' : 'failed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.simplificationRatios = TARGETS.join(',');
    document.body.dataset.simplificationTriangles = triangleCounts.join(',');
    document.body.dataset.simplificationVertices = geometries.map(geometry => geometry.vertexCount).join(',');
    query<HTMLElement>('#result').textContent = JSON.stringify({
      status: document.body.dataset.renderStatus,
      errors: validationErrors,
      ratios: TARGETS,
      triangles: triangleCounts,
      vertices: geometries.map(geometry => geometry.vertexCount),
      simplifyMs: simplifyTimes,
      sourceTriangles: triangleCount(source),
      sourceVertices: source.vertexCount,
    });
  }
}

function createAsteroidGeometry(): Geometry3D {
  const geometry = createIcosahedron3D({ radius: 1.58, detail: 3 });
  for (let vertex = 0; vertex < geometry.vertexCount; vertex++) {
    const offset = vertex * 3;
    const x = geometry.positions[offset]!;
    const y = geometry.positions[offset + 1]!;
    const z = geometry.positions[offset + 2]!;
    const length = Math.hypot(x, y, z) || 1;
    const nx = x / length;
    const ny = y / length;
    const nz = z / length;
    const noise = 1
      + Math.sin(nx * 8.3 + ny * 3.1) * 0.065
      + Math.cos(nz * 10.7 - nx * 2.4) * 0.045
      + Math.sin((nx + ny + nz) * 13.2) * 0.025;
    geometry.positions[offset] = nx * length * noise;
    geometry.positions[offset + 1] = ny * length * noise;
    geometry.positions[offset + 2] = nz * length * noise;
  }
  geometry.normals = calculateSmoothNormals(geometry);
  geometry.markDirty();
  return geometry;
}

function addComparisonMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  geometry: Geometry3D,
  baseColor: readonly [number, number, number, number],
  position: [number, number, number],
  index: number,
): void {
  const surface = new Entity(`Simplification surface ${index}`);
  surface.addComponent(new CartesianTransform3D({ position }));
  surface.addComponent(new Mesh3D(geometry, new PbrMaterial({
    baseColor,
    metallic: 0.3,
    roughness: 0.34,
  })));
  scene.add(surface);

  const wireframe = new Entity(`Simplification wireframe ${index}`);
  wireframe.addComponent(new CartesianTransform3D({ position }));
  wireframe.addComponent(new Line3D(
    new LineGeometry(createWireframePoints(geometry), { topology: 'segments' }),
    new LineMaterial({ color: [0.82, 0.93, 1, 1], width: 0.72, screenSpace: true, cap: 'butt' }),
  ));
  scene.add(wireframe);
}

function createWireframePoints(geometry: Geometry3D): Float32Array {
  const indices = geometry.indices!;
  const edges = new Set<string>();
  const points: number[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!];
    const triangleEdges: ReadonlyArray<readonly [number, number]> = [
      [triangle[0]!, triangle[1]!],
      [triangle[1]!, triangle[2]!],
      [triangle[2]!, triangle[0]!],
    ];
    for (const [first, second] of triangleEdges) {
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      const key = `${low}:${high}`;
      if (edges.has(key)) continue;
      edges.add(key);
      appendOffsetPosition(points, geometry, first);
      appendOffsetPosition(points, geometry, second);
    }
  }
  return new Float32Array(points);
}

function appendOffsetPosition(output: number[], geometry: Geometry3D, vertex: number): void {
  const offset = vertex * 3;
  const normalOffset = 0.008;
  output.push(
    geometry.positions[offset]! + (geometry.normals?.[offset] ?? 0) * normalOffset,
    geometry.positions[offset + 1]! + (geometry.normals?.[offset + 1] ?? 0) * normalOffset,
    geometry.positions[offset + 2]! + (geometry.normals?.[offset + 2] ?? 0) * normalOffset,
  );
}

function calculateSmoothNormals(geometry: Geometry3D): Float32Array {
  const normals = new Float32Array(geometry.positions.length);
  const indices = geometry.indices!;
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

function publishStats(geometries: readonly Geometry3D[], times: readonly number[]): void {
  geometries.forEach((geometry, index) => {
    query<HTMLElement>(`#vertices-${index}`).textContent = geometry.vertexCount.toLocaleString();
    query<HTMLElement>(`#triangles-${index}`).textContent = triangleCount(geometry).toLocaleString();
    query<HTMLElement>(`#time-${index}`).textContent = `${times[index]!.toFixed(1)} ms`;
  });
}

function triangleCount(geometry: Geometry3D): number {
  return (geometry.indices?.length ?? geometry.vertexCount) / 3;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing geometry-simplification example element: ${selector}`);
  return element;
}

main().catch(error => {
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
});
