import {
  Camera3D,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  Geometry3D,
  HaiyueEngine,
  Mesh3D,
  PbrMaterial,
  System,
  type World,
  createSphere3D,
} from '@haiyue/engine';
import { FirstPersonControls } from '@haiyue/engine/controls';
import { createTorus3D } from '@haiyue/engine/geometry';
import { NavMesh } from '@haiyue/engine/navigation';
import { runFirstPersonBrowserRegression } from './browserRegression';

const CELL_SIZE = 0.5;
const COLUMNS = 28;
const ROWS = 22;
const ORIGIN_X = -COLUMNS * CELL_SIZE * 0.5;
const ORIGIN_Z = -ROWS * CELL_SIZE * 0.5;
const PLAYER_RADIUS = 0.38;
const EYE_OFFSET = 0.58;
const SPAWN: readonly [number, number, number] = [0, PLAYER_RADIUS + EYE_OFFSET, 4.25];

async function main(): Promise<void> {
  const engine = new HaiyueEngine({
    canvas: '#canvas',
    clearColor: { r: 0.012, g: 0.022, b: 0.034, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();
  const canvas = engine.canvas!;
  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const grid = createNavigationGrid();
  const navMesh = new NavMesh({
    origin: [ORIGIN_X, ORIGIN_Z],
    cellSize: CELL_SIZE,
    columns: COLUMNS,
    rows: ROWS,
    heights: grid.heights,
    walkable: grid.walkable,
    maxStepHeight: 0.12,
  });

  const playerTransform = new CartesianTransform3D({
    position: [SPAWN[0], SPAWN[1] - EYE_OFFSET, SPAWN[2]],
  });
  const player = new Entity('First-person ball')
    .addComponent(playerTransform)
    .addComponent(new Mesh3D(
      createSphere3D({ radius: PLAYER_RADIUS, widthSegments: 32, heightSegments: 20 }),
      new PbrMaterial({
        baseColor: [0.08, 0.78, 1, 1],
        metallic: 0.68,
        roughness: 0.2,
        emissiveFactor: [0.01, 0.12, 0.2],
      }),
    ));
  const cameraTransform = new CartesianTransform3D({ position: [...SPAWN] });
  const camera = new Entity('First-person camera')
    .addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 2.7, near: 0.05, far: 80 }))
    .addComponent(cameraTransform);

  const scene = engine.createScene({
    name: 'NavMesh holes + first-person controls',
    camera,
    render3D: { renderProfile: 'simple', loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'NavMeshFirstPerson.render',
  });
  scene.add(player);
  scene.add(new Entity('Navigation terrain')
    .addComponent(new CartesianTransform3D())
    .addComponent(new Mesh3D(
      createTerrainGeometry(grid.heights, grid.walkable),
      new PbrMaterial({
        baseColor: [0.12, 0.34, 0.27, 1],
        metallic: 0.04,
        roughness: 0.82,
      }),
    )));
  scene.add(new Entity('Hole warning rim')
    .addComponent(new CartesianTransform3D({ position: [0, 0.075, 0] }))
    .addComponent(new Mesh3D(
      createTorus3D({ radius: 1.32, tube: 0.055, radialSegments: 12, tubularSegments: 64 }),
      new PbrMaterial({
        baseColor: [1, 0.16, 0.07, 1],
        metallic: 0.2,
        roughness: 0.3,
        emissiveFactor: [2.2, 0.12, 0.025],
      }),
    )));
  addStepMarkers(scene);
  scene.add(new Entity('Sun').addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.3],
    color: [1, 0.92, 0.78],
    intensity: 3.6,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 17, far: 35, bias: 0.0012 },
  })));
  scene.add(new Entity('Environment').addComponent(new EnvironmentLight({
    intensity: 0.74,
    diffuseColor: [0.08, 0.18, 0.24],
    specularColor: [0.42, 0.68, 0.82],
  })));

  const surfaceSample = new Float32Array(3);
  const controls = new FirstPersonControls(canvas, cameraTransform, {
    moveSpeed: 4.2,
    sprintMultiplier: 1.65,
    lookSensitivity: 0.0018,
    jumpSpeed: 5.5,
    gravity: 16,
    groundOffset: PLAYER_RADIUS + EYE_OFFSET,
    maxStepHeight: 0.12,
    groundProbe: position => navMesh.sampleSurface(position, { radius: 0 }, surfaceSample)?.[1] ?? null,
  });
  scene.addSystem(controls, false);
  scene.addSystem(new PlayerVisualFollowSystem(cameraTransform, playerTransform), false);

  const ui = createUi();
  document.addEventListener('pointerlockchange', () => {
    const locked = controls.pointerLocked;
    ui.start.classList.toggle('hidden', locked);
    ui.lock.textContent = locked ? 'LOCKED' : 'CLICK TO LOCK';
  });
  ui.start.addEventListener('click', event => {
    event.stopPropagation();
    controls.requestPointerLock();
  });

  engine.switchScene(scene);
  const regression = new URLSearchParams(globalThis.location.search).get('regression') === '1'
    ? runFirstPersonBrowserRegression(canvas, controls, cameraTransform, {
      spawn: SPAWN,
      playerRadius: PLAYER_RADIUS,
      eyeOffset: EYE_OFFSET,
    })
    : null;
  engine.on('after-update', () => {
    const position = cameraTransform.position;
    if (position[1]! < -5) {
      controls.teleport(SPAWN, true);
      ui.message.textContent = '球已穿过洞口；为继续体验，已在起点重生。';
      ui.falls.textContent = String(Number(ui.falls.textContent) + 1);
    } else if (!controls.grounded) {
      ui.message.textContent = controls.velocity[1]! > 0
        ? '跳跃中：达到台阶顶面高度后即可向前越过立面。'
        : '脚下没有 NavMesh 支撑：球正在穿过洞口下落。';
    } else if (isOnStair(position[0]!, position[2]!)) {
      ui.message.textContent = '台阶高于自动跨步阈值；使用空格逐级跳上去。';
    } else {
      ui.message.textContent = 'WASD 移动，鼠标观察；正前方红色圆环内是真实 NavMesh 洞。';
    }
    ui.grounded.textContent = controls.grounded ? 'YES' : 'NO';
    ui.height.textContent = (position[1]! - EYE_OFFSET).toFixed(2);
    document.body.dataset.playerGrounded = String(controls.grounded);
  });
  document.body.dataset.navmeshStatus = 'ready';
  document.body.dataset.navmeshFeatures = 'surface-hole,local-surface-sample,first-person-controls,jump,low-steps';

  let validationFrames = 0;
  let validationFinished = false;
  engine.on('after-update', () => {
    if (validationFinished || ++validationFrames < 8) return;
    validationFinished = true;
    void finishValidation();
  });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (regression) {
      for (const [name, passed] of Object.entries(regression)) {
        if (name !== 'finalPosition' && passed !== true) validationErrors.push(`Browser regression failed: ${name}.`);
      }
    }
    const result = requiredElement('result', HTMLElement);
    result.dataset.status = validationErrors.length === 0 ? 'passed' : 'failed';
    result.textContent = JSON.stringify({
      schemaVersion: 1,
      suite: 'navmesh-first-person-example',
      status: result.dataset.status,
      errors: validationErrors,
      validationErrorCount: validationErrors.length,
      features: document.body.dataset.navmeshFeatures?.split(',') ?? [],
      regression,
    });
  }
  engine.run();
}

