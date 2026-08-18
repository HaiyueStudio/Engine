import { writeFileSync } from 'node:fs';
import { createBox3D, createPlane3D, createSphere3D } from '../engine/dist/index.js';

const OUTPUTS = [
  new URL('../editor/scene-examples/billiards-3d-import.scene.json', import.meta.url),
  new URL('../games/pad-simulator/scenes/billiards-3d-import.scene.json', import.meta.url),
];

const TABLE_W = 760;
const TABLE_H = 420;
const BALL_R = 14;
const POCKET_R = 27;
const BALL_Y = BALL_R + 4.2;
const SHADOW_Y = 4.35;
const CUE_STICK_Y = BALL_Y + 0.8;

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

function phong(id, name, diffuse, ambientScale = 0.25, specular = [0.22, 0.18, 0.12, 1], shininess = 24) {
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

function radialShadow(id, name, color = [0, 0, 0], opacity = 0.34, innerRadius = 0.12) {
  return {
    id,
    name,
    type: 'RadialShadowMaterial',
    color,
    opacity,
    innerRadius,
  };
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
    friction: options.friction ?? 0.08,
    restitution: options.restitution ?? 0.92,
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

function sync3d(offset = [0, 0, 0], sourceEntity = null) {
  return {
    type: 'Physics2DTo3DTransformSync',
    sourceEntity,
    plane: 'xz',
    fixedAxisValue: BALL_Y,
    offset,
    syncRotation: false,
    rotationAxis: 'none',
    rotationOffset: 0,
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
        backgroundColor: 'rgba(2, 6, 23, 0.56)',
        borderColor: 'rgba(148, 163, 184, 0.28)',
        borderWidth: 1,
        borderRadius: 8,
        padding: [8, 12],
        textAlign: 'center',
        verticalAlign: 'middle',
        fontSize,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        fontWeight: '600',
        lineHeight: 1.2,
        color: '#f8fafc',
        whiteSpace: 'normal',
      },
    },
  ]);
}

function rail(name, x, z, width, depth) {
  return entity(name, [
    cart([x, 24, z], [width, 42, depth]),
    t2d(x, z),
    mesh(1, 3),
    body('static', 'box', { width, height: depth, friction: 0.08, restitution: 0.92 }),
  ]);
}

function box(name, x, y, z, sx, sy, sz, materialId) {
  return entity(name, [
    cart([x, y, z], [sx, sy, sz]),
    mesh(2, materialId),
  ]);
}

function pocket(name, x, z) {
  return entity(name, [
    cart([x, 3, z], [1, 0.16, 1]),
    mesh(4, 5),
  ]);
}

function ballEntity(name, kind, x, z) {
  return entity(name, [
    t2d(x, z),
    cart([x, BALL_Y, z]),
    mesh(3, kind === 'cue' ? 1 : 2),
    body('dynamic', 'circle', { radius: BALL_R, density: 1, friction: 0.02, restitution: 0.96, linearDamping: 1.35, angularDamping: 2.2, bullet: true }),
    sync3d(),
    { type: 'DataComponent', data: { billiardsKind: kind, startX: x, startZ: z } },
  ]);
}

function ballShadowEntity(name, x, z) {
  return entity(`${name} Shadow`, [
    cart([x, SHADOW_Y, z], [BALL_R * 2.75, 1, BALL_R * 2.15]),
    mesh(5, 7),
  ]);
}

function cueStickEntity() {
  return entity('Cue Stick', [
    cart([-330, CUE_STICK_Y, 0], [210, 4.2, 4.2], [0, 0, 0]),
    mesh(2, 8),
  ], [], true);
}

function rackBallEntities() {
  const balls = [ballEntity('CueBall', 'cue', -235, 0)];
  let index = 0;
  const startX = 135;
  const spacing = BALL_R * 2.18;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col <= row; col++) {
      if (index >= 10) break;
      const x = startX + row * spacing;
      const z = (col - row * 0.5) * spacing;
      balls.push(ballEntity(`RedBall ${index + 1}`, 'red', x, z));
      index++;
    }
  }
  return balls;
}

function rackShadowEntities() {
  const shadows = [ballShadowEntity('CueBall', -235, 0)];
  let index = 0;
  const startX = 135;
  const spacing = BALL_R * 2.18;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col <= row; col++) {
      if (index >= 10) break;
      const x = startX + row * spacing;
      const z = (col - row * 0.5) * spacing;
      shadows.push(ballShadowEntity(`RedBall ${index + 1}`, x, z));
      index++;
    }
  }
  return shadows;
}

