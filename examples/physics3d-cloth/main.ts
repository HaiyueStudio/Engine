import {
  BasicMaterial,
  Entity,
  Geometry3D,
  Mesh3D,
  System,
  type Scene,
  type World,
} from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import {
  Physics3DBody,
  Physics3DJoint,
  type Physics3DSystem,
} from '@haiyue/engine/physics';
import type { MutablePhysics3DBodyTransform } from '@haiyue/engine/physics/backend';
import {
  addGround,
  addRigidSphere,
  createPhysics3DExample,
  runExample,
  transformAt,
} from '../physics3d-shared';

const COLUMNS = 12;
const ROWS = 9;
const SPACING = 0.75;
const NODE_RADIUS = 0.12;

interface ClothNode {
  entity: Entity;
  body: Physics3DBody;
  initialPosition: [number, number, number];
  pinned: boolean;
}

class ClothWindSystem extends System {
  private elapsed = 0;

  constructor(
    private readonly physics: Physics3DSystem,
    private readonly nodes: readonly ClothNode[],
    private readonly getWind: () => number,
  ) {
    super(() => false);
    this.name = 'ClothWindSystem';
    this.priority = physics.priority - 1;
  }

  override update(_world: World, _time: number, delta: number): this {
    this.elapsed += delta / 1000;
    const wind = Math.max(0, this.getWind());
    if (wind === 0) return this;
    const gust = 0.75 + Math.sin(this.elapsed * 0.85) * 0.25;
    for (const [index, node] of this.nodes.entries()) {
      if (node.pinned) continue;
      const flutter = Math.sin(this.elapsed * 3.1 + index * 0.31);
      this.physics.applyForce(
        node.body,
        wind * (
          flutter * 0.09
          + Math.sin(this.elapsed * 1.2 + index * 0.07) * 0.035
        ),
        wind * Math.cos(this.elapsed * 2.4 + index * 0.19) * 0.025,
        wind * (gust * 0.18 + flutter * 0.055),
      );
    }
    return this;
  }
}

class ClothMeshSyncSystem extends System {
  private readonly scratch: MutablePhysics3DBodyTransform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };

  constructor(
    private readonly physics: Physics3DSystem,
    private readonly nodes: readonly ClothNode[],
    private readonly positions: Float32Array,
    private readonly normals: Float32Array,
    private readonly indices: Uint16Array,
    private readonly geometry: Geometry3D,
  ) {
    super(() => false);
    this.name = 'ClothMeshSyncSystem';
    this.priority = physics.priority + 1;
  }

  override update(_world: World, _time: number, _delta: number): this {
    for (const [index, node] of this.nodes.entries()) {
      if (!this.physics.getBodyTransform(node.body, this.scratch)) continue;
      writePosition(this.positions, index, [
        this.scratch.position.x,
        this.scratch.position.y,
        this.scratch.position.z,
      ]);
    }
    updateNormals(this.positions, this.normals, this.indices);
    this.geometry.markDirty();
    return this;
  }
}