class PlayerVisualFollowSystem extends System {
  constructor(
    private readonly _camera: CartesianTransform3D,
    private readonly _player: CartesianTransform3D,
  ) {
    super(() => false);
    this.name = 'PlayerVisualFollowSystem';
    this.priority = -90;
  }

  override update(_world: World, _time: number, _delta: number): this {
    const position = this._camera.position;
    this._player.setPosition(position[0]!, position[1]! - EYE_OFFSET, position[2]!);
    this._player.setRotation(0, this._camera.rotation[1]!, 0);
    return this;
  }
}

function createNavigationGrid(): { heights: Float32Array; walkable: Uint8Array } {
  const heights = new Float32Array(COLUMNS * ROWS);
  const walkable = new Uint8Array(COLUMNS * ROWS);
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const x = ORIGIN_X + (column + 0.5) * CELL_SIZE;
      const z = ORIGIN_Z + (row + 0.5) * CELL_SIZE;
      const index = row * COLUMNS + column;
      if (isHole(x, z)) {
        heights[index] = Number.NaN;
        continue;
      }
      heights[index] = stairHeight(x, z);
      walkable[index] = 1;
    }
  }
  return { heights, walkable };
}

function isHole(x: number, z: number): boolean {
  return (x / 1.32) ** 2 + (z / 1.08) ** 2 < 1;
}

function isOnStair(x: number, z: number): boolean {
  return x >= 2.5 && x <= 5.75 && z >= -3.8 && z <= 3.7;
}

function stairHeight(x: number, z: number): number {
  if (!isOnStair(x, z)) return 0;
  const stage = Math.max(0, Math.min(5, Math.floor((3.7 - z) / 1.25)));
  return stage * 0.28;
}