const gameScript = String.raw`
const C = api.read.components;
const state = component.__billiards3d || (component.__billiards3d = {});

const TABLE_W = 760;
const TABLE_H = 420;
const BALL_R = 14;
const POCKET_R = 27;
const BALL_Y = BALL_R + 4.2;
const SHADOW_Y = 4.35;
const CUE_STICK_Y = BALL_Y + 0.8;
const CUE_STICK_LENGTH = 210;
const CUE_STICK_TIP_GAP = BALL_R + 7;
const CUE_STICK_MAX_PULLBACK = 92;
const MAX_DRAG = 190;
const IMPULSE_SCALE = 0.020;
const STOP_SPEED = 0.045;
const AIM_RADIUS = 175;
const AIM_PHI = Math.PI * 0.45;
const AIM_THETA_TO_RACK = -Math.PI / 2;
const TOP_RADIUS = 980;
const TOP_THETA = 0;
const TOP_PHI = Math.PI * 0.035;
const POCKETS = [
  [-TABLE_W / 2, -TABLE_H / 2],
  [0, -TABLE_H / 2 - 4],
  [TABLE_W / 2, -TABLE_H / 2],
  [-TABLE_W / 2, TABLE_H / 2],
  [0, TABLE_H / 2 + 4],
  [TABLE_W / 2, TABLE_H / 2],
];

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function ease(t) { return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }
function bodyOf(ball) { return ball.entity.getComponent(C.Physics2DBody); }
function t2dOf(ball) { return ball.entity.getComponent(C.Transform2D); }
function setHud(score, status) {
  api.scene.setText('Billiards Score', score);
  api.scene.setText('Billiards Status', status);
}
function canShoot() {
  if (state.transition || state.potted >= 10 || !state.balls) return false;
  for (const ball of state.balls) {
    if (!ball.active) continue;
    const body = bodyOf(ball);
    if (!body) return false;
    const scratch = state.velocityScratch || (state.velocityScratch = { x: 0, y: 0 });
    const velocity = api.physics.getVelocity(body, scratch);
    if (!velocity) return false;
    if (Math.hypot(velocity.x, velocity.y) >= STOP_SPEED) return false;
  }
  return true;
}
function stopSlowBalls() {
  for (const ball of state.balls) {
    if (!ball.active) continue;
    const body = bodyOf(ball);
    if (!body) continue;
    const scratch = state.velocityScratch || (state.velocityScratch = { x: 0, y: 0 });
    const velocity = api.physics.getVelocity(body, scratch);
    if (!velocity) continue;
    if (Math.hypot(velocity.x, velocity.y) <= STOP_SPEED) {
      api.physics.stop(body);
    }
  }
}
function setCamera(target, radius, theta, phi) {
  state.cameraOrbit.setTarget(target[0], target[1], target[2]);
  state.cameraOrbit.set(radius, theta, phi);
}
function snapToCueCamera() {
  const t = t2dOf(state.cue);
  state.mode = 'aim';
  setCamera([t.x, BALL_Y, t.y], AIM_RADIUS, AIM_THETA_TO_RACK, AIM_PHI);
}
function startCameraTransition(to, duration, done) {
  state.mode = 'transition';
  state.transition = {
    startTime: api.debug.performance.now(),
    duration,
    from: {
      radius: state.cameraOrbit.radius,
      theta: state.cameraOrbit.theta,
      phi: state.cameraOrbit.phi,
      target: [state.cameraOrbit.target[0], state.cameraOrbit.target[1], state.cameraOrbit.target[2]],
    },
    to,
    done,
  };
}
function updateCameraTransition() {
  if (!state.transition) return;
  const tr = state.transition;
  const k = ease(clamp01((api.debug.performance.now() - tr.startTime) / tr.duration));
  setCamera([
    lerp(tr.from.target[0], tr.to.target[0], k),
    lerp(tr.from.target[1], tr.to.target[1], k),
    lerp(tr.from.target[2], tr.to.target[2], k),
  ], lerp(tr.from.radius, tr.to.radius, k), lerp(tr.from.theta, tr.to.theta, k), lerp(tr.from.phi, tr.to.phi, k));
  if (k >= 1) {
    const done = tr.done;
    state.transition = null;
    done?.();
  }
}
function transitionToTopView() {
  startCameraTransition({ radius: TOP_RADIUS, theta: TOP_THETA, phi: TOP_PHI, target: [0, 0, 0] }, 760, () => {
    state.mode = 'top';
  });
}
function transitionToCueView() {
  const t = t2dOf(state.cue);
  startCameraTransition({ radius: AIM_RADIUS, theta: state.cameraOrbit.theta, phi: AIM_PHI, target: [t.x, BALL_Y, t.y] }, 720, () => {
    state.mode = 'aim';
  });
}
function placeBallEntity(entity, x, z) {
  const t = entity.getComponent(C.Transform2D);
  t.x = x;
  t.y = z;
  entity.getComponent(C.CartesianTransform3D).setPosition(x, BALL_Y, z);
  const physics = entity.getComponent(C.Physics2DBody);
  if (physics) {
    api.physics.stop(physics);
    api.physics.teleport(physics, x, z, 0);
  }
}
function placeShadow(ball, x, z) {
  if (!ball.shadow) return;
  ball.shadow.disabled = !ball.active;
  const transform = ball.shadow.getComponent(C.CartesianTransform3D);
  transform?.setPosition(x, SHADOW_Y, z);
}
function hideBall(ball) {
  ball.active = false;
  placeBallEntity(ball.entity, 99999, 99999);
  placeShadow(ball, 99999, 99999);
  ball.entity.disabled = true;
  if (ball.shadow) ball.shadow.disabled = true;
}
function activateBall(ball) {
  ball.active = true;
  ball.entity.disabled = false;
  if (ball.shadow) ball.shadow.disabled = false;
  placeBallEntity(ball.entity, ball.startX, ball.startZ);
  placeShadow(ball, ball.startX, ball.startZ);
}
function collectBalls() {
  const balls = [];
  for (const entity of api.read.findAll()) {
    const data = entity.getComponent(C.DataComponent)?.data;
    if (!data || (data.billiardsKind !== 'cue' && data.billiardsKind !== 'red')) continue;
    balls.push({
      entity,
      shadow: api.read.find(entity.name + ' Shadow'),
      kind: data.billiardsKind,
      startX: data.startX,
      startZ: data.startZ,
      active: true,
    });
  }
  balls.sort((a, b) => a.entity.name.localeCompare(b.entity.name, undefined, { numeric: true }));
  return balls;
}
function updateShadows() {
  for (const ball of state.balls) {
    if (!ball.active) continue;
    const t = t2dOf(ball);
    placeShadow(ball, t.x, t.y);
  }
}
function resetCueBall() {
  activateBall(state.cue);
}
function newGame() {
  state.potted = 0;
  state.charging = false;
  state.chargePower = 0;
  state.transition = null;
  state.spawnTime = api.debug.performance.now();
  for (const ball of state.balls) activateBall(ball);
  state.cue = state.balls.find(ball => ball.kind === 'cue');
  snapToCueCamera();
  setHud('0 / 10', 'Ready');
}
function checkPockets() {
  if (api.debug.performance.now() - (state.spawnTime || 0) < 250) return;
  for (const ball of [...state.balls]) {
    if (!ball.active) continue;
    const t = t2dOf(ball);
    const hit = POCKETS.some(([x, z]) => Math.hypot(t.x - x, t.y - z) <= POCKET_R - 3);
    if (!hit) continue;
    if (ball.kind === 'cue') resetCueBall();
    else {
      hideBall(ball);
      state.potted++;
    }
  }
}
function shotDirection() {
  const eye = state.cameraOrbit.eyePosition;
  const target = state.cameraOrbit.target;
  const dx = target[0] - eye[0];
  const dz = target[2] - eye[2];
  const len = Math.hypot(dx, dz) || 1;
  return [dx / len, dz / len];
}
function updateCueStick() {
  const cueStick = state.cueStick;
  if (!cueStick || !state.cue?.active || state.mode !== 'aim' || !canShoot()) {
    if (cueStick) cueStick.disabled = true;
    return;
  }
  const t = t2dOf(state.cue);
  const dir = shotDirection();
  const power = state.dragMode === 'charge' ? state.chargePower : 0;
  const pullback = power * CUE_STICK_MAX_PULLBACK;
  const distance = CUE_STICK_TIP_GAP + pullback + CUE_STICK_LENGTH * 0.5;
  const x = t.x - dir[0] * distance;
  const z = t.y - dir[1] * distance;
  const yaw = Math.atan2(-dir[1], dir[0]);
  const transform = cueStick.getComponent(C.CartesianTransform3D);
  transform?.setPosition(x, CUE_STICK_Y, z);
  transform?.setRotation(0, yaw, 0);
  cueStick.disabled = false;
}
function shoot(power) {
  const dir = shotDirection();
  const body = bodyOf(state.cue);
  if (!body) return;
  if (state.cueStick) state.cueStick.disabled = true;
  api.physics.applyImpulse(body, dir[0] * power * MAX_DRAG * IMPULSE_SCALE, dir[1] * power * MAX_DRAG * IMPULSE_SCALE);
  transitionToTopView();
}
function bindInput() {
  if (state.inputBound) return;
  state.inputBound = true;
  api.debug.addDisposer(() => {
    state.inputBound = false;
    state.pointerId = -1;
    state.dragMode = 'none';
  });
  const canvas = api.read.canvas.element;
  state.pointerId = -1;
  state.dragMode = 'none';
  api.debug.listen(canvas, 'pointerdown', (event) => {
    if (state.mode !== 'aim' || !canShoot()) return;
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.chargePower = 0;
    state.dragMode = 'pending';
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  api.debug.listen(canvas, 'pointermove', (event) => {
    if (event.pointerId !== state.pointerId || state.mode !== 'aim') return;
    const dxTotal = event.clientX - state.startX;
    const dyTotal = event.clientY - state.startY;
    if (state.dragMode === 'pending') {
      if (Math.abs(dyTotal) > 10 && dyTotal > Math.abs(dxTotal) * 0.8) state.dragMode = 'charge';
      else if (Math.abs(dxTotal) > 8) state.dragMode = 'orbit';
    }
    if (state.dragMode === 'orbit') {
      const dx = event.clientX - state.lastX;
      state.cameraOrbit.theta -= dx * 0.006;
    } else if (state.dragMode === 'charge') {
      state.chargePower = clamp01(dyTotal / MAX_DRAG);
      setHud(state.potted + ' / 10', 'Power ' + Math.round(state.chargePower * 100) + '%');
    }
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    event.preventDefault();
  });
  const release = (event) => {
    if (event.pointerId !== state.pointerId) return;
    const power = state.chargePower || 0;
    state.pointerId = -1;
    const wasCharge = state.dragMode === 'charge';
    state.dragMode = 'none';
    if (wasCharge && power > 0.04) shoot(power);
    event.preventDefault();
  };
  api.debug.listen(canvas, 'pointerup', release);
  api.debug.listen(canvas, 'pointercancel', release);
  api.debug.listen(canvas, 'wheel', (event) => {
    if (state.mode !== 'aim') return;
    state.cameraOrbit.radius = Math.max(95, Math.min(280, state.cameraOrbit.radius + event.deltaY * 0.18));
    event.preventDefault();
  }, { passive: false });
}

if (!state.initialized) {
  state.initialized = true;
  state.cameraOrbit = api.read.find('Billiards Camera').getComponent(C.SphericalTransform3D);
  state.cueStick = api.read.find('Cue Stick');
  state.mode = 'aim';
  state.balls = collectBalls();
  state.spawnTime = 0;
  newGame();
}
bindInput();

updateCameraTransition();
stopSlowBalls();
checkPockets();
updateShadows();
updateCueStick();
if (state.mode === 'aim' && !state.charging && state.cue?.active) {
  const t = t2dOf(state.cue);
  state.cameraOrbit.setTarget(t.x, BALL_Y, t.y);
}
if (state.mode === 'top' && canShoot() && state.potted < 10) transitionToCueView();
if (state.potted >= 10) setHud('10 / 10', 'Cleared - reload scene to restart');
else if (canShoot() && state.mode === 'aim' && state.dragMode !== 'charge') setHud(state.potted + ' / 10', 'Ready - drag left/right to aim, drag down to shoot');
else if (state.mode !== 'aim') setHud(state.potted + ' / 10', 'Rolling');
`;

