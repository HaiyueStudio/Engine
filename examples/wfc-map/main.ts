import { AmbientLight } from '@haiyue/engine/lighting';
import { BlinnPhongMaterial } from '@haiyue/engine/material';
import { BlinnPhongRenderSystem, Render3DSystem } from '@haiyue/engine/systems';
import { Camera3D, CartesianTransform3D, DirectionalLight, Entity, Mesh3D, OrbitControl, Scene, SphericalTransform3D, HaiyueEngine, World, createBox3D, createPlane3D, createSphere3D } from '@haiyue/engine';

type Direction = 0 | 1 | 2 | 3;
type Connector = 'road' | 'lot';
type Color = [number, number, number, number];
type TileKind = 'road' | 'building' | 'park' | 'plaza';

interface TileDef {
  id: string;
  kind: TileKind;
  connectors: [Connector, Connector, Connector, Connector];
  roadDirs: Direction[];
  weight: number;
  color: Color;
}

interface Cell {
  options: number[];
}

interface CollapseHistory {
  snapshot: number[][][];
  x: number;
  y: number;
  choice: number;
}

interface WfcResult {
  tiles: TileDef[];
  grid: number[][];
  seed: number;
  backtracks: number;
  restarts: number;
}

const GRID_W = 17;
const GRID_H = 17;
const TILE_SIZE = 34;
const TILE_HEIGHT = 2.4;
const ROAD_WIDTH = 12;
const MAX_BACKTRACKS = 1200;
const OPPOSITE: Direction[] = [2, 3, 0, 1];
const OFFSETS: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];

const TILES: TileDef[] = [
  { id: 'building-low', kind: 'building', connectors: ['lot', 'lot', 'lot', 'lot'], roadDirs: [], weight: 5.5, color: [0.58, 0.63, 0.66, 1] },
  { id: 'building-tower', kind: 'building', connectors: ['lot', 'lot', 'lot', 'lot'], roadDirs: [], weight: 2.4, color: [0.46, 0.53, 0.60, 1] },
  { id: 'park', kind: 'park', connectors: ['lot', 'lot', 'lot', 'lot'], roadDirs: [], weight: 2.2, color: [0.22, 0.54, 0.30, 1] },
  { id: 'plaza', kind: 'plaza', connectors: ['lot', 'lot', 'lot', 'lot'], roadDirs: [], weight: 1.0, color: [0.64, 0.61, 0.54, 1] },
  { id: 'road-ns', kind: 'road', connectors: ['road', 'lot', 'road', 'lot'], roadDirs: [0, 2], weight: 1.35, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-ew', kind: 'road', connectors: ['lot', 'road', 'lot', 'road'], roadDirs: [1, 3], weight: 1.35, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-ne', kind: 'road', connectors: ['road', 'road', 'lot', 'lot'], roadDirs: [0, 1], weight: 1.0, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-es', kind: 'road', connectors: ['lot', 'road', 'road', 'lot'], roadDirs: [1, 2], weight: 1.0, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-sw', kind: 'road', connectors: ['lot', 'lot', 'road', 'road'], roadDirs: [2, 3], weight: 1.0, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-wn', kind: 'road', connectors: ['road', 'lot', 'lot', 'road'], roadDirs: [3, 0], weight: 1.0, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-t-nes', kind: 'road', connectors: ['road', 'road', 'road', 'lot'], roadDirs: [0, 1, 2], weight: 0.76, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-t-esw', kind: 'road', connectors: ['lot', 'road', 'road', 'road'], roadDirs: [1, 2, 3], weight: 0.76, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-t-swn', kind: 'road', connectors: ['road', 'lot', 'road', 'road'], roadDirs: [2, 3, 0], weight: 0.76, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-t-wne', kind: 'road', connectors: ['road', 'road', 'lot', 'road'], roadDirs: [3, 0, 1], weight: 0.76, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-cross', kind: 'road', connectors: ['road', 'road', 'road', 'road'], roadDirs: [0, 1, 2, 3], weight: 0.42, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-end-n', kind: 'road', connectors: ['road', 'lot', 'lot', 'lot'], roadDirs: [0], weight: 0.58, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-end-e', kind: 'road', connectors: ['lot', 'road', 'lot', 'lot'], roadDirs: [1], weight: 0.58, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-end-s', kind: 'road', connectors: ['lot', 'lot', 'road', 'lot'], roadDirs: [2], weight: 0.58, color: [0.16, 0.17, 0.18, 1] },
  { id: 'road-end-w', kind: 'road', connectors: ['lot', 'lot', 'lot', 'road'], roadDirs: [3], weight: 0.58, color: [0.16, 0.17, 0.18, 1] },
];

function requiredAt<T>(values: ArrayLike<T>, index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`${label} is missing index ${index}.`);
  return value;
}