async function main(): Promise<void> {
  const context = await createPhysics3DExample({
    name: 'Physics3DCloth',
    camera: { radius: 17, theta: Math.PI * 0.15, phi: Math.PI * 0.26, target: [0, 1.3, 0] },
  });
  const { scene, physics } = context;

  addGround(scene, [16, 0.5, 13], [0, -3.15, 0]);
  addRigidSphere(
    scene,
    'Cloth obstacle',
    [0, -0.1, 0.35],
    2.05,
    [0.12, 0.38, 0.82, 1],
    { type: 'static', friction: 0.55, categoryBits: 0x0001, maskBits: 0x0002 },
  );

  const nodes: ClothNode[] = [];
  const positions = new Float32Array(COLUMNS * ROWS * 3);
  const normals = new Float32Array(positions.length);
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const position: [number, number, number] = [
        (column - (COLUMNS - 1) * 0.5) * SPACING,
        5,
        (row - (ROWS - 1) * 0.5) * SPACING,
      ];
      const pinned = row === 0 && (column % 2 === 0 || column === COLUMNS - 1);
      const entity = new Entity(`Cloth node ${column}:${row}`);
      entity.addComponent(transformAt(position));
      const body = new Physics3DBody({
        type: pinned ? 'static' : 'dynamic',
        shape: 'sphere',
        radius: NODE_RADIUS,
        density: 18,
        friction: 0.42,
        restitution: 0.02,
        linearDamping: 0.16,
        angularDamping: 0.4,
        categoryBits: 0x0002,
        maskBits: 0x0001,
        lockRotations: [true, true, true],
      });
      entity.addComponent(body);
      scene.add(entity);
      nodes.push({ entity, body, initialPosition: position, pinned });
      writePosition(positions, nodeIndex(column, row), position);
    }
  }

  let jointCount = 0;
  const connect = (
    columnA: number,
    rowA: number,
    columnB: number,
    rowB: number,
    stiffness: number,
  ) => {
    const nodeA = nodes[nodeIndex(columnA, rowA)]!;
    const nodeB = nodes[nodeIndex(columnB, rowB)]!;
    const dx = (columnB - columnA) * SPACING;
    const dz = (rowB - rowA) * SPACING;
    const joint = new Entity(`Cloth spring ${jointCount++}`);
    joint.addComponent(new Physics3DJoint({
      type: 'spring',
      bodyA: nodeA.entity,
      bodyB: nodeB.entity,
      restLength: Math.hypot(dx, dz),
      stiffness,
      damping: 1.35,
      collideConnected: false,
    }));
    scene.add(joint);
  };

  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      if (column + 1 < COLUMNS) connect(column, row, column + 1, row, 34);
      if (row + 1 < ROWS) connect(column, row, column, row + 1, 34);
      if (column + 1 < COLUMNS && row + 1 < ROWS) {
        connect(column, row, column + 1, row + 1, 24);
        connect(column + 1, row, column, row + 1, 24);
      }
    }
  }

  const indices = createClothIndices();
  updateNormals(positions, normals, indices);
  const geometry = new Geometry3D({
    positions,
    normals,
    indices,
    cullMode: 'none',
    boundsMode: 'manual',
    localBounds: { center: [0, 1, 0], radius: 18 },
  });
  const cloth = new Entity('Rendered cloth surface');
  cloth.addComponent(new Transform3D());
  cloth.addComponent(new Mesh3D(
    geometry,
    new BasicMaterial({
      color: [0.08, 0.68, 1, 1],
      emissiveFactor: [0.16, 0.38, 0.7],
      blending: 'none',
      depthWrite: true,
      cullMode: 'none',
    }),
  ));
  scene.add(cloth);

  let wind = 1.6;
  createClothSystems(physics, scene, nodes, positions, normals, indices, geometry, () => wind);

  const windInput = document.querySelector<HTMLInputElement>('#wind')!;
  const windOutput = document.querySelector<HTMLOutputElement>('#wind-value')!;
  windInput.addEventListener('input', () => {
    wind = Number(windInput.value);
    if (wind > 0) {
      for (const node of nodes) {
        if (!node.pinned) physics.setBodyAwake(node.body, true);
      }
    }
    windOutput.value = wind.toFixed(1);
  });
  document.querySelector<HTMLElement>('#constraint-count')!.textContent = String(jointCount);

  document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
    for (const node of nodes) {
      physics.teleportBody(node.body, node.initialPosition, [0, 0, 0, 1]);
      physics.setLinearVelocity(node.body, 0, 0, 0);
      physics.setAngularVelocity(node.body, 0, 0, 0);
    }
  });

  runExample(context);
}

function createClothSystems(
  physics: Physics3DSystem,
  scene: Scene,
  nodes: readonly ClothNode[],
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint16Array,
  geometry: Geometry3D,
  getWind: () => number,
): void {
  scene.addSystem(new ClothWindSystem(physics, nodes, getWind), false);
  scene.addSystem(new ClothMeshSyncSystem(
    physics,
    nodes,
    positions,
    normals,
    indices,
    geometry,
  ), false);
}

function nodeIndex(column: number, row: number): number {
  return row * COLUMNS + column;
}

function writePosition(
  positions: Float32Array,
  index: number,
  value: readonly [number, number, number],
): void {
  const offset = index * 3;
  positions[offset] = value[0];
  positions[offset + 1] = value[1];
  positions[offset + 2] = value[2];
}

function createClothIndices(): Uint16Array {
  const values: number[] = [];
  for (let row = 0; row + 1 < ROWS; row++) {
    for (let column = 0; column + 1 < COLUMNS; column++) {
      const a = nodeIndex(column, row);
      const b = nodeIndex(column + 1, row);
      const c = nodeIndex(column, row + 1);
      const d = nodeIndex(column + 1, row + 1);
      values.push(a, c, b, b, c, d);
    }
  }
  return new Uint16Array(values);
}

function updateNormals(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint16Array,
): void {
  normals.fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const a = (indices[i] ?? 0) * 3;
    const b = (indices[i + 1] ?? 0) * 3;
    const c = (indices[i + 2] ?? 0) * 3;
    const abx = (positions[b] ?? 0) - (positions[a] ?? 0);
    const aby = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0);
    const abz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0);
    const acx = (positions[c] ?? 0) - (positions[a] ?? 0);
    const acy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0);
    const acz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const offset of [a, b, c]) {
      normals[offset] = (normals[offset] ?? 0) + nx;
      normals[offset + 1] = (normals[offset + 1] ?? 0) + ny;
      normals[offset + 2] = (normals[offset + 2] ?? 0) + nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i] ?? 0;
    const y = normals[i + 1] ?? 0;
    const z = normals[i + 2] ?? 0;
    const inverseLength = 1 / Math.max(Math.hypot(x, y, z), 0.00001);
    normals[i] = x * inverseLength;
    normals[i + 1] = y * inverseLength;
    normals[i + 2] = z * inverseLength;
  }
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
