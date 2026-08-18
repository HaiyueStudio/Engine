import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry3D, Ray } from '../dist/experimental.js';

const IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function createRay(origin = [0, 0, 1], direction = [0, 0, -1]) {
  const ray = new Ray();
  ray.origin.set(origin);
  ray.direction.set(direction);
  return ray;
}

function createTriangle(indices = null) {
  return new Geometry3D({
    positions: new Float32Array([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.0,  0.5, 0,
    ]),
    ...(indices ? { indices } : {}),
  });
}

test('Ray camera and matrix boundaries reject incomplete or zero-length inputs', () => {
  const ray = new Ray();
  assert.throws(() => ray.setFromCamera(0, 0, new Float32Array(2), IDENTITY), /at least 3 elements/);
  assert.throws(() => ray.setFromCamera(0, 0, new Float32Array(3), new Float32Array(15)), /at least 16 elements/);
  assert.throws(() => ray.setFromCamera(0, 0, new Float32Array([0, 0, 0.5]), IDENTITY), /non-zero direction/);
  assert.throws(() => ray.intersectMesh(createTriangle(), new Float32Array(15)), /at least 16 elements/);

  ray.setFromCamera(0, 0, new Float32Array([0, 0, 0]), IDENTITY);
  assert.deepEqual(Array.from(ray.origin), [0, 0, 0]);
  assert.deepEqual(Array.from(ray.direction), [0, 0, 1]);
});

test('Ray BVH and linear triangle paths return the same closest hit and ignore incomplete index tails', () => {
  const ray = createRay();
  const direct = createTriangle();
  const indexedWithTail = createTriangle(new Uint16Array([0, 1, 2, 0]));

  for (const geometry of [direct, indexedWithTail]) {
    const linear = ray.intersectMesh(geometry, IDENTITY, { useBVH: false });
    const bvh = ray.intersectMesh(geometry, IDENTITY, { useBVH: true });
    assert.ok(linear);
    assert.ok(bvh);
    assert.ok(Math.abs(linear.distance - 1) < 1e-6);
    assert.ok(Math.abs(bvh.distance - linear.distance) < 1e-6);
    assert.deepEqual(Array.from(bvh.point), [0, 0, 0]);
    assert.deepEqual(Array.from(bvh.normal), [0, 0, 1]);
  }
});

test('Ray intersectMesh writes into a caller-owned hit result without replacing it', () => {
  const ray = createRay();
  const out = {
    distance: Number.POSITIVE_INFINITY,
    point: new Float32Array(3),
    normal: new Float32Array(3),
  };
  const point = out.point;
  const normal = out.normal;
  const hit = ray.intersectMesh(createTriangle(), IDENTITY, { useBVH: true }, out);

  assert.equal(hit, out);
  assert.equal(hit.point, point);
  assert.equal(hit.normal, normal);
  assert.ok(Math.abs(hit.distance - 1) < 1e-6);
  assert.deepEqual(Array.from(hit.point), [0, 0, 0]);
  assert.deepEqual(Array.from(hit.normal), [0, 0, 1]);
});

test('Ray BVH invalidates in-place position changes by Geometry3D version', () => {
  const geometry = createTriangle();
  const ray = createRay();
  assert.ok(ray.intersectMesh(geometry, IDENTITY, { useBVH: true }));

  for (let i = 0; i < geometry.positions.length; i += 3) geometry.positions[i] += 10;
  geometry.markDirty();
  ray.origin.set([10, 0, 1]);
  assert.ok(ray.intersectMesh(geometry, IDENTITY, { useBVH: true }));
});

test('Ray transforms normals with inverse transpose under non-uniform scale', () => {
  const geometry = new Geometry3D({
    positions: new Float32Array([
       0, 0, 0,
       0, 1, 0,
      -1, 0, 1,
    ]),
  });
  const matrix = new Float32Array([
    2, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0.5, 0,
    0, 0, 0, 1,
  ]);
  const expected = new Float32Array([0.5, 0, 2]);
  const length = Math.hypot(...expected);
  expected[0] /= length;
  expected[2] /= length;
  const point = [-0.5, 0.25, 0.125];
  const ray = createRay(
    point.map((value, index) => value + expected[index] * 2),
    Array.from(expected, value => -value),
  );

  const hit = ray.intersectMesh(geometry, matrix, { useBVH: true });
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance - 2) < 1e-5);
  assert.ok(Math.abs(hit.normal[0] - expected[0]) < 1e-6);
  assert.ok(Math.abs(hit.normal[1] - expected[1]) < 1e-6);
  assert.ok(Math.abs(hit.normal[2] - expected[2]) < 1e-6);
});

test('Ray BVH sorting matches linear traversal for more than one leaf', () => {
  const positions = [];
  for (let x = -6; x <= 6; x++) {
    positions.push(
      x - 0.4, -0.4, 0,
      x + 0.4, -0.4, 0,
      x, 0.4, 0,
    );
  }
  const geometry = new Geometry3D({ positions: new Float32Array(positions) });
  const ray = createRay();
  const linear = ray.intersectMesh(geometry, IDENTITY, { useBVH: false });
  const bvh = ray.intersectMesh(geometry, IDENTITY, { useBVH: true });
  assert.ok(linear);
  assert.ok(bvh);
  assert.ok(Math.abs(bvh.distance - linear.distance) < 1e-6);
  assert.deepEqual(Array.from(bvh.point), Array.from(linear.point));
});
