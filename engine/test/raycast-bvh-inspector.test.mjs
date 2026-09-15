import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry3D } from '../dist/index.js';
import { Ray } from '../dist/math.js';
import { createRaycastBVHInspector } from '../dist/experimental/diagnostics.js';
import { mat4 } from 'wgpu-matrix';

const identity = mat4.identity();
function fixture(indexed = true) {
  const positions = [];
  for (let x = -24; x <= 24; x++) {
    positions.push(x - 0.4, -0.4, 0, x + 0.4, -0.4, 0, x, 0.4, 0);
  }
  return new Geometry3D({ positions: new Float32Array(positions),
    ...(indexed ? { indices: new Uint32Array(Array.from({ length: positions.length / 3 }, (_, i) => i)) } : {}),
  });
}
function rayAt(x = 0, y = 0) {
  const ray = new Ray();
  ray.origin.set([x, y, 3]);
  ray.direction.set([0, 0, -1]);
  return ray;
}

test('BVH diagnostic snapshot preserves hierarchy, triangle coverage, and detached immutable bounds', () => {
  const geometry = fixture();
  const inspector = createRaycastBVHInspector(geometry);
  const snapshot = inspector.getSnapshot();
  assert.equal(inspector.getSnapshot(), snapshot);
  assert.equal(snapshot.triangleIndices.length, geometry.indices.length);
  const leafCoverage = new Set();
  for (const node of snapshot.nodes) {
    assert.equal(snapshot.nodes[node.id], node);
    for (let tri = node.start; tri < node.end; tri++) {
      for (let corner = 0; corner < 3; corner++) {
        const vertex = snapshot.triangleIndices[tri * 3 + corner];
        for (let axis = 0; axis < 3; axis++) {
          const value = geometry.positions[vertex * 3 + axis];
          assert.ok(value >= node.min[axis] && value <= node.max[axis]);
        }
      }
      if (node.left === null) {
        assert.ok(!leafCoverage.has(tri));
        leafCoverage.add(tri);
      }
    }
    if (node.left === null) {
      assert.equal(node.right, null);
      assert.ok(node.end - node.start <= 8);
    } else {
      const left = snapshot.nodes[node.left], right = snapshot.nodes[node.right];
      assert.equal(left.depth, node.depth + 1);
      assert.equal(right.depth, node.depth + 1);
      assert.equal(left.start, node.start);
      assert.equal(left.end, right.start);
      assert.equal(right.end, node.end);
    }
  }
  assert.equal(leafCoverage.size, 49);
  assert.throws(() => { snapshot.nodes[0].min[0] = -1000; }, TypeError);
  assert.throws(() => { snapshot.triangleIndices[0] = 100; }, TypeError);
});

test('BVH trace records actual pruning and exactly the triangles the production ray tests', () => {
  for (const indexed of [true, false]) {
    const geometry = fixture(indexed);
    const inspector = createRaycastBVHInspector(geometry);
    for (const x of [0, 8, 0.45, 100]) {
      const ray = rayAt(x);
      const trace = inspector.trace(ray, identity);
      const expected = { distance: 0, point: new Float32Array(3), normal: new Float32Array(3) };
      const linear = ray.intersectMesh(geometry, identity, { useBVH: false }, expected);
      assert.deepEqual(trace.hit, linear);
      assert.equal(trace.boundingBoxTests, trace.steps.length + 1);
      let testedTriangles = 0;
      const acceptedParents = new Set();
      for (const step of trace.steps) {
        const node = trace.snapshot.nodes[step.nodeId];
        if (node.id !== 0) assert.ok(acceptedParents.has(node.id), 'a node is reached only through an accepted parent');
        if (!step.accepted) continue;
        if (node.left === null) testedTriangles += node.end - node.start;
        else { acceptedParents.add(node.left); acceptedParents.add(node.right); }
      }
      assert.equal(testedTriangles, trace.triangleTests);
      assert.ok(trace.triangleTests < 49);
      if (x === 100) { assert.equal(trace.broadPhaseHit, false); assert.equal(trace.steps.length, 0); }
      if (x === 0.45) { assert.equal(trace.hit, null); assert.ok(trace.triangleTests > 0, 'tested does not imply hit'); }
      if (x === 0) assert.ok(trace.steps.some(step => !step.accepted));
    }
  }
});

test('BVH trace preserves world-space hits and output ownership across transformed queries', () => {
  const geometry = fixture();
  const inspector = createRaycastBVHInspector(geometry);
  const matrix = mat4.multiply(mat4.translation([0, 0, -2]), mat4.scaling([1.5, 0.75, 2]));
  const ray = rayAt(0);
  const trace = inspector.trace(ray, matrix);
  assert.equal(trace.hit.distance, 5);
  assert.deepEqual(Array.from(trace.hit.point), [0, 0, -2]);
  ray.origin[0] = 3;
  inspector.trace(ray, matrix);
  assert.deepEqual(Array.from(trace.hit.point), [0, 0, -2], 'later calls must not overwrite recorded hits');
  assert.throws(() => inspector.trace(ray, new Float32Array(2)), RangeError);
  const next = inspector.trace(ray, matrix);
  assert.ok(next.hit, 'instrumentation is removed even when a query throws');
});

test('BVH inspector refreshes topology snapshots after source geometry invalidation', () => {
  const geometry = fixture();
  const inspector = createRaycastBVHInspector(geometry);
  const before = inspector.getSnapshot();
  for (let i = 0; i < geometry.positions.length; i += 3) geometry.positions[i] += 100;
  geometry.markDirty();
  const after = inspector.getSnapshot();
  assert.notEqual(after, before);
  assert.equal(after.geometryVersion, geometry.version);
  assert.ok(after.nodes[0].min[0] > 75);
  assert.ok(before.nodes[0].min[0] < 0, 'old snapshots remain detached');
  assert.equal(inspector.trace(rayAt(), identity).hit, null);
  assert.ok(inspector.trace(rayAt(100), identity).hit);
});