function getCell(grid: Cell[][], x: number, y: number): Cell {
  return requiredAt(requiredAt(grid, y, 'WFC grid rows'), x, 'WFC grid cells');
}

function getTile(index: number): TileDef {
  return requiredAt(TILES, index, 'WFC tiles');
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash01(seed: number, x: number, y: number, salt = 0): number {
  return mulberry32((seed ^ Math.imul(x + 101, 374761393) ^ Math.imul(y + 607, 668265263) ^ salt) >>> 0)();
}

class WfcMapGenerator {
  private readonly allOptions = TILES.map((_tile, index) => index);

  generate(seed: number): WfcResult {
    let currentSeed = seed;
    let totalBacktracks = 0;
    for (let restart = 0; restart < 8; restart++) {
      const rng = mulberry32(currentSeed);
      const grid = this.createGrid();
      this.applyBoundaryConstraints(grid);
      this.seedCenterRoad(grid);
      if (!this.propagate(grid, this.allPositions())) {
        currentSeed++;
        continue;
      }

      const history: CollapseHistory[] = [];
      let backtracks = 0;
      while (!this.isComplete(grid)) {
        const selected = this.findLowestEntropyCell(grid, rng);
        if (!selected) break;
        const snapshot = this.snapshot(grid);
        const selectedCell = getCell(grid, selected.x, selected.y);
        const choice = this.weightedChoice(selectedCell.options, rng);
        history.push({ snapshot, x: selected.x, y: selected.y, choice });
        selectedCell.options = [choice];

        if (this.propagate(grid, [[selected.x, selected.y]])) continue;

        backtracks++;
        while (!this.recover(grid, history)) {
          backtracks++;
          if (!history.length || backtracks > MAX_BACKTRACKS) break;
        }
        if (!history.length || backtracks > MAX_BACKTRACKS) break;
      }

      totalBacktracks += backtracks;
      if (this.isComplete(grid)) {
        return {
          tiles: TILES,
          grid: grid.map(row => row.map(cell => requiredAt(cell.options, 0, 'collapsed WFC cell'))),
          seed: currentSeed,
          backtracks: totalBacktracks,
          restarts: restart,
        };
      }
      currentSeed++;
    }
    throw new Error('Wave Function Collapse failed after repeated restarts.');
  }

  private createGrid(): Cell[][] {
    return Array.from({ length: GRID_H }, () =>
      Array.from({ length: GRID_W }, () => ({ options: [...this.allOptions] })),
    );
  }

  private applyBoundaryConstraints(grid: Cell[][]): void {
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const cell = getCell(grid, x, y);
        cell.options = cell.options.filter(index => {
          const tile = getTile(index);
          return !(
            (y === 0 && tile.connectors[0] === 'road') ||
            (x === GRID_W - 1 && tile.connectors[1] === 'road') ||
            (y === GRID_H - 1 && tile.connectors[2] === 'road') ||
            (x === 0 && tile.connectors[3] === 'road')
          );
        });
      }
    }
  }

  private seedCenterRoad(grid: Cell[][]): void {
    const cross = TILES.findIndex(tile => tile.id === 'road-cross');
    getCell(grid, Math.floor(GRID_W / 2), Math.floor(GRID_H / 2)).options = [cross];
  }

  private allPositions(): Array<[number, number]> {
    const positions: Array<[number, number]> = [];
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) positions.push([x, y]);
    }
    return positions;
  }

  private propagate(grid: Cell[][], starts: Array<[number, number]>): boolean {
    const queue = [...starts];
    const queued = new Set(starts.map(([x, y]) => `${x},${y}`));
    while (queue.length) {
      const position = queue.shift();
      if (!position) continue;
      const [x, y] = position;
      queued.delete(`${x},${y}`);
      const options = getCell(grid, x, y).options;
      if (!options.length) return false;

      for (let dir = 0; dir < 4; dir++) {
        const [dx, dy] = requiredAt(OFFSETS, dir, 'WFC neighbor offsets');
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;

        const neighbor = getCell(grid, nx, ny);
        const filtered = neighbor.options.filter(candidate =>
          options.some(option => this.compatible(option, candidate, dir as Direction)),
        );
        if (!filtered.length) return false;
        if (filtered.length === neighbor.options.length) continue;

        neighbor.options = filtered;
        const key = `${nx},${ny}`;
        if (!queued.has(key)) {
          queue.push([nx, ny]);
          queued.add(key);
        }
      }
    }
    return true;
  }

  private compatible(a: number, b: number, dir: Direction): boolean {
    const opposite = requiredAt(OPPOSITE, dir, 'opposite WFC directions');
    return getTile(a).connectors[dir] === getTile(b).connectors[opposite];
  }

  private isComplete(grid: Cell[][]): boolean {
    return grid.every(row => row.every(cell => cell.options.length === 1));
  }

  private findLowestEntropyCell(grid: Cell[][], rng: () => number): { x: number; y: number } | null {
    let best: { x: number; y: number; entropy: number } | null = null;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const options = getCell(grid, x, y).options;
        if (options.length <= 1) continue;
        const entropy = this.entropy(options) + rng() * 0.0001;
        if (!best || entropy < best.entropy) best = { x, y, entropy };
      }
    }
    return best;
  }

  private entropy(options: number[]): number {
    let sum = 0;
    let weightedLog = 0;
    for (const option of options) {
      const weight = getTile(option).weight;
      sum += weight;
      weightedLog += weight * Math.log(weight);
    }
    return Math.log(sum) - weightedLog / sum;
  }

  private weightedChoice(options: number[], rng: () => number): number {
    const total = options.reduce((sum, option) => sum + getTile(option).weight, 0);
    let cursor = rng() * total;
    for (const option of options) {
      cursor -= getTile(option).weight;
      if (cursor <= 0) return option;
    }
    return requiredAt(options, options.length - 1, 'weighted WFC choices');
  }

  private snapshot(grid: Cell[][]): number[][][] {
    return grid.map(row => row.map(cell => [...cell.options]));
  }

  private restore(grid: Cell[][], snapshot: number[][][]): void {
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        getCell(grid, x, y).options = [...requiredAt(requiredAt(snapshot, y, 'WFC snapshot rows'), x, 'WFC snapshot cells')];
      }
    }
  }

  private recover(grid: Cell[][], history: CollapseHistory[]): boolean {
    while (history.length) {
      const item = history.pop();
      if (!item) continue;
      this.restore(grid, item.snapshot);
      const cell = getCell(grid, item.x, item.y);
      cell.options = cell.options.filter(option => option !== item.choice);
      if (!cell.options.length) continue;
      if (this.propagate(grid, [[item.x, item.y]])) return true;
    }
    return false;
  }
}

