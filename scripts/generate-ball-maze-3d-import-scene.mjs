import { writeFileSync } from 'node:fs';
import { createBox3D, createPlane3D, createSphere3D } from '../engine/dist/index.js';

const OUTPUTS = [
  new URL('../editor/scene-examples/ball-maze-3d-import.scene.json', import.meta.url),
  new URL('../games/pad-simulator/scenes/ball-maze-3d-import.scene.json', import.meta.url),
];

const MAX_DIM = 31;
const CELL = 36;
const WALL_H = 34;
const BALL_R = 9;
const BALL_Y = BALL_R + 3.5;
const SHADOW_Y = 3.6;
const CAMERA_THETA = 0;
const CAMERA_PHI = Math.PI * 0.18;
const CAMERA_RADIUS = 225;

function arr(value) {
  return value ? Array.from(value) : null;
}

function geom(id, name, geometry) {
  return {
    id,
    name,
    positions: arr(geometry.positions),
    normals: arr(geometry.normals),
    textureCoordinates: [...geometry.textureCoordinates].map(([set, data]) => ({ set, data: arr(data) })),
    textureCoordinateLayout: [...geometry.textureCoordinateLayout],
    indices: arr(geometry.indices),
    indexType: geometry.indices instanceof Uint32Array ? 'uint32' : geometry.indices instanceof Uint16Array ? 'uint16' : null,
    topology: geometry.topology ?? null,
    cullMode: geometry.cullMode ?? null,
    frontFace: geometry.frontFace ?? null,
  };
}

function phong(id, name, diffuse, ambientScale = 0.25, specular = [0.18, 0.18, 0.16, 1], shininess = 20) {
  return {
    id,
    name,
    type: 'BlinnPhongMaterial',
    ambient: [diffuse[0] * ambientScale, diffuse[1] * ambientScale, diffuse[2] * ambientScale, 1],
    diffuse,
    specular,
    shininess,
    blending: 'none',
  };
}

function radialShadow(id, name, color = [0, 0, 0], opacity = 0.34, innerRadius = 0.15) {
  return { id, name, type: 'RadialShadowMaterial', color, opacity, innerRadius };
}

function entity(name, components = [], children = [], disabled = false) {
  return { name, disabled, components, children };
}

function cart(position, scale = [1, 1, 1], rotation = [0, 0, 0]) {
  return { type: 'CartesianTransform3D', position, rotation, scale, anchor: [0, 0, 0] };
}

function sph(radius, theta, phi, target) {
  return { type: 'SphericalTransform3D', radius, theta, phi, target };
}

function t2d(x, y) {
  return { type: 'Transform2D', x, y, rotation: 0, scaleX: 1, scaleY: 1 };
}

function mesh(geometryId, materialId) {
  return { type: 'Mesh3D', geometryId, materialId };
}

function body(bodyType, shape, options = {}) {
  return {
    type: 'Physics2DBody',
    bodyType,
    shape,
    width: options.width ?? 100,
    height: options.height ?? 100,
    radius: options.radius ?? 50,
    density: options.density ?? (bodyType === 'dynamic' ? 1 : 0),
    friction: options.friction ?? 0,
    restitution: options.restitution ?? 0.2,
    fixedRotation: options.fixedRotation ?? false,
    linearDamping: options.linearDamping ?? 0,
    angularDamping: options.angularDamping ?? 0,
    bullet: options.bullet ?? false,
    allowSleep: options.allowSleep ?? true,
    isSensor: options.isSensor ?? false,
    categoryBits: options.categoryBits ?? 1,
    maskBits: options.maskBits ?? 0xffff,
    groupIndex: options.groupIndex ?? 0,
    syncTransform: options.syncTransform ?? true,
  };
}

