import { mat4 } from 'wgpu-matrix';
import { Camera3D, CartesianTransform3D, DirectionalLight, Entity, EnvironmentLight, Geometry3D, HaiyueEngine, Mesh3D, OrbitControl, PbrMaterial, SphericalTransform3D, createSphere3D } from '@haiyue/engine';
import { Line3D } from '@haiyue/engine/components';
import { Line3DRenderSystem } from '@haiyue/engine/systems';
import { LineGeometry, createCylinder3D } from '@haiyue/engine/geometry';
import { LineMaterial } from '@haiyue/engine/material';
import { Ray } from '@haiyue/engine/math';
import { NavMesh, NavMeshPath, type NavMeshPathStatus } from '@haiyue/engine/navigation';

const TERRAIN_WIDTH = 22;
const TERRAIN_DEPTH = 16;
const TERRAIN_COLUMNS = 55;
const TERRAIN_ROWS = 40;
const NAV_CELL_SIZE = 0.4;

interface DemoAgent {
  readonly id: string;
  readonly label: string;
  readonly radius: number;
  readonly speed: number;
  readonly transform: CartesianTransform3D;
  readonly position: Float32Array;
  readonly path: NavMeshPath;
  readonly commandTarget: Float32Array;
  readonly movable: boolean;
  waypoint: number;
  moving: boolean;
  repathCooldown: number;
}

