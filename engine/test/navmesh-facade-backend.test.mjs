import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry3D } from '../dist/geometry.js';
import * as navigation from '../dist/navigation.js';

const { NavMesh, NavMeshPath } = navigation;

function createGridNavMesh() {
  return new NavMesh({
    origin: [2, 4],
    cellSize: 1,
    columns: 3,
    rows: 1,
    heights: new Float32Array([0, 0, 0]),
  });
}

test('navigation entry keeps its runtime facade surface and hides backend classes', () => {
  assert.deepEqual(Object.keys(navigation).sort(), ['NavMesh', 'NavMeshPath']);
  assert.equal(navigation.HeightfieldNavBackend, undefined);
  assert.equal(navigation.NavBackend, undefined);
});

test('NavMesh facade delegates queries while HeightfieldNavBackend owns mutable state', () => {
  const navMesh = createGridNavMesh();
  const backend = navMesh._backend;

  assert.ok(backend);
  assert.equal(backend.constructor.name, 'HeightfieldNavBackend');
  assert.equal(navMesh.heights, backend.heights);
  assert.equal(navMesh.walkable, backend.walkable);
  assert.equal(navMesh.clearance, backend.clearance);
  assert.equal(Object.hasOwn(navMesh, '_gScore'), false);
  assert.equal(Object.hasOwn(backend, '_gScore'), true);

  let findPathCallCount = 0;
  const backendFindPath = backend.findPath;
  backend.findPath = function (...args) {
    findPathCallCount++;
    return backendFindPath.apply(this, args);
  };

  const out = new NavMeshPath();
  assert.equal(navMesh.findPath([2.5, 0, 4.5], [4.5, 0, 4.5], { radius: 0 }, out), out);
  assert.equal(findPathCallCount, 1);
  assert.equal(out.status, 'complete');

  const projected = new Float32Array(3);
  assert.equal(navMesh.projectPoint([4.5, 0, 4.5], { radius: 0 }, projected), projected);

  assert.equal(navMesh.setObstacle({
    id: 'temporary',
    position: [3.5, 0, 4.5],
    radius: 0.2,
  }), navMesh);
  assert.equal(navMesh.obstacleCount, 1);
  assert.equal(backend.obstacleCount, 1);
  assert.equal(navMesh.removeObstacle('temporary'), true);
  assert.equal(navMesh.obstacleCount, 0);
});

test('NavMesh.fromGeometry also returns a facade backed by the heightfield implementation', () => {
  const geometry = new Geometry3D({
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 0, 1,
    ]),
  });
  const navMesh = NavMesh.fromGeometry(geometry, {
    cellSize: 0.25,
    boundsPadding: 0,
  });

  assert.equal(navMesh._backend.constructor.name, 'HeightfieldNavBackend');
  assert.equal(navMesh.heights, navMesh._backend.heights);
  assert.equal(navMesh.isPositionWalkable([0.125, 0, 0.125], { radius: 0 }), true);
});