function textEntity(name, x, y, text, width, height, fontSize) {
  return entity(name, [
    t2d(x, y),
    {
      type: 'CanvasTextComponent',
      text,
      style: {
        width,
        height,
        resolutionScale: 2,
        backgroundColor: 'rgba(10, 18, 32, 0.68)',
        borderColor: 'rgba(148, 163, 184, 0.32)',
        borderWidth: 1,
        borderRadius: 8,
        padding: [7, 12],
        textAlign: 'center',
        verticalAlign: 'middle',
        fontSize,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        fontWeight: '700',
        lineHeight: 1.2,
        color: '#f8fafc',
        whiteSpace: 'normal',
      },
    },
  ]);
}

function gridToWorld(i, j, dim = MAX_DIM) {
  const center = (dim - 1) * 0.5;
  return [(i - center) * CELL, (j - center) * CELL];
}

function wallEntity(index) {
  return entity(`Maze Wall ${index}`, [
    t2d(0, 0),
    cart([0, WALL_H * 0.5, 0], [CELL, WALL_H, CELL]),
    mesh(1, 1),
    body('static', 'box', {
      width: CELL,
      height: CELL,
      friction: 0,
      restitution: 0.18,
    }),
    { type: 'DataComponent', data: { ballMazeWall: true, wallIndex: index } },
  ], [], true);
}

