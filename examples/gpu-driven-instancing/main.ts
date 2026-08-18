import {
  Camera3D,
  Entity,
  Frustum,
  InstancedMaterial,
  InstancedMesh3D,
  InstancedMesh3DRenderSystem,
  OrbitControl,
  RenderIntegration,
  SphericalTransform3D,
  HaiyueEngine,
  World,
  computeBoundingSphere,
  createBox3D,
  transformBoundingSphere,
} from '@haiyue/engine/experimental';
import { mat4 } from 'wgpu-matrix';
import { requiredItemAt } from '../arrayAccess';

type Mode = 'none' | 'cpu' | 'indirect' | 'gpu';
type InstancePreset = 1000 | 10000 | 100000;

const MAX_INSTANCE_COUNT = 100000;
const BATCH_COUNT = 8;
const MAX_INSTANCES_PER_BATCH = Math.ceil(MAX_INSTANCE_COUNT / BATCH_COUNT);
const INSTANCE_PRESETS: InstancePreset[] = [1000, 10000, 100000];
const SPACING = 2.7;
const CUBE_SIZE = 1.1;

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'none', label: 'No culling' },
  { id: 'cpu', label: 'CPU frustum culling' },
  { id: 'indirect', label: 'CPU frustum + indirect draw' },
  { id: 'gpu', label: 'GPU culling + indirect draw' },
];

interface InstanceSource {
  matrix: Float32Array;
  color: [number, number, number, number];
}

interface InstanceBatch {
  material: InstancedMaterial;
  start: number;
  capacity: number;
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats')!;
  const buttons = new Map<Mode, HTMLButtonElement>([
    ['none', document.getElementById('mode-none') as HTMLButtonElement],
    ['cpu', document.getElementById('mode-cpu') as HTMLButtonElement],
    ['indirect', document.getElementById('mode-indirect') as HTMLButtonElement],
    ['gpu', document.getElementById('mode-gpu') as HTMLButtonElement],
  ]);
  const presetButtons = new Map<InstancePreset, HTMLButtonElement>(
    INSTANCE_PRESETS.map(count => [count, document.getElementById(`count-${count}`) as HTMLButtonElement]),
  );

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.025, g: 0.032, b: 0.045, a: 1 },
  });
  await engine.init();

  const world = new World('GpuDrivenInstancingPrep');
  const cameraTransform = new SphericalTransform3D({
    radius: 96,
    theta: Math.PI * 0.22,
    phi: Math.PI * 0.34,
    target: [0, 0, 0],
  });
  const cameraEntity = new Entity('Camera');
  const camera = new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.5, far: 280 });
  cameraEntity.addComponent(camera);
  cameraEntity.addComponent(cameraTransform);
  world.addEntity(cameraEntity);
  new OrbitControl(canvas, cameraTransform, { minRadius: 20, maxRadius: 210 });

  const geometry = createBox3D({ width: CUBE_SIZE, height: CUBE_SIZE, depth: CUBE_SIZE });
  const batches: InstanceBatch[] = [];
  for (let i = 0; i < BATCH_COUNT; i++) {
    const start = i * MAX_INSTANCES_PER_BATCH;
    const capacity = Math.min(MAX_INSTANCES_PER_BATCH, MAX_INSTANCE_COUNT - start);
    const material = new InstancedMaterial(capacity);
    material.setActiveInstanceCount(0);
    const meshEntity = new Entity(`IndirectInstancedCubes.${i + 1}`);
    meshEntity.addComponent(new InstancedMesh3D(geometry, material));
    world.addEntity(meshEntity);
    batches.push({ material, start, capacity });
  }

  const renderSystem = new InstancedMesh3DRenderSystem(engine, cameraEntity, {
    loadOp: 'clear',
    indirect: false,
    gpuProfiling: true,
    gpuSorting: true,
    batchSort: 'depth-front-to-back',
    instanceSorting: 'depth-back-to-front',
  });
  world.addSystem(renderSystem);
  const renderIntegration = new RenderIntegration(engine, { label: 'GpuDrivenInstancingPrep.render' });
  world.addRuntimeIntegration(renderIntegration);
  renderIntegration.registerAll(world, () => ({ pass: 'shared' }));

  const sources = createInstances(MAX_INSTANCE_COUNT);
  const frustum = new Frustum();
  const viewMatrix = mat4.identity() as Float32Array;
  const viewProjMatrix = mat4.identity() as Float32Array;
  let mode: Mode = 'none';
  let instanceCount: InstancePreset = 10000;
  let visibleCount: number | null = instanceCount;
  let cullMsAvg = 0;
  let frameMsAvg = 0;

  function setMode(next: Mode): void {
    mode = next;
    for (const { id } of MODES) buttons.get(id)!.classList.toggle('active', id === mode);
  }

  function setInstanceCount(next: InstancePreset): void {
    instanceCount = next;
    for (const count of INSTANCE_PRESETS) presetButtons.get(count)!.classList.toggle('active', count === instanceCount);
  }

  for (const { id } of MODES) buttons.get(id)!.addEventListener('click', () => setMode(id));
  for (const count of INSTANCE_PRESETS) presetButtons.get(count)!.addEventListener('click', () => setInstanceCount(count));
  setMode(mode);
  setInstanceCount(instanceCount);

  engine.on('update', ({ detail: { time, delta } }) => {
    const frameStart = performance.now();
    animateSources(sources, instanceCount, time * 0.001);

    const cullStart = performance.now();
    renderSystem.indirect = mode === 'indirect' || mode === 'gpu';
    renderSystem.gpuCulling = mode === 'gpu';
    if (mode === 'none') {
      uploadInstances(batches, sources, instanceCount);
      visibleCount = instanceCount;
    } else if (mode === 'gpu') {
      uploadInstances(batches, sources, instanceCount);
      visibleCount = null;
    } else {
      visibleCount = uploadVisibleInstances(batches, sources, instanceCount, camera, cameraTransform, frustum, viewMatrix, viewProjMatrix);
    }
    cullMsAvg = smooth(cullMsAvg, performance.now() - cullStart);

    world.update(time, delta);
    const gpuProfile = renderSystem.getGpuProfile();
    frameMsAvg = smooth(frameMsAvg, performance.now() - frameStart);
    renderStats(stats, mode, instanceCount, visibleCount, cullMsAvg, frameMsAvg, gpuProfile);
  });

  engine.run();
}