async function main(): Promise<void> {
  const engine = new HaiyueEngine({
    canvas: '#canvas',
    clearColor: { r: 0.025, g: 0.045, b: 0.055, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();
  const canvas = engine.canvas!;

  const cameraTransform = new SphericalTransform3D({
    target: [0, 0.8, 0],
    radius: 22,
    theta: Math.PI * 0.08,
    phi: Math.PI * 0.31,
  });
  const cameraComponent = new Camera3D({ type: 'perspective', fov: Math.PI / 3, near: 0.1, far: 80 });
  const camera = new Entity('RTS camera').addComponent(cameraComponent).addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'NavMesh RTS',
    camera,
    render3D: { renderProfile: 'simple', loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'NavMeshRTS.render',
  });
  new OrbitControl(canvas, cameraTransform, { minRadius: 13, maxRadius: 34, rotateSpeed: 0.55 });

  const terrainGeometry = createTerrainGeometry();
  const terrainTransform = new CartesianTransform3D();
  terrainTransform.updateWorldMatrix();
  scene.add(new Entity('Uneven terrain')
    .addComponent(terrainTransform)
    .addComponent(new Mesh3D(terrainGeometry, new PbrMaterial({
      baseColor: [0.19, 0.34, 0.25, 1],
      metallic: 0.04,
      roughness: 0.86,
    }))));

  const navMesh = NavMesh.fromGeometry(terrainGeometry, {
    cellSize: NAV_CELL_SIZE,
    maxSlopeRadians: Math.PI * 0.21,
    maxStepHeight: 0.34,
    boundsPadding: 0,
  });

  scene.add(new Entity('Sun').addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.25],
    color: [1, 0.9, 0.75],
    intensity: 3.2,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 18, far: 45, bias: 0.0015 },
  })));
  scene.add(new Entity('Environment').addComponent(new EnvironmentLight({
    intensity: 0.68,
    diffuseColor: [0.12, 0.25, 0.28],
    specularColor: [0.5, 0.78, 0.75],
  })));

  const agents: DemoAgent[] = [
    createAgent(scene, navMesh, 'large', 'Large', [-7.4, 0, -0.8], 0.72, 2.8, [0.08, 0.48, 0.95, 1], true),
    createAgent(scene, navMesh, 'small', 'Small', [-7.2, 0, 2.5], 0.3, 3.5, [0.12, 0.88, 0.47, 1], true),
    createAgent(scene, navMesh, 'blocker-a', 'Blocker A', [-3.7, 0, -2.2], 0.52, 0, [1, 0.48, 0.08, 1], false),
    createAgent(scene, navMesh, 'blocker-b', 'Blocker B', [4.8, 0, 3.8], 0.62, 0, [1, 0.62, 0.12, 1], false),
  ];
  for (const agent of agents) updateObstacle(navMesh, agent);

  const boundaryGeometry = new LineGeometry(createNavMeshBoundaryLines(navMesh), { topology: 'segments' });
  scene.add(new Entity('NavMesh boundary')
    .addComponent(new CartesianTransform3D())
    .addComponent(new Line3D(boundaryGeometry, new LineMaterial({
      color: [0.12, 0.94, 0.83, 0.88], width: 2, screenSpace: true, cap: 'butt',
    }))));
  const pathGeometry = new LineGeometry(new Float32Array([0, -10, 0, 0, -10, 0]));
  const pathMaterial = new LineMaterial({ color: [0.38, 1, 0.8, 1], width: 5, screenSpace: true });
  scene.add(new Entity('Current path')
    .addComponent(new CartesianTransform3D())
    .addComponent(new Line3D(pathGeometry, pathMaterial)));
  scene.addSystem(new Line3DRenderSystem(engine, camera, { loadOp: 'load' }));

  const markerMaterial = new PbrMaterial({ baseColor: [0.16, 1, 0.65, 1], metallic: 0.1, roughness: 0.32 });
  const markerTransform = new CartesianTransform3D({ position: [0, -10, 0] });
  scene.add(new Entity('Resolved destination')
    .addComponent(markerTransform)
    .addComponent(new Mesh3D(
      createCylinder3D({ radiusTop: 0.42, radiusBottom: 0.42, height: 0.09, radialSegments: 32 }),
      markerMaterial,
    )));

  const selectionTransform = new CartesianTransform3D({ position: [0, -10, 0] });
  scene.add(new Entity('Selection indicator')
    .addComponent(selectionTransform)
    .addComponent(new Mesh3D(
      createCylinder3D({ radiusTop: 0.86, radiusBottom: 0.86, height: 0.035, radialSegments: 40 }),
      new PbrMaterial({ baseColor: [0.2, 0.95, 1, 1], metallic: 0.15, roughness: 0.28 }),
    )));

  let selected = agents[0]!;
  const ray = new Ray();
  const inverseViewProjection = mat4.identity() as Float32Array;
  const viewMatrix = mat4.identity() as Float32Array;
  const viewProjection = mat4.identity() as Float32Array;
  const ui = createUi();
  let pointerDownX = 0;
  let pointerDownY = 0;

  const selectAgent = (agent: DemoAgent): void => {
    if (!agent.movable) {
      ui.status.textContent = `${agent.label} 是动态 NavMesh 障碍，会按真实半径阻挡其他球。`;
      return;
    }
    selected = agent;
    ui.large.classList.toggle('active', agent.id === 'large');
    ui.small.classList.toggle('active', agent.id === 'small');
    ui.agent.textContent = agent.label.toUpperCase();
    updatePathLine(agent, pathGeometry);
    updateSelectionIndicator(agent, selectionTransform);
    ui.status.textContent = `已选择 ${agent.label}，半径 ${agent.radius.toFixed(2)}。点击地形下达移动命令。`;
  };

  ui.large.addEventListener('click', () => selectAgent(agents[0]!));
  ui.small.addEventListener('click', () => selectAgent(agents[1]!));
  canvas.addEventListener('pointerdown', event => {
    pointerDownX = event.clientX;
    pointerDownY = event.clientY;
  });
  canvas.addEventListener('pointerup', event => {
    if (Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY) > 5) return;
    updatePointerRay(event, canvas, engine, cameraComponent, cameraTransform, ray, viewMatrix, viewProjection, inverseViewProjection);
    const picked = pickAgent(ray, agents);
    if (picked) {
      selectAgent(picked);
      return;
    }
    const hit = ray.intersectMesh(terrainGeometry, terrainTransform.worldMatrix, { useBVH: true });
    if (!hit) return;
    commandAgent(selected, hit.point, navMesh, pathGeometry, pathMaterial, markerTransform, markerMaterial, ui);
  });

  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    const dt = Math.min(delta * 0.001, 0.05);
    for (const agent of agents) updateObstacle(navMesh, agent);
    for (const agent of agents) {
      if (agent.movable) updateAgent(agent, agents, navMesh, dt, selected === agent, pathGeometry, ui);
    }
    updateSelectionIndicator(selected, selectionTransform);
  });
  engine.run();

  document.body.dataset.navmeshStatus = 'ready';
  document.body.dataset.navmeshFeatures = 'slope-filter,agent-clearance,partial-path,dynamic-obstacles,rts-pointer';
}