function createTerrainGeometry(heights: Float32Array, walkable: Uint8Array): Geometry3D {
  const positions: number[] = [];
  const normals: number[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const index = row * COLUMNS + column;
      if (walkable[index] === 0) continue;
      const height = heights[index]!;
      const x0 = ORIGIN_X + column * CELL_SIZE;
      const x1 = x0 + CELL_SIZE;
      const z0 = ORIGIN_Z + row * CELL_SIZE;
      const z1 = z0 + CELL_SIZE;
      appendQuad(positions, normals,
        [x0, height, z1], [x1, height, z1], [x1, height, z0], [x0, height, z0]);

      appendExposedSide(positions, normals, heights, walkable, column, row, column - 1, row,
        [x0, height, z0], [x0, height, z1]);
      appendExposedSide(positions, normals, heights, walkable, column, row, column + 1, row,
        [x1, height, z1], [x1, height, z0]);
      appendExposedSide(positions, normals, heights, walkable, column, row, column, row - 1,
        [x1, height, z0], [x0, height, z0]);
      appendExposedSide(positions, normals, heights, walkable, column, row, column, row + 1,
        [x0, height, z1], [x1, height, z1]);
    }
  }
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    cullMode: 'none',
  });
}

function appendExposedSide(
  positions: number[],
  normals: number[],
  heights: Float32Array,
  walkable: Uint8Array,
  column: number,
  row: number,
  neighbourColumn: number,
  neighbourRow: number,
  topA: readonly [number, number, number],
  topB: readonly [number, number, number],
): void {
  const currentHeight = heights[row * COLUMNS + column]!;
  const inside = neighbourColumn >= 0 && neighbourColumn < COLUMNS && neighbourRow >= 0 && neighbourRow < ROWS;
  const neighbourIndex = inside ? neighbourRow * COLUMNS + neighbourColumn : -1;
  const neighbourWalkable = neighbourIndex >= 0 && walkable[neighbourIndex] !== 0;
  const bottomHeight = neighbourWalkable ? heights[neighbourIndex]! : inside ? -3.5 : -0.8;
  if (bottomHeight >= currentHeight - 1e-5) return;
  appendQuad(positions, normals,
    topA,
    topB,
    [topB[0], bottomHeight, topB[2]],
    [topA[0], bottomHeight, topA[2]]);
}

function appendQuad(
  positions: number[],
  normals: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
): void {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz) || 1;
  const normal: readonly [number, number, number] = [nx / length, ny / length, nz / length];
  for (const point of [a, b, c, a, c, d]) {
    positions.push(point[0], point[1], point[2]);
    normals.push(normal[0], normal[1], normal[2]);
  }
}

function addStepMarkers(scene: ReturnType<HaiyueEngine['createScene']>): void {
  for (let stage = 1; stage <= 5; stage++) {
    const z = 3.7 - stage * 1.25 + 0.625;
    const y = stage * 0.28 + 0.055;
    scene.add(new Entity(`Step marker ${stage}`)
      .addComponent(new CartesianTransform3D({ position: [4.15, y, z] }))
      .addComponent(new Mesh3D(
        createTorus3D({ radius: 0.2, tube: 0.035, radialSegments: 8, tubularSegments: 24 }),
        new PbrMaterial({
          baseColor: [1, 0.78, 0.1, 1],
          metallic: 0.25,
          roughness: 0.3,
          emissiveFactor: [0.75, 0.3, 0.01],
        }),
      )));
  }
}

function createUi(): {
  start: HTMLButtonElement;
  lock: HTMLElement;
  grounded: HTMLElement;
  height: HTMLElement;
  falls: HTMLElement;
  message: HTMLElement;
} {
  return {
    start: requiredElement('start', HTMLButtonElement),
    lock: requiredElement('lock', HTMLElement),
    grounded: requiredElement('grounded', HTMLElement),
    height: requiredElement('height', HTMLElement),
    falls: requiredElement('falls', HTMLElement),
    message: requiredElement('message', HTMLElement),
  };
}

function requiredElement<T extends HTMLElement>(id: string, Constructor: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof Constructor)) throw new Error(`Missing #${id}.`);
  return element;
}

main().catch(error => {
  console.error(error);
  document.body.dataset.navmeshStatus = 'error';
  const message = document.getElementById('message');
  if (message) message.textContent = error instanceof Error ? error.message : String(error);
  const result = document.getElementById('result');
  if (result) {
    result.dataset.status = 'failed';
    result.textContent = JSON.stringify({
      schemaVersion: 1,
      suite: 'navmesh-first-person-example',
      status: 'failed',
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
});
