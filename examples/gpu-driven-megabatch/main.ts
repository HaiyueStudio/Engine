import { BasicMaterial, Camera3D, CartesianTransform3D, ColorSRGB, Entity, Mesh3D, OrbitControl, SphericalTransform3D, HaiyueEngine, type RenderProfileName, createBox3D } from '@haiyue/engine';
import { type Render3DSystem } from '@haiyue/engine/systems';
import { getRender3DGpuDrivenBatchBuffer } from '@haiyue/engine/experimental';
import { requiredItemAt } from '../arrayAccess';

type Mode = RenderProfileName;
type EntityPreset = 500 | 2000 | 8000;

const MAX_ENTITY_COUNT = 8000;
const ENTITY_PRESETS: EntityPreset[] = [500, 2000, 8000];
const GRID_SPACING = 2.55;
const CUBE_SIZE = 0.95;

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'simple', label: 'Simple' },
  { id: 'batched', label: 'Batched' },
  { id: 'gpu-driven', label: 'GPU driven' },
  { id: 'diagnostic', label: 'Diagnostic' },
];

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLDivElement;
  const modeButtons = new Map<Mode, HTMLButtonElement>(
    MODES.map(({ id }) => [id, document.getElementById(`mode-${id}`) as HTMLButtonElement]),
  );
  const countButtons = new Map<EntityPreset, HTMLButtonElement>(
    ENTITY_PRESETS.map(count => [count, document.getElementById(`count-${count}`) as HTMLButtonElement]),
  );
  const stressButton = document.getElementById('layout-stress') as HTMLButtonElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.025, g: 0.032, b: 0.045, a: 1 },
    renderProfile: 'diagnostic',
  });
  await engine.init();

  const scene = engine.createScene({
    name: 'GpuDrivenMegaBatch',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.5, far: 320 },
      orbit: {
        radius: 112,
        theta: Math.PI * 0.21,
        phi: Math.PI * 0.33,
        target: [0, 0, 0],
      },
    },
    render3D: {
      loadOp: 'clear',
      renderProfile: 'diagnostic',
    },
    pipelineLabel: 'GpuDrivenMegaBatch.render',
  });
  const cameraTransform = scene.cameraEntity.getComponent(SphericalTransform3D)!;
  new OrbitControl(canvas, cameraTransform, { minRadius: 18, maxRadius: 210 });
  engine.switchScene(scene);

  const render3D = scene.render3DSystem!;
  const geometry = createBox3D({ width: CUBE_SIZE, height: CUBE_SIZE, depth: CUBE_SIZE });
  const materials = createMaterials(8);
  const entities = createEntities(MAX_ENTITY_COUNT, geometry, materials);
  for (const entity of entities) scene.add(entity);

  let mode: Mode = 'gpu-driven';
  let entityCount: EntityPreset = 2000;
  let cullStress = false;
  let frameMsAvg = 0;
  let lastFrameStart = performance.now();

  function setMode(next: Mode): void {
    mode = next;
    render3D.setRenderProfile(next);
    for (const { id } of MODES) modeButtons.get(id)!.classList.toggle('active', id === mode);
  }

  function setEntityCount(next: EntityPreset): void {
    entityCount = next;
    for (let i = 0; i < entities.length; i++) requiredItemAt(entities, i, 'megabatch entities').disabled = i >= entityCount;
    applyEntityLayout(entities, entityCount, cullStress);
    for (const count of ENTITY_PRESETS) countButtons.get(count)!.classList.toggle('active', count === entityCount);
  }

  function setCullStress(next: boolean): void {
    cullStress = next;
    stressButton.textContent = `Cull stress: ${cullStress ? 'on' : 'off'}`;
    stressButton.classList.toggle('active', cullStress);
    applyEntityLayout(entities, entityCount, cullStress);
  }

  for (const { id } of MODES) modeButtons.get(id)!.addEventListener('click', () => setMode(id));
  for (const count of ENTITY_PRESETS) countButtons.get(count)!.addEventListener('click', () => setEntityCount(count));
  stressButton.addEventListener('click', () => setCullStress(!cullStress));
  setMode(mode);
  setEntityCount(entityCount);
  setCullStress(cullStress);

  engine.on('update', ({ detail: { time } }) => {
    const now = performance.now();
    frameMsAvg = smooth(frameMsAvg, now - lastFrameStart);
    lastFrameStart = now;
    animateEntities(entities, entityCount, time * 0.001);
    renderStats(stats, mode, entityCount, frameMsAvg, render3D, engine.device.features.has('indirect-first-instance'));
  });

  engine.run();
}

function createMaterials(count: number): BasicMaterial[] {
  const result: BasicMaterial[] = [];
  for (let i = 0; i < count; i++) {
    const hue = i / Math.max(1, count);
    result.push(new BasicMaterial({ color: new ColorSRGB(...hsvToRgb(hue, 0.76, 0.95), 1) }));
  }
  return result;
}