function createTerrainGeometry(): Geometry3D {
  const vertexColumns = TERRAIN_COLUMNS + 1;
  const positions = new Float32Array((TERRAIN_COLUMNS + 1) * (TERRAIN_ROWS + 1) * 3);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array(TERRAIN_COLUMNS * TERRAIN_ROWS * 6);
  let vertexOffset = 0;
  for (let row = 0; row <= TERRAIN_ROWS; row++) {
    const z = row / TERRAIN_ROWS * TERRAIN_DEPTH - TERRAIN_DEPTH * 0.5;
    for (let column = 0; column <= TERRAIN_COLUMNS; column++) {
      const x = column / TERRAIN_COLUMNS * TERRAIN_WIDTH - TERRAIN_WIDTH * 0.5;
      const y = terrainHeight(x, z);
      positions.set([x, y, z], vertexOffset);
      const step = 0.04;
      const dx = (terrainHeight(x + step, z) - terrainHeight(x - step, z)) / (step * 2);
      const dz = (terrainHeight(x, z + step) - terrainHeight(x, z - step)) / (step * 2);
      const length = Math.hypot(dx, 1, dz);
      normals.set([-dx / length, 1 / length, -dz / length], vertexOffset);
      vertexOffset += 3;
    }
  }
  let indexOffset = 0;
  for (let row = 0; row < TERRAIN_ROWS; row++) {
    for (let column = 0; column < TERRAIN_COLUMNS; column++) {
      const a = row * vertexColumns + column;
      const b = a + 1;
      const c = a + vertexColumns;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], indexOffset);
      indexOffset += 6;
    }
  }
  return new Geometry3D({ positions, normals, indices, cullMode: 'back' });
}

function terrainHeight(x: number, z: number): number {
  const rolling = Math.sin(x * 0.48) * Math.cos(z * 0.43) * 0.24
    + Math.sin((x + z) * 0.75) * 0.08;
  const narrowPass = Math.exp(-Math.pow((z - 2.15) / 0.62, 8));
  const widePass = Math.exp(-Math.pow((z + 5.15) / 1.65, 8));
  const pass = Math.max(narrowPass, widePass);
  const transitionWidth = 0.48 + pass * 3.65;
  const ridge = 2.55 * (0.5 + 0.5 * Math.tanh(x / transitionWidth));
  const hill = 0.58 * Math.exp(-((x + 6.2) ** 2 + (z + 4.6) ** 2) / 8.5);
  return rolling + ridge + hill - 1.15;
}

function createAgent(
  scene: ReturnType<HaiyueEngine['createScene']>,
  navMesh: NavMesh,
  id: string,
  label: string,
  initial: [number, number, number],
  radius: number,
  speed: number,
  color: [number, number, number, number],
  movable: boolean,
): DemoAgent {
  const projected = navMesh.projectPoint(initial, { radius }) ?? new Float32Array(initial);
  const position = new Float32Array([projected[0]!, projected[1]! + radius, projected[2]!]);
  const transform = new CartesianTransform3D({ position: [position[0]!, position[1]!, position[2]!] });
  scene.add(new Entity(label)
    .addComponent(transform)
    .addComponent(new Mesh3D(
      createSphere3D({ radius, widthSegments: 32, heightSegments: 20 }),
      new PbrMaterial({ baseColor: color, metallic: movable ? 0.3 : 0.55, roughness: movable ? 0.22 : 0.38 }),
    )));
  return {
    id, label, radius, speed, transform, position, movable,
    path: new NavMeshPath(), commandTarget: new Float32Array(3), waypoint: 0, moving: false, repathCooldown: 0,
  };
}

function commandAgent(
  agent: DemoAgent,
  target: Float32Array,
  navMesh: NavMesh,
  pathGeometry: LineGeometry,
  pathMaterial: LineMaterial,
  markerTransform: CartesianTransform3D,
  markerMaterial: PbrMaterial,
  ui: ReturnType<typeof createUi>,
): void {
  agent.commandTarget.set(target);
  queryAgentPath(agent, navMesh);
  updatePathLine(agent, pathGeometry);
  const resolved = agent.path.resolvedTarget;
  markerTransform.setPosition(resolved[0]!, resolved[1]! + 0.07, resolved[2]!);
  const complete = agent.path.status === 'complete';
  markerMaterial.baseColor = complete ? [0.13, 1, 0.6, 1] : [1, 0.42, 0.12, 1];
  pathMaterial.color = complete ? [0.35, 1, 0.78, 1] : [1, 0.4, 0.13, 1];
  updateUiForPath(agent.path.status, agent.path.visitedNodeCount, ui);
  ui.status.textContent = complete
    ? `${agent.label} 获得完整路径，共 ${agent.path.pointCount} 个平滑路点。`
    : `${agent.label} 无法到达点击位置，正在移动到同一连通区域内最接近的点。`;
}