const scene = {
  version: 1,
  name: 'Billiards 3D Import Scene',
  globals: {
    designWidth: 1280,
    designHeight: 720,
    clearColor: [0.03, 0.07, 0.06, 1],
    parameters: {
      starterKit: 'billiards-3d',
      description: 'Importable 3D billiards scene. Drag left/right to aim, drag down to charge and release to shoot. Sink 10 red balls.',
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
      velocityIterations: 10,
      positionIterations: 6,
      syncStaticBodiesFromTransform: true,
      priority: 0,
    },
  ],
  resources: {
    geometries: [
      geom(1, 'Unit Rail Box', createBox3D({ width: 1, height: 1, depth: 1 })),
      geom(2, 'Unit Box', createBox3D({ width: 1, height: 1, depth: 1 })),
      geom(3, 'Billiard Ball Sphere', createSphere3D({ radius: BALL_R, widthSegments: 32, heightSegments: 16 })),
      geom(4, 'Pocket Bowl Sphere', createSphere3D({ radius: POCKET_R, widthSegments: 32, heightSegments: 12 })),
      geom(5, 'Ball Shadow Plane', createPlane3D({ width: 1, height: 1, normal: 'y' })),
    ],
    materials: [
      phong(1, 'Cue Ball Material', [0.96, 0.94, 0.86, 1], 0.20, [0.95, 0.95, 0.9, 1], 78),
      phong(2, 'Red Ball Material', [0.86, 0.06, 0.08, 1], 0.20, [0.95, 0.95, 0.9, 1], 78),
      phong(3, 'Wood Rail Material', [0.30, 0.13, 0.05, 1], 0.25, [0.22, 0.18, 0.12, 1], 20),
      phong(4, 'Green Felt Material', [0.04, 0.37, 0.22, 1], 0.25, [0.06, 0.08, 0.06, 1], 8),
      phong(5, 'Pocket Black Material', [0.01, 0.01, 0.01, 1], 0.05, [0.02, 0.02, 0.02, 1], 12),
      phong(6, 'Table Base Material', [0.18, 0.08, 0.035, 1], 0.25, [0.18, 0.12, 0.08, 1], 18),
      radialShadow(7, 'Ball Contact Shadow Material', [0, 0, 0], 0.32, 0.12),
      phong(8, 'Cue Stick Wood Material', [0.74, 0.47, 0.19, 1], 0.22, [0.36, 0.24, 0.12, 1], 28),
    ],
    textures: [],
    models: [],
    prefabs: [],
    scripts: [
      {
        id: 1,
        name: 'Billiards3D GameManager',
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
    entity('Billiards Camera', [
      {
        type: 'Camera3D',
        projectionType: 'perspective',
        fov: Math.PI / 4.2,
        aspect: 1,
        near: 1,
        far: 3000,
        orthoLeft: -1,
        orthoRight: 1,
        orthoTop: 1,
        orthoBottom: -1,
        reverseZ: false,
      },
      sph(175, -Math.PI / 2, Math.PI * 0.45, [-235, BALL_Y, 0]),
    ]),
    entity('HUD Camera 2D', [
      { type: 'Camera2D', width: 1280, height: 720, near: -1000, far: 1000, zoom: 1 },
    ]),
    entity('Ambient Light', [
      { type: 'AmbientLight', color: [1, 1, 1, 1], intensity: 0.34 },
    ]),
    entity('Key Light', [
      { type: 'DirectionalLight', color: [1, 0.96, 0.88, 1], intensity: 1.35, direction: [-0.35, -1, -0.25] },
    ]),
    box('Table Base', 0, -14, 0, TABLE_W + 104, 22, TABLE_H + 104, 6),
    box('Felt', 0, 0, 0, TABLE_W, 8, TABLE_H, 4),
    cueStickEntity(),
    rail('Top Rail', 0, TABLE_H / 2 + 24, TABLE_W + 80, 38),
    rail('Bottom Rail', 0, -TABLE_H / 2 - 24, TABLE_W + 80, 38),
    rail('Left Rail', -TABLE_W / 2 - 24, 0, 38, TABLE_H + 80),
    rail('Right Rail', TABLE_W / 2 + 24, 0, 38, TABLE_H + 80),
    ...[
      [-TABLE_W / 2, -TABLE_H / 2],
      [0, -TABLE_H / 2 - 4],
      [TABLE_W / 2, -TABLE_H / 2],
      [-TABLE_W / 2, TABLE_H / 2],
      [0, TABLE_H / 2 + 4],
      [TABLE_W / 2, TABLE_H / 2],
    ].map(([x, z], i) => pocket(`Pocket ${i + 1}`, x, z)),
    ...rackShadowEntities(),
    ...rackBallEntities(),
    entity('Physics Sync Bootstrap', [
      t2d(0, 0),
      cart([0, BALL_Y, 0]),
      sync3d(),
    ]),
    textEntity('Billiards Score', -620, 304, '0 / 10', 180, 58, 34),
    textEntity('Billiards Status', -420, 304, 'Drag left/right to aim, drag down to shoot', 1040, 58, 30),
    entity('Billiards GameManager', [
      { type: 'KeyboardComponent' },
      { type: 'ScriptComponent', scriptId: 1, scripts: { onUpdate: '', onEntityAddComponent: '', onEntityRemoveComponent: '', onEntityAddToWorld: '', onEntityRemoveFromWorld: '' } },
    ]),
  ],
};

for (const output of OUTPUTS) {
  writeFileSync(output, `${JSON.stringify(scene, null, 2)}\n`);
  console.log(`Wrote ${output.pathname}`);
}