function createEntities(count: number, geometry: ReturnType<typeof createBox3D>, materials: BasicMaterial[]): Entity[] {
  const entities: Entity[] = [];
  for (let i = 0; i < count; i++) {
    const [x, y, z] = gridPosition(i);
    const transform = new CartesianTransform3D({
      position: [x, y, z],
      rotation: [0, (i % 17) * 0.08, 0],
    });
    const entity = new Entity(`MegaBatchCube.${i}`);
    entity.addComponent(transform);
    entity.addComponent(new Mesh3D(geometry, requiredItemAt(materials, i % materials.length, 'megabatch materials')));
    entities.push(entity);
  }
  return entities;
}

function applyEntityLayout(entities: Entity[], activeCount: number, cullStress: boolean): void {
  const limit = Math.min(activeCount, entities.length);
  for (let i = 0; i < limit; i++) {
    const transform = requiredItemAt(entities, i, 'megabatch entities').getComponent(CartesianTransform3D);
    if (!transform) continue;
    const [x, y, z] = cullStress && i % 10 !== 0
      ? [12000 + i * 2, 0, 12000]
      : cullStress
        ? stressVisiblePosition(i)
        : gridPosition(i);
    transform.setPosition(x, y, z);
  }
}

function gridPosition(index: number): [number, number, number] {
  const gridX = Math.ceil(Math.sqrt(MAX_ENTITY_COUNT));
  const gridZ = Math.ceil(MAX_ENTITY_COUNT / gridX);
  const offsetX = ((gridX - 1) * GRID_SPACING) / 2;
  const offsetZ = ((gridZ - 1) * GRID_SPACING) / 2;
  const x = index % gridX;
  const z = Math.floor(index / gridX);
  return [x * GRID_SPACING - offsetX, 0, z * GRID_SPACING - offsetZ];
}

function stressVisiblePosition(index: number): [number, number, number] {
  const visibleIndex = Math.floor(index / 10);
  const gridX = 20;
  const x = visibleIndex % gridX;
  const z = Math.floor(visibleIndex / gridX);
  return [(x - (gridX - 1) / 2) * GRID_SPACING, 0, (z - 4.5) * GRID_SPACING];
}

function animateEntities(entities: Entity[], count: number, time: number): void {
  const limit = Math.min(count, entities.length);
  for (let i = 0; i < limit; i++) {
    const transform = requiredItemAt(entities, i, 'megabatch entities').getComponent(CartesianTransform3D);
    if (!transform) continue;
    transform.setRotation(0, time * 0.45 + (i % 31) * 0.04, 0);
  }
}

function renderStats(
  host: HTMLElement,
  mode: Mode,
  entityCount: number,
  frameMs: number,
  render3D: Render3DSystem,
  supportsIndirectFirstInstance: boolean,
): void {
  const modeLabel = MODES.find(item => item.id === mode)?.label ?? mode;
  const settings = render3D.renderSettings;
  const effectiveIndirect = settings.gpuDrivenIndirectDraws && supportsIndirectFirstInstance;
  const batchBuffer = getRender3DGpuDrivenBatchBuffer(render3D);
  host.innerHTML = [
    statRow('Mode', modeLabel),
    statRow('Entities', String(entityCount)),
    statRow('CPU collected', String(render3D.lastVisibleCount)),
    statRow('Frame CPU', `${frameMs.toFixed(2)} ms`),
    statRow('Batch commands', String(render3D.lastGpuDrivenBatchCount)),
    statRow('GPU visible', settings.gpuDrivenCulling && effectiveIndirect ? String(batchBuffer?.lastIndexedInstanceCountSum ?? 'pending') : 'n/a'),
    statRow('Material slots', String(render3D.lastGpuDrivenMaterialCount)),
    statRow('Instance table', String(batchBuffer?.instanceTableCount ?? 0)),
    statRow('Material table', String(batchBuffer?.materialTableCount ?? 0)),
    statRow('Mega-batch runs', String(batchBuffer?.megaBatchRunCount ?? 0)),
    statRow('Batch tables', settings.gpuDrivenBatches ? 'enabled' : 'disabled'),
    statRow('Draw command compute', settings.gpuDrivenDrawCommands ? 'enabled' : 'disabled'),
    statRow('Indirect feature', supportsIndirectFirstInstance ? 'enabled' : 'unsupported'),
    statRow('Draw path', effectiveIndirect ? 'drawIndexedIndirect' : 'drawIndexed'),
    statRow('GPU culling', settings.gpuDrivenCulling && effectiveIndirect ? 'enabled' : 'disabled'),
    statRow('Mega sort', settings.megaBatchSort ? 'enabled' : 'disabled'),
  ].join('');
}

function statRow(label: string, value: string): string {
  return `<div class="row"><span>${label}</span><strong>${value}</strong></div>`;
}

function smooth(previous: number, next: number): number {
  return previous === 0 ? next : previous * 0.92 + next * 0.08;
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

main().catch(error => {
  console.error(error);
  const stats = document.getElementById('stats');
  if (stats) stats.textContent = error instanceof Error ? error.message : String(error);
});