class WfcMapGame {
  private engine!: HaiyueEngine;
  private scene!: Scene;
  private world!: World;
  private cameraEntity!: Entity;
  private generated: Entity[] = [];
  private materials = new Map<string, BlinnPhongMaterial>();
  private generator = new WfcMapGenerator();
  private seed = Math.floor(Math.random() * 100000);

  private readonly seedText = document.getElementById('seed')!;
  private readonly backtracksText = document.getElementById('backtracks')!;
  private readonly statusText = document.getElementById('status')!;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.engine = new HaiyueEngine({ canvas, clearColor: { r: 0.84, g: 0.87, b: 0.90, a: 1 } });
    await this.engine.init();
    this.setupCamera(canvas);
    this.scene = this.engine.createScene({
      name: 'WaveFunctionCollapseMap',
      camera: this.cameraEntity,
      render3D: { priority: 10, loadOp: 'clear' },
      render2D: false,
      gui: false,
      pipelineLabel: 'WaveFunctionCollapseMap.render',
    });
    this.world = this.scene.world;
    this.setupLights();
    const render3DSystem = this.scene.render3DSystem as Render3DSystem;
    this.scene.addSystem(new BlinnPhongRenderSystem(this.engine, this.cameraEntity, { priority: -1, render3DSystem }));

