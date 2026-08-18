import { BasicMaterial, Camera3D, CartesianTransform3D, Entity, HaiyueEngine, Mesh3D, OrbitControl, SphericalTransform3D, createSphere3D } from '@haiyue/engine';
import { BvhLod3D } from '@haiyue/engine/components';
import { BvhLodSystem } from '@haiyue/engine/experimental';

const GRID_SIZE = 19;
const SPACING = 4.2;
const INITIAL_PHI = Math.PI * 0.26;
const MIN_PHI = Math.PI * 0.12;
const MAX_PHI = Math.PI * 0.3;

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const requestedRadius = Number(new URLSearchParams(location.search).get('radius'));
  const initialRadius = Number.isFinite(requestedRadius) && requestedRadius > 0
    ? Math.min(110, Math.max(8, requestedRadius))
    : 42;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.025, g: 0.035, b: 0.06, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  const cameraTransform = new SphericalTransform3D({
    target: [0, 0, 0],
    radius: initialRadius,
    theta: Math.PI * 0.17,
    phi: INITIAL_PHI,
  });
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 3, near: 0.1, far: 240 }))
    .addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'BVH LOD',
    camera,
    render3D: true,
    render2D: false,
    gui: false,
    pipelineLabel: 'BvhLod.render',
  });

  const lodSystem = new BvhLodSystem(camera, { leafSize: 8 });
  scene.addSystem(lodSystem);
  new OrbitControl(canvas, cameraTransform, {
    minRadius: 8,
    maxRadius: 110,
    rotateSpeed: 0.7,
    panSpeed: 0.65,
    // Keep the sample grid readable. At a grazing angle, separate LOD samples
    // can project onto the same pixels and look as if one of them disappeared.
    minPhi: MIN_PHI,
    maxPhi: MAX_PHI,
  });

  const highGeometry = createSphere3D({ radius: 1.1, widthSegments: 28, heightSegments: 18 });
  const mediumGeometry = createSphere3D({ radius: 1.1, widthSegments: 12, heightSegments: 8 });
  const lowGeometry = createSphere3D({ radius: 1.1, widthSegments: 6, heightSegments: 4 });
  const highMaterial = new BasicMaterial({ color: [0.25, 0.94, 0.68, 1] });
  const mediumMaterial = new BasicMaterial({ color: [1, 0.67, 0.2, 1] });
  const lowMaterial = new BasicMaterial({ color: [0.9, 0.27, 0.45, 1] });
  const lodEntities: Entity[] = [];
  const offset = (GRID_SIZE - 1) * SPACING * 0.5;

  for (let z = 0; z < GRID_SIZE; z++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      // A regular, level grid makes every sample position auditable. Together
      // with MAX_PHI, neighbouring samples remain visually separate throughout
      // the overview camera's allowed tilt range.
      const px = x * SPACING - offset;
      const pz = z * SPACING - offset;
      const entity = new Entity(`LOD ${x}:${z}`)
        .addComponent(new CartesianTransform3D({
          position: [px, 0, pz],
          rotation: [0, (x * 0.37 + z * 0.19) % Math.PI, 0],
        }))
        .addComponent(new Mesh3D(lowGeometry, lowMaterial))
        .addComponent(new BvhLod3D({
          bounds: { center: [0, 0, 0], radius: 1.1 },
          hysteresis: 0.12,
          levels: [
            { geometry: highGeometry, material: highMaterial, maxDistance: 18 },
            { geometry: mediumGeometry, material: mediumMaterial, maxDistance: 34 },
            { geometry: lowGeometry, material: lowMaterial, maxDistance: Infinity },
          ],
        }));
      lodEntities.push(entity);
      scene.add(entity);
    }
  }

  let autoOrbit = false;
  document.querySelector<HTMLButtonElement>('#auto-orbit')!.addEventListener('click', event => {
    autoOrbit = !autoOrbit;
    const button = event.currentTarget as HTMLButtonElement;
    button.classList.toggle('active', autoOrbit);
    button.textContent = autoOrbit ? 'Pause camera tour' : 'Start camera tour';
  });

  engine.on('update', ({ detail: { delta } }) => {
    if (autoOrbit) cameraTransform.theta += Math.min(40, delta) * 0.00012;
  });
  let uiFrame = 0;
  engine.on('after-update', () => {
    uiFrame++;
    if (uiFrame <= 3 || uiFrame % 10 === 0) renderStats(lodSystem, lodEntities);
  });

  engine.switchScene(scene);
  engine.run();
  renderStats(lodSystem, lodEntities);
}

function renderStats(system: BvhLodSystem, entities: readonly Entity[]): void {
  const levels = [0, 0, 0];
  for (const entity of entities) {
    const level = system.getActiveLevel(entity);
    if (level >= 0 && level < levels.length) levels[level] = (levels[level] ?? 0) + 1;
  }
  const stats = system.stats;
  setText('objects', stats.objectCount);
  setText('nodes', stats.nodeCount);
  setText('candidates', stats.candidateCount);
  setText('switches', stats.switchCount);
  setText('rebuilds', stats.rebuildCount);
  setText('high-count', levels[0] ?? 0);
  setText('medium-count', levels[1] ?? 0);
  setText('low-count', levels[2] ?? 0);
  document.body.dataset.bvhLodStatus = stats.objectCount === GRID_SIZE * GRID_SIZE && stats.nodeCount > 0 ? 'passed' : 'warming';
}

function setText(id: string, value: string | number): void {
  document.getElementById(id)!.textContent = String(value);
}

main().catch(error => {
  document.body.dataset.bvhLodStatus = 'error';
  console.error(error);
});
