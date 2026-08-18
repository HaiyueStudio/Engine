import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry3D } from '../dist/geometry.js';
import { NavMesh, NavMeshPath } from '../dist/navigation.js';

function createNarrowPassage() {
  const columns = 9;
  const rows = 7;
  const heights = new Float32Array(columns * rows);
  const walkable = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (column <= 2 || column >= 6 || row === 3) walkable[row * columns + column] = 1;
    }
  }
  return new NavMesh({ origin: [0, 0], cellSize: 1, columns, rows, heights, walkable });
}

test('NavMesh rasterizes geometry and filters surfaces above max slope', () => {
  const geometry = new Geometry3D({
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 0, 1,
      1, 0, 0, 2, 2, 0, 1, 0, 1,
    ]),
  });
  const navMesh = NavMesh.fromGeometry(geometry, {
    cellSize: 0.2,
    maxSlopeRadians: Math.PI / 6,
    maxStepHeight: 0.3,
    boundsPadding: 0,
  });

  assert.equal(navMesh.isPositionWalkable([0.25, 0, 0.25], { radius: 0 }), true);
  assert.equal(navMesh.isPositionWalkable([1.25, 0.5, 0.25], { radius: 0 }), false);
});

test('NavMesh shares one mesh across agent radii and rejects a too-wide agent', () => {
  const navMesh = createNarrowPassage();
  const start = [1.5, 0, 3.5];
  const target = [7.5, 0, 3.5];
  const smallPath = navMesh.findPath(start, target, { radius: 0.35 });
  const largePath = navMesh.findPath(start, target, { radius: 0.6 });

  assert.equal(smallPath.status, 'complete');
  assert.equal(smallPath.reachedTarget, true);
  assert.ok(smallPath.pointCount >= 2);
  assert.equal(largePath.status, 'partial');
  assert.ok(largePath.resolvedTarget[0] < 3.5);
});

test('NavMesh dynamic circular obstacles block paths and can be ignored by owner id', () => {
  const navMesh = createNarrowPassage();
  navMesh.setObstacle({ id: 'blocker', position: [4.5, 0, 3.5], radius: 0.3 });
  const path = new NavMeshPath();

  navMesh.findPath([1.5, 0, 3.5], [7.5, 0, 3.5], { radius: 0.3 }, path);
  assert.equal(path.status, 'partial');

  navMesh.findPath(
    [1.5, 0, 3.5],
    [7.5, 0, 3.5],
    { radius: 0.3, ignoreObstacleIds: new Set(['blocker']) },
    path,
  );
  assert.equal(path.status, 'complete');
});

test('NavMesh projects an invalid target to the closest reachable point', () => {
  const navMesh = createNarrowPassage();
  const path = navMesh.findPath([1.5, 0, 1.5], [4.5, 0, 1.5], { radius: 0.25 });

  assert.equal(path.status, 'partial');
  assert.equal(path.reachedTarget, false);
  assert.ok(path.pointCount >= 1);
  assert.ok(Math.abs(path.resolvedTarget[0] - 2.5) < 1e-6);
  assert.ok(Math.abs(path.resolvedTarget[2] - 1.5) < 1e-6);
});

test('NavMesh distinguishes a local hole from nearest-point projection and routes around it', () => {
  const columns = 7;
  const rows = 7;
  const heights = new Float32Array(columns * rows);
  const walkable = new Uint8Array(columns * rows).fill(1);
  for (let row = 2; row <= 4; row++) {
    for (let column = 2; column <= 4; column++) {
      heights[row * columns + column] = Number.NaN;
      walkable[row * columns + column] = 0;
    }
  }
  const navMesh = new NavMesh({ origin: [0, 0], cellSize: 1, columns, rows, heights, walkable });
  const local = new Float32Array(3);

  assert.equal(navMesh.sampleSurface([3.5, 4, 3.5], { radius: 0 }, local), null);
  assert.equal(navMesh.isPositionWalkable([3.5, 0, 3.5], { radius: 0 }), false);
  assert.deepEqual(Array.from(navMesh.sampleSurface([1.25, 8, 3.5], { radius: 0 }, local)), [1.25, 0, 3.5]);
  assert.notEqual(navMesh.projectPoint([3.5, 4, 3.5], { radius: 0 }, local), null);

  const path = navMesh.findPath([0.5, 0, 3.5], [6.5, 0, 3.5], { radius: 0 });
  assert.equal(path.status, 'complete');
  assert.ok(path.pointCount >= 3, 'a smoothed path must retain a corner around the hole');
  for (let index = 0; index < path.pointCount; index++) {
    const offset = index * 3;
    assert.equal(
      navMesh.sampleSurface([path.points[offset], path.points[offset + 1], path.points[offset + 2]], { radius: 0 }, local) !== null,
      true,
    );
  }
});

test('NavMesh geometry rasterization preserves an omitted floor opening as a hole', () => {
  const positions = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      if (row === 1 && column === 1) continue;
      const x = column;
      const z = row;
      positions.push(
        x, 0, z, x, 0, z + 1, x + 1, 0, z,
        x + 1, 0, z, x, 0, z + 1, x + 1, 0, z + 1,
      );
    }
  }
  const navMesh = NavMesh.fromGeometry(new Geometry3D({ positions: new Float32Array(positions) }), {
    cellSize: 0.25,
    maxSlopeRadians: Math.PI / 4,
    boundsPadding: 0,
  });

  assert.equal(navMesh.sampleSurface([1.5, 0, 1.5], { radius: 0 }), null);
  assert.notEqual(navMesh.sampleSurface([0.5, 0, 1.5], { radius: 0 }), null);
});
