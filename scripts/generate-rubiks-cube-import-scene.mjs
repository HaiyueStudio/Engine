import { writeFileSync } from 'node:fs';

const OUT = new URL('../editor/scene-examples/rubiks-cube-3d-import.scene.json', import.meta.url);

function roundedPlaneGeometry(id, name, size = 1, radius = 0.16, segments = 5) {
  const half = size / 2;
  const r = Math.min(radius, half);
  const centers = [
    [half - r, half - r, 0, 0],
    [-(half - r), half - r, Math.PI / 2, 0],
    [-(half - r), -(half - r), Math.PI, 0],
    [half - r, -(half - r), Math.PI * 1.5, 0],
  ];
  const outline = [];
  for (const [cx, cy, start] of centers) {
    for (let i = 0; i <= segments; i++) {
      const a = start + (i / segments) * Math.PI * 0.5;
      outline.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  const positions = [0, 0, 0];
  const normals = [0, 0, 1];
  const uvs = [0.5, 0.5];
  for (const [x, y] of outline) {
    positions.push(x, y, 0);
    normals.push(0, 0, 1);
    uvs.push(x / size + 0.5, 0.5 - y / size);
  }
  const indices = [];
  for (let i = 1; i <= outline.length; i++) {
    indices.push(0, i, i === outline.length ? 1 : i + 1);
  }
  return {
    id,
    name,
    positions,
    normals,
    textureCoordinates: [{ set: 0, data: uvs }],
    textureCoordinateLayout: [0],
    indices,
    indexType: 'uint16',
    topology: 'triangle-list',
    cullMode: 'back',
    frontFace: 'ccw',
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

function textEntity(name, x, y, text, width, height, fontSize, color = '#f8fafc') {
  return entity(name, [
    t2d(x, y),
    {
      type: 'CanvasTextComponent',
      text,
      style: {
        width,
        height,
        resolutionScale: 2,
        backgroundColor: name.includes('Button') ? 'rgba(15, 23, 42, 0.84)' : 'rgba(2, 6, 23, 0.48)',
        borderColor: 'rgba(148, 163, 184, 0.35)',
        borderWidth: 1,
        borderRadius: 10,
        padding: [8, 12],
        textAlign: 'center',
        verticalAlign: 'middle',
        fontSize,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        fontWeight: '700',
        lineHeight: 1.15,
        color,
        whiteSpace: 'normal',
      },
    },
  ]);
}

const gameScript = String.raw`
const C = api.read.components;
const state = component.__rubiks || (component.__rubiks = {});

const SIZE = 3;
const BODY_SIZE = 0.96;
const BASE_CUBIE_GAP = 0.12;
const CUBIE_GAP = BASE_CUBIE_GAP * 0.3;
const SPACING = BODY_SIZE + CUBIE_GAP;
const BODY_RADIUS = 0.12;
const STICKER = BODY_SIZE - BODY_RADIUS * BODY_SIZE;
const STICKER_RADIUS = 0.16;
const STICKER_SEGMENTS = 10;
const FACE_OFFSET = 0.496;
const CUBE_BOUND = SPACING + FACE_OFFSET + 0.08;
const TURN_MS = 185;
const AUTO_DELAY = 40;
const SCRAMBLE_COUNT = 24;
const FACE_COLORS = [
  [1.00, 1.00, 1.00, 1], // +X white
  [1.00, 0.88, 0.05, 1], // -X yellow
  [0.10, 0.42, 1.00, 1], // +Y blue
  [0.10, 0.78, 0.30, 1], // -Y green
  [1.00, 0.16, 0.10, 1], // +Z red
  [1.00, 0.52, 0.05, 1], // -Z orange
];
const FACE_DEFS = [
  { name: '+X', normal: [1, 0, 0], rot: [0, Math.PI / 2, 0] },
  { name: '-X', normal: [-1, 0, 0], rot: [0, -Math.PI / 2, 0] },
  { name: '+Y', normal: [0, 1, 0], rot: [-Math.PI / 2, 0, 0] },
  { name: '-Y', normal: [0, -1, 0], rot: [Math.PI / 2, 0, 0] },
  { name: '+Z', normal: [0, 0, 1], rot: [0, 0, 0] },
  { name: '-Z', normal: [0, 0, -1], rot: [0, Math.PI, 0] },
];
const BUTTONS = [
  { id: 'scramble', label: 'Scramble', x: 418, y: 650, w: 140, h: 46 },
  { id: 'solve', label: 'Auto Solve', x: 570, y: 650, w: 154, h: 46 },
  { id: 'reset', label: 'Reset', x: 742, y: 650, w: 140, h: 46 },
];

function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function vlen(a) { return Math.hypot(a[0], a[1], a[2]) || 1; }
function vnorm(a) { const l = vlen(a); return [a[0] / l, a[1] / l, a[2] / l]; }
function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function axisIndex(axis) { return axis === 'x' ? 0 : axis === 'y' ? 1 : 2; }
function axisNameFromVector(v) {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
  if (ax >= ay && ax >= az) return 'x';
  if (ay >= az) return 'y';
  return 'z';
}
function axisVector(axis, sign = 1) {
  return axis === 'x' ? [sign, 0, 0] : axis === 'y' ? [0, sign, 0] : [0, 0, sign];
}
function axisVectorByIndex(index, sign = 1) {
  return index === 0 ? [sign, 0, 0] : index === 1 ? [0, sign, 0] : [0, 0, sign];
}
function identity3() { return [1,0,0, 0,1,0, 0,0,1]; }
function rot3(axis, quarter) {
  const q = ((quarter % 4) + 4) % 4;
  if (q === 0) return identity3();
  if (axis === 'x') return q === 1 ? [1,0,0, 0,0,-1, 0,1,0] : q === 2 ? [1,0,0, 0,-1,0, 0,0,-1] : [1,0,0, 0,0,1, 0,-1,0];
  if (axis === 'y') return q === 1 ? [0,0,1, 0,1,0, -1,0,0] : q === 2 ? [-1,0,0, 0,1,0, 0,0,-1] : [0,0,-1, 0,1,0, 1,0,0];
  return q === 1 ? [0,-1,0, 1,0,0, 0,0,1] : q === 2 ? [-1,0,0, 0,-1,0, 0,0,1] : [0,1,0, -1,0,0, 0,0,1];
}
function mul3(a, b) {
  return [
    a[0]*b[0]+a[1]*b[3]+a[2]*b[6], a[0]*b[1]+a[1]*b[4]+a[2]*b[7], a[0]*b[2]+a[1]*b[5]+a[2]*b[8],
    a[3]*b[0]+a[4]*b[3]+a[5]*b[6], a[3]*b[1]+a[4]*b[4]+a[5]*b[7], a[3]*b[2]+a[4]*b[5]+a[5]*b[8],
    a[6]*b[0]+a[7]*b[3]+a[8]*b[6], a[6]*b[1]+a[7]*b[4]+a[8]*b[7], a[6]*b[2]+a[7]*b[5]+a[8]*b[8],
  ];
}
function apply3(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
}
function rotAxisAngle(axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (axis === 'x') return [1,0,0, 0,c,-s, 0,s,c];
  if (axis === 'y') return [c,0,s, 0,1,0, -s,0,c];
  return [c,-s,0, s,c,0, 0,0,1];
}
function composeMatrix(position, rotation3, scale = STICKER) {
  return new Float32Array([
    rotation3[0] * scale, rotation3[3] * scale, rotation3[6] * scale, 0,
    rotation3[1] * scale, rotation3[4] * scale, rotation3[7] * scale, 0,
    rotation3[2] * scale, rotation3[5] * scale, rotation3[8] * scale, 0,
    position[0], position[1], position[2], 1,
  ]);
}
function hiddenMatrix() {
  return composeMatrix([99999, 99999, 99999], identity3(), 0);
}
function euler3(rx, ry, rz) {
  return mul3(mul3(rotAxisAngle('z', rz), rotAxisAngle('y', ry)), rotAxisAngle('x', rx));
}
function faceBasis(face) {
  const n = face.normal;
  if (n[2] === 1) return { u: [1,0,0], v: [0,1,0] };
  if (n[2] === -1) return { u: [-1,0,0], v: [0,1,0] };
  if (n[0] === 1) return { u: [0,0,-1], v: [0,1,0] };
  if (n[0] === -1) return { u: [0,0,1], v: [0,1,0] };
  if (n[1] === 1) return { u: [1,0,0], v: [0,0,-1] };
  return { u: [1,0,0], v: [0,0,1] };
}
function updateHud(text) {
  api.scene.setText('Rubiks Status', text);
}
function createRoundedGeometry() {
  const half = 0.5;
  const r = Math.min(STICKER_RADIUS, half);
  const centers = [
    [half - r, half - r, 0],
    [-(half - r), half - r, Math.PI / 2],
    [-(half - r), -(half - r), Math.PI],
    [half - r, -(half - r), Math.PI * 1.5],
  ];
  const outline = [];
  for (const [cx, cy, start] of centers) {
    for (let i = 0; i <= STICKER_SEGMENTS; i++) {
      const a = start + (i / STICKER_SEGMENTS) * Math.PI * 0.5;
      outline.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  const positions = [0, 0, 0];
  const normals = [0, 0, 1];
  const uvs = [0.5, 0.5];
  for (const [x, y] of outline) {
    positions.push(x, y, 0);
    normals.push(0, 0, 1);
    uvs.push(x + 0.5, 0.5 - y);
  }
  const indices = [];
  for (let i = 1; i <= outline.length; i++) indices.push(0, i, i === outline.length ? 1 : i + 1);
  return new C.Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: new Uint16Array(indices),
    cullMode: 'back',
  });
}
function createCubies() {
  const cubies = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        cubies.push({ home: [x, y, z], coord: [x, y, z], orient: identity3() });
      }
    }
  }
  return cubies;
}
function hasSticker(cubie, face) {
  const n = face.normal;
  if (n[0] !== 0) return cubie.home[0] === n[0];
  if (n[1] !== 0) return cubie.home[1] === n[1];
  return cubie.home[2] === n[2];
}
function ensureInstancedScene() {
  const camera = api.read.find('Rubiks Camera');
  if (!api.read.getSystem('InstancedMesh3DRenderSystem')) {
    world.addSystem(new C.InstancedMesh3DRenderSystem(api.read.engine, camera, { loadOp: 'load', priority: 2 }));
  }
  state.hiddenTransform = hiddenMatrix();
  const bodyGeometry = C.createRoundedBox3D({
    width: 1,
    height: 1,
    depth: 1,
    radius: BODY_RADIUS,
    segments: 4,
  });
  state.bodyMaterial = new C.InstancedMaterial(27);
  for (let i = 0; i < 27; i++) state.bodyMaterial.setColor(i, 0.005, 0.006, 0.008, 1);
  state.bodyEntity = api.scene.createEntity('Rubiks Black Rounded Body Instances');
  state.bodyEntity.addComponent(new C.InstancedMesh3D(bodyGeometry, state.bodyMaterial));

  const geometry = createRoundedGeometry();
  state.materials = [];
  state.faceEntities = [];
  for (let f = 0; f < FACE_DEFS.length; f++) {
    const material = new C.InstancedMaterial(27);
    const color = FACE_COLORS[f];
    for (let i = 0; i < 27; i++) material.setColor(i, color[0], color[1], color[2], color[3]);
    const e = api.scene.createEntity('Rubiks Face Instances ' + FACE_DEFS[f].name);
    e.addComponent(new C.InstancedMesh3D(geometry, material));
    state.materials.push(material);
    state.faceEntities.push(e);
  }
}
function renderCubies() {
  let active = state.activeMove;
  if (active) {
    const k = clamp((api.debug.performance.now() - active.startTime) / active.duration, 0, 1);
    if (k >= 1) {
      finishMove();
      active = null;
    }
  }
  for (let i = 0; i < state.cubies.length; i++) {
    const cubie = state.cubies[i];
    let coord = cubie.coord;
    let orient = cubie.orient;
    if (active && cubie.coord[axisIndex(active.axis)] === active.layer) {
      const k = clamp((api.debug.performance.now() - active.startTime) / active.duration, 0, 1);
      const eased = k * k * (3 - 2 * k);
      const angle = active.quarter * Math.PI * 0.5 * eased;
      const r = rotAxisAngle(active.axis, angle);
      coord = apply3(r, cubie.coord);
      orient = mul3(r, cubie.orient);
    }
    const base = vscale(coord, SPACING);
    state.bodyMaterial.setTransform(i, composeMatrix(base, orient, BODY_SIZE));
    for (let f = 0; f < FACE_DEFS.length; f++) {
      const face = FACE_DEFS[f];
      if (!hasSticker(cubie, face)) {
        state.materials[f].setTransform(i, state.hiddenTransform);
        continue;
      }
      const localRot = euler3(face.rot[0], face.rot[1], face.rot[2]);
      const rot = mul3(orient, localRot);
      const faceNormal = apply3(orient, face.normal);
      const pos = vadd(base, vscale(faceNormal, FACE_OFFSET));
      state.materials[f].setTransform(i, composeMatrix(pos, rot, STICKER));
    }
  }
}
function finishMove() {
  const m = state.activeMove;
  if (!m) return;
  const r = rot3(m.axis, m.quarter);
  for (const cubie of state.cubies) {
    if (cubie.coord[axisIndex(m.axis)] !== m.layer) continue;
    const next = apply3(r, cubie.coord).map(v => Math.round(v));
    cubie.coord = next;
    cubie.orient = mul3(r, cubie.orient);
  }
  state.activeMove = null;
  if (m.record) state.history.push({ axis: m.axis, layer: m.layer, quarter: m.quarter });
}
function queueMove(axis, layer, quarter, record = true) {
  if (state.activeMove) return false;
  state.activeMove = { axis, layer, quarter, record, startTime: api.debug.performance.now(), duration: TURN_MS };
  return true;
}
function resetCube() {
  state.cubies = createCubies();
  state.history = [];
  state.solveQueue = [];
  state.activeMove = null;
  state.mode = 'manual';
  updateHud('Ready: drag a row or column to turn it.');
  renderCubies();
}
function randomMove(prev) {
  const axes = ['x', 'y', 'z'];
  let axis = axes[Math.floor(Math.random() * axes.length)];
  if (prev && prev.axis === axis) axis = axes[(axes.indexOf(axis) + 1 + Math.floor(Math.random() * 2)) % 3];
  const layer = Math.random() < 0.5 ? -1 : 1;
  const quarter = Math.random() < 0.5 ? -1 : 1;
  return { axis, layer, quarter };
}
function scramble() {
  if (state.activeMove) return;
  state.solveQueue = [];
  let prev = null;
  for (let i = 0; i < SCRAMBLE_COUNT; i++) {
    const m = randomMove(prev);
    state.solveQueue.push({ ...m, record: true });
    prev = m;
  }
  state.mode = 'scramble';
  updateHud('Scrambling...');
}
function autoSolve() {
  if (state.activeMove) return;
  state.solveQueue = state.history.slice().reverse().map(m => ({ axis: m.axis, layer: m.layer, quarter: -m.quarter, record: false }));
  state.mode = 'solve';
  updateHud(state.solveQueue.length ? 'Auto restoring...' : 'Already solved.');
}
function runQueuedMoves() {
  if (state.activeMove || !state.solveQueue.length) {
    if (!state.activeMove && (state.mode === 'solve' || state.mode === 'scramble') && !state.solveQueue.length) {
      state.mode = 'manual';
      if (isSolved()) updateHud('Solved.');
      else updateHud('Ready.');
    }
    return;
  }
  const m = state.solveQueue.shift();
  queueMove(m.axis, m.layer, m.quarter, m.record);
}
function isSolved() {
  return state.cubies.every(c => c.coord[0] === c.home[0] && c.coord[1] === c.home[1] && c.coord[2] === c.home[2] && c.orient.every((v, i) => v === identity3()[i]));
}
function canvasPoint(event) {
  const rect = api.read.canvas.element.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width * 1280,
    y: (event.clientY - rect.top) / rect.height * 720,
  };
}
function hitButton(p) {
  return BUTTONS.find(b => p.x >= b.x - b.w * 0.5 && p.x <= b.x + b.w * 0.5 && p.y >= b.y - b.h * 0.5 && p.y <= b.y + b.h * 0.5) || null;
}
function getCameraBasis() {
  const orbit = state.cameraOrbit;
  const eye = orbit.eyePosition || [6, 5, 6];
  const target = orbit.target || [0, 0, 0];
  const forward = vnorm(vsub(target, eye));
  let right = vnorm(vcross(forward, [0, 1, 0]));
  if (vlen(right) < 0.001) right = [1, 0, 0];
  const up = vnorm(vcross(right, forward));
  return { eye, forward, right, up };
}
function pointerRay(event) {
  const rect = api.read.canvas.element.getBoundingClientRect();
  const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
  const basis = getCameraBasis();
  const aspect = rect.width / rect.height;
  const tan = Math.tan(Math.PI / 8);
  const dir = vnorm(vadd(vadd(basis.forward, vscale(basis.right, ndcX * tan * aspect)), vscale(basis.up, ndcY * tan)));
  return { origin: basis.eye, dir };
}
function intersectCubeBounds(origin, dir) {
  let tMin = -Infinity;
  let tMax = Infinity;
  let normal = [0, 0, 1];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(dir[axis]) < 0.00001) {
      if (origin[axis] < -CUBE_BOUND || origin[axis] > CUBE_BOUND) return null;
      continue;
    }
    let t1 = (-CUBE_BOUND - origin[axis]) / dir[axis];
    let t2 = ( CUBE_BOUND - origin[axis]) / dir[axis];
    let n1 = axisVectorByIndex(axis, -1);
    let n2 = axisVectorByIndex(axis,  1);
    if (t1 > t2) {
      const t = t1; t1 = t2; t2 = t;
      const n = n1; n1 = n2; n2 = n;
    }
    if (t1 > tMin) {
      tMin = t1;
      normal = n1;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  const dist = tMin > 0 ? tMin : tMax;
  if (dist <= 0) return null;
  return { dist, normal };
}
function pickCube(event) {
  const ray = pointerRay(event);
  const hitInfo = intersectCubeBounds(ray.origin, ray.dir);
  if (!hitInfo) return null;
  const hit = vadd(ray.origin, vscale(ray.dir, hitInfo.dist));
  const normal = hitInfo.normal;
  const face = FACE_DEFS.find(f => f.normal[0] === normal[0] && f.normal[1] === normal[1] && f.normal[2] === normal[2]) || FACE_DEFS[4];
  const fb = faceBasis(face);
  return { hit, normal, face, u: fb.u, v: fb.v };
}
function projectWorld(p) {
  const basis = getCameraBasis();
  const rel = vsub(p, basis.eye);
  const z = vdot(rel, basis.forward);
  if (z <= 0.001) return [0, 0];
  const f = 1 / Math.tan(Math.PI / 8);
  return [vdot(rel, basis.right) * f / z, vdot(rel, basis.up) * f / z];
}
function beginDrag(event) {
  const hit = pickCube(event);
  if (hit && !state.activeMove && state.mode === 'manual') {
    state.drag = { type: 'cube', startX: event.clientX, startY: event.clientY, hit };
  } else {
    state.drag = {
      type: 'orbit',
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      theta: state.cameraOrbit.theta,
      phi: state.cameraOrbit.phi,
    };
  }
}
function updateDrag(event) {
  if (!state.drag) return;
  if (state.drag.type === 'orbit') {
    const dx = event.clientX - state.drag.lastX;
    const dy = event.clientY - state.drag.lastY;
    state.cameraOrbit.theta -= dx * 0.006;
    state.cameraOrbit.phi = clamp(state.cameraOrbit.phi - dy * 0.005, 0.16, Math.PI - 0.16);
    state.drag.lastX = event.clientX;
    state.drag.lastY = event.clientY;
    event.preventDefault();
    return;
  }
  if (state.activeMove) return;
  const dx = event.clientX - state.drag.startX;
  const dy = event.clientY - state.drag.startY;
  if (Math.hypot(dx, dy) < 18) return;
  const hit = state.drag.hit;
  const origin = hit.hit;
  const pu = projectWorld(vadd(origin, hit.u));
  const pv = projectWorld(vadd(origin, hit.v));
  const p0 = projectWorld(origin);
  const su = [pu[0] - p0[0], -(pu[1] - p0[1])];
  const sv = [pv[0] - p0[0], -(pv[1] - p0[1])];
  const du = dx * su[0] + dy * su[1];
  const dv = dx * sv[0] + dy * sv[1];
  const useU = Math.abs(du) >= Math.abs(dv);
  const tangent = vscale(useU ? hit.u : hit.v, Math.sign(useU ? du : dv) || 1);
  const axisVec = vnorm(vcross(hit.normal, tangent));
  const axis = axisNameFromVector(axisVec);
  const layerCoord = hit.hit[axisIndex(axis)] / SPACING;
  const layer = clamp(Math.round(layerCoord), -1, 1);
  const quarter = axisVec[axisIndex(axis)] >= 0 ? 1 : -1;
  state.drag = null;
  queueMove(axis, layer, quarter, true);
  updateHud('Turn ' + axis.toUpperCase() + ' layer ' + layer);
}
function bindInput() {
  if (state.inputBound) return;
  state.inputBound = true;
  api.debug.addDisposer(() => {
    state.inputBound = false;
    state.drag = null;
  });
  const canvas = api.read.canvas.element;
  api.debug.listen(canvas, 'pointerdown', event => {
    const p = canvasPoint(event);
    const button = hitButton(p);
    if (button) {
      if (button.id === 'scramble') scramble();
      else if (button.id === 'solve') autoSolve();
      else resetCube();
      event.preventDefault();
      return;
    }
    beginDrag(event);
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  api.debug.listen(canvas, 'pointermove', event => {
    updateDrag(event);
  });
  api.debug.listen(canvas, 'pointerup', event => {
    state.drag = null;
    canvas.releasePointerCapture?.(event.pointerId);
  });
  api.debug.listen(canvas, 'pointercancel', event => {
    state.drag = null;
    canvas.releasePointerCapture?.(event.pointerId);
  });
  api.debug.listen(window, 'keydown', event => {
    if (event.key.toLowerCase() === 's') scramble();
    if (event.key.toLowerCase() === 'r') resetCube();
    if (event.key === ' ') autoSolve();
  });
}

if (!state.initialized) {
  state.initialized = true;
  state.cameraOrbit = api.read.find('Rubiks Camera').getComponent(C.SphericalTransform3D);
  state.history = [];
  state.solveQueue = [];
  state.mode = 'manual';
  state.cubies = createCubies();
  ensureInstancedScene();
  updateHud('Ready: drag a row or column. S scramble, Space solve, R reset.');
  renderCubies();
}
bindInput();

runQueuedMoves();
renderCubies();
`;

const scene = {
  version: 1,
  name: 'Rubiks Cube 3D Import Scene',
  globals: {
    designWidth: 1280,
    designHeight: 720,
    clearColor: [0.78, 0.80, 0.84, 1],
    reverseZ: true,
    parameters: {
      starterKit: 'rubiks-cube-3d',
      runScriptsInEditor: true,
      description: 'Importable 3x3 Rubiks cube scene. Uses six instanced rounded-square face batches. Drag cube rows or columns, scramble, and auto restore.',
    },
    inputMap: {},
  },
  systems: [],
  resources: {
    geometries: [
      roundedPlaneGeometry(1, 'Rounded Sticker Plane'),
    ],
    materials: [],
    textures: [],
    scripts: [
      {
        id: 1,
        name: 'Rubiks Cube Runtime',
        scripts: {
          onUpdate: gameScript,
          onEntityAddComponent: '',
          onEntityRemoveComponent: '',
          onEntityAddToWorld: '',
          onEntityRemoveFromWorld: '',
        },
      },
    ],
    prefabs: [],
  },
  entities: [
    entity('Rubiks Camera', [
      { type: 'Camera3D', projectionType: 'perspective', fov: Math.PI / 4, aspect: 1280 / 720, near: 0.1, far: 1000, orthoLeft: -10, orthoRight: 10, orthoTop: 10, orthoBottom: -10, reverseZ: true },
      sph(8.4, Math.PI * 0.24, Math.PI * 0.32, [0, 0, 0]),
    ]),
    entity('Rubiks HUD Camera2D', [
      { type: 'Camera2D', width: 1280, height: 720, near: -1000, far: 1000, zoom: 1 },
    ]),
    entity('Rubiks Ambient Light', [
      { type: 'AmbientLight', color: [1, 1, 1, 1], intensity: 0.55 },
    ]),
    entity('Rubiks Key Light', [
      cart([0, 0, 0]),
      { type: 'DirectionalLight', color: [1, 1, 1, 1], intensity: 1.45, direction: [-0.4, -0.75, -0.55] },
    ]),
    textEntity('Rubiks Title', 640, 42, '3x3 Rubiks Cube', 360, 42, 22),
    textEntity('Rubiks Status', 640, 94, 'Loading...', 680, 42, 16, '#dbeafe'),
    textEntity('Rubiks Button Scramble', 418, 650, 'Scramble', 140, 46, 16),
    textEntity('Rubiks Button Solve', 570, 650, 'Auto Solve', 154, 46, 16),
    textEntity('Rubiks Button Reset', 742, 650, 'Reset', 140, 46, 16),
    entity('Rubiks Game Controller', [
      { type: 'ScriptComponent', scriptId: 1, scripts: {} },
      { type: 'DataComponent', data: {
        note: 'Runtime builds six InstancedMesh3D rounded-square face batches. Default colors represent replaceable face textures: white, yellow, blue, green, red, orange.',
      } },
    ]),
  ],
};

writeFileSync(OUT, `${JSON.stringify(scene, null, 2)}\n`);
console.log(`Wrote ${OUT.pathname}`);