function createInstances(count: number): InstanceSource[] {
  const sources: InstanceSource[] = [];
  const gridX = Math.ceil(Math.sqrt(count));
  const gridZ = Math.ceil(count / gridX);
  const offsetX = ((gridX - 1) * SPACING) / 2;
  const offsetZ = ((gridZ - 1) * SPACING) / 2;
  for (let i = 0; i < count; i++) {
    const x = i % gridX;
    const z = Math.floor(i / gridX);
    const px = x * SPACING - offsetX;
    const pz = z * SPACING - offsetZ;
    const hue = (x / gridX) * 0.72 + (z / gridZ) * 0.28;
    sources.push({
      matrix: mat4.translation([px, 0, pz]) as Float32Array,
      color: [...hsvToRgb(hue % 1, 0.82, 0.95), 1],
    });
  }
  return sources;
}

function animateSources(sources: InstanceSource[], count: number, time: number): void {
  const gridX = Math.ceil(Math.sqrt(count));
  const gridZ = Math.ceil(count / gridX);
  const offsetX = ((gridX - 1) * SPACING) / 2;
  const offsetZ = ((gridZ - 1) * SPACING) / 2;
  for (let i = 0; i < count; i++) {
    const x = i % gridX;
    const z = Math.floor(i / gridX);
    const px = x * SPACING - offsetX;
    const pz = z * SPACING - offsetZ;
    const wave = Math.sin(time * 1.5 + x * 0.15 + z * 0.09) * 1.6;
    mat4.translation([px, wave, pz], requiredItemAt(sources, i, 'instance sources').matrix);
  }
}