function queryAgentPath(agent: DemoAgent, navMesh: NavMesh): void {
  navMesh.findPath(
    [agent.position[0]!, agent.position[1]! - agent.radius, agent.position[2]!],
    agent.commandTarget,
    { radius: agent.radius, ignoreObstacleIds: [agent.id] },
    agent.path,
  );
  agent.waypoint = Math.min(1, Math.max(0, agent.path.pointCount - 1));
  agent.moving = agent.path.pointCount > 1;
}

function updateAgent(
  agent: DemoAgent,
  agents: readonly DemoAgent[],
  navMesh: NavMesh,
  dt: number,
  selected: boolean,
  pathGeometry: LineGeometry,
  ui: ReturnType<typeof createUi>,
): void {
  if (!agent.moving) return;
  agent.repathCooldown = Math.max(0, agent.repathCooldown - dt);
  const offset = agent.waypoint * 3;
  const targetX = agent.path.points[offset]!;
  const targetY = agent.path.points[offset + 1]! + agent.radius;
  const targetZ = agent.path.points[offset + 2]!;
  const dx = targetX - agent.position[0]!;
  const dz = targetZ - agent.position[2]!;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.06) {
    agent.position.set([targetX, targetY, targetZ]);
    agent.waypoint++;
    if (agent.waypoint >= agent.path.pointCount) agent.moving = false;
    agent.transform.setPosition(agent.position[0]!, agent.position[1]!, agent.position[2]!);
    updateObstacle(navMesh, agent);
    return;
  }
  const move = Math.min(distance, agent.speed * dt);
  const candidateX = agent.position[0]! + dx / distance * move;
  const candidateZ = agent.position[2]! + dz / distance * move;
  const candidateY = agent.position[1]! + (targetY - agent.position[1]!) * Math.min(1, move / Math.max(distance, 0.001));
  const blockedByBall = agents.some(other => {
    if (other === agent) return false;
    const ox = candidateX - other.position[0]!;
    const oz = candidateZ - other.position[2]!;
    const radius = agent.radius + other.radius;
    return ox * ox + oz * oz < radius * radius;
  });
  const allowed = navMesh.isPositionWalkable(
    [candidateX, candidateY - agent.radius, candidateZ],
    { radius: agent.radius, ignoreObstacleIds: [agent.id] },
  );
  if (blockedByBall || !allowed) {
    if (agent.repathCooldown <= 0) {
      queryAgentPath(agent, navMesh);
      agent.repathCooldown = 0.35;
      if (selected) {
        updatePathLine(agent, pathGeometry);
        updateUiForPath(agent.path.status, agent.path.visitedNodeCount, ui);
        ui.status.textContent = blockedByBall
          ? `${agent.label} 检测到球体碰撞，已把其他球作为动态障碍重新寻路。`
          : `${agent.label} 的局部通路发生变化，已重新寻路。`;
      }
    }
    return;
  }
  agent.position.set([candidateX, candidateY, candidateZ]);
  agent.transform.setPosition(candidateX, candidateY, candidateZ);
  updateObstacle(navMesh, agent);
}

function updateObstacle(navMesh: NavMesh, agent: DemoAgent): void {
  navMesh.setObstacle({ id: agent.id, position: agent.position, radius: agent.radius });
}

function updatePathLine(agent: DemoAgent, geometry: LineGeometry): void {
  if (agent.path.pointCount === 0) {
    geometry.setPoints(new Float32Array([0, -10, 0, 0, -10, 0]));
    return;
  }
  const points = new Float32Array(agent.path.pointCount * 3);
  for (let i = 0; i < agent.path.pointCount; i++) {
    const offset = i * 3;
    points[offset] = agent.path.points[offset]!;
    points[offset + 1] = agent.path.points[offset + 1]! + 0.13;
    points[offset + 2] = agent.path.points[offset + 2]!;
  }
  geometry.setPoints(points);
}

function updateSelectionIndicator(agent: DemoAgent, transform: CartesianTransform3D): void {
  transform.setPosition(agent.position[0]!, agent.position[1]! - agent.radius + 0.045, agent.position[2]!);
  const scale = Math.max(0.48, agent.radius * 1.28) / 0.86;
  transform.setScale(scale, 1, scale);
}