const gameScript = String.raw`
const C = api.read.components;
const state = component.__ballMaze3d || (component.__ballMaze3d = {});

const MAX_DIM = 31;
const CELL = 36;
const WALL_H = 34;
const BALL_R = 9;
const BALL_Y = BALL_R + 3.5;
const SHADOW_Y = 3.6;
const START_DIM = 11;
const MAX_SPEED = 5.6;
const IMPULSE = 0.0625;
const FRICTION = 0.97;
const FADE_MS = 420;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function gridToWorld(i, j, dim) {
  const center = (dim - 1) * 0.5;
  return [(i - center) * CELL, (j - center) * CELL];
}
function cellOf(x, y, dim) {
  const center = (dim - 1) * 0.5;
  return [Math.floor(x / CELL + center + 0.5), Math.floor(y / CELL + center + 0.5)];
}
function getComponent(entity, name) {
  return entity?.getComponent(C[name]) || entity?.getComponent(name) || null;
}
function setHud() {
  const level = Math.floor((state.dim - 1) / 2 - 4);
  api.scene.setText('Ball Maze Level', 'Level ' + level);
  api.scene.setText('Ball Maze Status', state.status || 'Arrow keys / WASD');
}
function generateSquareMaze(dimension) {
  const field = [];
  field.dimension = dimension;
  for (let i = 0; i < dimension; i++) {
    field[i] = [];
    for (let j = 0; j < dimension; j++) field[i][j] = true;
  }
  function iterate(x, y) {
    field[x][y] = false;
    while (true) {
      const directions = [];
      if (x > 1 && field[x - 2][y]) directions.push([-1, 0]);
      if (x < dimension - 2 && field[x + 2][y]) directions.push([1, 0]);
      if (y > 1 && field[x][y - 2]) directions.push([0, -1]);
      if (y < dimension - 2 && field[x][y + 2]) directions.push([0, 1]);
      if (!directions.length) return;
      const dir = directions[Math.floor(Math.random() * directions.length)];
      field[x + dir[0]][y + dir[1]] = false;
      iterate(x + dir[0] * 2, y + dir[1] * 2);
    }
  }
  iterate(1, 1);
  field[dimension - 1][dimension - 2] = false;
  return field;
}
function placeEntity(entity, x, z, y) {
  const t2d = getComponent(entity, 'Transform2D');
  const t3d = getComponent(entity, 'CartesianTransform3D');
  if (t2d) {
    t2d.x = x;
    t2d.y = z;
  }
  t3d?.setPosition(x, y, z);
}
function placeBall(x, z) {
  const ball = state.ball;
  placeEntity(ball, x, z, BALL_Y);
  const body = getComponent(ball, 'Physics2DBody');
  if (body) {
    api.physics.stop(body);
    api.physics.teleport(body, x, z, 0);
  }
  state.lastBallX = x;
  state.lastBallZ = z;
  state.visualX = x;
  state.visualZ = z;
  state.rollX = 0;
  state.rollZ = 0;
}
function applyMaze() {
  const maze = generateSquareMaze(state.dim);
  state.maze = maze;
  let used = 0;
  for (let i = 0; i < state.dim; i++) {
    for (let j = 0; j < state.dim; j++) {
      if (!maze[i][j]) continue;
      const wall = state.walls[used++];
      if (!wall) continue;
      const [x, z] = gridToWorld(i, j, state.dim);
      placeEntity(wall, x, z, WALL_H * 0.5);
      wall.disabled = false;
    }
  }
  for (let i = used; i < state.walls.length; i++) state.walls[i].disabled = true;
  state.wallCount = used;
  const [sx, sz] = gridToWorld(1, 1, state.dim);
  const [ex, ez] = gridToWorld(state.dim, state.dim - 2, state.dim);
  placeBall(sx, sz);
  placeEntity(state.exit, ex, ez, 2.5);
  state.exit.disabled = false;
  state.status = 'Arrow keys / WASD';
  setHud();
  updateCamera(true);
}
function startNextMaze() {
  state.phase = 'fadeOut';
  state.fadeStart = api.debug.performance.now();
  state.status = 'Exit reached';
  setHud();
}
function finishNextMaze() {
  state.dim = state.dim >= MAX_DIM ? MAX_DIM : state.dim + 2;
  state.phase = 'fadeIn';
  state.fadeStart = api.debug.performance.now();
  applyMaze();
}
function axis() {
  let x = 0;
  let y = 0;
  if (api.input.isPressed('ArrowLeft') || api.input.isPressed('KeyA')) x -= 1;
  if (api.input.isPressed('ArrowRight') || api.input.isPressed('KeyD')) x += 1;
  if (api.input.isPressed('ArrowDown') || api.input.isPressed('KeyS')) y += 1;
  if (api.input.isPressed('ArrowUp') || api.input.isPressed('KeyW')) y -= 1;
  if (x && y) {
    x *= Math.SQRT1_2;
    y *= Math.SQRT1_2;
  }
  return [x, y];
}
function updateBall(delta) {
  const body = getComponent(state.ball, 'Physics2DBody');
  if (!body) return;
  const velocity = state.velocityScratch || (state.velocityScratch = { x: 0, y: 0 });
  const lv = api.physics.getVelocity(body, velocity);
  if (!lv) return;
  lv.x *= FRICTION;
  lv.y *= FRICTION;
  const [ax, ay] = axis();
  api.physics.setVelocity(body, lv.x, lv.y);
  const mass = api.physics.getMass(body) || 1;
  if (ax || ay) api.physics.applyImpulse(body, ax * mass * IMPULSE, ay * mass * IMPULSE);
  const capped = api.physics.getVelocity(body, velocity);
  if (!capped) return;
  const speed = Math.hypot(capped.x, capped.y);
  if (speed > MAX_SPEED) api.physics.setVelocity(body, capped.x / speed * MAX_SPEED, capped.y / speed * MAX_SPEED);

  const t2d = getComponent(state.ball, 'Transform2D');
  const ball3d = getComponent(state.ball, 'CartesianTransform3D');
  if (!t2d || !ball3d) return;
  if (!Number.isFinite(state.visualX) || !Number.isFinite(state.visualZ)) {
    state.visualX = t2d.x;
    state.visualZ = t2d.y;
  }
  const smooth = clamp(delta / 72, 0.16, 0.5);
  const prevVisualX = state.visualX;
  const prevVisualZ = state.visualZ;
  state.visualX += (t2d.x - state.visualX) * smooth;
  state.visualZ += (t2d.y - state.visualZ) * smooth;
  const stepX = state.visualX - prevVisualX;
  const stepZ = state.visualZ - prevVisualZ;
  state.lastBallX = state.visualX;
  state.lastBallZ = state.visualZ;
  state.rollX += -stepZ / BALL_R;
  state.rollZ += -stepX / BALL_R;
  ball3d.setPosition(state.visualX, BALL_Y, state.visualZ);
  ball3d.setRotation(state.rollX, 0, state.rollZ);
  placeEntity(state.shadow, state.visualX, state.visualZ, SHADOW_Y);

  const [mazeX, mazeY] = cellOf(t2d.x, t2d.y, state.dim);
  if (state.phase === 'play' && mazeX === state.dim && mazeY === state.dim - 2) startNextMaze();
}
function updateCamera(force) {
  const t2d = getComponent(state.ball, 'Transform2D');
  if (!state.camera || !t2d) return;
  const targetX = force ? t2d.x : state.camera.target[0] + (t2d.x - state.camera.target[0]) * 0.1;
  const targetZ = force ? t2d.y : state.camera.target[2] + (t2d.y - state.camera.target[2]) * 0.1;
  state.camera.setTarget(targetX, 0, targetZ);
  const targetRadius = clamp(state.dim * CELL * 0.46, 180, 520);
  state.camera.radius += (targetRadius - state.camera.radius) * (force ? 1 : 0.08);
}
function updateFade() {
  const light = getComponent(state.keyLight, 'DirectionalLight');
  if (!light || state.phase === 'play') return;
  const t = clamp((api.debug.performance.now() - state.fadeStart) / FADE_MS, 0, 1);
  if (state.phase === 'fadeOut') {
    light.intensity = 1.35 * (1 - t);
    if (t >= 1) finishNextMaze();
  } else if (state.phase === 'fadeIn') {
    light.intensity = 1.35 * t;
    if (t >= 1) {
      light.intensity = 1.35;
      state.phase = 'play';
    }
  }
}

if (!state.initialized) {
  state.initialized = true;
  state.dim = START_DIM;
  state.phase = 'play';
  state.ball = api.read.find('Maze Ball');
  state.shadow = api.read.find('Maze Ball Shadow');
  state.exit = api.read.find('Maze Exit');
  state.camera = api.read.find('Ball Maze Camera')?.getComponent(C.SphericalTransform3D);
  state.keyLight = api.read.find('Ball Maze Key Light');
  state.walls = api.read.findAll().filter(entity => getComponent(entity, 'DataComponent')?.data?.ballMazeWall)
    .sort((a, b) => getComponent(a, 'DataComponent').data.wallIndex - getComponent(b, 'DataComponent').data.wallIndex);
  applyMaze();
}

if (api.input.wasPressed('KeyR')) {
  state.dim = START_DIM;
  applyMaze();
  state.phase = 'play';
}
updateBall(delta);
updateCamera(false);
updateFade();
`;