function uploadInstances(batches: InstanceBatch[], sources: InstanceSource[], count: number): void {
  for (const batch of batches) {
    const writeCount = Math.max(0, Math.min(batch.capacity, count - batch.start));
    for (let i = 0; i < writeCount; i++) {
      const source = requiredItemAt(sources, batch.start + i, 'instance sources');
      batch.material.transforms.set(source.matrix, i * 16);
      batch.material.colors.set(source.color, i * 4);
    }
    batch.material.transformsDirty = true;
    batch.material.colorsDirty = true;
    batch.material.setActiveInstanceCount(writeCount);
  }
}

function uploadVisibleInstances(
  batches: InstanceBatch[],
  sources: InstanceSource[],
  count: number,
  camera: Camera3D,
  cameraTransform: SphericalTransform3D,
  frustum: Frustum,
  viewMatrix: Float32Array,
  viewProjMatrix: Float32Array,
): number {
  camera.updateAspect(window.innerWidth / Math.max(1, window.innerHeight));
  cameraTransform.updateWorldMatrix();
  mat4.inverse(cameraTransform.worldMatrix, viewMatrix);
  mat4.multiply(camera.projectionMatrix, viewMatrix, viewProjMatrix);
  frustum.setFromViewProjection(viewProjMatrix);

  let write = 0;
  const sphere = { center: [0, 0, 0] as [number, number, number], radius: Math.sqrt(3) * CUBE_SIZE * 0.5 };
  for (const batch of batches) batch.material.setActiveInstanceCount(0);
  for (let i = 0; i < count; i++) {
    const source = requiredItemAt(sources, i, 'instance sources');
    const worldSphere = transformBoundingSphere(sphere, source.matrix);
    if (!frustum.containsSphere(worldSphere)) continue;
    const batchIndex = Math.floor(write / MAX_INSTANCES_PER_BATCH);
    const batch = batches[batchIndex];
    if (!batch) break;
    const localIndex = write - batchIndex * MAX_INSTANCES_PER_BATCH;
    batch.material.transforms.set(source.matrix, localIndex * 16);
    batch.material.colors.set(source.color, localIndex * 4);
    write++;
  }
  for (const batch of batches) {
    const activeCount = Math.max(0, Math.min(batch.capacity, write - batch.start));
    batch.material.transformsDirty = true;
    batch.material.colorsDirty = true;
    batch.material.setActiveInstanceCount(activeCount);
  }
  return write;
}

function renderStats(
  host: HTMLElement,
  mode: Mode,
  instanceCount: number,
  visible: number | null,
  cullMs: number,
  frameMs: number,
  gpuProfile: ReturnType<InstancedMesh3DRenderSystem['getGpuProfile']>,
): void {
  const modeLabel = MODES.find(item => item.id === mode)?.label ?? mode;
  const gpuVisible = mode === 'gpu' && gpuProfile.visibleCount !== null ? gpuProfile.visibleCount : visible;
  host.innerHTML = [
    statRow('Mode', modeLabel),
    statRow('Instances', gpuVisible == null ? `GPU computed / ${instanceCount}` : `${gpuVisible} / ${instanceCount}`),
    statRow('Batches', String(gpuProfile.batchCount)),
    statRow('GPU batch sort', gpuProfile.gpuSortedBatchCount > 1 ? `${gpuProfile.gpuSortedBatchCount} batches` : 'idle'),
    statRow('Cull/upload CPU', `${cullMs.toFixed(2)} ms`),
    statRow('Frame CPU', `${frameMs.toFixed(2)} ms`),
    statRow('Draw path', mode === 'indirect' || mode === 'gpu' ? 'drawIndexedIndirect' : 'drawIndexed'),
    statRow('GPU culling', mode === 'gpu' ? 'enabled' : 'disabled'),
    statRow('Timestamp query', gpuProfile.supported ? (gpuProfile.pending ? 'pending' : 'available') : 'unavailable'),
    statRow('GPU cull', formatGpuMs(gpuProfile.gpuCullMs)),
    statRow('GPU render', formatGpuMs(gpuProfile.gpuRenderMs)),
  ].join('');
}

function statRow(label: string, value: string): string {
  return `<div class="row"><span>${label}</span><strong>${value}</strong></div>`;
}

function smooth(previous: number, next: number): number {
  return previous === 0 ? next : previous * 0.92 + next * 0.08;
}

function formatGpuMs(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(3)} ms`;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
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

main().catch(console.error);