function createNavMeshBoundaryLines(navMesh: NavMesh): Float32Array {
  const points: number[] = [];
  const directions = [
    [-1, 0, -0.5, -0.5, 0.5],
    [1, 0, 0.5, -0.5, 0.5],
    [0, -1, -0.5, -0.5, 0.5],
    [0, 1, 0.5, -0.5, 0.5],
  ] as const;
  for (let row = 0; row < navMesh.rows; row++) {
    for (let column = 0; column < navMesh.columns; column++) {
      const cell = row * navMesh.columns + column;
      if (navMesh.walkable[cell] === 0) continue;
      const centerX = navMesh.originX + (column + 0.5) * navMesh.cellSize;
      const centerZ = navMesh.originZ + (row + 0.5) * navMesh.cellSize;
      const y = navMesh.heights[cell]! + 0.06;
      for (const [dc, dr, edge, from, to] of directions) {
        const nc = column + dc;
        const nr = row + dr;
        const boundary = nc < 0 || nc >= navMesh.columns || nr < 0 || nr >= navMesh.rows
          || navMesh.walkable[nr * navMesh.columns + nc] === 0;
        if (!boundary) continue;
        if (dc !== 0) points.push(centerX + edge * navMesh.cellSize, y, centerZ + from * navMesh.cellSize, centerX + edge * navMesh.cellSize, y, centerZ + to * navMesh.cellSize);
        else points.push(centerX + from * navMesh.cellSize, y, centerZ + edge * navMesh.cellSize, centerX + to * navMesh.cellSize, y, centerZ + edge * navMesh.cellSize);
      }
    }
  }
  return new Float32Array(points);
}

function updatePointerRay(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  engine: HaiyueEngine,
  camera: Camera3D,
  transform: SphericalTransform3D,
  ray: Ray,
  view: Float32Array,
  viewProjection: Float32Array,
  inverseViewProjection: Float32Array,
): void {
  const rect = canvas.getBoundingClientRect();
  const ndcX = (event.clientX - rect.left) / rect.width * 2 - 1;
  const ndcY = 1 - (event.clientY - rect.top) / rect.height * 2;
  camera.updateAspect(engine.width / Math.max(1, engine.height));
  transform.updateWorldMatrix();
  mat4.inverse(transform.worldMatrix, view);
  mat4.multiply(camera.projectionMatrix, view, viewProjection);
  mat4.inverse(viewProjection, inverseViewProjection);
  ray.setFromCamera(ndcX, ndcY, transform.eyePosition, inverseViewProjection);
}

function pickAgent(ray: Ray, agents: readonly DemoAgent[]): DemoAgent | null {
  let picked: DemoAgent | null = null;
  let nearest = Infinity;
  for (const agent of agents) {
    const distance = raySphereDistance(ray, agent.position, agent.radius);
    if (distance !== null && distance < nearest) {
      nearest = distance;
      picked = agent;
    }
  }
  return picked;
}

function raySphereDistance(ray: Ray, center: Float32Array, radius: number): number | null {
  const ox = ray.origin[0]! - center[0]!;
  const oy = ray.origin[1]! - center[1]!;
  const oz = ray.origin[2]! - center[2]!;
  const b = ox * ray.direction[0]! + oy * ray.direction[1]! + oz * ray.direction[2]!;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const near = -b - Math.sqrt(discriminant);
  const far = -b + Math.sqrt(discriminant);
  return near >= 0 ? near : far >= 0 ? far : null;
}

function createUi() {
  return {
    large: document.querySelector<HTMLButtonElement>('#select-large')!,
    small: document.querySelector<HTMLButtonElement>('#select-small')!,
    agent: document.querySelector<HTMLElement>('#agent')!,
    pathStatus: document.querySelector<HTMLElement>('#path-status')!,
    visited: document.querySelector<HTMLElement>('#visited')!,
    status: document.querySelector<HTMLElement>('#status')!,
  };
}

function updateUiForPath(status: NavMeshPathStatus, visited: number, ui: ReturnType<typeof createUi>): void {
  ui.pathStatus.textContent = status.toUpperCase();
  ui.pathStatus.style.color = status === 'complete' ? '#73e8cf' : status === 'partial' ? '#ff9655' : '#ff6d6d';
  ui.visited.textContent = String(visited);
}

main().catch(error => {
  document.body.dataset.navmeshStatus = 'failed';
  document.body.dataset.navmeshError = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
});