    document.getElementById('generate')!.addEventListener('click', () => this.generateNext());
    window.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'r') this.generateNext();
    });

    this.generate();
    this.engine.switchScene(this.scene);
    this.engine.run();
  }

  private setupCamera(canvas: HTMLCanvasElement): void {
    const camera = new Camera3D({ type: 'perspective', fov: Math.PI / 4.8, near: 1, far: 3000 });
    const transform = new SphericalTransform3D({
      radius: 650,
      theta: Math.PI * 0.25,
      phi: Math.PI * 0.34,
      target: [0, 0, 0],
    });
    this.cameraEntity = new Entity('Camera');
    this.cameraEntity.addComponent(camera);
    this.cameraEntity.addComponent(transform);
    new OrbitControl(canvas, transform, {
      minRadius: 300,
      maxRadius: 980,
      minPhi: Math.PI * 0.12,
      maxPhi: Math.PI * 0.48,
      rotateSpeed: 0.62,
      zoomSpeed: 0.42,
      enablePan: true,
    });
  }

  private setupLights(): void {
    const ambient = new Entity('AmbientLight');
    ambient.addComponent(new AmbientLight({ color: [1, 1, 1], intensity: 0.55 }));
    this.world.addEntity(ambient);

    const sun = new Entity('SunLight');
    sun.addComponent(new DirectionalLight({ color: [1, 0.96, 0.88], intensity: 1.3, direction: [-0.45, -1, -0.32] }));
    this.world.addEntity(sun);
  }

  private generateNext(): void {
    this.seed++;
    this.generate();
  }

  private generate(): void {
    for (const entity of this.generated) this.world.removeEntity(entity);
    this.generated = [];

    const result = this.generator.generate(this.seed);
    this.seed = result.seed;
    this.seedText.textContent = String(result.seed);
    this.backtracksText.textContent = String(result.backtracks);
    this.statusText.textContent = `${GRID_W * GRID_H} cells, ${result.restarts} restarts. Drag to orbit, wheel to zoom. Press R to regenerate.`;

    this.addBase();
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) this.renderTile(result, x, y);
    }
  }

  private renderTile(result: WfcResult, x: number, y: number): void {
    const tileIndex = requiredAt(requiredAt(result.grid, y, 'WFC result rows'), x, 'WFC result cells');
    const tile = requiredAt(result.tiles, tileIndex, 'WFC result tiles');
    const [wx, wz] = this.cellToWorld(x, y);
    this.addBox(`Tile-${x}-${y}`, wx, 0, wz, TILE_SIZE - 0.8, TILE_HEIGHT, TILE_SIZE - 0.8, [0.41, 0.47, 0.41, 1], 6);

    if (tile.kind === 'road') {
      this.addRoad(wx, wz, tile.roadDirs);
      return;
    }
    if (tile.kind === 'park') {
      this.addPark(wx, wz, result.seed, x, y);
      return;
    }
    if (tile.kind === 'plaza') {
      this.addBox(`Plaza-${x}-${y}`, wx, 2.1, wz, TILE_SIZE * 0.74, 1.2, TILE_SIZE * 0.74, tile.color, 8);
      this.addBox(`PlazaMark-${x}-${y}`, wx, 3.1, wz, TILE_SIZE * 0.26, 0.9, TILE_SIZE * 0.26, [0.78, 0.74, 0.64, 1], 10);
      return;
    }
    this.addBuilding(wx, wz, result.seed, x, y, tile.id === 'building-tower');
  }

  private addBase(): void {
    this.addBox('MapBase', 0, -5, 0, GRID_W * TILE_SIZE + 42, 10, GRID_H * TILE_SIZE + 42, [0.22, 0.26, 0.28, 1], 4);
    this.addBox('MapGround', 0, -0.7, 0, GRID_W * TILE_SIZE + 18, 2, GRID_H * TILE_SIZE + 18, [0.50, 0.56, 0.50, 1], 5);
  }

  private addRoad(x: number, z: number, dirs: Direction[]): void {
    this.addBox('RoadCenter', x, 2.0, z, ROAD_WIDTH, 1.0, ROAD_WIDTH, [0.13, 0.14, 0.15, 1], 14);
    for (const dir of dirs) {
      if (dir === 0) this.addBox('RoadN', x, 2.05, z - TILE_SIZE * 0.25, ROAD_WIDTH, 1.0, TILE_SIZE * 0.5 + 1.5, [0.13, 0.14, 0.15, 1], 14);
      if (dir === 1) this.addBox('RoadE', x + TILE_SIZE * 0.25, 2.05, z, TILE_SIZE * 0.5 + 1.5, 1.0, ROAD_WIDTH, [0.13, 0.14, 0.15, 1], 14);
      if (dir === 2) this.addBox('RoadS', x, 2.05, z + TILE_SIZE * 0.25, ROAD_WIDTH, 1.0, TILE_SIZE * 0.5 + 1.5, [0.13, 0.14, 0.15, 1], 14);
      if (dir === 3) this.addBox('RoadW', x - TILE_SIZE * 0.25, 2.05, z, TILE_SIZE * 0.5 + 1.5, 1.0, ROAD_WIDTH, [0.13, 0.14, 0.15, 1], 14);
    }
    if (dirs.length >= 2) this.addBox('Crosswalk', x, 2.7, z, ROAD_WIDTH * 0.18, 0.5, ROAD_WIDTH * 0.18, [0.82, 0.80, 0.66, 1], 4);
  }

  private addBuilding(x: number, z: number, seed: number, gx: number, gy: number, tower: boolean): void {
    const jitterX = (hash01(seed, gx, gy, 11) - 0.5) * 5;
    const jitterZ = (hash01(seed, gx, gy, 17) - 0.5) * 5;
    const height = tower ? 36 + hash01(seed, gx, gy, 23) * 46 : 14 + hash01(seed, gx, gy, 29) * 24;
    const width = tower ? 14 + hash01(seed, gx, gy, 31) * 6 : 17 + hash01(seed, gx, gy, 37) * 8;
    const depth = tower ? 14 + hash01(seed, gx, gy, 41) * 6 : 17 + hash01(seed, gx, gy, 43) * 8;
    const shade = tower ? 0.44 + hash01(seed, gx, gy, 47) * 0.16 : 0.50 + hash01(seed, gx, gy, 53) * 0.18;
    const color: Color = [shade * 0.88, shade * 0.98, shade * 1.06, 1];
    this.addBox('Building', x + jitterX, TILE_HEIGHT + height * 0.5, z + jitterZ, width, height, depth, color, 28);

    const roofColor: Color = [Math.max(0.12, color[0] - 0.08), Math.max(0.12, color[1] - 0.08), Math.max(0.12, color[2] - 0.08), 1];
    this.addBox('Roof', x + jitterX, TILE_HEIGHT + height + 0.8, z + jitterZ, width * 0.86, 1.6, depth * 0.86, roofColor, 18);
  }

  private addPark(x: number, z: number, seed: number, gx: number, gy: number): void {
    this.addBox('ParkPatch', x, 2.1, z, TILE_SIZE * 0.72, 1.2, TILE_SIZE * 0.72, [0.16, 0.48, 0.24, 1], 8);
    for (let i = 0; i < 3; i++) {
      const px = x + (hash01(seed, gx, gy, 101 + i) - 0.5) * TILE_SIZE * 0.52;
      const pz = z + (hash01(seed, gx, gy, 201 + i) - 0.5) * TILE_SIZE * 0.52;
      this.addBox('TreeTrunk', px, 6.0, pz, 2.0, 7.0, 2.0, [0.30, 0.20, 0.11, 1], 8);
      this.addSphere('TreeTop', px, 11.8, pz, 5.3, [0.08, 0.34, 0.16, 1], 12);
    }
  }

  private cellToWorld(x: number, y: number): [number, number] {
    return [
      (x - (GRID_W - 1) * 0.5) * TILE_SIZE,
      (y - (GRID_H - 1) * 0.5) * TILE_SIZE,
    ];
  }

  private addBox(name: string, x: number, y: number, z: number, width: number, height: number, depth: number, color: Color, shininess: number): Entity {
    const entity = new Entity(name);
    entity.addComponent(new CartesianTransform3D({ position: [x, y, z] }));
    entity.addComponent(new Mesh3D(createBox3D({ width, height, depth }), this.material(color, shininess)));
    this.world.addEntity(entity);
    this.generated.push(entity);
    return entity;
  }

  private addSphere(name: string, x: number, y: number, z: number, radius: number, color: Color, shininess: number): Entity {
    const entity = new Entity(name);
    entity.addComponent(new CartesianTransform3D({ position: [x, y, z] }));
    entity.addComponent(new Mesh3D(createSphere3D({ radius, widthSegments: 16, heightSegments: 8 }), this.material(color, shininess)));
    this.world.addEntity(entity);
    this.generated.push(entity);
    return entity;
  }

  private material(color: Color, shininess: number): BlinnPhongMaterial {
    const key = `${color.join(',')}:${shininess}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new BlinnPhongMaterial({
        diffuse: color,
        ambient: [color[0] * 0.28, color[1] * 0.28, color[2] * 0.28, 1],
        specular: [0.18, 0.18, 0.16, 1],
        shininess,
      });
      this.materials.set(key, material);
    }
    return material;
  }
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
new WfcMapGame().init(canvas).catch(error => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = error instanceof Error ? error.message : String(error);
});
