import assert from 'node:assert/strict';
import test from 'node:test';
import { Camera3D, Geometry3D, Ray } from '../dist/experimental.js';
import { mat4, vec3 } from 'wgpu-matrix';

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
  assert.throws(() => ray.setFromCamera(0, 0, new Float32Array(3), new Float32Array(16)), /non-zero direction/);
  assert.throws(() => ray.intersectMesh(createTriangle(), new Float32Array(15)), /at least 16 elements/);

  ray.setFromCamera(0, 0, new Float32Array([0, 0, 0]), IDENTITY);
  assert.deepEqual(Array.from(ray.origin), [0, 0, 0]);
  assert.deepEqual(Array.from(ray.direction), [0, 0, -1]);
});

test('projected world points round-trip through camera rays across projections, resize, movement and reverseZ', () => {
  const targets = [[0, 0, 0], [-4, -3, 0], [4, -3, 0], [-4, 3, 0], [4, 3, 0]];
  for (const type of ['orthographic', 'perspective']) {
    for (const reverseZ of [false, true]) {
      for (const aspect of [1, 16 / 9, 9 / 16]) {
        for (const eye of [[0, 0, 22], [5, 4, 30]]) {
          const camera = new Camera3D({ type, near: 0.01, far: 100, aspect });
          camera.reverseZ = reverseZ;
          camera.orthoLeft = -8.75 * aspect; camera.orthoRight = 8.75 * aspect;
          camera.orthoBottom = -8.75; camera.orthoTop = 8.75;
          const view = mat4.lookAt(eye, [0, 0, 0], [0, 1, 0]);
          const viewProjection = mat4.multiply(camera.projectionMatrix, view);
          const inverse = mat4.inverse(viewProjection);
          let previousDirection;
          for (const point of targets) {
            const ndc = vec3.transformMat4(point, viewProjection);
            const ray = new Ray().setFromCamera(ndc[0], ndc[1], new Float32Array(eye), inverse);
            const t = -ray.origin[2] / ray.direction[2];
            const hit = Array.from(ray.origin, (v, i) => v + t * ray.direction[i]);
            const label = JSON.stringify({ type, reverseZ, aspect, eye, point, hit });
            assert.ok(t > 0, label);
            assert.ok(Math.hypot(...hit.map((v, i) => v - point[i])) < 0.002, label);
            if (type === 'orthographic' && previousDirection) {
              assert.deepEqual(ray.direction, previousDirection, 'orthographic rays must be parallel');
            }
            if (type === 'perspective') assert.deepEqual(Array.from(ray.origin), eye);
            previousDirection = ray.direction;
          }
        }
      }
    }
  }
});

test('orthographic rays keep forward orientation when the depth interval straddles the camera', () => {
  for (const reverseZ of [false, true]) {
    const camera = new Camera3D({ type: 'orthographic', near: -1000, far: 1000 });
    camera.reverseZ = reverseZ;
    camera.orthoLeft = -10; camera.orthoRight = 10;
    camera.orthoBottom = -10; camera.orthoTop = 10;
    const ray = new Ray().setFromCamera(0.4, -0.3, new Float32Array(3), mat4.inverse(camera.projectionMatrix));
    assert.ok(Math.abs(ray.origin[0] - 4) < 1e-6);
    assert.ok(Math.abs(ray.origin[1] + 3) < 1e-6);
    assert.ok(Math.hypot(ray.direction[0], ray.direction[1], ray.direction[2] + 1) < 1e-6);
    assert.equal(ray.origin[2], 0);
  }
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

test('Ray per-call counters measure pruning and reset on misses for indexed and unindexed meshes', () => {
  for (const indexed of [false, true]) {
    const positions = [];
    for (let x = -32; x <= 32; x++) {
      positions.push(x - 0.4, -0.4, 0, x + 0.4, -0.4, 0, x, 0.4, 0);
    }
    const geometry = new Geometry3D({
      positions: new Float32Array(positions),
      ...(indexed ? { indices: new Uint32Array(Array.from({ length: positions.length / 3 }, (_, i) => i)) } : {}),
    });
    const ray = createRay();
    const linearStats = { triangleTests: -1, boundingBoxTests: -1 };
    const bvhStats = { triangleTests: -1, boundingBoxTests: -1 };
    const result = () => ({ distance: 0, point: new Float32Array(3), normal: new Float32Array(3) });
    const linear = ray.intersectMesh(geometry, IDENTITY, { useBVH: false, stats: linearStats }, result());
    const bvh = ray.intersectMesh(geometry, IDENTITY, { useBVH: true, stats: bvhStats }, result());
    assert.deepEqual(bvh, linear, 'instrumented paths preserve hit and face normal');
    assert.equal(linearStats.triangleTests, 65);
    assert.equal(linearStats.boundingBoxTests, 1);
    assert.ok(bvhStats.triangleTests > 0 && bvhStats.triangleTests < 65 / 2);
    assert.ok(bvhStats.boundingBoxTests > 1);
    for (const useBVH of [false, true]) {
      ray.origin.set([100, 100, 1]);
      assert.equal(ray.intersectMesh(geometry, IDENTITY, { useBVH, stats: bvhStats }), null);
      assert.deepEqual(bvhStats, { triangleTests: 0, boundingBoxTests: 1 });
      ray.origin.set([0.45, 0, 1]);
      assert.equal(ray.intersectMesh(geometry, IDENTITY, { useBVH, stats: bvhStats }), null);
      assert.ok(bvhStats.triangleTests > 0, 'misses inside the mesh bounds still count triangle work');
      ray.direction.fill(0);
      assert.equal(ray.intersectMesh(geometry, IDENTITY, { useBVH, stats: bvhStats }), null);
      assert.deepEqual(bvhStats, { triangleTests: 0, boundingBoxTests: 0 });
      ray.direction.set([0, 0, -1]);
    }
  }
});