const wallPool = [];
for (let i = 0; i < MAX_DIM * MAX_DIM; i++) wallPool.push(wallEntity(i));

const scene = {
  version: 1,
  name: 'Ball Maze 3D Import Scene',
  globals: {
    designWidth: 1280,
    designHeight: 720,
    clearColor: [0.035, 0.05, 0.075, 1],
    parameters: {
      starterKit: 'ball-maze-3d',
      description: 'Importable 3D ball maze scene inspired by HypnosNova/ball_maze. Arrow keys or WASD roll the ball; reaching the exit generates a new maze.',
    },
    inputMap: {},
  },
  systems: [
    {
      type: 'Physics2DSystem',
      gravity: [0, 0],
      pixelsPerMeter: 100,
      fixedTimeStep: 1 / 60,
      maxSubSteps: 5,
      velocityIterations: 8,
      positionIterations: 3,
      syncStaticBodiesFromTransform: true,
      priority: 0,
    },
  ],
  resources: {
    geometries: [
      geom(1, 'Maze Wall Cube', createBox3D({ width: 1, height: 1, depth: 1 })),
      geom(2, 'Maze Floor Plane', createPlane3D({ width: 1, height: 1, normal: 'y' })),
      geom(3, 'Maze Ball Sphere', createSphere3D({ radius: BALL_R, widthSegments: 32, heightSegments: 16 })),
      geom(4, 'Maze Exit Plate', createBox3D({ width: 1, height: 1, depth: 1 })),
      geom(5, 'Maze Ball Shadow Plane', createPlane3D({ width: 1, height: 1, normal: 'y' })),
    ],
    materials: [
      phong(1, 'Brick Wall Material', [0.62, 0.18, 0.11, 1], 0.22, [0.22, 0.16, 0.12, 1], 18),
      phong(2, 'Concrete Floor Material', [0.36, 0.39, 0.37, 1], 0.35, [0.08, 0.09, 0.08, 1], 10),
      phong(3, 'Iron Ball Material', [0.72, 0.74, 0.76, 1], 0.28, [0.98, 0.98, 0.95, 1], 86),
      phong(4, 'Exit Material', [0.04, 0.74, 0.48, 1], 0.20, [0.55, 0.95, 0.72, 1], 44),
      radialShadow(5, 'Ball Shadow Material', [0, 0, 0], 0.30, 0.16),
    ],
    textures: [],
    models: [],
    prefabs: [],
    scripts: [
      {
        id: 1,
        name: 'BallMaze3D GameManager',
        scripts: {
          onUpdate: gameScript,
          onEntityAddComponent: '',
          onEntityRemoveComponent: '',
          onEntityAddToWorld: '',
          onEntityRemoveFromWorld: '',
        },
      },
    ],
  },
  entities: [
    entity('Ball Maze Camera', [
      {
        type: 'Camera3D',
        projectionType: 'perspective',
        fov: Math.PI / 4.3,
        aspect: 1,
        near: 1,
        far: 4000,
        orthoLeft: -1,
        orthoRight: 1,
        orthoTop: 1,
        orthoBottom: -1,
        reverseZ: false,
      },
      sph(CAMERA_RADIUS, CAMERA_THETA, CAMERA_PHI, [0, 0, 0]),
    ]),
    entity('HUD Camera 2D', [
      { type: 'Camera2D', width: 1280, height: 720, near: -1000, far: 1000, zoom: 1 },
    ]),
    entity('Ball Maze Ambient Light', [
      { type: 'AmbientLight', color: [1, 1, 1, 1], intensity: 0.28 },
    ]),
    entity('Ball Maze Key Light', [
      { type: 'DirectionalLight', color: [1, 0.96, 0.88, 1], intensity: 1.35, direction: [-0.45, -1, -0.35] },
    ]),
    entity('Maze Floor', [
      cart([0, 0, 0], [MAX_DIM * CELL + CELL * 6, 1, MAX_DIM * CELL + CELL * 6]),
      mesh(2, 2),
    ]),
    entity('Maze Exit', [
      t2d(0, 0),
      cart([0, 2.5, 0], [CELL * 0.82, 5, CELL * 0.82]),
      mesh(4, 4),
    ], [], true),
    entity('Maze Ball Shadow', [
      cart([0, SHADOW_Y, 0], [BALL_R * 3, 1, BALL_R * 2.35]),
      mesh(5, 5),
    ]),
    entity('Maze Ball', [
      t2d(0, 0),
      cart([0, BALL_Y, 0]),
      mesh(3, 3),
      body('dynamic', 'circle', {
        radius: BALL_R,
        density: 1,
        friction: 0,
        restitution: 0.25,
        linearDamping: 0,
        angularDamping: 0.4,
        bullet: true,
        allowSleep: false,
      }),
    ]),
    ...wallPool,
    textEntity('Ball Maze Level', -560, 304, 'Level 1', 190, 56, 32),
    textEntity('Ball Maze Status', -350, 304, 'Arrow keys / WASD', 900, 56, 28),
    entity('Ball Maze GameManager', [
      { type: 'KeyboardComponent' },
      { type: 'ScriptComponent', scriptId: 1, scripts: { onUpdate: '', onEntityAddComponent: '', onEntityRemoveComponent: '', onEntityAddToWorld: '', onEntityRemoveFromWorld: '' } },
    ]),
  ],
};

for (const output of OUTPUTS) {
  writeFileSync(output, JSON.stringify(scene, null, 2));
  console.log(`Wrote ${output.pathname}`);
}
